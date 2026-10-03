#!/bin/bash
# Adds a named runtime and bounded Flux disks. Does not restart Docker or change its default runtime.
set -euo pipefail
flux_root=/mnt/cache/appdata/flux-deployment
mkdir -p "$flux_root/receipts" "$flux_root/storage" "$flux_root/gvisor"
for executable in curl jq sha512sum tar fallocate mkfs.ext4 mount mountpoint docker; do command -v "$executable" >/dev/null || { echo "Missing prerequisite: $executable"; exit 1; }; done
test "$(uname -m)" = x86_64 || { echo 'This deployment currently targets amd64.'; exit 1; }
docker ps --format '{{.ID}} {{.Names}}' > "$flux_root/receipts/containers-before.txt"
if ! docker info --format '{{json .Runtimes}}' | jq -e 'has("runsc")' >/dev/null; then
  flux_url=https://storage.googleapis.com/gvisor/releases/release/latest/x86_64
  (cd "$flux_root/gvisor"; curl --fail --location --proto '=https' --tlsv1.2 --retry 2 "$flux_url/gvisor.tar.bz2" -o gvisor.tar.bz2; curl --fail --location --proto '=https' --tlsv1.2 "$flux_url/gvisor.tar.bz2.sha512" -o gvisor.tar.bz2.sha512; sha512sum -c gvisor.tar.bz2.sha512; tar -xjf gvisor.tar.bz2)
  cp -a "$flux_root/gvisor/runsc" "$flux_root/gvisor/gvisor-bin" /usr/local/bin/
  if [ -f /etc/docker/daemon.json ]; then cp -p /etc/docker/daemon.json "$flux_root/receipts/daemon-before.json"; fi
  /usr/local/bin/runsc install --runtime=runsc
  kill -HUP "$(cat /var/run/dockerd.pid)"
  sleep 2
fi
cp "$flux_root/source/deploy/runsc-unraid" /usr/local/bin/runsc-unraid
chmod 0755 /usr/local/bin/runsc-unraid
jq '.runtimes.runsc.path="/usr/local/bin/runsc-unraid"' /etc/docker/daemon.json > /etc/docker/daemon.json.flux
mv /etc/docker/daemon.json.flux /etc/docker/daemon.json
kill -HUP "$(cat /var/run/dockerd.pid)"
docker info --format '{{json .Runtimes}}' | jq -e 'has("runsc")' >/dev/null
chattr +C "$flux_root/storage" 2>/dev/null || true
for pair in api:16 worker:24 scanner:8; do
  flux_name=${pair%:*}; flux_size=${pair#*:}; flux_image="$flux_root/storage/$flux_name.img"; flux_mount="/mnt/flux-work-$flux_name"
  if [ ! -f "$flux_image" ]; then
    fallocate -l "${flux_size}G" "$flux_image"
    mkfs.ext4 -q -m 0 -i 1048576 -L "flux-$flux_name" "$flux_image"
  fi
  mkdir -p "$flux_mount"
  if ! mountpoint -q "$flux_mount"; then mount -o loop,noexec,nosuid,nodev "$flux_image" "$flux_mount"; fi
  case "$flux_name" in api) flux_uid=10001;; worker) flux_uid=10002;; scanner) flux_uid=10003;; esac
  chown "$flux_uid:$flux_uid" "$flux_mount"; chmod 0700 "$flux_mount"
  if ! docker volume inspect "flux-$flux_name-work" >/dev/null 2>&1; then docker volume create --driver local --opt type=none --opt o=bind --opt "device=$flux_mount" "flux-$flux_name-work"; fi
  mountpoint -q "$flux_mount"
done
docker network inspect flux-outbound >/dev/null 2>&1 || docker network create --subnet 10.77.2.0/24 flux-outbound
docker volume inspect flux-antivirus-definitions >/dev/null 2>&1 || docker volume create flux-antivirus-definitions
docker ps --format '{{.ID}} {{.Names}}' > "$flux_root/receipts/containers-after.txt"
diff -u "$flux_root/receipts/containers-before.txt" "$flux_root/receipts/containers-after.txt"
df -h /mnt/flux-work-api /mnt/flux-work-worker /mnt/flux-work-scanner > "$flux_root/receipts/storage.txt"
echo 'Flux sandbox, dedicated network, and bounded scratch disks are ready. Existing containers were not restarted.'
