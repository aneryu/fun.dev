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
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { execFileSync } from "node:child_process";
import { chromium } from "playwright";
import { createPreviewServer, listen } from "./preview-server.mjs";
import { agentTools, toolInvocation } from "../site/editor/agent-tools.js";
import { errorInfo } from "../site/editor/agent-contract.js";
import { normalizeProject } from "../site/editor/document.js";

const root = fileURLToPath(new URL("../", import.meta.url)),
  args = process.argv.slice(2),
  config = {};
// The published single-file tool (cdn.fun.dev/tools/fundev-workshop.mjs) is built with a
// default URL: it drives the live workshop and needs no repository, only Playwright.
const defaultUrl = process.env.FUNDEV_WORKSHOP_URL || undefined;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--mcp") config.mcp = true;
  else if (args[i] === "--gpu") config.gpu = true;
  else if (
    ["--session", "--project", "--artifacts", "--cdp", "--url"].includes(
      args[i],
    )
  ) {
    const key = args[i].slice(2);
    if (!args[i + 1] || args[i + 1].startsWith("--"))
      throw new Error("Missing " + args[i]);
    config[key] = args[++i];
  } else if (args[i] === "--help") {
    console.log(
      `node ${defaultUrl ? "fundev-workshop.mjs" : "scripts/editor-agent.mjs"} [--mcp] [--session state.json] [--project model.funmodel.json] [--artifacts directory] [--url ${defaultUrl ?? "https://fun.dev/editor/"}] [--gpu]\nExisting browser: --cdp http://127.0.0.1:9222 --url <exact editor tab URL>\nCLI stdin: one JSON {"method":"inspect","arguments":{}} per line; stdout: JSON results.\n${defaultUrl ? "Needs Playwright beside this file: npm i playwright && npx playwright install chromium" : "Build the editor first (npm run editor -- --build), or pass --url to drive a published workshop."}`,
    );
    process.exit(0);
  } else throw new Error("Unknown option " + args[i]);
}
config.url ??= config.cdp ? undefined : defaultUrl;
if (config.cdp && (!config.url || config.project || config.session))
  throw new Error(
    "Existing-tab mode requires --url and does not load a project or session",
  );
let browser,
  context,
  page,
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
      const output = resolve(root, ".editor-preview");
      await access(resolve(output, "editor/index.html")).catch(() =>
        execFileSync(process.execPath, ["scripts/editor.mjs", "--build"], {
          cwd: root,
          stdio: ["ignore", "ignore", "inherit"],
        }),
      );
      server = createPreviewServer({ root: output });
      const { port } = await listen(server, 0, "127.0.0.1");
      url = `http://127.0.0.1:${port}/editor/?lang=en`;
    }
    browser = await chromium.launch({
      headless: true,
      // Software WebGL 2 works everywhere; --gpu uses the machine's GPU through Vulkan.
      args: config.gpu
        ? ["--enable-unsafe-webgpu", "--enable-features=Vulkan,VulkanFromANGLE", "--use-angle=vulkan", "--ignore-gpu-blocklist"]
        : ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
    });
    context = await browser.newContext({
      serviceWorkers: "block",
      viewport: { width: 1440, height: 900 },
    });
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
      record = {
        project: JSON.parse(await readFile(resolve(config.project), "utf8")),
        revision: 0,
      };
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
  process.stderr.write("Editor agent connected (local draft).\n");
}
async function persist() {
  if (!config.session || !page || !ready) return;
  const path = resolve(config.session),
    record = await page.evaluate(() => funEditor.getSession());
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
async function invoke(name, arguments_) {
  arguments_ = await localFiles(name, arguments_);
  const call = toolInvocation(name, arguments_);
  await start();
  const result = await page.evaluate(async ({ method, args }) => {
    let value,
      applied = false;
    try {
      value = await window.funEditor[method](...args);
      if (
        [
          "apply",
          "loadProject",
          "undo",
          "redo",
          "checkpoint",
          "restoreCheckpoint",
          "removeCheckpoint",
        ].includes(method)
      ) {
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
  }, call);
  let sessionPersistence;
  try {
    sessionPersistence = await persist();
  } catch (e) {
    const state = await page.evaluate(() => ({
      revision: funEditor.inspect().revision,
      draft: funEditor.inspect().persistence,
    }));
    const mutating = [
      "apply",
      "loadProject",
      "undo",
      "redo",
      "checkpoint",
      "restoreCheckpoint",
      "removeCheckpoint",
    ].includes(call.method);
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
  else if (call.method === "exportGLB" && config.artifacts) {
    const { data, ...meta } = value;
    structured = {
      ...meta,
      artifact: await asset(data, "glb", value.mimeType),
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
        error.revision = await page
          .evaluate(() => funEditor.inspect().revision)
          .catch(() => undefined);
      return {
        isError: true,
        content: [{ type: "text", text: JSON.stringify(error) }],
        structuredContent: { error },
      };
    }
  throw new Error("Unknown method");
}
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
process.once("SIGINT", () => lines.close());
process.once("SIGTERM", () => lines.close());
try {
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
