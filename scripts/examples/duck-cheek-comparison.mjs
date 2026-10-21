// Reuse captured, provenance-checked observations; no new camera fitting.
import {readFile,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {launch} from '../browser/harness.mjs';
const out='test-results/duck-cheeks',before='test-results/duck-rim-repair';
const a=JSON.parse(await readFile(`${before}/browser.json`)),b=JSON.parse(await readFile(`${out}/browser.json`));
const pairs=[];
for(const view of ['front','left','perspective']) {
 const old=a.images.find(i=>i.name===`pose-half-closed-${view}`),next=b.images.find(i=>i.name===`half-${view}`).shot;
 assert.deepEqual(old.camera,next.camera);assert.deepEqual(old.quality,next.quality);
 pairs.push({view,images:await Promise.all([`${before}/pose-half-closed-${view}.png`,`${out}/half-${view}.png`]
  .map(async path=>'data:image/png;base64,'+(await readFile(path)).toString('base64')))});
}
const browser=await launch();
try {
 const page=await browser.newPage();
 for(const {view,images} of pairs) {
  const png=await page.evaluate(async images=>{
   const pair=await Promise.all(images.map(async src=>{const img=new Image();img.src=src;await img.decode();return img;}));
   const canvas=document.createElement('canvas');canvas.width=pair[0].width+pair[1].width;canvas.height=pair[0].height;
   const context=canvas.getContext('2d');context.drawImage(pair[0],0,0);context.drawImage(pair[1],pair[0].width,0);return canvas.toDataURL('image/png');
  },images);
  await writeFile(`${out}/comparison-half-${view}.png`,Buffer.from(png.split(',')[1],'base64'));
 }
 console.log('Three fixed-camera half-close comparisons: before left, after right.');
}finally{await browser.close();}
