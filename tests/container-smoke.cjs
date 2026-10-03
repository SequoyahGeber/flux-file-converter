const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const sharp = require('sharp');
const { rpc } = require('../server/transport.cjs');
async function main() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(),'flux-container-test-'));
  const config = { worker: process.env.WORKER_URL || 'http://127.0.0.1:8090', secret: process.env.WORKER_SECRET };
  try {
    const image = path.join(dir,'sample.png'); await sharp({create:{width:40,height:30,channels:4,background:'#9474c8'}}).png().toFile(image);
    const file = { path:image,name:'sample.png',size:(await fs.stat(image)).size };
    const info = await rpc({operation:'inspect'},[file],null,config); assert.equal(info.family,'image'); assert.ok(info.targets.includes('jpg'));
    const output = path.join(dir,'result.jpg'); const result = await rpc({operation:'convert',target:'jpg'},[file],output,config); assert.equal(result.target,'jpg'); assert.equal((await sharp(output).metadata()).width,40);
    const csv = path.join(dir,'sheet.csv'); await fs.writeFile(csv,'name,amount\ncoffee,400\n'); const sheet = {path:csv,name:'sheet.csv',size:(await fs.stat(csv)).size};
    const sheetOut = path.join(dir,'sheet.xlsx'); await rpc({operation:'convert',target:'xlsx'},[sheet],sheetOut,config); assert.equal((await fs.readFile(sheetOut)).subarray(0,2).toString(),'PK');
    const doc = path.join(dir,'note.md'); await fs.writeFile(doc,'# Hello\n\nA converted document.'); const document = {path:doc,name:'note.md',size:(await fs.stat(doc)).size};
    const pdf = path.join(dir,'note.pdf'); await rpc({operation:'convert',target:'pdf'},[document],pdf,config); assert.equal((await fs.readFile(pdf)).subarray(0,4).toString(),'%PDF');
    const text = path.join(dir,'note.txt'); await rpc({operation:'convert',target:'txt'},[{path:pdf,name:'note.pdf',size:(await fs.stat(pdf)).size}],text,config); assert.match(await fs.readFile(text,'utf8'),/Hello/);
    const zip = path.join(dir,'bundle.zip'); await rpc({operation:'pack'},[file,document],zip,config); assert.equal((await fs.readFile(zip)).subarray(0,2).toString(),'PK');
    const opt = path.join(dir,'small.webp'); await rpc({operation:'compress',compression:'lossy'},[file],opt,config); assert.equal((await sharp(opt).metadata()).format,'webp');
    console.log('Passed Linux worker image, document, PDF, spreadsheet, ZIP and compression conversions.');
  } finally { await fs.rm(dir,{recursive:true,force:true}); }
}
main().catch(e=>{console.error(e);process.exit(1)});
