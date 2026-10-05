const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const sharp = require('sharp');
const { rpc } = require('../server/transport.cjs');
const { PDFDocument } = require('pdf-lib');
async function main() {
  if (process.env.FLUX_VERIFY_PRIVILEGES === '1') {
    assert.equal(process.getuid(), 10001);
    const status = await fs.readFile('/proc/self/status', 'utf8');
    for (const field of ['CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb'])
      assert.match(status, new RegExp(field + ':\\s+0+\\b'));
    await assert.rejects(fs.readdir('/work/worker'), { code: 'EACCES' });
    let found = false;
    for (const pid of (await fs.readdir('/proc')).filter((p) => /^\d+$/.test(p))) {
      try {
        const workerStatus = await fs.readFile('/proc/' + pid + '/status', 'utf8');
        if (!/^Uid:\s+10002\s/m.test(workerStatus)) continue;
        found = true;
        for (const field of ['CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb'])
          assert.match(workerStatus, new RegExp(field + ':\\s+0+\\b'));
        await assert.rejects(fs.readFile('/proc/' + pid + '/environ'), { code: 'EACCES' });
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }
    }
    assert.ok(found, 'The worker runs under its separate UID');
    console.log(
      'Passed non-root UID, zero capability sets and private worker directory/environment checks.',
    );
  }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'flux-container-test-'));
  const config = {
    worker: process.env.WORKER_URL || 'http://127.0.0.1:8090',
    secret: process.env.WORKER_SECRET,
  };
  try {
    const image = path.join(dir, 'sample.png');
    await sharp({ create: { width: 40, height: 30, channels: 4, background: '#9474c8' } })
      .png()
      .toFile(image);
    const file = { path: image, name: 'sample.png', size: (await fs.stat(image)).size };
    const info = await rpc({ operation: 'inspect' }, [file], null, config);
    assert.equal(info.family, 'image');
    assert.ok(info.targets.includes('jpg'));
    const output = path.join(dir, 'result.jpg');
    const result = await rpc({ operation: 'convert', target: 'jpg' }, [file], output, config);
    assert.equal(result.target, 'jpg');
    assert.equal((await sharp(output).metadata()).width, 40);
    const csv = path.join(dir, 'sheet.csv');
    await fs.writeFile(csv, 'name,amount\ncoffee,400\n');
    const sheet = { path: csv, name: 'sheet.csv', size: (await fs.stat(csv)).size };
    const sheetOut = path.join(dir, 'sheet.xlsx');
    await rpc({ operation: 'convert', target: 'xlsx' }, [sheet], sheetOut, config);
    assert.equal((await fs.readFile(sheetOut)).subarray(0, 2).toString(), 'PK');
    const doc = path.join(dir, 'note.md');
    await fs.writeFile(doc, '# Hello\n\nA converted document.');
    const document = { path: doc, name: 'note.md', size: (await fs.stat(doc)).size };
    const slides = path.join(dir, 'slides.pptx');
    await fs.copyFile(path.join(__dirname, 'fixtures/powerpoint-regression.pptx'), slides);
    const presentation = { path: slides, name: 'slides.pptx', size: (await fs.stat(slides)).size };
    const slidesPDF = path.join(dir, 'slides.pdf');
    await rpc({ operation: 'convert', target: 'pdf' }, [presentation], slidesPDF, config);
    assert.ok((await PDFDocument.load(await fs.readFile(slidesPDF))).getPageCount() > 0);
    // Allow the launcher to reap completed Office helpers before the next job.
    await new Promise((resolve) => setTimeout(resolve, 2200));
    await rpc({ operation: 'convert', target: 'pdf' }, [presentation], slidesPDF, config);
    const pdf = path.join(dir, 'note.pdf');
    await rpc({ operation: 'convert', target: 'pdf' }, [document], pdf, config);
    assert.equal((await fs.readFile(pdf)).subarray(0, 4).toString(), '%PDF');
    const text = path.join(dir, 'note.txt');
    await rpc(
      { operation: 'convert', target: 'txt' },
      [{ path: pdf, name: 'note.pdf', size: (await fs.stat(pdf)).size }],
      text,
      config,
    );
    assert.match(await fs.readFile(text, 'utf8'), /Hello/);
    const zip = path.join(dir, 'bundle.zip');
    await rpc({ operation: 'pack' }, [file, document], zip, config);
    assert.equal((await fs.readFile(zip)).subarray(0, 2).toString(), 'PK');
    const opt = path.join(dir, 'small.webp');
    await rpc({ operation: 'compress', compression: 'lossy' }, [file], opt, config);
    assert.equal((await sharp(opt).metadata()).format, 'webp');
    console.log(
      'Passed Linux worker image, document, repeated PowerPoint, PDF, spreadsheet, ZIP and compression conversions.',
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
