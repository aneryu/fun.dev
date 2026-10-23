// A failed binary load must surface an error and allow a clean retry.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { launch, serve, running } from '../browser/harness.mjs';
const server=await serve(resolve('dist')),browser=await launch();
const context=await browser.newContext({serviceWorkers:'block',reducedMotion:'reduce'}),page=await context.newPage();
const report={date:new Date().toISOString(),status:'incomplete',expectedErrors:[]};
page.on('console',m=>{if(m.type()==='error')report.expectedErrors.push(m.text());});
try {
  await context.route('**/*.fun3d',route=>route.fulfill({status:200,contentType:'application/octet-stream',body:'corrupt fixture'}));
  await page.goto(`${server.base}/games/toy-a?lang=en`);await page.locator('#error-back').waitFor({state:'visible'});
  report.corruptResource='pass';await page.screenshot({path:resolve('test-results/workshop-toolchain/loading-error.png')});
  await context.unroute('**/*.fun3d');await page.reload();await running(page);
  assert.equal(await page.locator('#error-back').isHidden(),true);report.recovery='pass';report.status='pass';
}finally{await context.close();await browser.close();server.close();await writeFile('test-results/workshop-toolchain/error-report.json',JSON.stringify(report,null,2));}
console.log(JSON.stringify(report));
