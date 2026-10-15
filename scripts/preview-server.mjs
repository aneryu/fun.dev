import { parseHeaders, headersFor } from "./headers.mjs";
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";

const types = {
  ".gz": "application/gzip", ".md": "text/plain; charset=utf-8", ".yaml": "text/plain; charset=utf-8",
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".avif": "image/avif",
  ".wasm": "application/wasm", ".glb": "model/gltf-binary", ".gltf": "model/gltf+json",
  ".webmanifest": "application/manifest+json", ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".wav": "audio/wav", ".txt": "text/plain",
};

// Pages-style _redirects: `from to status` lines with :placeholders (one path segment). Returns
// the redirect target for a 301/302 match.
async function redirectFor(root, path) {
  let text = "";
  try { text = await readFile(resolve(root, "_redirects"), "utf8"); } catch { return null; }
  for (const line of text.split("\n")) {
    const [from, to, status = "302"] = line.trim().split(/\s+/);
    if (!from || from.startsWith("#") || !["301", "302"].includes(status)) continue;
    const names = [];
    const pattern = new RegExp(`^${from.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/:(\w+)/g, (_, name) => { names.push(name); return "([^/]+)"; })}$`);
    const found = path.match(pattern);
    if (found) return { status: Number(status), location: names.reduce((target, name, index) => target.replace(`:${name}`, found[index + 1]), to) };
  }
  return null;
}

// Serves a built directory with the repository's _headers and _redirects, re-read per request so
// rebuilds apply. Like Pages, /x serves x.html when it exists.
// `handle` may answer extra routes first; `transformHTML` rewrites HTML documents.
export function createPreviewServer({ root, handle = () => false, transformHTML = (html) => html }) {
  return createServer(async (request, response) => {
    if (await handle(request, response)) return;
    const headers = { "Cache-Control": "no-cache" };
    try {
      const path = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
      const rules = parseHeaders(await readFile(resolve(root, "_headers"), "utf8"));
      Object.assign(headers, headersFor(rules, path, `http://${request.headers.host}`));
      const redirect = await redirectFor(root, path);
      if (redirect) {
        response.writeHead(redirect.status, { ...headers, Location: redirect.location + new URL(request.url, "http://localhost").search });
        response.end();
        return;
      }
      let file = resolve(root, `.${path}`);
      if (file !== root && !file.startsWith(`${root}${sep}`)) throw new Error("Invalid path");
      if (!extname(file) && await stat(`${file}.html`).then((info) => info.isFile(), () => false)) file = `${file}.html`;
      else if ((await stat(file)).isDirectory()) file = resolve(file, "index.html");
      let body = await readFile(file);
      if (extname(file) === ".html") body = transformHTML(body.toString());
      response.writeHead(200, { ...headers, "Content-Type": types[extname(file)] || "application/octet-stream" });
      response.end(request.method === "HEAD" ? undefined : body);
    } catch {
      // Like Pages, answer unknown paths with the site's 404.html when it exists.
      let body = "Not found", type = "text/plain; charset=utf-8";
      try {
        body = transformHTML((await readFile(resolve(root, "404.html"))).toString());
        type = types[".html"];
        const rules = parseHeaders(await readFile(resolve(root, "_headers"), "utf8"));
        Object.assign(headers, headersFor(rules, "/404.html", `http://${request.headers.host}`));
      } catch { /* No custom page. */ }
      response.writeHead(404, { ...headers, "Content-Type": type });
      response.end(request.method === "HEAD" ? undefined : body);
    }
  });
}

// PORT and HOST behave the same for the preview and dev servers.
export function listen(server, port = Number(process.env.PORT || 8000), host = process.env.HOST || "0.0.0.0") {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve({ port: server.address().port, host }));
  });
}
