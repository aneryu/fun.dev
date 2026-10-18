// Converts GLBs with the runtime's importer in a browser and writes .fun3d files beside a report.
//   node dev/fun3d/convert.mjs <site dir> <input dir> <output dir> [--quiet]
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from "node:fs";
import { resolve, basename } from "node:path";
const [site, input, output] = process.argv.slice(2).map((p) => resolve(p));
const quiet = process.argv.includes("--quiet");
const { launch, serve } = await import(new URL("../../scripts/browser/harness.mjs", import.meta.url));
const server = await serve(site), browser = await launch({ webgpu: true });
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
await page.goto(`${server.base}/demo/convert.html`);
await page.waitForFunction(() => window.ready, null, { timeout: 60000 });
mkdirSync(output, { recursive: true });
const reports = [];
for (const name of readdirSync(input).filter((f) => f.endsWith(".glb")).sort()) {
  const type = /piece/.test(name) ? "piece" : null;
  try {
    const { file, report } = await page.evaluate(([b64, type]) => window.convert(b64, { type }), [readFileSync(resolve(input, name)).toString("base64"), type]);
    writeFileSync(resolve(output, basename(name, ".glb") + ".fun3d"), Buffer.from(file, "base64"));
    reports.push({ name, ...report });
    if (!quiet) console.log(name, JSON.stringify(report));
  } catch (error) {
    reports.push({ name, error: String(error).slice(0, 300) });
    console.log(name, "ERROR", String(error).slice(0, 300));
  }
}
writeFileSync(resolve(output, "report.json"), JSON.stringify(reports, null, 1));
if (errors.length) console.log("page errors:", errors.slice(0, 5));
await browser.close(); server.close();
