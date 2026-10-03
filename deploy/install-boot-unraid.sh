#!/bin/bash
set -euo pipefail
flux_root=/mnt/cache/appdata/flux-deployment
test -f /boot/config/go
mkdir -p /boot/config/flux
cp "$flux_root/source/deploy/boot-unraid.sh" /boot/config/flux/boot.sh
if ! grep -q '/boot/config/flux/boot.sh' /boot/config/go; then
  cp -p /boot/config/go "$flux_root/receipts/go-before"
  cat >> /boot/config/go <<'BOOT'

# Flux: restore its isolated runtime and bounded scratch disks before starting.
(bash /boot/config/flux/boot.sh >> /var/log/flux-boot.log 2>&1) &
BOOT
fi
echo 'Flux boot restoration installed; existing boot commands were preserved.'
