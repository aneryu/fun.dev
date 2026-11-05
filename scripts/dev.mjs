import { createServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { mkdir, readFile, stat } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { hostname, networkInterfaces } from "node:os";

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

// Addresses other devices on the LAN or a tailnet can reach this machine at.
function lanAddresses() {
  return Object.values(networkInterfaces())
    .flat()
    .filter((a) => a && a.family === "IPv4" && !a.internal)
    .map((a) => a.address);
}

// WebGPU needs a secure context, so phones on the LAN reach the dev server over HTTPS with a
// self-signed certificate for this machine's names and addresses. DEV_HOSTNAMES adds more names
// (comma-separated), e.g. a tailnet name. The certificate lives in the ignored .wrangler/ folder.
async function ensureSelfSignedCert() {
  const certDir = resolve(fileURLToPath(new URL("../.wrangler/", import.meta.url)));
  const keyPath = resolve(certDir, "dev-key.pem");
  const certPath = resolve(certDir, "dev-cert.pem");
  const existing = await stat(certPath).catch(() => null);
  if (!existing) {
    await mkdir(certDir, { recursive: true });
    const names = [hostname(), "localhost", ...(process.env.DEV_HOSTNAMES || "").split(",")]
      .map((n) => n.trim())
      .filter(Boolean);
    const ips = ["127.0.0.1", ...lanAddresses()];
    const san = [...new Set(names)].map((n) => `DNS:${n}`).concat(ips.map((ip) => `IP:${ip}`)).join(",");
    execFileSync("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes",
      "-keyout", keyPath,
      "-out", certPath,
      "-days", "365",
      "-subj", `/CN=${names[0]}`,
      "-addext", `subjectAltName=${san}`,
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
  const lan = lanAddresses();
  const server = createStaticServer();
  server.listen(port, host, () => {
    console.log(`HTTP  server: http://localhost:${port}`);
  });
  ensureSelfSignedCert()
    .then((tls) => {
      const httpsServer = createStaticServer(root, tls);
      httpsServer.listen(httpsPort, host, () => {
        for (const ip of lan) console.log(`HTTPS server: https://${ip}:${httpsPort} (self-signed, for WebGPU on other devices)`);
      });
    })
    .catch((err) => console.warn(`HTTPS server not started: ${err.message}`));
}
