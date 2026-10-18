import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { blobPath } from "../blobs.mjs";
import { dist, launch, results, serve } from "./harness.mjs";

// The parity gate over converted library files (docs/model-format.md §8): every pair in a
// `npm run fun3d -- library` output directory is rendered from its GLB and its .fun3d with the same
// classic materials, lights and cameras, and compared. Writes <dir>/parity.json and a worst-50
// sheet to test-results/fun3d-parity.png.
//   node scripts/browser/fun3d-parity.mjs [dir=test-results/fun3d-library] [--gpu] [--only id,id] [--limit n]
const here = fileURLToPath(new URL("./", import.meta.url));

export async function parity({ directory, gpu = false, only = null, limit = Infinity, worst = 50 }) {
  const report = JSON.parse(await readFile(resolve(directory, "report.json"), "utf8"));
  let files = report.models.filter((m) => !m.error && m.kind === "model" && m.hash);
  if (only) files = files.filter((m) => only.includes(m.id));
  files = files.slice(0, limit);
  try { await readFile(resolve(dist, "runtime", "three.js")); } catch { throw new Error("Build the site first: npm run build."); }
  const server = await serve(), browser = await launch({ webgpu: gpu });
  try {
    const context = await browser.newContext({ serviceWorkers: "block", viewport: { width: 400, height: 300 } });
    await context.route("**/fun3d-parity/page.js", async (route) => route.fulfill({ body: await readFile(resolve(here, "fun3d-parity-page.js")), headers: { "content-type": "text/javascript" } }));
    await context.route("**/fun3d-parity/files/*", async (route) => {
      const name = decodeURIComponent(route.request().url().split("/").at(-1)), id = name.replace(/\.(glb|fun3d)$/, ""), model = files.find((m) => m.id === id);
      if (!model) return route.fulfill({ status: 404 });
      const body = name.endsWith(".glb") ? await readFile(blobPath(model.hash)) : await readFile(resolve(directory, `${model.id}@${model.version}.fun3d`));
      return route.fulfill({ body, headers: { "content-type": "application/octet-stream" } });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(0);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${server.base}/games/muyu`);
    const result = await page.evaluate(async ({ list, worst }) => (await import("/fun3d-parity/page.js")).run({ files: list, worst }), { list: files.map((m) => ({ id: m.id })), worst });
    await mkdir(results, { recursive: true });
    await writeFile(resolve(results, "fun3d-parity.png"), Buffer.from(result.sheet, "base64"));
    const scored = result.results.filter((r) => !r.error).sort((a, b) => b.mean - a.mean);
    const summary = {
      backend: result.backend, models: result.results.length, errors: result.results.filter((r) => r.error).length,
      mean: scored.reduce((n, r) => n + r.mean, 0) / Math.max(1, scored.length), median: scored[Math.floor(scored.length / 2)]?.mean ?? 0,
      above2: scored.filter((r) => r.mean > 2).length, above5: scored.filter((r) => r.mean > 5).length, worst: scored.slice(0, 20).map((r) => [r.id, Number(r.mean.toFixed(2)), Number(r.big.toFixed(3)), r.triangles]),
    };
    await writeFile(resolve(directory, "parity.json"), JSON.stringify({ summary, results: result.results }, null, 1));
    return { summary, errors };
  } finally {
    await browser.close();
    server.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2), flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const directory = resolve(args.find((a, i) => !a.startsWith("-") && !["--only", "--limit"].includes(args[i - 1])) ?? "test-results/fun3d-library");
  const { summary, errors } = await parity({ directory, gpu: args.includes("--gpu"), only: flag("--only")?.split(","), limit: Number(flag("--limit") ?? Infinity) });
  console.log(JSON.stringify(summary, null, 1));
  if (errors.length) console.log(`page errors:\n  ${errors.join("\n  ")}`);
  console.log(`sheet: ${resolve(results, "fun3d-parity.png")}`);
}
