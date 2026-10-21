// Real loopback bridge + browser draft persistence, with one lost acknowledgement.
import { readFile, writeFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { launch, serve, local } from "../browser/harness.mjs";
import { serveBridge, bridgeRequest } from "../workshop-bridge.mjs";

const out = "test-results/duck-connection-recovery"; await mkdir(out, { recursive: true });
const project = JSON.parse(await readFile("test-results/duck-mirror-followers/authored.json", "utf8")).project;
const temporary = await mkdtemp(join(tmpdir(), "duck-recovery-"));
const server = await serve(), browser = await launch();
const bridge = await serveBridge({ file: join(temporary, "connection.json"),
  pageURL: `${server.base}/workshop/`, timeout: 5000, pollTimeout: 1000 });
const errors = [];
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
  await context.route("https://static.fun.dev/**", local(server.base));
  const page = await context.newPage();
  page.on("pageerror", e => errors.push(e.message));
  await page.goto(`${server.base}/workshop/?renderer=webgl&lang=en`);
  await page.waitForFunction(() => window.funEditor);
  await page.evaluate(async p => { funEditor.loadProject(p); await funEditor.flush(); }, project);
  await page.locator("#agent").click();
  await page.locator("#agent-connection-code").fill(bridge.code);
  await page.getByRole("button", { name: "Connect this project", exact: true }).click();
  await page.waitForFunction(() => document.querySelector("#agent")?.textContent.includes("connected"));
  const call = (method, ...args) => bridgeRequest(bridge.connection, "/call", { method, args });
  const initial = await call("inspect"); assert.equal(initial.ok, true);
  assert.match(initial.result.documentId, /^[a-f0-9-]{36}$/);
  const unknown = await call("operationStatus", { operationId: "never-issued" });
  assert.equal(unknown.result.status, "unknown");
  let aborted = false;
  await page.route(`${bridge.connection.endpoint}/result`, async route => {
    if (!aborted) { aborted = true; await route.abort("connectionreset"); }
    else await route.continue();
  });
  const operationId = "duck-recovery-relative-move";
  const commands = [{ op: "transform", id: "body", translation: [.01, 0, 0] }];
  const options = { ifRevision: initial.result.revision, operationId };
  const lost = await call("apply", commands, options);
  assert.equal(aborted, true);
  assert.equal(lost.ok, false);
  assert.equal(lost.error.applied, "unknown");
  // Reload destroys the in-memory receipt map and candidate cache.
  await page.reload();
  await page.waitForFunction(() => window.funEditor);
  await page.waitForFunction(() => document.querySelector("#agent")?.textContent.includes("connected"));
  const recovered = await call("inspect");
  assert.equal(recovered.result.draftId, initial.result.draftId);
  assert.equal(recovered.result.documentId, initial.result.documentId);
  assert.equal(recovered.result.revision, initial.result.revision + 1);
  const status = await call("operationStatus", { operationId });
  assert.equal(status.result.status, "recorded");
  assert.equal(status.result.receipt.revision, recovered.result.revision);
  const beforeRetry = await call("getProject");
  const retry = await call("apply", commands, options);
  assert.equal(retry.ok, true);
  assert.equal(retry.result.replayed, true);
  assert.equal(retry.result.revision, recovered.result.revision);
  assert.deepEqual((await call("getProject")).result, beforeRetry.result);
  const conflict = await call("apply", [{ op: "set", id: "body", name: "different request" }], options);
  assert.equal(conflict.ok, false); assert.equal(conflict.error.code, "conflict");
  await page.locator("#agent").click();
  await page.locator("#agent-connection-code").fill(""); // Never put the ephemeral credential in screenshots.
  await page.screenshot({ path: `${out}/reconnected.png` });
  assert.deepEqual(errors, []);
  await writeFile(`${out}/recovery.json`, JSON.stringify({
    lost: { code: lost.error.code, applied: lost.error.applied },
    initial: { draftId: initial.result.draftId, documentId: initial.result.documentId, revision: initial.result.revision },
    recovered: { draftId: recovered.result.draftId, documentId: recovered.result.documentId, revision: recovered.result.revision },
    operation: status.result, replayed: retry.result.replayed, conflictingReuse: conflict.error.code, errors,
  }, null, 2));
  console.log("Lost acknowledgement → browser reload → same draft/revision → recorded receipt → retry without another edit.");
} finally {
  await browser.close(); await bridge.close(); await server.close(); await rm(temporary, { recursive: true, force: true });
}
