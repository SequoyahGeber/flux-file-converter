# Flux server security

Uploaded files are treated as hostile. This deployment reduces the impact of parser exploits; it cannot promise zero vulnerabilities, zero code execution, or malware-free output. A dedicated Unraid VM offers another isolation boundary beyond gVisor.

## Access

Only `fileconverter.sequoyahgeber.com` is routed through an outbound Cloudflare Tunnel. No container publishes a server port. Cloudflare Access requires verified login and MFA. In invitation mode its Flux policy admits authenticated identities to the landing page, and the API separately restricts conversion/upload/download endpoints to the configured owner and claimed members. Until invitation mode is activated, Access retains the owner-only email policy. The API independently verifies the Access token's RSA signature, issuer, application audience, expiry, identity and request host. An email header alone cannot authenticate. Writes also require the matching Origin and a custom request header.

There is no unauthenticated production mode, server path selector, Docker socket, host network, privileged mode, GPU device or mount of Unraid shares. An anonymous health endpoint returns only `ok`; Cloudflare still protects the external hostname.

An authenticated top-level GET navigation to the landing page is allowed after a cross-site login redirect, including an invitation query. It still requires the valid Access token and application host. Cross-site API reads/writes, embedded documents and subresources remain blocked; write requests also retain the exact Origin and custom-header checks.

Website logins are intended to last 30 days in the same browser. Set the Flux Access application session duration to **1 month**, and its Allow policy session duration to **Same as application** (or **1 month**). Set the Flux application/policy's independent MFA authentication duration to **1 month** as well, keeping MFA enabled. A shorter policy duration overrides the application setting. The API accepts tokens issued within the past 30 days and requires a signed, unexpired `exp` claim; a shorter Cloudflare token expiry still applies. Changing these dashboard settings does not extend tokens already issued, so an existing short session may require one more login. Signing out, clearing browser cookies, using a different browser, or revoking access can require an earlier login. See [Cloudflare session management](https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/session-management/) and [MFA configuration](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/mfa-requirements/). The 30-minute inactivity cleanup for uploads/results is independent of login duration.

Invitations are 256-bit random credentials, expire after 24 hours and can be claimed once by the first authenticated account. Only the configured owner can create/revoke links or revoke members. Atomic, serialized transactions prevent two accounts claiming one link. Only token hashes are persisted; URLs are removed from browser history after reading them. Membership metadata is stored in `access.json` on the private API volume and survives updates. Revocation blocks subsequent API requests and cancels queued/running jobs. The Cloudflare policy still requires MFA even for an invited account. New users enroll authenticators themselves through the App Launcher; enrollment does not grant conversion access. An unused bearer invite can be stolen or forwarded, so share it privately and revoke it if exposed.

## Isolation

Flux uses one container with gVisor's `runsc` runtime, a read-only image, `no-new-privileges`, bounded processes and logs. A small compiled startup program initially uses root with only CHOWN, SETUID, SETGID and SETPCAP. Before a service accepts files it drops every capability, its capability bounding set, supplementary groups and root. API, worker, scanner, updater, tunnel and supervisor run under distinct UIDs (10001 through 10006) with private scratch directories. The supervisor erases its initial credential environment and drops privileges after startup. Any service exit stops the complete container. Missing gVisor prevents startup. Docker health checks use the same privilege-dropping native program.

Unraid's initial RAM filesystem needs a compatibility entrypoint: the trusted runtime creates a private mount namespace and bind-mounted root before invoking unmodified gVisor. This keeps gVisor's normal pivot-root and user-namespace isolation enabled. The Docker default runtime and other containers are unchanged. Docker loopback DNS is unreachable from gVisor; the entrypoint writes public Cloudflare resolvers only to Docker-generated per-container resolver files. All API, worker and scanner listeners bind to loopback. The tunnel reaches the API through a loopback host alias. The container has outbound connectivity for the tunnel, JWT keys and antivirus updates; conversion children cannot create IP sockets. Combining services shares an outer sandbox and is weaker containment than separate containers, as selected by the owner.

The worker sees immutable conversion tools and can access its dedicated scratch filesystem. Separate UIDs and directory permissions block access to API uploads, scanner scratch and tunnel credentials. Uploaded code is never intentionally executed. Blender automatic scripts and LibreOffice macros are disabled. Pandoc uses `--sandbox`; ImageMagick delegates, executable coders and remote protocols are disabled. FFmpeg permits file/pipe protocols. Conversion children inherit a seccomp filter denying IP sockets, tracing, namespace creation, mounts and process daemonisation. Their process group is killed on completion, cancellation or timeout. No Cloudflare login tokens or tunnel credentials are sent to the worker.

A compromised parser can still corrupt its result or crash the app. The sandbox, host kernel, conversion tools and client viewers all require security updates.

## Resource and storage bounds

The single container is capped at two CPU cores and 5700 MiB (5,976,883,200 bytes), below 6 GB. These limits apply to all services and conversion children together. Swap is disabled. These are ceilings, not reservations; verify running cgroups and Docker stats after installation.

One conversion/inspection runs at a time, at most eight jobs can queue, and each running job has a ten-minute deadline shared by scanning and conversion. Users are limited to 20 files, two active requests/jobs, six conversion submissions per minute and 30 per hour. Aggregate uploads/results are limited to 12 GB. Uploads use 16 MiB chunks to fit Cloudflare Free's per-request limit. Chunks cannot skip ahead, exceed declared size or overwrite another user's upload.

