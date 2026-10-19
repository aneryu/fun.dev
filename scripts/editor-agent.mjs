#!/usr/bin/env node
// Local stdio adapter only. The website remains entirely static.
import {
  readFile,
  writeFile,
  mkdir,
  rename,
  access,
  open,
  unlink,
} from "node:fs/promises";
import { resolve, dirname, extname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createInterface } from "node:readline";
import { execFileSync } from "node:child_process";
import { createPreviewServer, listen } from "./preview-server.mjs";
import { agentTools, toolInvocation } from "../site/editor/agent-tools.js";
import { errorInfo } from "../site/editor/agent-contract.js";
import { normalizeProject } from "../site/editor/document.js";
import { runScript, guideText, compactError } from "./editor-script.mjs";
import { parseModelFile, workshopProject } from "../site/editor/glb.js";
import { openWorkshop } from "./workshop-node.mjs";
import { kernel } from "./workshop-kernel.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const MUTATING = [
  "apply",
  "loadProject",
  "importGLB",
  "undo",
  "redo",
  "checkpoint",
  "restoreCheckpoint",
  "removeCheckpoint",
];

/** The workshop tool: --run, the JSON line CLI or MCP over stdio (docs/model-editor.md). */
export async function main(args = process.argv.slice(2)) {
const config = {};
// The published single-file tool (static.fun.dev/tools/fundev-workshop.mjs) is built with a
// default URL: it drives the live workshop and needs no repository, only Playwright.
const defaultUrl = process.env.FUNDEV_WORKSHOP_URL || undefined;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--mcp") config.mcp = true;
  else if (args[i] === "--gpu") config.gpu = true;
  else if (args[i] === "--software") config.software = true;
  else if (args[i] === "--browser") config.browser = true;
  else if (args[i] === "--guide") config.guide = true;
  else if (
    ["--session", "--project", "--artifacts", "--cdp", "--url", "--run"].includes(
      args[i],
    )
  ) {
    const key = args[i].slice(2);
    if (!args[i + 1] || args[i + 1].startsWith("--"))
      throw new Error("Missing " + args[i]);
    config[key] = args[++i];
  } else if (args[i] === "--help") {
    // Published as the npm package fundev-workshop and as the site's fundev-workshop.mjs.
    const tool = defaultUrl ? "npx -y fundev-workshop" : "node scripts/editor-agent.mjs";
    console.log(
      [
        `${tool} --run model.mjs        build a model from a script (--guide prints the quick reference)`,
        `${tool} [--mcp] [--session state.json] [--project model.funmodel.glb|.json] [--artifacts directory]`,
        "The workshop runs in Node: no browser, GPU or WebGL; views draw in software.",
        `--browser drives a real page instead (${defaultUrl ?? "the local preview"}; --url another), --gpu draws on the GPU,`,
        "--cdp http://127.0.0.1:9222 --url <exact editor tab URL> attaches to an open browser. These need Playwright:",
        "npm i playwright && npx playwright install chromium",
        'CLI stdin: one JSON {"method":"inspect","arguments":{}} per line; stdout: JSON results.',
      ].join("\n"),
    );
    process.exit(0);
  } else throw new Error("Unknown option " + args[i]);
}
if (config.guide) {
  process.stdout.write(await guideText(root));
  process.exit(0);
}
// The workshop runs in Node unless a browser is asked for: --browser, --gpu, --software,
// --url or --cdp drive a real page (the published workshop by default).
config.node = !(config.browser || config.gpu || config.software || config.url || config.cdp);
if (!config.node) config.url ??= config.cdp ? undefined : defaultUrl;
if (config.cdp && (!config.url || config.project || config.session))
  throw new Error(
    "Existing-tab mode requires --url and does not load a project or session",
  );
let browser,
  context,
  page,
  editor,
  server,
  sessionLock,
  startError,
  ready = false,
  initialization = false,
  sequence = 0;
