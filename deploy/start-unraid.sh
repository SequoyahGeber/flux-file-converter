#!/bin/bash
# Create only Flux's containers; never publish ports or bind Unraid shares.
set -euo pipefail
flux_root=/mnt/cache/appdata/flux-deployment
source "$flux_root/config.env"
[[ "$WORKER_SECRET" =~ ^[a-f0-9]{64}$ ]] && [[ "$ACCESS_AUD" =~ ^[a-f0-9]{64}$ ]] && [[ "$TUNNEL_TOKEN" =~ ^[a-zA-Z0-9_=.-]+$ ]] || exit 1
for name in api worker scanner; do mountpoint -q "/mnt/flux-work-$name" || { echo 'Scratch disks are not mounted'; exit 1; }; done
umask 077
printf 'WORKER_SECRET=%s\n' "$WORKER_SECRET" > "$flux_root/worker.env"
printf 'WORKER_SECRET=%s\nACCESS_AUD=%s\nACCESS_ISSUER=%s\nPUBLIC_ORIGIN=https://fileconverter.sequoyahgeber.com\nWORKER_URL=http://flux-worker:8090\nCLAMAV_HOST=flux-scanner\n' "$WORKER_SECRET" "$ACCESS_AUD" "$ACCESS_ISSUER" > "$flux_root/api.env"
printf 'TUNNEL_TOKEN=%s\n' "$TUNNEL_TOKEN" > "$flux_root/tunnel.env"
common=(--read-only --cap-drop=ALL --security-opt=no-new-privileges --restart=on-failure:3 --log-opt max-size=5m --log-opt max-file=2 --label net.unraid.docker.managed=dockerman --label net.unraid.docker.icon=https://raw.githubusercontent.com/SequoyahGeber/flux-file-converter/main/resources/icon.png)
create() {
  local name=$1 cpu=$2 memory=$3 pids=$4 tmp=$5 user=$6; shift 6
  if ! docker container inspect "$name" >/dev/null 2>&1; then
    docker create --name "$name" "${common[@]}" --user="$user:$user" --cpus="$cpu" --memory="$memory" --memory-swap="$memory" --pids-limit="$pids" --tmpfs "/tmp:rw,noexec,nosuid,nodev,size=$tmp,uid=$user,gid=$user,mode=0700" "$@"
  fi
}
create flux-definitions 0.05 256m 16 32m 10001 --network=flux-outbound --mount type=volume,source=flux-antivirus-definitions,target=/var/lib/clamav ghcr.io/sequoyahgeber/flux-antivirus:stable freshclam --daemon --foreground=true --config-file=/etc/clamav/freshclam.conf
create flux-scanner 0.25 1900m 32 64m 10001 --runtime=runsc --network=name=flux-jobs,ip=10.77.0.11 --mount type=volume,source=flux-scanner-work,target=/work --mount type=volume,source=flux-antivirus-definitions,target=/var/lib/clamav,readonly ghcr.io/sequoyahgeber/flux-antivirus:stable
create flux-worker 1.5 2800m 192 128m 10001 --runtime=runsc --network=name=flux-jobs,ip=10.77.0.10 --mount type=volume,source=flux-worker-work,target=/work --env-file "$flux_root/worker.env" ghcr.io/sequoyahgeber/flux-worker:stable
create flux-api 0.15 512m 64 64m 10001 --runtime=runsc --network=name=flux-jobs,ip=10.77.0.12 --network=flux-edge --network=name=flux-outbound,gw-priority=1 --add-host=flux-worker:10.77.0.10 --add-host=flux-scanner:10.77.0.11 --mount type=volume,source=flux-api-work,target=/work --env-file "$flux_root/api.env" --label net.unraid.docker.webui=https://fileconverter.sequoyahgeber.com ghcr.io/sequoyahgeber/flux-api:stable
create flux-tunnel 0.05 128m 32 32m 65532 --network=flux-edge --network=flux-outbound --env-file "$flux_root/tunnel.env" cloudflare/cloudflared:latest tunnel --no-autoupdate run
docker start flux-definitions flux-worker
# Initial definitions may still be downloading. Start the scanner/API explicitly
# after they are ready; boot normally already has definitions from the last run.
if [ "${1:-}" = --activate ]; then docker start flux-scanner flux-api flux-tunnel; fi
