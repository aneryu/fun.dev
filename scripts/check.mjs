import { readFile, readdir, stat } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { bundlePath, validateCatalog } from "../site/catalog.js";

const root = resolve(fileURLToPath(new URL("../site/", import.meta.url)));
const errors = [];
const games = validateCatalog(JSON.parse(await readFile(join(root, "games.json"), "utf8")));
const generated = new Set(["/vendor/three/three.module.js", "/skills/fun-dev-games.tar.gz"]);

async function checkReference(source, value) {
  if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(value)) return;
  const url = new URL(value, `https://local.test/${relative(root, source)}`);
  if (/^\/games\/[^/]+\/[^/]+\/(?:dev|package\.json|README\.md)(?:\/|$)/.test(url.pathname)) {
    errors.push(`${relative(root, source)}: reference to unpublished game development file ${value}`);
    return;
  }
  if (generated.has(url.pathname)) return;
  let target = resolve(root, `.${decodeURIComponent(url.pathname)}`);
  if (!target.startsWith(`${root}/`) && target !== root) throw new Error("Reference escapes site directory.");
  try {
    if ((await stat(target)).isDirectory()) target = join(target, "index.html");
    if (!(await stat(target)).isFile()) throw new Error("Not a file");
    if (url.hash && extname(target) === ".html") {
      const html = await readFile(target, "utf8");
      const ids = [...html.matchAll(/\bid=["']([^"']+)["']/g)].map((match) => match[1]);
      if (!ids.includes(decodeURIComponent(url.hash.slice(1)))) throw new Error("Missing fragment");
    }
  } catch {
    errors.push(`${relative(root, source)}: unresolved local reference ${value}`);
  }
}

async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) { errors.push(`Symlink is not a portable game asset: ${relative(root, path)}`); continue; }
    // Bundle development tools are not browser code or published assets.
    if (entry.isDirectory()) { if (!(entry.name === "dev" && path.startsWith(join(root, "games") + "/"))) await walk(path); continue; }
    const extension = extname(path);
    if (![".html", ".css", ".js", ".mjs"].includes(extension)) continue;
    const text = await readFile(path, "utf8");
    if (extension === ".html") {
      for (const match of text.matchAll(/\b(?:src|href)=["']([^"']+)["']/g)) await checkReference(path, match[1]);
    } else if (extension === ".css") {
      for (const match of text.matchAll(/url\(\s*["']?([^\s"')]+)["']?\s*\)/g)) await checkReference(path, match[1]);
    } else {
      const result = spawnSync(process.execPath, ["--check", path], { encoding: "utf8" });
      if (result.status !== 0) errors.push(result.stderr || `Cannot check ${path}`);
      // Only literal module references can be checked without executing a bundle.
      for (const match of text.matchAll(/\b(?:from\s*|import\s*\(\s*|import\s*)["']([^"']+)["']/g)) {
        if (!match[1].startsWith(".") && !match[1].startsWith("/")) {
          errors.push(`${relative(root, path)}: browser-unresolved import ${match[1]}`);
        } else await checkReference(path, match[1]);
      }
    }
  }
}

for (const game of games) await checkReference(join(root, "games.json"), bundlePath(game));
await walk(root);
if (errors.length) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Checked ${games.length} game bundles, JavaScript syntax, local links, module imports, and CSS assets.`);
}
