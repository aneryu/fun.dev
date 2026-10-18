import { spawn } from "node:child_process";
import { readdirSync, watch } from "node:fs";
import { access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPreviewServer, listen } from "./preview-server.mjs";
import { sync } from "./blobs.mjs";

// Development only: rebuild dist/ on source changes and reload open pages.
// The reload script is injected by this server and never written into dist/.
const root = new URL("../", import.meta.url);
const [id, ...extra] = process.argv.slice(2);
if (extra.length || (id && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id))) {
  console.error("Usage: npm run dev [-- <game-id>]");
  process.exit(1);
}
if (id) {
  try { await access(new URL(`games/${id}/game.json`, root)); }
  catch { console.error(`Unknown game: games/${id}/game.json does not exist.`); process.exit(1); }
}

// Bring games/<id>/assets/ and sources/ up to date with their locks (never edits a lock).
const { problems } = await sync({ mode: "restore" });
for (const problem of problems) console.warn(problem);

const clients = new Set();
const reloadScript = 'new EventSource("/__dev/events").addEventListener("reload", () => location.reload());\n';
// Dev never runs the offline worker: a build without FUNDEV_NO_SW (e.g. verify) can register it,
// and it then serves cached release files for the unchanged version. Browsers re-check /sw.js on
// every navigation, so this replacement removes any installed worker and its caches by itself.
const removeWorkerScript = `self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil((async () => {
  for (const name of await caches.keys()) await caches.delete(name);
  await self.registration.unregister();
  for (const client of await self.clients.matchAll({ type: "window" })) client.navigate(client.url);
})()));
`;

function build() {
  // An empty origin overrides .env, so dev always serves the local games/ sources.
  const env = { ...process.env, FUNDEV_GAME_ORIGIN: "", FUNDEV_TRANSFER: "", FUNDEV_NO_SW: "1" };
  return new Promise((done) => {
    spawn("npm", ["run", "--silent", "build"], { cwd: fileURLToPath(root), env, stdio: "inherit" })
      .on("exit", (code) => done(code === 0));
  });
}

let building = false;
let pending = false;
async function rebuild() {
  if (building) { pending = true; return; }
  building = true;
  do {
    pending = false;
    if (await build()) {
      for (const client of clients) client.write("event: reload\ndata:\n\n");
    } else console.error("Build failed; pages keep the previous build until the next change.");
  } while (pending);
  building = false;
}

// One non-recursive watcher per directory. Node's recursive watch on Linux follows files by
// inode, so a file replaced by rename (sed -i, many editors' atomic save) was never seen again;
// a directory watcher reports changes, creations and renames of its children. New directories
// are picked up as they appear; removed ones close their watcher.
let timer;
const watchers = new Map();
const ignored = (name) => /^\.|^node_modules$|~$/.test(name);
function watchTree(directory) {
  if (watchers.has(directory)) return;
  let entries;
  try { entries = readdirSync(directory, { withFileTypes: true }); } catch { return; }
  try {
    const watcher = watch(directory, (event, file) => {
      if (file && ignored(file)) return;
      if (event === "rename" && file) watchTree(join(directory, file));
      clearTimeout(timer);
      timer = setTimeout(rebuild, 150);
    });
    watcher.on("error", () => { watcher.close(); watchers.delete(directory); });
    watchers.set(directory, watcher);
  } catch { return; }
  for (const entry of entries) if (entry.isDirectory() && !ignored(entry.name)) watchTree(join(directory, entry.name));
}
// Rebuilds and directory moves can remove watched directories: drop the dead ones now and then.
setInterval(() => {
  for (const [directory, watcher] of watchers) {
    try { readdirSync(directory); } catch { watcher.close(); watchers.delete(directory); }
  }
}, 5000).unref();
for (const directory of ["site", "games", "scripts", "skills"]) watchTree(fileURLToPath(new URL(`${directory}/`, root)));

await rebuild();
const server = createPreviewServer({
  root: resolve(fileURLToPath(new URL("dist/", root))),
  transformHTML: (html) => html.replace("</head>", '<script type="module" src="/__dev/reload.js"></script></head>'),
  handle(request, response) {
    const { pathname } = new URL(request.url, "http://localhost");
    if (pathname === "/__dev/reload.js") {
      response.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-cache" });
      response.end(reloadScript);
      return true;
    }
    if (pathname === "/sw.js") {
      response.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-cache" });
      response.end(removeWorkerScript);
      return true;
    }
    if (pathname === "/__dev/events") {
      response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      response.write(": connected\n\n");
      clients.add(response);
      request.on("close", () => clients.delete(response));
      return true;
    }
    return false;
  },
});
const { port, host } = await listen(server);
const page = id ? `games/${id}?debug=1` : "";
console.log(`Dev: http://127.0.0.1:${port}/${page} (listening on ${host}:${port}; rebuilding on changes to site/, games/, scripts/, skills/)`);
