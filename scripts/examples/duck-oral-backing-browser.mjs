import {readFile,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {launch,serve,watch,local} from '../browser/harness.mjs';
const out=process.env.DUCK_ORAL_STUDY_DIR??'test-results/duck-oral-backing';
const {project}=JSON.parse(await readFile(`${out}/study.json`));
const server=await serve(),browser=await launch(),errors=[];
try {
 const context=await browser.newContext({viewport:{width:1440,height:1000},serviceWorkers:'block'});
 await context.route('https://static.fun.dev/**',local(server.base));const page=watch(await context.newPage(),errors,60000);
 await page.goto(`${server.base}/workshop/?renderer=webgl&lang=en`);await page.waitForFunction(()=>window.funEditor);
 const images=await page.evaluate(async project=>{
  funEditor.loadProject(project);const images=[];
  for(const [name,values] of [['neutral',{}],['half',{mouthClose:.5}],['open',{mouthOpen:1}],['closed',{mouthClose:1}]]) {
   const p=structuredClone(project);delete p.character.pose;p.character.values={...p.character.values,...values};
   const c=await funEditor.workflow({action:'prepare',project:p,views:[]});
   for(const view of ['front','left','perspective']) {
    const r=await funEditor.workflow({action:'inspect',candidateId:c.candidateId,
     ...(view==='front'?{render:{preset:'mouth'}}:{views:[view],size:768,render:{ids:['head','mouth_mount']}})});
    if(r.renderError)throw new Error(r.renderError.message);
    images.push({name:`${name}-${view}`,ok:c.ok,shot:r.observations[0]});
   }
  }return images;
 },project);
 assert.deepEqual(errors,[]);
 for(const {name,shot} of images)await writeFile(`${out}/${name}.png`,Buffer.from(shot.dataUrl.split(',')[1],'base64'));
 await writeFile(`${out}/browser.json`,JSON.stringify({errors,images:images.map(({shot:{dataUrl,...shot},...r})=>({...r,shot}))}));
 console.log(`Rendered 12 isolated oral study views in ${out}; no source acceptance.`);
}finally{await browser.close();await server.close();}
