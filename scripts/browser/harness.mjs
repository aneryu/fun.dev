import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createPreviewServer, listen } from "../preview-server.mjs";

// Shared pieces for the browser suites: one Chromium, one static server per build.
export const root = fileURLToPath(new URL("../../", import.meta.url));
export const dist = resolve(root, "dist");
export const results = resolve(root, "test-results");

export async function serve(directory = dist) {
  const server = createPreviewServer({ root: directory });
  const { port } = await listen(server, 0, "127.0.0.1");
  return { base: `http://127.0.0.1:${port}`, close: () => server.close() };
}

export async function launch() {
  await mkdir(results, { recursive: true });
  return chromium.launch({ args: ["--no-sandbox", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
}

// Collects page errors and console errors into `errors`.
export function watch(page, errors, timeout = 20000) {
  page.setDefaultTimeout(timeout);
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(`${page.url()}: ${message.text()}`); });
  return page;
}

export function running(page) {
  return page.waitForFunction(() => document.querySelector("#player-message").hidden && document.querySelector(".game-surface canvas"));
}

// Serves cross-origin game files from Node, for origins whose CORS excludes the test server.
export function proxy(base) {
  const cache = new Map();
  return async (route) => {
    const url = route.request().url();
    if (!cache.has(url)) {
      const response = await fetch(url, { redirect: "error" });
      cache.set(url, { status: response.status, contentType: response.headers.get("content-type") || "application/octet-stream", body: Buffer.from(await response.arrayBuffer()) });
    }
    const { status, contentType, body } = cache.get(url);
    await route.fulfill({ status, body, headers: { "content-type": contentType, "access-control-allow-origin": base } });
  };
}