async function start() {
  if (startError) throw startError;
  try {
    return await connect();
  } catch (e) {
    startError = e;
    throw e;
  }
}
// Playwright for --browser: beside this file, or in the working directory's node_modules (the
// published workshop runs from a cache, so its own location rarely has it).
async function loadPlaywright() {
  try {
    return await import("playwright");
  } catch (error) {
    if (error.code !== "ERR_MODULE_NOT_FOUND") throw error;
    const { createRequire } = await import("node:module");
    for (const base of [process.cwd(), dirname(resolve(process.argv[1] ?? "."))])
      try {
        const found = await import(pathToFileURL(createRequire(resolve(base, "noop.js")).resolve("playwright")).href);
        // A CommonJS package arrives as a default export.
        return found.chromium ? found : found.default;
      } catch {
        /* not here */
      }
    throw new Error("--browser needs Playwright: npm i playwright && npx playwright install chromium");
  }
}
// The project to start from: the session file, else --project (a .funmodel.glb or JSON).
async function sessionRecord() {
  let record;
  if (config.session)
    try {
      record = JSON.parse(await readFile(resolve(config.session), "utf8"));
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
  if (config.project) {
    if (record)
      throw new Error(
        "Session already exists; use loadProject with ifRevision instead of --project",
      );
    // A project file (.funmodel.glb) carries its editable project; JSON projects still work.
    const bytes = await readFile(resolve(config.project)),
      project = /\.glb$/i.test(config.project)
        ? workshopProject(parseModelFile(new Uint8Array(bytes)).json)
        : JSON.parse(bytes.toString("utf8"));
    if (!project)
      throw new Error(
        "This GLB has no workshop project; start a session and use importGLB",
      );
    record = { project, revision: 0 };
  }
  if (record) {
    // Projects built by the geometry kernel are checked by the page instead.
    try {
      normalizeProject(record.project);
    } catch (error) {
      if (error.code !== "kernel_loading") throw error;
    }
    if (!Number.isSafeInteger(record.revision) || record.revision < 0)
      throw new Error("Invalid session revision");
  }
  return record;
}
async function connect() {
  if (page) return;
  if (config.session && !sessionLock) {
    const path = resolve(config.session) + ".lock";
    await mkdir(dirname(path), { recursive: true });
    try {
      sessionLock = await open(path, "wx");
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      const pid = Number(await readFile(path, "utf8"));
      let alive = true;
      if (Number.isInteger(pid) && pid > 0)
        try {
          process.kill(pid, 0);
        } catch (error) {
          if (error.code === "ESRCH") alive = false;
        }
      if (alive)
        throw new Error("Session is already in use: " + config.session);
      await unlink(path);
      sessionLock = await open(path, "wx");
    }
    await sessionLock.writeFile(String(process.pid));
  }
  if (config.node) {
    if (editor) return;
    // No browser: the page's modules in Node, drawn by the software renderer.
    const session = await openWorkshop({ record: await sessionRecord(), kernel });
    editor = session.api;
    ready = true;
    process.stderr.write("Editor agent ready (Node workshop, software renderer).\n");
    return;
  }
  const { chromium } = await loadPlaywright();
  if (config.cdp) {
    browser = await chromium.connectOverCDP(config.cdp);
    const matches = browser
      .contexts()
      .flatMap((c) => c.pages())
      .filter((p) => p.url() === config.url);
    if (matches.length !== 1)
      throw new Error(
        "Expected one existing editor tab matching --url exactly",
      );
    page = matches[0];
  } else {
    let url = config.url;
    if (!url) {
      // Rebuild on every start: a preview older than the sources would reject new commands.
      const output = resolve(root, ".editor-preview");
      execFileSync(process.execPath, ["scripts/editor.mjs", "--build"], {
        cwd: root,
        stdio: ["ignore", "ignore", "inherit"],
      });
      server = createPreviewServer({ root: output });
      const { port } = await listen(server, 0, "127.0.0.1");
      url = `http://127.0.0.1:${port}/editor/?lang=en`;
    }
    // --software: the workshop's own software renderer, no GPU process at all.
    if (config.software) {
      const target = new URL(url);
      target.searchParams.set("renderer", "software");
      url = target.href;
    }
    browser = await chromium.launch({
      headless: true,
      // Software WebGL 2 where Chromium has it (the page falls back to its own software
      // renderer where it does not); --gpu uses the machine's GPU through Vulkan.
      args: config.gpu
        ? ["--enable-unsafe-webgpu", "--enable-features=Vulkan,VulkanFromANGLE", "--use-angle=vulkan", "--ignore-gpu-blocklist"]
        : config.software
          ? ["--disable-gpu"]
          : ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
    });
    context = await browser.newContext({
      serviceWorkers: "block",
      viewport: { width: 1440, height: 900 },
    });
    const record = await sessionRecord();
    if (record)
      await context.addInitScript(
        (value) =>
          localStorage.setItem(
            "fun.dev.editor.project.v2:default",
            JSON.stringify(value),
          ),
        record,
      );
    page = await context.newPage();
    await page.goto(url);
  }
  await page.waitForFunction(
    () => window.funEditor?.version >= 3,
    {},
    { timeout: 15000 },
  );
  ready = true;
  const backend = await page
    .evaluate(() => funEditor.inspect().renderer?.backend)
    .catch(() => null);
  process.stderr.write(
    `Editor agent connected (local draft${backend ? `, ${backend === "software" ? "software renderer: no GPU or WebGL here, slower" : backend}` : ""}).\n`,
  );
}
async function persist() {
  if (!config.session || (!page && !editor) || !ready) return;
  const path = resolve(config.session),
    record = editor ? editor.getSession() : await page.evaluate(() => funEditor.getSession());
  if (record.recovery) return { state: "protected" };
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path + ".tmp", JSON.stringify(record));
  await rename(path + ".tmp", path);
  return { state: "saved" };
}
// Local tools pass files by path; the page receives data.
async function localFiles(name, arguments_) {
  if (name !== "fun_editor_setReference" || typeof arguments_?.path !== "string")
    return arguments_;
  const { path, ...rest } = arguments_,
    type = {
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".webp": "image/webp",
      ".gif": "image/gif",
    }[extname(path).toLowerCase()];
  if (!type) throw new Error("Reference images are PNG, JPEG, WebP or GIF files");
  const data = (await readFile(resolve(path))).toString("base64");
  return { ...rest, image: `data:${type};base64,${data}` };
}
// Calls a method of the workshop API: in this process (Node) or in the page. Mutating calls
// are flushed; the result travels as data either way.
async function callEditor(call) {
  if (editor) {
    let applied = false;
    try {
      let value = await editor[call.method](...call.args);
      if (MUTATING.includes(call.method)) {
        applied = true;
        const persistence = await editor.flush();
        if (value && !Array.isArray(value) && typeof value === "object")
          value.persistence = persistence;
      }
      if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) value = undefined;
      return { ok: true, result: value === undefined ? value : structuredClone(value) };
    } catch (e) {
      return {
        ok: false,
        error: { ...errorInfo(e), applied, revision: editor.inspect().revision },
      };
    }
  }
  return page.evaluate(async ({ method, args, mutating }) => {
    let value,
      applied = false;
    try {
      value = await window.funEditor[method](...args);
      if (mutating.includes(method)) {
        applied = true;
        const persistence = await window.funEditor.flush();
        if (value && !Array.isArray(value) && typeof value === "object")
          value.persistence = persistence;
      }
      return { ok: true, result: value };
    } catch (e) {
      const { errorInfo } = await import("/editor/agent-contract.js");
      return {
        ok: false,
        error: {
          ...errorInfo(e),
          applied,
          revision: window.funEditor.inspect().revision,
        },
      };
    }
  }, { ...call, mutating: MUTATING });
}
async function editorState() {
  if (editor) return { revision: editor.inspect().revision, draft: editor.inspect().persistence };
  return page.evaluate(() => ({
    revision: funEditor.inspect().revision,
    draft: funEditor.inspect().persistence,
  }));
}
async function invoke(name, arguments_) {
  arguments_ = await localFiles(name, arguments_);
  // Agents hand over a local file by path; the page receives its bytes.
  if (name === "fun_editor_importGLB" && typeof arguments_?.path === "string") {
    const { path, ...rest } = arguments_;
    arguments_ = {
      ...rest,
      data: (await readFile(resolve(path))).toString("base64"),
    };
  }
  const call = toolInvocation(name, arguments_);
  await start();
  const result = await callEditor(call);
  let sessionPersistence;
  try {
    sessionPersistence = await persist();
  } catch (e) {
    const state = await editorState();
    const mutating = MUTATING.includes(call.method);
    const error = {
      ...errorInfo(e),
      code: "session_storage",
      cause: e.code,
      applied: result.ok ? mutating : result.error.applied,
      revision: state.revision,
      persistence: {
        draft: state.draft,
        session: { state: "failed", path: resolve(config.session) },
      },
      ...(result.ok
        ? { result: result.result }
        : { operationError: result.error }),
      recovery: {
        operationId: arguments_?.operationId ?? null,
        action:
          "Restore session file access, then retry apply with the same operationId; otherwise inspect before issuing another mutation.",
      },
    };
    return {
      isError: true,
      content: [{ type: "text", text: JSON.stringify(error) }],
      structuredContent: { error },
    };
  }
  if (
    result.ok &&
    config.session &&
    result.result &&
    typeof result.result === "object" &&
    !Array.isArray(result.result) &&
    (result.result.persistence || call.method === "flush")
  )
    result.result.sessionPersistence = sessionPersistence;
  if (!result.ok)
    return {
      isError: true,
      content: [{ type: "text", text: JSON.stringify(result.error) }],
      structuredContent: { error: result.error },
    };
  const content = [],
    value = result.result;
  async function asset(data, extension, mimeType) {
    if (config.artifacts) {
      const directory = resolve(config.artifacts);
      await mkdir(directory, { recursive: true });
      const path = resolve(
        directory,
        `editor-${Date.now()}-${++sequence}.${extension}`,
      );
      await writeFile(path, Buffer.from(data, "base64"));
      return { path, mimeType };
    }
    return { data, mimeType };
  }
  async function observations(shots) {
    const metadata = [];
    for (const shot of shots) {
      const { dataUrl, ...meta } = shot,
        data = dataUrl.split(",")[1];
      if (config.mcp)
        content.push({ type: "image", mimeType: shot.mimeType, data });
      metadata.push({
        ...meta,
        ...(config.artifacts
          ? { artifact: await asset(data, "png", shot.mimeType) }
          : config.mcp
            ? {}
            : { dataUrl }),
      });
    }
    return metadata;
  }
  let structured = value;
  if (call.method === "renderViews")
    structured = { observations: await observations(value) };
  else if (
    ["preview", "recipeStage"].includes(call.method) &&
    value.observations
  )
    structured = {
      ...value,
      observations: await observations(value.observations),
    };
  else if (
    ["exportGLB", "exportProject"].includes(call.method) &&
    config.artifacts
  ) {
    const { data, ...meta } = value;
    structured = {
      ...meta,
      artifact: await asset(
        data,
        call.method === "exportProject" ? "funmodel.glb" : "glb",
        value.mimeType,
      ),
    };
  }
  content.unshift({ type: "text", text: JSON.stringify(structured) });
  return { content, structuredContent: structured };
}
async function handle(message) {
  if (!config.mcp) {
    const result = await invoke(
      "fun_editor_" + message.method,
      message.arguments ?? {},
    );
    return result.isError
      ? { ok: false, ...result.structuredContent }
      : { ok: true, result: result.structuredContent };
  }
  if (message.method === "initialize") {
    initialization = true;
    return {
      protocolVersion: [
        "2025-11-25",
        "2025-06-18",
        "2025-03-26",
        "2024-11-05",
      ].includes(message.params?.protocolVersion)
        ? message.params.protocolVersion
        : "2025-11-25",
      capabilities: { tools: {} },
      serverInfo: { name: "fun-dev-model-editor", version: "3.0.0" },
    };
  }
  if (message.method === "ping") return {};
  if (!initialization) throw new Error("Initialize first");
  if (message.method === "tools/list") return { tools: agentTools };
  if (message.method === "tools/call")
    try {
      return await invoke(message.params.name, message.params.arguments ?? {});
    } catch (e) {
      const error = { ...errorInfo(e), applied: false };
      if (ready)
        error.revision = await editorState()
          .then((state) => state.revision)
          .catch(() => undefined);
      return {
        isError: true,
        content: [{ type: "text", text: JSON.stringify(error) }],
        structuredContent: { error },
      };
    }
  throw new Error("Unknown method");
}
// --run: one model script, one JSON line of output, exit code 1 on failure.
const lines = config.run
  ? []
  : createInterface({ input: process.stdin, crlfDelay: Infinity });
