# Flux server security

Uploaded files are treated as hostile. This deployment reduces the impact of parser exploits; it cannot promise zero vulnerabilities, zero code execution, or malware-free output. A dedicated Unraid VM offers another isolation boundary beyond gVisor.

## Access

Only `fileconverter.sequoyahgeber.com` is routed through an outbound Cloudflare Tunnel. No container publishes a server port. Cloudflare Access must allow individual invited email addresses and require MFA. The API independently verifies the Access token's RSA signature, issuer, application audience, expiry, identity and request host. An email header alone cannot authenticate. Writes also require the matching Origin and a custom request header.

There is no unauthenticated production mode, server path selector, Docker socket, host network, privileged mode, GPU device or mount of Unraid shares. An anonymous health endpoint returns only `ok`; Cloudflare still protects the external hostname.

## Isolation

The API, worker and antivirus scanner require gVisor's `runsc` runtime. Every service runs as non-root with all Linux capabilities dropped, a read-only image, `no-new-privileges`, bounded process counts and bounded logs. Missing gVisor prevents these services from starting.

Unraid's initial RAM filesystem needs a compatibility entrypoint: the trusted runtime creates a private mount namespace and bind-mounted root before invoking unmodified gVisor. This keeps gVisor's normal pivot-root and user-namespace isolation enabled. The Docker default runtime and other containers are unchanged.

The worker sees immutable conversion tools and its dedicated scratch filesystem. Uploaded code is never intentionally executed. Blender automatic scripts and LibreOffice macros are disabled. Pandoc uses `--sandbox`; ImageMagick delegates, executable coders and remote protocols are disabled. FFmpeg permits file/pipe protocols. Conversion children inherit a seccomp filter denying IP sockets, tracing, namespace creation, mounts and process daemonisation. Their process group is killed on completion, cancellation or timeout. No Cloudflare login tokens or tunnel credentials are sent to the worker.

A compromised parser can still corrupt its result or crash its own container. The sandbox, host kernel, conversion tools and client viewers all require security updates.

## Resource and storage bounds

The complete stack is capped at two CPU cores and under 6 GB container RAM: worker 1.5 CPUs / 2800 MiB, scanner 0.25 / 1900 MiB, API 0.15 / 512 MiB, definition updater 0.05 / 256 MiB, tunnel 0.05 / 128 MiB. Swap is disabled. These are ceilings, not reservations; verify running cgroups and Docker stats after installation.

One conversion/inspection runs at a time, at most eight jobs can queue, and conversions time out after ten minutes. Users are limited to 20 files, two active requests/jobs, six conversion submissions per minute and 30 per hour. Aggregate uploads/results are limited to 12 GB. Uploads use 16 MiB chunks to fit Cloudflare Free's per-request limit. Chunks cannot skip ahead, exceed declared size or overwrite another user's upload.

Scratch data is on dedicated bounded filesystems inside preallocated disk images: API 16 GiB, worker 24 GiB and scanner 8 GiB. Docker named volumes refer only to these filesystems, mounted `noexec,nosuid,nodev`. Uploaded data cannot fill the rest of the cache or Docker image. Preparing them reserves 48 GiB of cache space. Definitions use a separate Docker-managed volume. No Unraid data shares are mounted into the app.

Containers use bounded `on-failure` restarts. A boot entrypoint waits for cache and Docker, restores gVisor and mounts the scratch disks, then starts Flux. This avoids starting against empty mount directories before the array is available. Scanner database reloads block scanning rather than loading a second engine into memory; the definition updater skips the duplicate engine-loading test to stay inside its RAM cap. Database signature validation remains enabled.

Files/results belong to the signed-in token identity. Downloads cannot resolve arbitrary paths. Files expire after 30 minutes of inactivity and can be deleted immediately. Startup must purge previous Flux scratch directories. Download results before restarting/updating the API. The boot restoration script must mount scratch disks and restore gVisor before starting Flux; do not enable ordinary Unraid autostart for Flux without that prerequisite.

## Malware scanning and format limits

ClamAV scans inputs and outputs. Scanner outages/errors, encrypted containers, limit alerts and detections reject the file; scanning is never silently skipped. Definitions update from the official ClamAV mirror. Archive extraction also checks traversal, links, entry count and actual expanded bytes inside the sandbox. Expansion is capped at 1.9 GB / 2000 entries; PDFs at 100 pages and images at 40 million pixels. Engines can impose lower limits.

ClamAV's technical full-file limit is 2 GB. This app uses 1.9 GB for ordinary files. Audio/video can reach 5 GB, as selected by the owner. Larger media uses overlapping 64 MiB signature scans with 1 MiB overlap and sandboxed media inspection. **This does not fully analyze embedded containers and is not equivalent to a full-file scan.** Large non-media files/outputs are rejected. The UI identifies this limitation.

Downloads use `application/octet-stream`, attachment disposition, `nosniff` and a sandbox CSP. HTML/SVG never execute at this origin. Save names preserve output extensions. Chrome/Edge can stream to a user-selected local file; Safari follows its download-location preference. The app gains no arbitrary server/client folder access. Scanning is not sterilization: archives can preserve active content, and Office/PDF/image files can retain features interpreted by local viewers.

## Updates

Source: https://github.com/SequoyahGeber/flux-file-converter

GitHub Actions runs security tests, builds Linux images, rejects fixable critical vulnerability findings and tests real worker conversions before promotion to `stable`. Actions are pinned to commit hashes. Release images are signed with Sigstore and retain immutable `sha-<commit>` tags. Public GHCR images: `flux-api`, `flux-worker`, `flux-antivirus`. Unraid templates preserve isolation/resource settings when using the Docker tab's Update button. Update the Flux images together and keep the protocol compatible across releases.

Unraid's normal Update button checks/pulls image content; it does not independently enforce Cosign signatures. Signatures support separate verification/auditing. Protect GitHub/Cloudflare with MFA. Passing automated scans/tests is not a penetration test or proof that native parsers have no exploitable bugs.

## Primary references

- [Docker limits](https://docs.docker.com/engine/containers/resource_constraints/)
- [gVisor security](https://gvisor.dev/docs/architecture_guide/intro/) and [installation](https://gvisor.dev/docs/user_guide/install/)
- [Access JWT validation](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)
- [Cloudflare upload size](https://developers.cloudflare.com/network/maximum-upload-size/)
- [ClamAV limits](https://github.com/Cisco-Talos/clamav/blob/main/etc/clamd.conf.sample)
- [Unraid containers and updates](https://docs.unraid.net/unraid-os/using-unraid-to/run-docker-containers/managing-and-customizing-containers/)