Scratch data is on dedicated bounded filesystems inside preallocated disk images: API 16 GiB, worker 24 GiB and scanner 8 GiB. Docker named volumes refer only to these filesystems, mounted `noexec,nosuid,nodev`. Uploaded data cannot fill the rest of the cache or Docker image. Preparing them reserves 48 GiB of cache space. Definitions use a separate Docker-managed volume. No Unraid data shares are mounted into the app.

The container uses an unlimited `on-failure` restart policy: Docker restarts it after any service failure with increasing back-off instead of giving up after a fixed lifetime count (`on-failure:3` left Flux down after its fourth failure). Unlike `unless-stopped`, a cleanly stopped Flux is not started automatically when the Docker daemon starts, so the boot entrypoint below still controls start order. A boot entrypoint waits for cache and Docker, restores gVisor and mounts the scratch disks, then starts Flux. This avoids starting against empty mount directories before the array is available. Scanner database reloads block scanning rather than loading a second engine into memory; the definition updater skips the duplicate engine-loading test to stay inside the aggregate RAM cap. Database signature validation remains enabled.

Files/results belong to the signed-in token identity. Downloads cannot resolve arbitrary paths. Files expire after 30 minutes of inactivity and can be deleted immediately. Startup must purge previous Flux scratch directories. Download results before restarting/updating Flux. The boot restoration script must mount scratch disks and restore gVisor before starting Flux; do not enable ordinary Unraid autostart for Flux without that prerequisite.

## Malware scanning and format limits

ClamAV scans inputs and outputs. Scanner outages/errors, encrypted containers, limit alerts and detections reject the file; scanning is never silently skipped. Definitions update from the official ClamAV mirror. Archive extraction also checks traversal, links, entry count and actual expanded bytes inside the sandbox. Expansion is capped at 1.9 GB / 2000 entries; PDFs at 100 pages and images at 40 million pixels. Engines can impose lower limits.

ClamAV's technical full-file limit is 2 GB. This app uses 1.9 GB for ordinary files. Audio/video can reach 5 GB, as selected by the owner. Larger media uses overlapping 64 MiB signature scans with 1 MiB overlap and sandboxed media inspection. **This does not fully analyze embedded containers and is not equivalent to a full-file scan.** Large non-media files/outputs are rejected. The UI identifies this limitation.

Downloads use `application/octet-stream`, attachment disposition, `nosniff` and a sandbox CSP. HTML/SVG never execute at this origin. Save names preserve output extensions. Chrome/Edge can stream to a user-selected local file; Safari follows its download-location preference. The app gains no arbitrary server/client folder access. Scanning is not sterilization: archives can preserve active content, and Office/PDF/image files can retain features interpreted by local viewers.

## Updates

Source: https://github.com/SequoyahGeber/flux-file-converter

GitHub Actions runs security tests, builds the unified Linux image, rejects fixable critical vulnerability findings and tests real worker conversions before promotion to `stable`. Actions are pinned to commit hashes. Release images are signed with Sigstore (keyless, through GitHub's OIDC identity for this repository's `containers.yml` workflow) and retain immutable `sha-<commit>` tags. The public GHCR image is `ghcr.io/sequoyahgeber/flux-api:stable` (the existing package name is retained for anonymous updates). The Unraid `flux` template and `start-unraid.sh` carry the same isolation/resource settings. Older split-service images are historical and are not used by this deployment.

`prepare-unraid.sh` installs a pinned Cosign release (checked against an embedded SHA-256) and a pinned gVisor release (checked against an embedded SHA-512); neither checksum is fetched from the download origin. `start-unraid.sh` pulls `:stable`, verifies its signature with `verify-image.sh` and creates Flux from the verified digest rather than the mutable tag. A failed verification stops the script without changing the existing container. To update, download any results and run `start-unraid.sh` again; it replaces the container only when the verified digest differs.

Unraid's Docker-tab Update button (and adding Flux from the template) pulls `:stable` without verifying the Cosign signature. Do not use it for Flux updates; use `start-unraid.sh`. The `cloudflared` stage is pinned by version and digest; the Node/Debian base images follow their tags so they receive security updates and are covered by the vulnerability scan. Protect GitHub/Cloudflare with MFA. Passing automated scans/tests is not a penetration test or proof that native parsers have no exploitable bugs.

## Monitoring

Nothing inside Flux alerts when it is down. Add an external uptime check of `https://fileconverter.sequoyahgeber.com/health` that alerts unless it returns `ok`. Cloudflare Access answers unauthenticated requests itself, so a login redirect does not prove Flux is up: give the monitor an Access service token (a Service Auth policy limited to `/health`) rather than bypassing Access. On Unraid, enable notifications (Settings → Notifications) and check the Docker tab for an `unhealthy` or stopped `flux` container, which the health check reports but does not restart.

## Primary references

- [Docker limits](https://docs.docker.com/engine/containers/resource_constraints/)
- [gVisor security](https://gvisor.dev/docs/architecture_guide/intro/) and [installation](https://gvisor.dev/docs/user_guide/install/)
- [Access JWT validation](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)
- [Cloudflare upload size](https://developers.cloudflare.com/network/maximum-upload-size/)
- [ClamAV limits](https://github.com/Cisco-Talos/clamav/blob/main/etc/clamd.conf.sample)
- [Unraid containers and updates](https://docs.unraid.net/unraid-os/using-unraid-to/run-docker-containers/managing-and-customizing-containers/)
