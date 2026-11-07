// Verification only. Never read or write target process memory.
#define _GNU_SOURCE
#include <unistd.h>
#include <sys/syscall.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/socket.h>
#include <fcntl.h>
#include <signal.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static void fail(const char *message) {
  fprintf(stderr, "Sandbox verification: %s (errno=%d)\n", message, errno);
  exit(1);
}
#define VERIFY_SENTINEL "flux-procfs-synthetic-sentinel-040-only"
struct environment { int credential; int sentinel; int denied; };
// Bound the read, require NUL-terminated entries and a real EOF. An empty,
// truncated or broken reader is never accepted as proof of absence.
static struct environment environment(pid_t pid, int allow_denial) {
  char path[80], data[65537];
  struct environment result = {0};
  snprintf(path, sizeof(path), "/proc/%ld/environ", (long)pid);
  int fd = open(path, O_RDONLY | O_CLOEXEC);
  if (fd < 0) {
    if (allow_denial && (errno == EACCES || errno == EPERM)) {
      result.denied = 1; return result;
    }
    fail("environment evidence unavailable");
  }
  size_t used = 0;
  for (;;) {
    ssize_t size = read(fd, data + used, sizeof(data) - used);
    if (size < 0 && errno == EINTR) continue;
    if (size < 0) { close(fd); fail("environment read failed"); }
    if (!size) break;
    used += (size_t)size;
    if (used == sizeof(data)) { close(fd); fail("environment evidence truncated"); }
  }
  close(fd);
  if (!used || data[used - 1]) fail("environment evidence incomplete");
  for (size_t offset = 0; offset < used;) {
    char *entry = data + offset;
    char *end = memchr(entry, 0, used - offset);
    if (!end || end == entry) fail("environment evidence malformed");
    char *equals = memchr(entry, '=', (size_t)(end - entry));
    if (!equals || equals == entry) fail("environment evidence malformed");
    size_t length = (size_t)(end - entry);
    if (length >= sizeof("WORKER_SECRET=") - 1 &&
        !memcmp(entry, "WORKER_SECRET=", sizeof("WORKER_SECRET=") - 1)) result.credential = 1;
    if (memmem(entry, length, VERIFY_SENTINEL, sizeof(VERIFY_SENTINEL) - 1)) result.sentinel = 1;
    offset += length + 1;
  }
  explicit_bzero(data, sizeof(data));
  return result;
}
static void identity(pid_t pid, int pidfd) {
  char path[80], data[4096];
  snprintf(path, sizeof(path), "/proc/%ld/cmdline", (long)pid);
  int fd = open(path, O_RDONLY);
  if (fd < 0) fail("worker cmdline unavailable");
  ssize_t size = read(fd, data, sizeof(data)); close(fd);
  const char expected[] = "/usr/local/bin/node\0/app/server/worker.cjs";
  if (size != (ssize_t)sizeof(expected) || memcmp(data, expected, sizeof(expected)))
    fail("target is not the recorded worker");
  snprintf(path, sizeof(path), "/proc/%ld/status", (long)pid);
  FILE *file = fopen(path, "r"); int valid = 0;
  if (!file) fail("worker status unavailable");
  while (fgets(data, sizeof(data), file)) {
    unsigned r, e, s, f;
    if (sscanf(data, "Uid: %u %u %u %u", &r, &e, &s, &f) == 4)
      valid = r == 10002 && e == 10002 && s == 10002 && f == 10002;
  }
  fclose(file);
  if (!valid || kill(pid, 0)) fail("worker UID or liveness mismatch");
  snprintf(path, sizeof(path), "/proc/self/fdinfo/%d", pidfd);
  file = fopen(path, "r"); valid = 0;
  if (!file) fail("valid worker pidfd unavailable");
  while (fgets(data, sizeof(data), file)) {
    long target;
    if (sscanf(data, "Pid: %ld", &target) == 1) valid = target == pid;
  }
  fclose(file);
  if (!valid) fail("pidfd does not identify live worker");
  // FD 0 is the worker's inherited stdin, a valid duplication target.
  snprintf(path, sizeof(path), "/proc/%ld/fd/0", (long)pid);
  struct stat st;
  if (stat(path, &st)) fail("worker descriptor 0 unavailable");
}
int main(int argc, char **argv) {
  if (argc != 3 || getuid() != 10002 || geteuid() != 10002 ||
      prctl(PR_GET_NO_NEW_PRIVS, 0, 0, 0, 0) != 1 ||
      prctl(PR_GET_SECCOMP, 0, 0, 0, 0) != 2) fail("probe is not sandboxed as worker UID");
  pid_t pid = (pid_t)strtol(argv[1], NULL, 10);
  int pidfd = (int)strtol(argv[2], NULL, 10);
  if (pid <= 1 || pidfd < 3) fail("invalid target");
  alarm(10);
  identity(pid, pidfd);
  // Only the public synthetic value is in this exposure-positive control.
  // No environment contents reach stdout.
  struct environment control = environment(getpid(), 0);
  if (!control.credential || !control.sentinel) fail("environment positive control failed");
  struct environment worker = environment(pid, 1);
  int exposed = worker.credential || worker.sentinel;
  identity(pid, pidfd);
  errno = 0;
  long result = syscall(SYS_pidfd_open, pid, 0);
  int open_error = result < 0 ? errno : 0;
  if (result >= 0) close((int)result);
  errno = 0;
  result = syscall(SYS_pidfd_getfd, pidfd, 0, 0);
  int getfd_error = result < 0 ? errno : 0;
  if (result >= 0) close((int)result);
  errno = 0;
  result = syscall(SYS_process_madvise, pidfd, NULL, 0, 0, 0);
  int advise_error = result < 0 ? errno : 0;
  errno = 0;
  result = syscall(SYS_pidfd_getfd, -1, 0, 0);
  int invalid_error = result < 0 ? errno : 0;
  if (result >= 0) close((int)result);
  errno = 0;
  int socket_fd = socket(AF_INET, SOCK_STREAM, 0);
  int socket_error = socket_fd < 0 ? errno : 0;
  if (socket_fd >= 0) close(socket_fd);
  char path[80];
  snprintf(path, sizeof(path), "/proc/%ld/mem", (long)pid);
  errno = 0;
  int memory = open(path, O_RDWR);
  int memory_error = memory < 0 ? errno : 0;
  if (memory >= 0) close(memory); // No memory access, even when the boundary fails.
  identity(pid, pidfd);
  close(pidfd);
  printf("{\"uid\":%u,\"worker\":%ld,\"sandbox\":true,\"pidfd_open\":%d,"
         "\"pidfd_getfd\":%d,\"process_madvise\":%d,\"invalid_pidfd_getfd\":%d,"
         "\"ip_socket\":%d,\"memory_open\":%d,\"environment_control\":true,"
         "\"credential_exposed\":%s}\n",
         (unsigned)getuid(), (long)pid, open_error, getfd_error, advise_error,
         invalid_error, socket_error, memory_error, exposed ? "true" : "false");
  return 0;
}
