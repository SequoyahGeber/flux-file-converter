#!/bin/bash
# One Flux container. Trusted startup drops privileges before accepting files.
set -euo pipefail
flux_root=/mnt/cache/appdata/flux-deployment
source "$flux_root/config.env"
[[ "$WORKER_SECRET" =~ ^[a-f0-9]{64}$ ]] && [[ "$ACCESS_AUD" =~ ^[a-f0-9]{64}$ ]] && [[ "$TUNNEL_TOKEN" =~ ^[a-zA-Z0-9_=.-]+$ ]] || exit 1
for name in api worker scanner; do mountpoint -q "/mnt/flux-work-$name" || { echo 'Scratch disks are not mounted'; exit 1; }; done
# Pull and verify the signed release; the container runs that digest, never the mutable tag.
flux_image=$(bash "$flux_root/source/deploy/verify-image.sh")
if docker container inspect flux >/dev/null 2>&1 && [ "$(docker container inspect --format '{{.Image}}' flux)" != "$(docker image inspect --format '{{.Id}}' "$flux_image")" ]; then
  echo 'Replacing Flux with the verified release; download results first.'
  docker stop flux >/dev/null
  docker rm flux >/dev/null
fi
if ! docker container inspect flux >/dev/null 2>&1; then
  docker create --name flux --runtime=runsc --network=flux-outbound --add-host=flux-api:127.0.0.1 --user=0:0 --read-only --cap-drop=ALL --cap-add=CHOWN --cap-add=SETUID --cap-add=SETGID --cap-add=SETPCAP --security-opt=no-new-privileges --restart=on-failure --cpus=2 --memory=5700m --memory-swap=5700m --pids-limit=256 --tmpfs /tmp:rw,noexec,nosuid,nodev,size=192m,mode=1777 --log-opt max-size=5m --log-opt max-file=2 --mount type=volume,source=flux-api-work,target=/work/api --mount type=volume,source=flux-worker-work,target=/work/worker --mount type=volume,source=flux-scanner-work,target=/work/scanner --mount type=volume,source=flux-antivirus-definitions,target=/var/lib/clamav --env-file "$flux_root/config.env" --label net.unraid.docker.managed=dockerman --label net.unraid.docker.icon=https://raw.githubusercontent.com/SequoyahGeber/flux-file-converter/main/resources/icon.png --label net.unraid.docker.webui=https://fileconverter.sequoyahgeber.com "$flux_image"
fi
docker start flux
