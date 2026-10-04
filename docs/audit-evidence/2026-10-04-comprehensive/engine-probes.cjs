const fs = require('node:fs/promises');
const path = require('node:path');
const root = process.env.FLUX_AUDIT_ROOT || '/tmp/flux-comprehensive-audit-20261004';
const {detectEngines, inspectFile, convert} = require(process.cwd() + '/electron/engine.cjs');
(async()=> {
const resources=path.resolve('resources'), engines=await detectEngines(resources), output=path.join(root,'engine-output');
for(const [name,target] of [['precise.json','csv'],['precise.json','yaml']]) {
 const file=await inspectFile(path.join(root,name),engines,resources);
 const result=await convert(file,target,output,{},engines,resources);
 console.log(name+' -> '+target+': SUCCESS\n'+await fs.readFile(result.path,'utf8'));
}
await fs.writeFile(path.join(root,'duplicate.csv'),'id,id\nfirst,second\n');
const dup=await inspectFile(path.join(root,'duplicate.csv'),engines,resources);
for (const target of ['json','parquet']) {try {
 const r=await convert(dup,target,output,{},engines,resources);
 console.log('Duplicate CSV -> '+target+': SUCCESS');
 if(target==='parquet') {
 const input=await inspectFile(r.path,engines,resources);
 const back=await convert(input,'json',output,{},engines,resources);
 console.log(await fs.readFile(back.path,'utf8'));
 }
} catch(e) {console.log('Duplicate CSV -> '+target+': ERROR '+e.message)}}
})();
