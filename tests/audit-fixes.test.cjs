const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { parseJSON, parseYAML } = require('../electron/data-policy.cjs');
const YAML = require('yaml');
const { structured, detectEngines, inspectFile, convert, run } = require('../electron/engine.cjs');

test('numeric tokens preserve their decimal value or explicitly reject before publication', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flux-precision-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const input = path.join(root, 'input.json'),
    out = path.join(root, 'out.csv');
  for (const token of [
    '9007199254740993',
    '1000000000000000128',
    '-9007199254740993',
    '0.1234567890123456789',
    '1e-400',
    '1e400',
    '-0',
    '0.10000000000000001',
  ]) {
    await fs.writeFile(input, `[{"number":${token}}]`);
    for (const target of ['csv', 'yaml', 'json'])
      await assert.rejects(structured({ path: input, ext: 'json' }, target, out), /precision/);
    await assert.rejects(fs.stat(out), { code: 'ENOENT' });
  }
  assert.deepEqual(
    parseJSON('[0.1,1.2300e-3,9007199254740992,1e100,-12.5]'),
    [0.1, 0.00123, 9007199254740992, 1e100, -12.5],
  );
  assert.deepEqual(parseYAML('a: 0.1\nb: .5\nc: 0x10\nd: 9007199254740992\n', YAML), {
    a: 0.1,
    b: 0.5,
    c: 16,
    d: 9007199254740992,
  });
  for (const token of [
    '9007199254740993',
    '1000000000000000128',
    '0.1234567890123456789',
    '.inf',
    '.nan',
  ])
    assert.throws(() => parseYAML('value: ' + token, YAML), /precision/);
  await fs.writeFile(
    input,
    '[{"number":"9007199254740993","decimal":"0.1234567890123456789","name":"日本語"}]',
  );
  await structured({ path: input, ext: 'json' }, 'csv', out);
  assert.match(await fs.readFile(out, 'utf8'), /9007199254740993,0\.1234567890123456789,日本語/);
});

test('advanced adapters enforce headers, precision and bounds independently of JavaScript', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flux-table-policy-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const resources = path.resolve('resources'),
    engines = await detectEngines(resources);
  const input = path.join(root, 'input.csv'),
    output = path.join(root, 'out');
  for (const text of [
    'id,id\nfirst,second\n',
    ',id\nfirst,second\n',
    '__proto__,id\nfirst,second\n',
  ]) {
    await fs.writeFile(input, text);
    const file = await inspectFile(input, engines, resources);
    for (const target of ['parquet', 'feather', 'ndjson']) {
      await assert.rejects(
        convert(file, target, output, {}, engines, resources),
        /headers|reserved/,
      );
      const direct = path.join(root, 'direct.' + target);
      await assert.rejects(
        run(engines.python, [path.join(resources, 'advanced.py'), 'table', input, target, direct]),
        /headers|reserved/,
      );
      await assert.rejects(fs.stat(direct), { code: 'ENOENT' });
    }
  }
  const json = path.join(root, 'precise.json');
  for (const text of ['[{"id":9007199254740993}]', '[{"amount":0.1234567890123456789}]']) {
    await fs.writeFile(json, text);
    await assert.rejects(
      run(engines.python, [
        path.join(resources, 'advanced.py'),
        'table',
        json,
        'ndjson',
        path.join(root, 'bad.ndjson'),
      ]),
      /precision/,
    );
    await assert.rejects(
      convert(
        await inspectFile(json, engines, resources),
        'parquet',
        output,
        {},
        engines,
        resources,
      ),
      /precision/,
    );
  }
  await fs.writeFile(input, 'id\n' + 'value\n'.repeat(100001));
  await assert.rejects(
    run(engines.python, [
      path.join(resources, 'advanced.py'),
      'table',
      input,
      'parquet',
      path.join(root, 'big.parquet'),
    ]),
    /100,000 rows/,
  );
  const oversized = path.join(root, 'oversized.csv');
  const handle = await fs.open(oversized, 'w');
  await handle.truncate(50 * 1024 * 1024 + 1);
  await handle.close();
  await assert.rejects(
    convert(
      await inspectFile(oversized, engines, resources),
      'ndjson',
      output,
      {},
      engines,
      resources,
    ),
    /50 MB/,
  );
});

test('advanced JSON output retains decimals, integer/null columns, booleans and Unicode', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flux-table-values-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const resources = path.resolve('resources'),
    engines = await detectEngines(resources);
  const input = path.join(root, 'values.json'),
    output = path.join(root, 'out');
  const records = [
    { id: 9007199254740992, amount: 0.12345678912345678, flag: true, name: '日本語' },
    { id: null, amount: null, flag: false, name: 'quoted identifier' },
  ];
  await fs.writeFile(input, JSON.stringify(records));
  for (const target of ['parquet', 'feather', 'ndjson']) {
    const packed = await convert(
      await inspectFile(input, engines, resources),
      target,
      output,
      {},
      engines,
      resources,
    );
    const back = await convert(
      await inspectFile(packed.path, engines, resources),
      'json',
      output,
      {},
      engines,
      resources,
    );
    const text = await fs.readFile(back.path, 'utf8');
    assert.deepEqual(parseJSON(text), records);
    assert.match(text, /9007199254740992/);
    assert.match(text, /0\.12345678912345678/);
  }
});
