#!/bin/bash
# Called after cache becomes available at boot, before Flux containers start.
set -euo pipefail
flux_root=/mnt/cache/appdata/flux-deployment
test -f "$flux_root/gvisor/runsc"
# Keep unchanged, running binaries in place. Replace changed binaries atomically
# so restoring prerequisites is safe while the existing container is running.
if ! cmp -s "$flux_root/gvisor/runsc" /usr/local/bin/runsc; then
  install -m 0755 "$flux_root/gvisor/runsc" /usr/local/bin/.runsc.flux-new
  mv -f /usr/local/bin/.runsc.flux-new /usr/local/bin/runsc
fi
mkdir -p /usr/local/bin/gvisor-bin
for flux_binary in "$flux_root/gvisor/gvisor-bin/"*; do
  test -f "$flux_binary"
  flux_name=$(basename "$flux_binary")
  if ! cmp -s "$flux_binary" "/usr/local/bin/gvisor-bin/$flux_name"; then
    install -m 0755 "$flux_binary" "/usr/local/bin/gvisor-bin/.$flux_name.flux-new"
    mv -f "/usr/local/bin/gvisor-bin/.$flux_name.flux-new" "/usr/local/bin/gvisor-bin/$flux_name"
  fi
done
/usr/local/bin/runsc install --runtime=runsc
cp "$flux_root/source/deploy/runsc-unraid" /usr/local/bin/runsc-unraid
chmod 0755 /usr/local/bin/runsc-unraid
jq '.runtimes.runsc.path="/usr/local/bin/runsc-unraid"' /etc/docker/daemon.json > /etc/docker/daemon.json.flux
mv /etc/docker/daemon.json.flux /etc/docker/daemon.json
if [ -f /var/run/dockerd.pid ]; then kill -HUP "$(cat /var/run/dockerd.pid)"; fi
for name in api worker scanner; do
  mkdir -p "/mnt/flux-work-$name"
  mountpoint -q "/mnt/flux-work-$name" || mount -o loop,noexec,nosuid,nodev "$flux_root/storage/$name.img" "/mnt/flux-work-$name"
done
echo 'Flux runtime and bounded volumes restored.'
