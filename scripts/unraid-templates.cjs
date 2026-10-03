const fs = require('node:fs/promises');
const path = require('node:path');
const definitions = [
  {
    name: 'flux',
    image: 'ghcr.io/sequoyahgeber/flux-api:stable',
    network: 'flux-outbound',
    cpu: 2,
    mem: '5700m',
    pids: 256,
    user: '0:0',
    args: '--runtime=runsc --cap-add=CHOWN --cap-add=SETUID --cap-add=SETGID --cap-add=SETPCAP --add-host=flux-api:127.0.0.1 --mount type=volume,source=flux-api-work,target=/work/api --mount type=volume,source=flux-worker-work,target=/work/worker --mount type=volume,source=flux-scanner-work,target=/work/scanner --mount type=volume,source=flux-antivirus-definitions,target=/var/lib/clamav',
    env: {
      FLUX_OWNER_EMAIL: '__OWNER_EMAIL__',
      ACCESS_ISSUER: '__ACCESS_ISSUER__',
      ACCESS_AUD: '__ACCESS_AUD__',
      WORKER_SECRET: '__WORKER_SECRET__',
      TUNNEL_TOKEN: '__TUNNEL_TOKEN__',
    },
  },
];
const xml = (x) =>
  String(x).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c],
  );
async function main() {
  const dir = path.join(__dirname, '../deploy/templates');
  await fs.mkdir(dir, { recursive: true });
  for (const d of definitions) {
    const args = `--user=${d.user || '10001:10001'} --restart=on-failure:3 --read-only --cap-drop=ALL --security-opt=no-new-privileges --cpus=${d.cpu} --memory=${d.mem} --memory-swap=${d.mem} --pids-limit=${d.pids} --tmpfs /tmp:rw,noexec,nosuid,nodev,size=192m,mode=1777 --log-opt max-size=5m --log-opt max-file=2 ${d.args}`;
    await fs.writeFile(
      path.join(dir, 'my-' + d.name + '.xml'),
      `<?xml version="1.0"?>\n<Container version="2"><Name>${d.name}</Name><Repository>${d.image}</Repository><Registry>https://github.com/SequoyahGeber/flux-file-converter/pkgs/container/flux-api</Registry><Network>${d.network}</Network><MyIP>${d.ip || ''}</MyIP><Privileged>false</Privileged><Shell>sh</Shell><Project>https://github.com/SequoyahGeber/flux-file-converter</Project><Support>https://github.com/SequoyahGeber/flux-file-converter/issues</Support><WebUI>https://fileconverter.sequoyahgeber.com</WebUI><Icon>https://raw.githubusercontent.com/SequoyahGeber/flux-file-converter/main/resources/icon.png</Icon><ExtraParams>${xml(args)}</ExtraParams><PostArgs>${xml(d.post || '')}</PostArgs><Overview>Flux private file conversion. Resource limits and isolation must be preserved.</Overview>${Object.entries(
        d.env,
      )
        .map(
          ([k, v]) =>
            `<Config Name="${k}" Target="${k}" Default="" Mode="" Description="Flux configuration" Type="Variable" Display="always" Required="true" Mask="${/SECRET|TOKEN/.test(k) ? 'true' : 'false'}">${xml(v)}</Config>`,
        )
        .join('')}</Container>\n`,
    );
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
