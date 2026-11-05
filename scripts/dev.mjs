import { createServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { mkdir, readFile, stat } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = resolve(fileURLToPath(new URL("../site/", import.meta.url)));

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
};

export function createStaticServer(siteRoot = root, tlsOptions = null) {
  const handler = async (req, res) => {
    try {
      const url = new URL(req.url || "/", "http://127.0.0.1");
      let relPath = decodeURIComponent(url.pathname);
      if (relPath.endsWith("/")) relPath += "index.html";
      let filePath = resolve(siteRoot, `.${relPath}`);
      if (!filePath.startsWith(`${siteRoot}/`) && filePath !== siteRoot) {
        res.writeHead(403).end("Forbidden");
        return;
      }
      const info = await stat(filePath).catch(() => null);
      if (!info || !info.isFile()) {
        if (!extname(filePath)) {
          const htmlCandidate = `${filePath}.html`;
          const htmlInfo = await stat(htmlCandidate).catch(() => null);
          if (htmlInfo && htmlInfo.isFile()) {
            filePath = htmlCandidate;
          } else {
            const notFoundBody = await readFile(resolve(siteRoot, "404.html")).catch(() => Buffer.from("Not found"));
            res.writeHead(404, { "content-type": "text/html; charset=utf-8" }).end(notFoundBody);
            return;
          }
        } else {
          res.writeHead(404).end("Not found");
          return;
        }
      }
      const body = await readFile(filePath);
      const mime = MIME_TYPES[extname(filePath)] || "application/octet-stream";
      res.writeHead(200, { "content-type": mime, "cache-control": "no-store" });
      res.end(body);
    } catch (err) {
      res.writeHead(500).end(err.message);
    }
  };
  return tlsOptions ? createHttpsServer(tlsOptions, handler) : createServer(handler);
}

async function ensureSelfSignedCert() {
  const certDir = resolve(fileURLToPath(new URL("../.wrangler/", import.meta.url)));
  const keyPath = resolve(certDir, "dev-key.pem");
  const certPath = resolve(certDir, "dev-cert.pem");
  const existing = await stat(certPath).catch(() => null);
  if (!existing) {
    await mkdir(certDir, { recursive: true });
    execFileSync("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes",
      "-keyout", keyPath,
      "-out", certPath,
      "-days", "365",
      "-subj", "/CN=spark-6d77.tail54dcda.ts.net",
      "-addext", "subjectAltName=DNS:spark-6d77.tail54dcda.ts.net,DNS:spark-6d77,DNS:localhost,IP:100.124.222.126,IP:127.0.0.1",
    ], { stdio: "ignore" });
  }
  return {
    key: await readFile(keyPath),
    cert: await readFile(certPath),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT) || 8000;
  const httpsPort = Number(process.env.HTTPS_PORT) || 8443;
  const host = process.env.HOST || "0.0.0.0";
  const server = createStaticServer();
  server.listen(port, host, () => {
    console.log(`HTTP  server: http://100.124.222.126:${port} (or http://localhost:${port})`);
  });
  ensureSelfSignedCert()
    .then((tls) => {
      const httpsServer = createStaticServer(root, tls);
      httpsServer.listen(httpsPort, host, () => {
        console.log(`HTTPS server: https://100.124.222.126:${httpsPort} (WebGPU Secure Context over Tailscale)`);
      });
    })
    .catch(() => {});
}
