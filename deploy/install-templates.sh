#!/bin/bash
set -euo pipefail
flux_root=/mnt/cache/appdata/flux-deployment
source "$flux_root/config.env"
[[ "$WORKER_SECRET" =~ ^[a-f0-9]{64}$ ]] && [[ "$ACCESS_AUD" =~ ^[a-f0-9]{64}$ ]] && [[ "$ACCESS_ISSUER" =~ ^https://[a-z0-9-]+\.cloudflareaccess\.com$ ]] && [[ "$TUNNEL_TOKEN" =~ ^[a-zA-Z0-9_=.-]+$ ]] || { echo 'Invalid Flux configuration'; exit 1; }
for template in "$flux_root/source/deploy/templates/my-flux.xml"; do
  destination="/boot/config/plugins/dockerMan/templates-user/$(basename "$template")"
  if [ -f "$destination" ]; then cp -p "$destination" "$flux_root/receipts/$(basename "$template").backup"; fi
  sed -e "s|__WORKER_SECRET__|$WORKER_SECRET|g" -e "s|__ACCESS_AUD__|$ACCESS_AUD|g" -e "s|__ACCESS_ISSUER__|$ACCESS_ISSUER|g" -e "s|__TUNNEL_TOKEN__|$TUNNEL_TOKEN|g" "$template" > "$destination"
  chmod 0600 "$destination"
done
echo 'Flux templates installed. Unraid’s Update button will pull the stable images.'
