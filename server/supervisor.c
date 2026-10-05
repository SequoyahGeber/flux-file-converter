// Trusted startup only. Every long-running process loses root, all capability
// sets, and its capability bounding set before accepting uploaded files.
#define _GNU_SOURCE
#include <unistd.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <linux/capability.h>
#include <sys/socket.h>
#include <arpa/inet.h>
#include <grp.h>
#include <signal.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static volatile sig_atomic_t stopping;
static pid_t service_pids[7];
static void stop(int sig) { (void)sig; stopping = 1; }
static void die(const char *message) { fprintf(stderr, "Flux startup: %s\n", message); exit(70); }
static void directory(const char *path, uid_t uid, gid_t gid, mode_t mode) {
  struct stat st;
  if (mkdir(path, mode) && errno != EEXIST) die("cannot create private directory");
  if (lstat(path, &st) || !S_ISDIR(st.st_mode)) die("invalid private directory");
  // Only named scratch volumes and fixed temporary directories are touched.
  if (chown(path, 0, 0) || chmod(path, mode) || chown(path, uid, gid)) die("cannot set private directory ownership");
}
static void unprivileged(uid_t uid, gid_t gid) {
  if (setgroups(0, NULL) || setgid(gid)) die("cannot drop groups");
  for (int cap = 0; cap <= CAP_LAST_CAP; cap++)
    if (prctl(PR_CAPBSET_DROP, cap, 0, 0, 0)) die("cannot drop capability bounding set");
  if (prctl(PR_SET_KEEPCAPS, 0, 0, 0, 0) || setuid(uid)) die("cannot drop user privileges");
  struct __user_cap_header_struct header = { .version = _LINUX_CAPABILITY_VERSION_3, .pid = 0 };
  struct __user_cap_data_struct data[2] = {{0}, {0}};
  if (syscall(SYS_capset, &header, data) || prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0)) die("cannot drop capabilities");
  if (getuid() != uid || geteuid() != uid) die("user privilege mismatch");
}
static char *env[32]; static int env_count;
static void reset_env(const char *home) {
  env_count = 0;
  env[env_count++] = "PATH=/usr/local/bin:/usr/bin:/bin";
  env[env_count++] = "NODE_ENV=production";
  env[env_count++] = "PYTHONDONTWRITEBYTECODE=1";
  env[env_count++] = "OMP_NUM_THREADS=1";
  env[env_count++] = "OPENBLAS_NUM_THREADS=1";
  env[env_count++] = "MAGICK_THREAD_LIMIT=1";
  char *value;
  if (asprintf(&value, "HOME=%s", home) < 0) die("allocation failed");
  env[env_count++] = value;
  if (asprintf(&value, "TMPDIR=%s", home) < 0) die("allocation failed");
  env[env_count++] = value;
}
static void variable(const char *name, const char *fallback) {
  const char *value = getenv(name); char *entry;
  if (!value) value = fallback;
  if (!value || strlen(value) > 4096 || env_count >= 30 || asprintf(&entry, "%s=%s", name, value) < 0) die("invalid service configuration");
  env[env_count++] = entry;
}
static void literal(char *entry) { if (env_count >= 30) die("environment limit"); env[env_count++] = entry; }
static pid_t launch(uid_t uid, gid_t gid, const char *home, char *const argv[], int role) {
  pid_t pid = fork(); if (pid < 0) die("cannot start service");
  if (pid) { if (role >= 1 && role <= 5) service_pids[role] = pid; return pid; }
  reset_env(home);
  literal("FLUX_BIND=127.0.0.1");
  if (role == 1 || role == 2 || role == 6) variable("WORKER_SECRET", NULL);
  if (role == 1) {
    variable("ACCESS_ISSUER", NULL); variable("ACCESS_AUD", NULL);
    variable("FLUX_OWNER_EMAIL", NULL);
    variable("PUBLIC_ORIGIN", "https://fileconverter.sequoyahgeber.com");
    literal("WORKER_URL=http://127.0.0.1:8090"); literal("CLAMAV_HOST=127.0.0.1");
    literal("FLUX_STORAGE=/work/api"); literal("NODE_OPTIONS=--max-old-space-size=256");
  }
  if (role == 2) {
    literal("FLUX_SERVER=1"); literal("FLUX_WORKDIR=/work/worker");
    literal("FLUX_TMPDIR=/tmp/worker"); literal("QT_QPA_PLATFORM=offscreen");
    literal("NODE_OPTIONS=--max-old-space-size=512");
  }
  if (role == 5) variable("TUNNEL_TOKEN", NULL);
  if (role == 6) {
    literal("WORKER_URL=http://127.0.0.1:8090");
    literal("FLUX_VERIFY_PRIVILEGES=1");
  }
  env[env_count] = NULL;
  umask(0027); unprivileged(uid, gid);
  execve(argv[0], argv, env); die("cannot execute service"); return -1;
}
static int port_ready(int port) {
  int fd = socket(AF_INET, SOCK_STREAM | SOCK_CLOEXEC, 0); if (fd < 0) return 0;
  struct sockaddr_in address = {.sin_family=AF_INET, .sin_port=htons(port), .sin_addr.s_addr=htonl(INADDR_LOOPBACK)};
  int ready = connect(fd, (struct sockaddr *)&address, sizeof(address)) == 0;
  close(fd); return ready;
}
static void alive(void) {
  int status; pid_t pid;
  // PID 1 also adopts short-lived converter descendants. Reap those without
  // treating a completed Office helper as a failed long-running service.
  while ((pid = waitpid(-1, &status, WNOHANG)) > 0) {
    for (int role = 1; role <= 5; role++) {
      if (service_pids[role] != pid) continue;
      fprintf(stderr, "Flux service role=%d pid=%ld exit=%d signal=%d\n", role, (long)pid,
              WIFEXITED(status) ? WEXITSTATUS(status) : -1,
              WIFSIGNALED(status) ? WTERMSIG(status) : 0);
      die("a service stopped; restarting the complete app");
    }
  }
  if (stopping) exit(0);
}
static void wait_port(int port) {
  for (int i=0;i<180;i++) { alive(); if (port_ready(port)) return; sleep(1); }
  die("service readiness deadline exceeded");
}
static void wait_database(void) {
  struct stat a, b;
  for (int i=0;i<600;i++) {
    alive();
    if (!stat("/var/lib/clamav/main.cvd",&a) && a.st_size>0 &&
        ((!stat("/var/lib/clamav/daily.cvd",&b) || !stat("/var/lib/clamav/daily.cld",&b)) && b.st_size>0)) return;
    sleep(1);
  }
  die("antivirus definitions are unavailable");
}
int main(int argc, char **argv) {
  if (geteuid() != 0) die("the trusted privilege-dropping launcher must start as root");
  if (argc == 2 && !strcmp(argv[1],"--health")) {
    unprivileged(10006,10006);
    return port_ready(8080) && port_ready(8090) && port_ready(3310) ? 0 : 1;
  }
  const char *secret = getenv("WORKER_SECRET");
  if (!secret || strlen(secret)<32) die("worker configuration missing");
  signal(SIGTERM, stop); signal(SIGINT, stop);
  directory("/work/api",10001,10001,0700); directory("/work/worker",10002,10002,0700);
  directory("/work/scanner",10003,10003,0700);
  directory("/tmp/api",10001,10001,0700); directory("/tmp/worker",10002,10002,0700);
  directory("/tmp/scanner",10003,10003,0700); directory("/tmp/definitions",10004,10003,0700);
  directory("/tmp/tunnel",10005,10005,0700);
  char *worker[] = {"/usr/local/bin/node","/app/server/worker.cjs",NULL};
  launch(10002,10002,"/tmp/worker",worker,2); wait_port(8090);
  if (argc == 2 && !strcmp(argv[1],"--verify")) {
    char *test[] = {"/usr/local/bin/node","/app/tests/container-smoke.cjs",NULL};
    pid_t test_pid = launch(10001,10001,"/tmp/api",test,6); int status;
    while (waitpid(test_pid,&status,0)<0) if(errno!=EINTR) die("verification failed");
    return WIFEXITED(status) ? WEXITSTATUS(status) : 1;
  }
  if (!getenv("TUNNEL_TOKEN") || !getenv("ACCESS_AUD") || !getenv("ACCESS_ISSUER")) die("login or tunnel configuration missing");
  // Definitions are public data. Startup only needs directory traversal to
  // stat their readiness; only the updater may write this directory.
  directory("/var/lib/clamav",10004,10003,0755);
  char *definitions[] = {"/usr/bin/freshclam","--daemon","--foreground=true","--config-file=/etc/clamav/freshclam.conf",NULL};
  launch(10004,10003,"/tmp/definitions",definitions,4); wait_database();
  char *scanner[] = {"/usr/sbin/clamd","--foreground=true","--config-file=/etc/clamav/clamd-unified.conf",NULL};
  launch(10003,10003,"/tmp/scanner",scanner,3); wait_port(3310);
  char *api[] = {"/usr/local/bin/node","/app/server/app.cjs",NULL};
  launch(10001,10001,"/tmp/api",api,1); wait_port(8080);
  char *tunnel[] = {"/usr/local/bin/cloudflared","tunnel","--protocol","http2","--no-autoupdate","run",NULL};
  launch(10005,10005,"/tmp/tunnel",tunnel,5);
  // Neither service environment nor long-lived supervisor retains the other
  // services' secrets. Linux UID checks also protect their /proc environments.
  for (char **item=environ; item && *item; item++) memset(*item,0,strlen(*item));
  clearenv(); unprivileged(10006,10006);
  puts("Flux ready: all services run without root or capabilities."); fflush(stdout);
  while (!stopping) { alive(); sleep(1); }
  return 0;
}