if (!config.run) {
  process.once("SIGINT", () => lines.close());
  process.once("SIGTERM", () => lines.close());
}
try {
  if (config.run)
    try {
      await start();
      process.stdout.write(JSON.stringify(await runScript(config.run, invoke)) + "\n");
    } catch (e) {
      process.stdout.write(JSON.stringify({ ok: false, error: compactError(e) }) + "\n");
      process.exitCode = 1;
    }
  for await (const line of lines) {
    if (!line.trim()) continue;
    let message;
    try {
      message = JSON.parse(line);
      if (config.mcp && message.id === undefined) continue;
      const result = await handle(message);
      process.stdout.write(
        JSON.stringify(
          config.mcp ? { jsonrpc: "2.0", id: message.id, result } : result,
        ) + "\n",
      );
    } catch (e) {
      process.stdout.write(
        JSON.stringify(
          config.mcp
            ? {
                jsonrpc: "2.0",
                id: message?.id ?? null,
                error: { code: message ? -32601 : -32700, message: e.message },
              }
            : { ok: false, error: errorInfo(e) },
        ) + "\n",
      );
    }
  }
} finally {
  try {
    await persist();
  } finally {
    // For connectOverCDP this closes the transport, not the user's browser.
    await browser?.close();
    server?.close();
    if (sessionLock) {
      await sessionLock.close();
      await unlink(resolve(config.session) + ".lock");
    }
  }
}
}

// `node scripts/editor-agent.mjs …` runs it; the published launcher imports it and calls main.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
