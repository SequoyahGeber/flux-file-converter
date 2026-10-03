#!/bin/bash
# Called after cache becomes available at boot, before Flux containers start.
set -euo pipefail
flux_root=/mnt/cache/appdata/flux-deployment
test -f "$flux_root/gvisor/runsc"
cp -a "$flux_root/gvisor/runsc" "$flux_root/gvisor/gvisor-bin" /usr/local/bin/
/usr/local/bin/runsc install --runtime=runsc
if [ -f /var/run/dockerd.pid ]; then kill -HUP "$(cat /var/run/dockerd.pid)"; fi
for name in api worker scanner; do
  mkdir -p "/mnt/flux-work-$name"
  mountpoint -q "/mnt/flux-work-$name" || mount -o loop,noexec,nosuid,nodev "$flux_root/storage/$name.img" "/mnt/flux-work-$name"
done
echo 'Flux runtime and bounded volumes restored.'
