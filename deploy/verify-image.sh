#!/bin/bash
# Pulls the stable Flux image and verifies its Sigstore signature from this repository's
# release workflow. Prints only the verified, immutable image@digest reference.
set -euo pipefail
flux_root=/mnt/cache/appdata/flux-deployment
image=ghcr.io/sequoyahgeber/flux-api
cosign="$flux_root/tools/cosign"
test -x "$cosign" || { echo 'Missing cosign; run prepare-unraid.sh first.' >&2; exit 1; }
# Use the digest reported by this pull, not whatever the mutable tag points to later.
digest=$(docker pull "$image:stable" | sed -n 's/^Digest: \(sha256:[a-f0-9]\{64\}\)$/\1/p')
if [ -z "$digest" ]; then
  digest=$(docker image inspect --format '{{json .RepoDigests}}' "$image:stable" | jq -r --arg image "$image" '[.[] | select(startswith($image + "@"))] | if length == 1 then .[0] | ltrimstr($image + "@") else empty end')
fi
[[ "$digest" =~ ^sha256:[a-f0-9]{64}$ ]] || { echo 'Cannot determine the pulled Flux image digest.' >&2; exit 1; }
# Keyless signature: only this repository's containers.yml workflow, via GitHub's OIDC issuer, is accepted.
"$cosign" verify \
  --certificate-identity-regexp '^https://github.com/SequoyahGeber/flux-file-converter/.github/workflows/containers.yml@' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  "$image@$digest" >/dev/null || { echo 'Flux image signature verification failed; nothing was changed.' >&2; exit 1; }
echo "$image@$digest"
