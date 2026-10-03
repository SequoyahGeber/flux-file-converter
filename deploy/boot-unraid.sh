#!/bin/bash
# This small entrypoint lives on /boot and waits for persistent cache storage.
set -euo pipefail
flux_root=/mnt/cache/appdata/flux-deployment
for attempt in $(seq 1 120); do
  if mountpoint -q /mnt/cache && [ -f "$flux_root/source/deploy/restore-unraid.sh" ] && docker info >/dev/null 2>&1; then
    bash "$flux_root/source/deploy/restore-unraid.sh"
    for name in api worker scanner; do mountpoint -q "/mnt/flux-work-$name" || exit 1; done
    for name in flux; do docker container inspect "$name" >/dev/null 2>&1 && docker start "$name"; done
    exit 0
  fi
  sleep 5
done
echo 'Flux remains stopped because its cache storage or Docker is unavailable.'
exit 1
