const {createRequire}=require('node:module');
const req=createRequire(process.cwd()+'/package.json');
const {chromium,_electron}=req('playwright');
const fs=req('node:fs/promises'),os=req('node:os'),path=req('node:path');
const {createApp}=req('./server/app.cjs');
(async()=> {
const root=process.env.FLUX_AUDIT_ROOT || '/tmp/flux-comprehensive-audit-20261004', storage=await fs.mkdtemp(path.join(os.tmpdir(),'flux-batch-audit-'));
const app=await createApp({storage},{auth:async()=>({id:'c'.repeat(64),email:'audit@example.com'}),scan:async()=>'full',capabilities:{formats:[],families:[]},rpc:async(spec,files,out)=>{
 if(spec.operation==='inspect')return {family:'image',ext:'png',size:files[0].size,targets:['jpg','png'],notes:{jpg:'JPEG loses quality and transparency.',png:'PNG preserves pixels.'}};
 await fs.writeFile(out,'synthetic conversion');return {name:'result.jpg',target:'jpg',size:20,completedAt:Date.now()};
}});
await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
const base='http://127.0.0.1:'+app.server.address().port, browser=await chromium.launch({headless:true});
try {
 const page=await browser.newPage();await page.goto(base);await page.getByText('audit@example.com').waitFor();
 await page.locator('#files').setInputFiles(Array.from({length:8},(_,i)=>({name:'file-'+i+'.png',mimeType:'image/png',buffer:Buffer.from('fixture-'+i)})));
 await page.waitForFunction(()=>document.querySelector('#count').textContent.startsWith('8 files'));
 await page.waitForFunction(()=>!document.querySelector('#run').disabled);
 console.log('Eight-file upload succeeded.');
 await page.locator('#rows select').first().selectOption('png');
 console.log('Warning after PNG selection: '+await page.locator('#rows .note').first().innerText());
 await page.getByRole('button',{name:'↘ Compress files',exact:true}).click();
 await page.getByRole('button',{name:'⇄ Convert files',exact:true}).click();
 console.log('Warning after rerender at PNG: '+await page.locator('#rows .note').first().innerText());
 await page.locator('#rows select').first().selectOption('jpg');
 console.log('Warning after lossy JPG selection: '+await page.locator('#rows .note').first().innerText());
 await page.locator('#run').click();await page.getByText('Too many requests. Please wait and try again.',{exact:true}).waitFor();
 const state=await (await page.request.get(base+'/api/status')).json();
 console.log('Eight-file conversion: '+state.jobs.filter(j=>j.operation==='convert'&&j.status==='done').length+' completed; '+state.jobs.filter(j=>j.operation==='convert').length+' accepted; '+await page.locator('#error').innerText());
 await page.screenshot({path:root+'/web-batch-limit.png',fullPage:true});
 console.log('Status live semantics: '+await page.locator('#status').evaluate(e=>({role:e.getAttribute('role'),live:e.getAttribute('aria-live')})).then(JSON.stringify));
 await page.setViewportSize({width:390,height:844}); await page.screenshot({path:root+'/web-mobile.png',fullPage:true});
 const bounds=await page.evaluate(()=>({client:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth}));console.log('Mobile width '+JSON.stringify(bounds));
}finally{await browser.close();await app.close();await fs.rm(storage,{recursive:true,force:true})}
const desktop=await _electron.launch({args:['.'],env:{...process.env,FLUX_TEST_DATA_DIR:root+'/desktop-probe-state'}});
try{
 const page=await desktop.firstWindow();await page.waitForSelector('h1');
 await page.getByRole('button',{name:/All formats/}).first().click();await page.getByPlaceholder('Search a format or category…').fill('png');
 const trigger=page.getByRole('button',{name:'PNG',exact:true});await trigger.focus();await page.keyboard.press('Enter');await page.getByLabel('Close format details').waitFor();
 console.log('Format dialog opening focus: '+await page.evaluate(()=>({active:document.activeElement?.getAttribute('aria-label')||document.activeElement?.textContent,inside:!!document.activeElement?.closest('.format-modal'),dialogRole:document.querySelector('.format-modal').getAttribute('role')})).then(JSON.stringify));
 const focused=[];
 for(let i=0;i<5;i++){await page.keyboard.press('Tab');focused.push(await page.evaluate(()=>({text:document.activeElement?.getAttribute('aria-label')||document.activeElement?.textContent,inside:!!document.activeElement?.closest('.format-modal')})))}
 console.log('Format dialog tab focus: '+JSON.stringify(focused));
 await page.screenshot({path:root+'/desktop-modal.png'});
 await page.keyboard.press('Escape');console.log('Close focus: '+await page.evaluate(()=>({active:document.activeElement?.tagName,text:document.activeElement?.textContent})).then(JSON.stringify));
}finally{await desktop.close()}
})();
