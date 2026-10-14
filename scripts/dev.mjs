import { spawn } from "node:child_process";
import { watch } from "node:fs";
import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPreviewServer, listen } from "./preview-server.mjs";

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

const clients = new Set();
const reloadScript = 'new EventSource("/__dev/events").addEventListener("reload", () => location.reload());\n';

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

let timer;
for (const directory of ["site", "games", "scripts", "skills"]) {
  watch(new URL(`${directory}/`, root), { recursive: true }, (event, file) => {
    if (file && /(?:^|[/\\])(?:\.|node_modules[/\\])|~$/.test(file)) return;
    clearTimeout(timer);
    timer = setTimeout(rebuild, 150);
  });
}

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
const page = id ? `play/?game=${id}&debug=1` : "";
console.log(`Dev: http://127.0.0.1:${port}/${page} (listening on ${host}:${port}; rebuilding on changes to site/, games/, scripts/, skills/)`);
