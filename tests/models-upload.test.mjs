import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { uploadAll } from "../scripts/models-upload.mjs";
import { boxGLB, modelStack } from "./helpers/models.mjs";

const stack = await modelStack();
// The upload API over HTTP, as api.fun.dev serves it.
const server = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const result = await stack.runtime.dispatchFetch(`https://api.test${request.url}`, { method: request.method, headers: request.headers, body: chunks.length ? Buffer.concat(chunks) : undefined });
  response.writeHead(result.status, Object.fromEntries(result.headers));
  response.end(Buffer.from(await result.arrayBuffer()));
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const api = `http://127.0.0.1:${server.address().port}/api/models`;
const root = await mkdtemp(join(tmpdir(), "models-upload-"));
after(async () => { server.close(); await stack.runtime.dispose(); await rm(root, { recursive: true, force: true }); });
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

async function prepare(id, version, { meta = { name: { zh: "路灯", en: "Street lamp" }, type: "prop", kit: "street", tags: ["outdoor"] }, glb = boxGLB(), preview = png, extra = {} } = {}) {
  const directory = join(root, id, version);
  await mkdir(directory, { recursive: true });
  if (meta) await writeFile(join(directory, "meta.json"), JSON.stringify(meta));
  if (glb) await writeFile(join(directory, "model.glb"), glb);
  if (preview) await writeFile(join(directory, "preview.png"), preview);
  for (const [name, body] of Object.entries(extra)) await writeFile(join(directory, name), body);
}

test("the upload tool checks prepared versions locally, uploads them, and repeats without uploading again", async () => {
  await prepare("street_lamp_01", "v001", { extra: { "source.blend": "blend", "qa.json": "{}" } });
  await prepare("crate_01", "v001", { glb: boxGLB({ lift: 0.05 }) });
  await prepare("Bad-Name", "v001");
  await prepare("chair_01", "v001", { meta: { name: { zh: "椅子", en: "Chair" }, type: "character" }, preview: Buffer.from("not a png") });
  const lines = [];
  const dry = await uploadAll({ root, api, dryRun: true, log: (line) => lines.push(line) });
  assert.deepEqual(dry.map((row) => [row.id, row.status]), [["Bad-Name", "not_uploaded"], ["chair_01", "not_uploaded"], ["crate_01", "checked"], ["street_lamp_01", "checked"]]);
  assert.match(dry[1].problems.join(), /type must be one of prop, piece/);
  assert.match(dry[1].problems.join(), /preview\.png is not a PNG/);
  assert.match(dry[2].warnings.join(), /not on the floor/);

  const rows = await uploadAll({ root, api, token: "secret-token", only: ["street_lamp_01", "crate_01"], log: (line) => lines.push(line) });
  assert.deepEqual(rows.map((row) => [row.id, row.status, row.uploaded.length]), [["crate_01", "pending", 2], ["street_lamp_01", "pending", 4]]);
  assert.equal(lines.some((line) => line.includes("secret-token")), false, "the token is never printed");

  const again = await uploadAll({ root, api, token: "secret-token", only: ["street_lamp_01"], log: () => {} });
  assert.deepEqual([again[0].uploaded, again[0].skipped.sort()], [[], ["model.glb", "preview.png", "qa.json", "source.blend"]]);

  await stack.console("/api/models/street_lamp_01/v001/approve", { method: "POST", body: {} });
  assert.equal((await uploadAll({ root, api, token: "secret-token", only: ["street_lamp_01"], log: () => {} }))[0].status, "approved");
  const denied = await uploadAll({ root, api, token: "wrong", only: ["crate_01"], log: () => {} });
  assert.match(denied[0].problems.join(), /unauthorized/);
});
