import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(fileURLToPath(new URL("../site/", import.meta.url)));
const errors = [];

async function checkReference(sourceFile, ref) {
  if (/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(ref)) return;
  const cleanRef = ref.split("?")[0].split("#")[0];
  if (!cleanRef || cleanRef === "/") {
    const idxInfo = await stat(join(root, "index.html")).catch(() => null);
    if (!idxInfo || !idxInfo.isFile()) {
      errors.push(`${relative(root, sourceFile)}: missing root index.html for ${ref}`);
    }
    return;
  }
  const target = cleanRef.startsWith("/")
    ? resolve(root, `.${cleanRef}`)
    : resolve(dirname(sourceFile), cleanRef);

  if (!target.startsWith(`${root}/`) && target !== root) {
    errors.push(`${relative(root, sourceFile)}: reference escapes site directory (${ref})`);
    return;
  }

  const info = await stat(target).catch(() => null);
  if (info && info.isFile()) return;
  if (info && info.isDirectory()) {
    const indexInfo = await stat(join(target, "index.html")).catch(() => null);
    if (indexInfo && indexInfo.isFile()) return;
  }
  if (!extname(target)) {
    const htmlCandidate = `${target}.html`;
    const htmlInfo = await stat(htmlCandidate).catch(() => null);
    if (htmlInfo && htmlInfo.isFile()) return;
  }
  errors.push(`${relative(root, sourceFile)}: unresolved local reference ${ref}`);
}

async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full);
      continue;
    }
    const ext = extname(full);
    if (![".html", ".css", ".js", ".mjs"].includes(ext)) continue;
    const text = await readFile(full, "utf8");

    if (ext === ".html") {
      for (const m of text.matchAll(/\b(?:src|href)=["']([^"']+)["']/g)) {
        await checkReference(full, m[1]);
      }
    } else if (ext === ".css") {
      for (const m of text.matchAll(/url\(\s*["']?([^\s"')]+)["']?\s*\)/g)) {
        await checkReference(full, m[1]);
      }
    } else {
      const check = spawnSync(process.execPath, ["--check", full], { encoding: "utf8" });
      if (check.status !== 0) {
        errors.push(`${relative(root, full)}: ${check.stderr.trim()}`);
      }
      // Strip template literals before scanning ES module imports
      const withoutTemplates = text.replace(/`[\s\S]*?`/g, '""');
      for (const m of withoutTemplates.matchAll(/\b(?:from\s+|import\s*\(\s*|import\s+)["']([^"']+)["']/g)) {
        await checkReference(full, m[1]);
      }
    }
  }
}

async function checkHomeDependencyIsolation() {
  const forbiddenOnHome = new Set([
    resolve(root, "kernel/sdf-editor.js"),
    resolve(root, "kernel/webgl2-fallback.js"),
    resolve(root, "studio.js"),
  ]);
  const visited = new Set();
  const queue = [resolve(root, "home.js")];

  while (queue.length > 0) {
    const cur = queue.shift();
    if (visited.has(cur)) continue;
    visited.add(cur);

    if (forbiddenOnHome.has(cur)) {
      errors.push(`Dependency isolation violation: site/home.js transitively imports ${relative(root, cur)}`);
      continue;
    }

    const text = await readFile(cur, "utf8").catch(() => "");
    const withoutTemplates = text.replace(/`[\s\S]*?`/g, '""');
    for (const m of withoutTemplates.matchAll(/\b(?:from\s+|import\s*\(\s*|import\s+)["']([^"']+)["']/g)) {
      const ref = m[1];
      if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(ref)) continue;
      const target = ref.startsWith("/") ? resolve(root, `.${ref}`) : resolve(dirname(cur), ref);
      if (target.startsWith(`${root}/`)) {
        queue.push(target);
      }
    }
  }
}

async function checkPagesAndSitemap() {
  const notFoundInfo = await stat(join(root, "404.html")).catch(() => null);
  if (!notFoundInfo || !notFoundInfo.isFile()) {
    errors.push("Missing site/404.html (required to prevent Cloudflare Pages SPA 200 fallback)");
  }

  const sitemapText = await readFile(join(root, "sitemap.xml"), "utf8").catch(() => "");
  for (const m of sitemapText.matchAll(/<loc>https:\/\/fun\.dev([^<]*)<\/loc>/g)) {
    const pathPart = m[1] || "/";
    await checkReference(join(root, "sitemap.xml"), pathPart);
  }
}

await walk(root);
await checkHomeDependencyIsolation();
await checkPagesAndSitemap();

if (errors.length > 0) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else {
  console.log("Checked site HTML links, CSS assets, JavaScript module syntax, and '/' dependency isolation.");
}
