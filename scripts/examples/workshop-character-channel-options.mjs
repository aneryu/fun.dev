// Focused actual-DOM check; no duck mutation or additional render acceptance.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {createStore,emptyProject} from '../../site/workshop/document.js';
import {launch,serve,watch,local} from '../browser/harness.mjs';
const store=createStore(emptyProject());
store.apply([{op:'create',id:'head',kind:'box'},
 {op:'characterControl',id:'global',bindings:[{node:'head',channel:'rotation',delta:[0,10,0]}]},
 ...['frame','position','deform'].flatMap(mode=>[
  {op:'create',id:`part_${mode}`,kind:'box',options:{size:[.1,.1,.1]},position:[0,0,.6]},
  {op:'attachSurface',id:`part_${mode}`,targetId:'head',mode}
 ])]);
const out='test-results/workshop-character-channel-options';await mkdir(out,{recursive:true});
const server=await serve(),browser=await launch(),errors=[];
try {
 const context=await browser.newContext({viewport:{width:1440,height:900},serviceWorkers:'block'});
 await context.route('https://static.fun.dev/**',local(server.base));
 const page=watch(await context.newPage(),errors,60000);
 // Verify current source without changing a production build owned by another check.
 for(const file of ['character-panel.js','character.js'])await page.route(`**/workshop/${file}`,async route=>
  route.fulfill({contentType:'text/javascript',body:await readFile(`site/workshop/${file}`,'utf8')}));
 await page.goto(`${server.base}/workshop/?renderer=webgl&lang=en`);
 await page.waitForFunction(()=>window.funEditor);
 await page.evaluate(project=>funEditor.loadProject(project),store.snapshot());
 const options={};
 for(const id of ['head','part_frame','part_position','part_deform']){
  options[id]=await page.evaluate(id=>{funEditor.select(id);return Array.from(
   document.querySelector('#character-tools [data-field="track"]').options,o=>o.textContent);},id);
 }
 assert.deepEqual(options.part_frame,['global']);
 assert.deepEqual(options.part_deform,['global']);
 assert.equal(options.part_position.length,3);
 assert.ok(options.part_position.some(v=>v==='part_position · Rotation (degrees)'));
 assert.ok(options.part_position.some(v=>v==='part_position · Scale'));
 assert.equal(options.head.length,4);
 assert.deepEqual(errors,[]);
 await writeFile(`${out}/result.json`,JSON.stringify({options,errors},null,2));
 console.log('Actual character track options respect frame, position and deform attachment ownership.');
}finally{await browser.close();await server.close();}
