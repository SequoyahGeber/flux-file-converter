// Exercise real child exits, including children adopted by PID 1.
#define main flux_supervisor_main
#include "../server/supervisor.c"
#undef main
#include <assert.h>
static void expect_child(pid_t pid) {
  int status;
  while (waitpid(pid, &status, 0) < 0) assert(errno == EINTR);
  assert(WIFEXITED(status) && WEXITSTATUS(status) == 0);
}
static void startup_descriptors(void) {
  // Both the fd == 3 and dup2-over-an-existing-fd cases must clear CLOEXEC.
  for (int move = 0; move <= 1; move++) {
    pid_t child = fork(); assert(child >= 0);
    if (!child) {
      int channel[2]; assert(pipe2(channel, O_CLOEXEC | O_NONBLOCK) == 0);
      assert(write(channel[1], "x", 1) == 1); close(channel[1]);
      int input = channel[0];
      if (move) {
        int relocated = fcntl(input, F_DUPFD_CLOEXEC, 4); assert(relocated >= 4);
        close(input); input = relocated;
        int occupied = open("/dev/null", O_RDONLY); assert(occupied >= 0);
        if (occupied != 3) { assert(dup2(occupied, 3) == 3); close(occupied); }
      } else if (input != 3) {
        assert(dup2(input, 3) == 3); close(input); input = 3;
        assert(fcntl(3, F_SETFD, FD_CLOEXEC) == 0);
      }
      credential_descriptor(input);
      assert(fcntl(3, F_GETFD) == 0);
      char byte; assert(read(3, &byte, 1) == 1 && byte == 'x');
      assert(read(3, &byte, 1) == 0);
      if (input != 3) { errno = 0; assert(fcntl(input, F_GETFD) == -1 && errno == EBADF); }
      close(3); _exit(0);
    }
    expect_child(child);
  }
}
static volatile sig_atomic_t interrupted;
static void interrupt_delivery(int sig) { (void)sig; interrupted = 1; }
static void startup_delivery(void) {
  int channel[2]; assert(pipe2(channel, O_CLOEXEC | O_NONBLOCK) == 0);
  assert(fcntl(channel[0], F_GETFD) & FD_CLOEXEC);
  assert(fcntl(channel[1], F_GETFD) & FD_CLOEXEC);
  // A frame is larger than this pipe capacity, forcing partial delivery.
  assert(fcntl(channel[1], F_SETPIPE_SZ, 4096) == 4096);
  char secret[4097]; memset(secret, 's', sizeof(secret) - 1); secret[4096] = 0;
  pid_t reader = fork(); assert(reader >= 0);
  if (!reader) {
    close(channel[1]); alarm(5);
    unsigned char data[4101]; size_t used = 0;
    for (;;) {
      ssize_t count = read(channel[0], data + used, sizeof(data) - used);
      if (count < 0 && (errno == EAGAIN || errno == EINTR)) { usleep(1000); continue; }
      assert(count >= 0);
      if (!count) break;
      used += (size_t)count; assert(used < sizeof(data));
    }
    assert(used == 4100);
    uint32_t length; memcpy(&length, data, 4); assert(ntohl(length) == 4096);
    assert(!memcmp(data + 4, secret, 4096));
    close(channel[0]); _exit(0);
  }
  close(channel[0]); assert(credential_write(channel[1], secret, 2000) == 0);
  close(channel[1]); expect_child(reader);
  // An exited reader must produce an error rather than terminate via SIGPIPE.
  assert(pipe2(channel, O_CLOEXEC | O_NONBLOCK) == 0); close(channel[0]);
  struct sigaction before, after;
  assert(sigaction(SIGPIPE, NULL, &before) == 0);
  errno = 0; assert(credential_write(channel[1], secret, 100) == -1 && errno == EPIPE);
  assert(sigaction(SIGPIPE, NULL, &after) == 0 && before.sa_handler == after.sa_handler);
  close(channel[1]);
  // A child that never drains its pipe cannot hold supervisor startup forever.
  assert(pipe2(channel, O_CLOEXEC | O_NONBLOCK) == 0);
  char padding[4096] = {0};
  while (write(channel[1], padding, sizeof(padding)) > 0) {}
  assert(errno == EAGAIN);
  struct sigaction interrupt = {.sa_handler = interrupt_delivery}, previous;
  sigemptyset(&interrupt.sa_mask);
  assert(sigaction(SIGUSR1, &interrupt, &previous) == 0);
  pid_t writer = getpid(), notifier = fork(); assert(notifier >= 0);
  if (!notifier) { usleep(10000); assert(kill(writer, SIGUSR1) == 0); _exit(0); }
  int64_t begin = milliseconds();
  errno = 0; assert(credential_write(channel[1], secret, 100) == -1 && errno == ETIMEDOUT);
  assert(interrupted && milliseconds() - begin < 3000);
  expect_child(notifier);
  assert(sigaction(SIGUSR1, &previous, NULL) == 0);
  close(channel[0]); close(channel[1]);
  explicit_bzero(secret, sizeof(secret));
}
int main(void) {
  alarm(15);
  startup_descriptors(); startup_delivery();
  pid_t helper = fork(); assert(helper >= 0);
  if (!helper) _exit(0);
  usleep(100000); alive();
  assert(waitpid(helper, NULL, WNOHANG) == -1 && errno == ECHILD);
  pid_t probe = fork(); assert(probe >= 0);
  if (!probe) {
    pid_t service = fork(); assert(service >= 0);
    if (!service) _exit(9);
    service_pids[2] = service;
    usleep(100000); alive(); _exit(99);
  }
  int status; assert(waitpid(probe, &status, 0) == probe);
  assert(WIFEXITED(status) && WEXITSTATUS(status) == 70);
  puts("Supervisor startup pipe delivery, descriptor lifecycle and service exits passed.");
  return 0;
}
