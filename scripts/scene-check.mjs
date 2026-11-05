import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createStaticServer } from "./dev.mjs";
import { findSceneById } from "../site/scenes/index.js";
import { buildSceneShaders } from "../site/kernel/compiler.js";

const root = resolve(fileURLToPath(new URL("../", import.meta.url)));
const outDir = resolve(root, "test-results");

const args = process.argv.slice(2);
const targetArg = args.find((a) => !a.startsWith("--")) || "bath-duck";
const timesArg = args.find((a) => a.startsWith("--t="))?.slice(4) || "0,0.6,1.2";
const times = timesArg.split(",").map((x) => Number(x.trim())).filter((n) => !Number.isNaN(n));

let scene = findSceneById(targetArg);
let isCustomFile = false;

if (existsSync(resolve(process.cwd(), targetArg))) {
  isCustomFile = true;
  const fullPath = resolve(process.cwd(), targetArg);
  const raw = await readFile(fullPath, "utf8");
  if (fullPath.endsWith(".json")) {
    const parsed = JSON.parse(raw);
    scene = { ...scene, ...parsed, id: parsed.id || basename(fullPath, ".json") };
  } else {
    scene = { ...scene, id: basename(fullPath, ".wgsl"), wgsl: raw };
  }
}

const built = buildSceneShaders(scene);
if (!built.ok) {
  console.error(JSON.stringify({ ok: false, scene: scene.id, errors: built.errors }, null, 2));
  process.exit(1);
}

const server = createStaticServer();
await new Promise((res) => server.listen(0, "127.0.0.1", res));
const { port } = server.address();
const baseUrl = `http://127.0.0.1:${port}`;

const chromeArgs = [
  "--headless=new",
  "--remote-debugging-port=0",
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
  "--enable-unsafe-webgpu",
  "--enable-features=Vulkan",
  "--use-vulkan=swiftshader",
  "--use-webgpu-adapter=swiftshader",
  "--window-size=960,720",
  "about:blank",
];

const proc = spawn("/usr/bin/google-chrome", chromeArgs, { stdio: ["ignore", "pipe", "pipe"] });
try {
  await mkdir(outDir, { recursive: true });
  const wsUrl = await new Promise((res, rej) => {
    let stderr = "";
    proc.stderr.on("data", (d) => {
      stderr += d.toString("utf8");
      const m = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (m) res(m[1]);
    });
    setTimeout(() => rej(new Error("Timeout launching Chrome")), 10000);
  });

  const ws = new WebSocket(wsUrl);
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  let nextId = 1;
  const errors = [];

  ws.addEventListener("message", (e) => {
    const msg = JSON.parse(String(e.data));
    if (msg.method === "Runtime.consoleAPICalled" && msg.params?.type === "error") {
      errors.push((msg.params.args || []).map((a) => a.value || a.description || "").join(" "));
    } else if (msg.method === "Runtime.exceptionThrown") {
      errors.push(msg.params?.exceptionDetails?.text || "Runtime exception");
    }
  });

  const send = (method, params = {}, sessionId = undefined) =>
    new Promise((res, rej) => {
      const id = nextId++;
      const fn = (e) => {
        const msg = JSON.parse(String(e.data));
        if (msg.id === id) {
          ws.removeEventListener("message", fn);
          if (msg.error) rej(new Error(msg.error.message));
          else res(msg.result);
        }
      };
      ws.addEventListener("message", fn);
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });

  const { targetInfos } = await send("Target.getTargets");
  const page = targetInfos.find((t) => t.type === "page");
  const { sessionId } = await send("Target.attachToTarget", { targetId: page.targetId, flatten: true });
  await send("Page.enable", {}, sessionId);
  await send("Runtime.enable", {}, sessionId);

  const outputs = [];
  for (const t of times) {
    const baseSceneId = isCustomFile ? "rubber-duck" : scene.id;
    const url = `${baseUrl}/?scene=${encodeURIComponent(baseSceneId)}&t=${t}&paused=1`;
    await send("Page.navigate", { url }, sessionId);

    const start = Date.now();
    let ready = false;
    while (Date.now() - start < 12000) {
      const r = await send(
        "Runtime.evaluate",
        { expression: `document.body?.dataset.sdfReady || ""`, returnByValue: true },
        sessionId
      );
      if (r.result?.value === "true") {
        ready = true;
        break;
      }
      await new Promise((r2) => setTimeout(r2, 70));
    }
    if (!ready) {
      throw new Error(`Timed out waiting for scene '${scene.id}' at t=${t}`);
    }

    if (isCustomFile) {
      const payload = JSON.stringify({
        stateCount: scene.stateCount,
        substeps: scene.substeps,
        stepScale: scene.stepScale,
        ground: scene.ground,
        camera: scene.camera,
        params: scene.params,
        wgsl: scene.wgsl,
      });
      await send(
        "Runtime.evaluate",
        {
          expression: `(() => {
            const ed = document.querySelector("#wgsl-editor");
            ed.value = ${JSON.stringify(payload)};
            document.querySelector("#compile-btn").click();
          })()`,
          awaitPromise: true,
        },
        sessionId
      );
      await new Promise((r2) => setTimeout(r2, 250));
    }

    if (errors.length > 0) {
      console.error(JSON.stringify({ ok: false, scene: scene.id, errors }, null, 2));
      process.exit(1);
    }

    const shot = await send("Page.captureScreenshot", { format: "png" }, sessionId);
    const outPath = resolve(outDir, `${scene.id}-t${String(t).replace(".", "_")}.png`);
    await writeFile(outPath, Buffer.from(shot.data, "base64"));
    outputs.push(outPath);
  }

  console.log(JSON.stringify({ ok: true, scene: scene.id, timestamps: times, screenshots: outputs }, null, 2));
  ws.close();
} finally {
  proc.kill("SIGKILL");
  server.close();
}
