// Exercise real child exits, including children adopted by PID 1.
#define main flux_supervisor_main
#include "../server/supervisor.c"
#undef main
#include <assert.h>
int main(void) {
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
  puts("Supervisor preserves completed helpers and restarts failed services.");
  return 0;
}
