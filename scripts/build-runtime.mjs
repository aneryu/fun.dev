import { copyFile, mkdir, readdir, readFile, rm } from "node:fs/promises";

// npm run runtime:npm: fills packages/fundev-runtime/kit/ with the runtime kit the site serves
// (site/runtime/kit/, minus the modules that need the site's own files: the pinned three
// build, MediaPipe, the game context; assets.js comes along for the loader's image decoding,
// its glTF and KTX2 helpers needing the site's addons). Release: bump the version in
// packages/fundev-runtime/package.json, run this, then `npm publish ./packages/fundev-runtime`.
const SITE_ONLY = new Set(["text.js", "input.js", "vision.js", "post.js"]);
export async function buildRuntime(root = new URL("../", import.meta.url)) {
  const source = new URL("site/runtime/kit/", root), target = new URL("packages/fundev-runtime/kit/", root);
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  const files = (await readdir(source)).filter((name) => name.endsWith(".js") && !SITE_ONLY.has(name)).sort();
  for (const name of files) await copyFile(new URL(name, source), new URL(name, target));
  return files;
}
if (import.meta.url === `file://${process.argv[1]}`) {
  const root = new URL("../", import.meta.url), files = await buildRuntime(root);
  const { version } = JSON.parse(await readFile(new URL("packages/fundev-runtime/package.json", root), "utf8"));
  console.log(`packages/fundev-runtime ${version}: ${files.length} modules`);
}
