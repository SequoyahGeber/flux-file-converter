// Render the repository's vector artwork with the standard macOS Dock inset.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const sharp = require('sharp');
const { execFileSync } = require('node:child_process');
async function main() {
  const resources = path.join(__dirname, '../resources');
  const svg = await fs.readFile(path.join(resources, 'icon.svg'));
  await sharp(svg).png().toFile(path.join(resources, 'icon.png'));
  if (process.platform !== 'darwin') return;
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'flux-icon-'));
  const iconset = path.join(temp, 'Flux.iconset');
  await fs.mkdir(iconset);
  try {
    for (const size of [16, 32, 128, 256, 512])
      for (const scale of [1, 2])
        await sharp(svg)
          .resize(size * scale, size * scale)
          .png()
          .toFile(path.join(iconset, `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`));
    execFileSync('/usr/bin/iconutil', [
      '-c',
      'icns',
      iconset,
      '-o',
      path.join(resources, 'icon.icns'),
    ]);
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
