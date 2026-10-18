// Runs the prototype scene in a browser and saves screenshots.
//   node dev/fun3d/demo.mjs <site dir> <output dir>
import { resolve } from "node:path";
import { mkdirSync } from "node:fs";
const [site, output] = process.argv.slice(2).map((p) => resolve(p));
const { launch, serve } = await import(new URL("../../scripts/browser/harness.mjs", import.meta.url));
const server = await serve(site), browser = await launch({ webgpu: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => { if (["error", "warning"].includes(m.type())) errors.push(m.text().slice(0, 200)); });
await page.goto(`${server.base}/demo/demo.html${process.env.GL === "1" ? "?gl" : ""}`);
await page.waitForFunction(() => window.ready, null, { timeout: 120000 });
mkdirSync(output, { recursive: true });
console.log("info", JSON.stringify(await page.evaluate(() => window.info)));
const shot = async (name, view) => {
  const r = await page.evaluate((v) => window.view(v), view);
  await page.screenshot({ path: resolve(output, `${name}.png`) });
  console.log(name, JSON.stringify(r));
};
await shot("0-overview", "overview");
await shot("0-chase", "chase");
await shot("0-person", "person");
for (const [t, views] of [[1.5, ["person"]], [1.5, ["chase", "person"]], [2.5, ["chase"]], [1, ["chase"]], [1.5, ["chase", "overview"]]]) {
  const state = await page.evaluate((s) => window.step(s), t);
  console.log("state", JSON.stringify(state));
  for (const v of views) await shot(`${state.time.toFixed(1)}-${v}`, v);
}
console.log("errors", JSON.stringify(errors.slice(0, 8)));
await browser.close(); server.close();
