import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createStaticServer } from "./dev.mjs";
import { SCENES } from "../site/scenes/index.js";

const root = resolve(fileURLToPath(new URL("../", import.meta.url)));
const outDir = resolve(root, "test-results");

function startBrowser() {
  const args = [
    "--headless=new",
    "--remote-debugging-port=0",
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
    "--enable-unsafe-webgpu",
    "--enable-features=Vulkan",
    "--use-vulkan=swiftshader",
    "--use-webgpu-adapter=swiftshader",
    "--window-size=1280,800",
    "about:blank",
  ];

  return new Promise((resolvePromise, rejectPromise) => {
    const proc = spawn("/usr/bin/google-chrome", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      rejectPromise(new Error(`Timed out waiting for Chrome DevTools endpoint.\n${stderr}`));
    }, 10000);

    const onData = (chunk) => {
      stderr += chunk.toString("utf8");
      const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) {
        clearTimeout(timer);
        proc.stderr.off("data", onData);
        resolvePromise({ proc, wsUrl: match[1] });
      }
    };

    proc.stderr.on("data", onData);
    proc.on("error", (err) => {
      clearTimeout(timer);
      rejectPromise(err);
    });
  });
}

class CDPSession {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();

    ws.addEventListener("message", (event) => {
      const msg = JSON.parse(String(event.data));
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve: res, reject: rej } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) rej(new Error(msg.error.message || JSON.stringify(msg.error)));
        else res(msg.result);
        return;
      }
      if (msg.method) {
        const list = this.listeners.get(msg.method) || [];
        for (const fn of list) fn(msg.params, msg.sessionId);
      }
    });
  }

  send(method, params = {}, sessionId = undefined) {
    const id = this.nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((res, rej) => {
      this.pending.set(id, { resolve: res, reject: rej, sessionId });
      this.ws.send(JSON.stringify(payload));
    });
  }

  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(fn);
  }
}

async function evaluate(cdp, sessionId, expression) {
  const res = await cdp.send(
    "Runtime.evaluate",
    { expression, returnByValue: true, awaitPromise: true },
    sessionId
  );
  if (res.exceptionDetails) {
    throw new Error(`Page evaluation exception: ${res.exceptionDetails.text} - ${JSON.stringify(res.exceptionDetails)}`);
  }
  return res.result?.value;
}

async function waitForCondition(cdp, sessionId, expr, timeoutMs = 45000, pageErrors = []) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const val = await evaluate(cdp, sessionId, expr);
    if (val) return val;
    await new Promise((r) => setTimeout(r, 70));
  }
  throw new Error(`Timed out waiting for condition: ${expr}\nPageErrors: ${pageErrors.join(" | ")}`);
}

const server = createStaticServer();
await new Promise((res) => server.listen(0, "127.0.0.1", res));
const { port } = server.address();
const baseUrl = `http://127.0.0.1:${port}`;

