import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { chromium } from 'playwright';

const temporary = await mkdtemp(join(tmpdir(), 'fundev-progress-browser-'));
const env = { ...process.env, CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false', WRANGLER_SEND_METRICS: 'false' };
const listener = createServer();
await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
const port = listener.address().port;
await new Promise(resolve => listener.close(resolve));
const origin = `https://localhost:${port}`;
let server, browser, output = '';
const cli = 'node_modules/wrangler/bin/wrangler.js';
try {
  execFileSync('npm', ['run', 'build:transfer-local'], { env, stdio: 'pipe' });
  execFileSync(process.execPath, [cli, 'd1', 'migrations', 'apply', 'DB', '--local', '--persist-to', temporary, '--env-file', '/dev/null'], { env, stdio: 'pipe' });
  server = spawn(process.execPath, [cli, 'pages', 'dev', '--persist-to', temporary, '--port', String(port), '--env-file', '/dev/null', '--binding', 'TRANSFER_ENABLED=true', '--binding', `TRANSFER_ORIGIN=${origin}`], { env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  for (const stream of [server.stdout, server.stderr]) stream.on('data', chunk => { output = (output + chunk).slice(-12000); });
  for (let i = 0; !output.includes('Ready on') && i < 120; i++) { if (server.exitCode !== null) throw new Error(output); await new Promise(resolve => setTimeout(resolve, 250)); }
  assert.ok(output.includes('Ready on'), output);
  browser = await chromium.launch({ args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const errors = [];
  async function makePage(context, url = `${origin}/play/?game=cyber-muyu&lang=en`) {
    const page = await context.newPage(); page.setDefaultTimeout(15000);
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error' && !message.text().includes('net::ERR_INTERNET_DISCONNECTED') && !message.text().includes('status of 409 (Conflict)')) errors.push(message.text()); });
    page.on('dialog', dialog => dialog.accept());
    await page.goto(url);
    return page;
  }
  const desktop = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 800 } });
  const a = await makePage(desktop);
  const merit = (page, n) => page.waitForFunction(n => document.querySelector('canvas')?.getAttribute('aria-label')?.includes(`MERIT ${n}.`), n);
  async function hit(page, n = 1) { await page.bringToFront(); await page.waitForTimeout(100); await page.locator('canvas').focus(); for (let i = 0; i < n; i++) { await page.keyboard.press('Space'); await page.waitForTimeout(120); } }
  async function menu(page) {
    if (await page.locator('.progress-dialog').evaluate(e => e.open)) return;
    if (await page.locator('#open-progress').isVisible()) await page.locator('#open-progress').click();
    else if (await page.locator('#open-progress-message').isVisible()) await page.locator('#open-progress-message').click();
    else { await page.locator('#menu-toggle').click(); await page.locator('#open-progress').click(); }
  }
  const action = async (page, name) => { await page.locator(`.progress-dialog [data-action="${name}"]`).evaluate(el => { for (let p = el.parentElement; p; p = p.parentElement) if (p.tagName === "DETAILS") p.open = true; }); await page.locator(`.progress-dialog [data-action="${name}"]`).click(); await page.waitForFunction(() => !document.querySelector(".progress-dialog [data-action=close]").disabled); };
  const calls = [];
  a.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/')) calls.push(request.url()); });
  await merit(a, 0); await hit(a, 3); await merit(a, 3);
  await a.reload(); await merit(a, 3); await a.evaluate(() => window.dispatchEvent(new Event('focus')));
  assert.equal(calls.length, 0, 'ordinary saves and reloads must stay local');
  assert.equal((await desktop.cookies()).length, 0, 'ordinary play creates no session Cookie');
  // Populate another game through the actual IDB service, not a cloud fixture.
  await a.evaluate(async () => {
    const {openLocal} = await import('/progress/local.js'); const local = await openLocal(); const identity = await local.identity();
    const row = await local.claim(identity, 'other-game'); await local.save(identity, 'other-game', row.writerGeneration, {schemaVersion:1,data:{merit:88}}); local.close();
  });
  await menu(a); await mkdir('test-results', {recursive:true});
  await a.screenshot({path:'test-results/progress-desktop.png'});
  await action(a, 'transfer');
  const link = await a.locator('#progress-link-value').inputValue(); assert.ok(new URL(link).hash.startsWith('#transfer='));
  const mobile = await browser.newContext({ignoreHTTPSErrors:true, viewport:{width:390,height:844}, isMobile:true, hasTouch:true});
  const b = await makePage(mobile); await merit(b,0); await hit(b); await merit(b,1);
  let claims = 0; b.on('request', request => {if(request.url().endsWith('/api/transfers/claim')) claims++;});
  await b.goto(link); await b.locator('[data-action=receive]').waitFor({state:'visible'});
  assert.equal(new URL(b.url()).hash, ''); assert.equal(claims,0,'opening a link does not accept it');
  await b.screenshot({path:'test-results/progress-mobile-receive.png'});
  await action(b,'receive'); await merit(b,3); assert.equal(claims,1);
  const saved = await b.evaluate(async()=>{const {openLocal}=await import('/progress/local.js');const local=await openLocal();const rows=await local.all();local.close();return rows;});
  assert.ok(saved.some(row=>row.gameId==='other-game'&&row.snapshot.data.merit===88));
  assert.ok(saved.some(row=>row.gameId==='cyber-muyu'&&row.snapshot.data.merit===1),'previous target profile retained');
  await a.bringToFront(); await action(a,'retry'); assert.match(await a.locator('#progress-status').innerText(),/Transferred/);
  await action(a,'close'); await a.reload(); await menu(a); assert.match(await a.locator('#progress-status').innerText(),/Transferred/);
  // The new device can play offline without progress API traffic.
  await b.bringToFront(); await mobile.setOffline(true); await hit(b,2); await merit(b,5); await mobile.setOffline(false);
  await b.reload(); await merit(b,5); await menu(b);
  await b.screenshot({path:'test-results/progress-mobile.png'}); assert.ok(await b.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  // Local writer takeover remains enforced, and a pending transfer freezes it all.
  const tab=await makePage(mobile); await menu(tab); await tab.locator('[data-action=takeover]').waitFor({state:'visible'});
  await action(tab,'takeover'); await action(tab,'close'); await hit(tab); await merit(tab,6); await menu(tab);
  await action(tab,'transfer'); await action(tab,'cancel'); await action(tab,'close'); await hit(tab); await merit(tab,7);
  await menu(tab); const downloadEvent=tab.waitForEvent('download'); await action(tab,'export');const file=await (await downloadEvent).path();assert.ok(file);
  await action(tab,'reset');await merit(tab,0);
  await tab.locator('#progress-file').setInputFiles(file);await tab.locator('#progress-import-choice').waitFor({state:'visible'});
  await action(tab,'importSelected');await merit(tab,7);
  // Clear is explicit and keeps the player usable.
  await action(tab,'clear');await merit(tab,0);
  // Transfer back to a browser whose old profile is moved/read-only.
  await action(tab,'transfer');const returnLink=await tab.locator('#progress-link-value').inputValue();
  await a.goto(returnLink);await a.locator('[data-action=receive]').waitFor({state:'visible'});await action(a,'receive');await merit(a,0);
  await menu(b);await b.setViewportSize({width:320,height:640});
  assert.ok(await b.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  assert.ok(await b.locator('.progress-dialog').evaluate(el=>{const r=el.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth;}));
  await b.screenshot({path:'test-results/progress-mobile-320.png'});
  const denied = await browser.newContext({ ignoreHTTPSErrors: true, reducedMotion: 'reduce', viewport: { width: 390, height: 844 } });
  await denied.addInitScript(() => Object.defineProperty(globalThis, 'indexedDB', { value: undefined }));
  const d = await makePage(denied); await merit(d, 0); await hit(d); await merit(d, 1); await menu(d);
  assert.match(await d.locator('#progress-status').innerText(), /not saved/);
  const memoryDownload = d.waitForEvent('download'); await action(d, 'export'); assert.ok(await (await memoryDownload).path());
  await action(d, 'close');
  await d.locator('#menu-toggle').click(); await d.locator('#language-toggle').selectOption('zh'); await d.locator('#open-progress').click();
  assert.equal(await d.locator('#progress-title').innerText(), '我的进度');
  await d.screenshot({ path: 'test-results/progress-storage-unavailable-zh.png' });
  assert.deepEqual(errors, []);
  console.log('Browser checks passed: zero idle API requests/cookies, explicit receipt, all-game transfer, source retirement, previous profile retention, offline saves, tab fencing, cancellation, export/import/reset/clear, storage denial, bilingual mobile and desktop.');
} catch (error) {
  if (browser) for (const context of browser.contexts()) for (const page of context.pages()) console.error('Browser state:', (await page.locator('body').innerText()).replace(/[a-f0-9]{64}/g, '[redacted]'), await page.locator('canvas').getAttribute('aria-label').catch(() => 'no canvas'));
  throw error;
} finally {
  await browser?.close();
  if (server?.pid) { try { process.kill(-server.pid, 'SIGTERM'); } catch {} }
  await rm(temporary, { recursive: true, force: true });
}
