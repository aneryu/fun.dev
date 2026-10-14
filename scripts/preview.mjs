import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPreviewServer, listen } from "./preview-server.mjs";

const root = resolve(fileURLToPath(new URL("../dist/", import.meta.url)));
try { await stat(resolve(root, "index.html")); }
catch { console.error("Run npm run build before previewing."); process.exit(1); }
const { port, host } = await listen(createPreviewServer({ root }));
console.log(`Preview: http://127.0.0.1:${port} (listening on ${host}:${port}, serving dist/ with site headers)`);
