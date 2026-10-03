// Additional restrictions inherited by the Node job process and every parser it starts.
// gVisor is the outer isolation boundary. This filter removes network access and
// daemonisation from the conversion process; failure to apply it aborts the job.
#include <seccomp.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <errno.h>
#include <unistd.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/socket.h>
int main(int argc, char **argv) {
  if (argc < 2) return 64;
  struct rlimit core = {0,0}, files = {256,256}, size = {5000000000ULL,5000000000ULL}, cpu = {900,900};
  if (setrlimit(RLIMIT_CORE, &core) || setrlimit(RLIMIT_NOFILE, &files) || setrlimit(RLIMIT_FSIZE, &size) || setrlimit(RLIMIT_CPU, &cpu) || prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0)) return 70;
  scmp_filter_ctx ctx = seccomp_init(SCMP_ACT_ALLOW); if (!ctx) return 70;
  // Local Unix sockets support LibreOffice IPC. IP/raw/packet sockets are denied.
  if (seccomp_rule_add(ctx, SCMP_ACT_ERRNO(EPERM), SCMP_SYS(socket), 1, SCMP_A0(SCMP_CMP_NE, AF_UNIX)) || seccomp_rule_add(ctx, SCMP_ACT_ERRNO(EPERM), SCMP_SYS(socketpair), 1, SCMP_A0(SCMP_CMP_NE, AF_UNIX))) return 70;
  const char *deny[] = {"ptrace", "process_vm_readv", "process_vm_writev", "bpf", "perf_event_open", "mount", "umount2", "pivot_root", "chroot", "unshare", "setns", "setsid", "setpgid", "keyctl", "add_key", "request_key", "userfaultfd", "io_uring_setup", "io_uring_enter", "io_uring_register", "reboot", "kexec_load", "init_module", "finit_module", "delete_module", "open_by_handle_at"};
  for (unsigned i = 0; i < sizeof(deny)/sizeof(deny[0]); i++) {
    int number = seccomp_syscall_resolve_name(deny[i]);
    if (number != __NR_SCMP_ERROR && seccomp_rule_add(ctx, SCMP_ACT_ERRNO(EPERM), number, 0)) return 70;
  }
  if (seccomp_load(ctx)) { perror("sandbox"); return 70; } seccomp_release(ctx);
  execvp(argv[1], argv + 1); perror("exec"); return 70;
}
