import { parseHeaders, headersFor } from "./headers.mjs";
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../dist/", import.meta.url)));
try { await stat(resolve(root, "index.html")); }
catch { console.error("Run npm run build before previewing."); process.exit(1); }
const rules = parseHeaders(await readFile(resolve(root, "_headers"), "utf8"));
const types = {
  ".gz": "application/gzip", ".md": "text/plain; charset=utf-8", ".yaml": "text/plain; charset=utf-8",
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".avif": "image/avif",
  ".wasm": "application/wasm", ".glb": "model/gltf-binary", ".gltf": "model/gltf+json",
  ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".wav": "audio/wav", ".txt": "text/plain",
};
const server = createServer(async (request, response) => {
  const headers = { "Cache-Control": "no-cache" };
  try {
    const path = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
    Object.assign(headers, headersFor(rules, path, `http://${request.headers.host}`));
    let file = resolve(root, `.${path}`);
    if (file !== root && !file.startsWith(`${root}${sep}`)) throw new Error("Invalid path");
    if ((await stat(file)).isDirectory()) file = resolve(file, "index.html");
    const body = await readFile(file);
    response.writeHead(200, { ...headers, "Content-Type": types[extname(file)] || "application/octet-stream" });
    response.end(request.method === "HEAD" ? undefined : body);
  } catch {
    response.writeHead(404, { ...headers, "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
  }
});
const host = process.env.HOST || "0.0.0.0";
server.listen(Number(process.env.PORT || 8000), host, () => {
  const port = server.address().port;
  console.log(`Preview: http://127.0.0.1:${port} (listening on ${host}:${port}, serving dist/ with site headers)`);
});