let chromeProc = null;
try {
  await mkdir(outDir, { recursive: true });
  const { proc, wsUrl } = await startBrowser();
  chromeProc = proc;

  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.addEventListener("open", res, { once: true });
    ws.addEventListener("error", rej, { once: true });
  });

  const cdp = new CDPSession(ws);
  const { targetInfos } = await cdp.send("Target.getTargets");
  const pageTarget = targetInfos.find((t) => t.type === "page");
  const { sessionId } = await cdp.send("Target.attachToTarget", {
    targetId: pageTarget.targetId,
    flatten: true,
  });

  const pageErrors = [];
  await cdp.send("Page.enable", {}, sessionId);
  await cdp.send("Runtime.enable", {}, sessionId);
  await cdp.send("Log.enable", {}, sessionId);

  cdp.on("Runtime.exceptionThrown", (params) => {
    pageErrors.push(params.exceptionDetails?.text || "Runtime exception");
  });
  cdp.on("Runtime.consoleAPICalled", (params) => {
    if (params.type === "error") {
      const text = (params.args || []).map((a) => a.value || a.description || "").join(" ");
      pageErrors.push(`console.error: ${text}`);
    }
  });

  // 1. Verify minimalist poster homepage (/)
  await cdp.send(
    "Emulation.setDeviceMetricsOverride",
    { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false },
    sessionId
  );
  await cdp.send("Page.navigate", { url: `${baseUrl}/?t=1.2` }, sessionId);
  await waitForCondition(cdp, sessionId, `document.body && document.body.dataset.sdfReady === "true"`);
  const homeShot = await cdp.send("Page.captureScreenshot", { format: "png" }, sessionId);
  await writeFile(resolve(outDir, "home-bath-duck.png"), Buffer.from(homeShot.data, "base64"));
  console.log("Verified homepage -> test-results/home-bath-duck.png");

  // 2. Verify SDF Low-Poly Block Editor (/studio) for bath-duck (default smooth high-precision mode)
  await cdp.send("Page.navigate", { url: `${baseUrl}/studio?lang=zh` }, sessionId);
  await waitForCondition(cdp, sessionId, `document.body && document.body.dataset.sdfReady === "true"`);

  const studioAudit = await evaluate(
    cdp,
    sessionId,
    `(() => {
      const title = document.querySelector("#dock-title")?.textContent;
      const blocks = document.querySelectorAll(".block-tree-item").length;
      const chips = document.querySelectorAll(".palette-chip").length;
      const sliders = document.querySelectorAll(".knob-slider").length;
      const stats = document.querySelector("#editor-mesh-stats")?.textContent;
      return { title, blocks, chips, sliders, stats };
    })()`
  );
  console.log("Verified Studio SDF Bath Duck Editor Audit:", JSON.stringify(studioAudit));
  if (studioAudit.title !== "澡盆小鸭" || studioAudit.blocks < 8 || studioAudit.sliders < 7) {
    throw new Error(`SDF Bath Duck Editor workbench check failed: ${JSON.stringify(studioAudit)}`);
  }

  const smoothShot = await cdp.send("Page.captureScreenshot", { format: "png" }, sessionId);
  await writeFile(resolve(outDir, "studio-sdf-blocks-editor.png"), Buffer.from(smoothShot.data, "base64"));
  console.log("Captured SDF Bath Duck (Smooth High-Precision) -> test-results/studio-sdf-blocks-editor.png");

  // 3. Switch to Faceted Low-Poly mode ("lowpoly") and capture screenshot
  await evaluate(
    cdp,
    sessionId,
    `(async () => {
      window.__studioApp.sdfEditor.shadingMode = "lowpoly";
      window.__studioApp.sdfEditor.invalidateAll();
      window.__studioApp._renderBlockEditor();
      if (window.__studioApp.runtime) await window.__studioApp.runtime.renderSingleFrame();
    })()`
  );
  const lowpolyShot = await cdp.send("Page.captureScreenshot", { format: "png" }, sessionId);
  await writeFile(resolve(outDir, "studio-sdf-lowpoly.png"), Buffer.from(lowpolyShot.data, "base64"));
  console.log("Captured SDF Bath Duck (Faceted Low-Poly) -> test-results/studio-sdf-lowpoly.png");

  // 4. Enable 36-instance crowd stress-test in SDF Editor and capture screenshot
  await evaluate(
    cdp,
    sessionId,
    `(async () => {
      window.__studioApp.sdfEditor.shadingMode = "smooth";
      window.__studioApp.sdfEditor.crowdMode = true;
      window.__studioApp.sdfEditor.invalidateAll();
      if (window.__studioApp.runtime) window.__studioApp.runtime.camera.distance = 4.35;
      window.__studioApp.webglCamera.distance = 4.35;
      window.__studioApp._syncEditorGizmo();
      window.__studioApp._renderBlockEditor();
      if (window.__studioApp.runtime) await window.__studioApp.runtime.renderSingleFrame();
    })()`
  );
  const crowdShot = await cdp.send("Page.captureScreenshot", { format: "png" }, sessionId);
  await writeFile(resolve(outDir, "studio-sdf-crowd-36.png"), Buffer.from(crowdShot.data, "base64"));
  console.log("Captured 36-Instance Bath Duck Crowd -> test-results/studio-sdf-crowd-36.png");

  // 5. English Studio: every visible label comes from the English dictionary (no CJK characters).
  await cdp.send("Page.navigate", { url: `${baseUrl}/studio?lang=en` }, sessionId);
  await waitForCondition(cdp, sessionId, `document.body && document.body.dataset.sdfReady === "true"`);
  const enAudit = await evaluate(
    cdp,
    sessionId,
    `(() => {
      const cjk = /[\\u3400-\\u9fff]/;
      const texts = [document.title, document.body.innerText,
        ...[...document.querySelectorAll("[aria-label],[title]")].map((el) => (el.getAttribute("aria-label") || "") + (el.getAttribute("title") || ""))];
      return { lang: document.documentElement.lang, title: document.querySelector("#dock-title")?.textContent,
        cjk: texts.join("\\n").split("\\n").filter((line) => cjk.test(line)).slice(0, 5) };
    })()`
  );
  console.log("Verified English Studio:", JSON.stringify(enAudit));
  if (enAudit.lang !== "en" || enAudit.title !== "Bath Duck" || enAudit.cjk.length > 0) {
    throw new Error(`English Studio check failed: ${JSON.stringify(enAudit)}`);
  }
  const enShot = await cdp.send("Page.captureScreenshot", { format: "png" }, sessionId);
  await writeFile(resolve(outDir, "studio-en.png"), Buffer.from(enShot.data, "base64"));

  // 6. Test Mobile Studio (375x812)
  await cdp.send(
    "Emulation.setDeviceMetricsOverride",
    { width: 375, height: 812, deviceScaleFactor: 2, mobile: true },
    sessionId
  );
  await cdp.send("Page.navigate", { url: `${baseUrl}/studio` }, sessionId);
  await waitForCondition(cdp, sessionId, `document.body && document.body.dataset.sdfReady === "true"`);
  const mobileStudioShot = await cdp.send("Page.captureScreenshot", { format: "png" }, sessionId);
  await writeFile(resolve(outDir, "studio-knobs-mobile.png"), Buffer.from(mobileStudioShot.data, "base64"));
  console.log("Captured Mobile Studio -> test-results/studio-knobs-mobile.png");

  console.log("\nAll verify tests passed cleanly!");
} finally {
  if (chromeProc) chromeProc.kill("SIGKILL");
  server.close();
}
