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
         "\"ip_socket\":%d,\"memory_open\":%d}\n",
         (unsigned)getuid(), (long)pid, open_error, getfd_error, advise_error,
         invalid_error, socket_error, memory_error);
  return 0;
}
