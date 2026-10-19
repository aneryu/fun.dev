import { cp, mkdir } from "node:fs/promises";
import { watchFile } from "node:fs";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildThree } from "./build-three.mjs";
import { createPreviewServer, listen } from "./preview-server.mjs";

const root = new URL("../", import.meta.url),
  output = new URL(".editor-preview/", root);
const args = process.argv.slice(2);
if (args.some((arg) => !["--verify", "--build"].includes(arg)))
  throw new Error("Usage: npm run editor [-- --build|--verify]");
async function build() {
  execFileSync(process.execPath, ["scripts/check.mjs", "--editor"], {
    cwd: root,
    stdio: "inherit",
  });
  await mkdir(output, { recursive: true });
  for (const path of [
    "editor",
    "platform.css",
    "i18n.js",
    "favicon.svg",
    "_headers",
    "404.html",
    "runtime/three.js",
    "runtime/kit/assets.js",
    // "Open in workshop" reads the model library through the site's own catalog module.
    "models-catalog.js",
    "game-source.js",
  ]) {
    await mkdir(new URL("./", new URL(path, output)), { recursive: true });
    await cp(new URL(`site/${path}`, root), new URL(path, output), {
      recursive: true,
    });
  }
  await buildThree(root, output);
}
await build();
if (args.includes("--verify")) {
  execFileSync(
    process.execPath,
    [
      "--test",
      "tests/editor.test.mjs",
      "tests/editor-agent.test.mjs",
      "tests/editor-draft.test.mjs",
      "tests/editor-import.test.mjs",
    ],
    { cwd: root, stdio: "inherit" },
  );
  const { launch, serve } = await import("./browser/harness.mjs");
  const { editorChecks } = await import("./browser/editor.mjs");
  const { editorAdapterChecks } = await import("./browser/editor-adapter.mjs");
  const server = await serve(resolve(fileURLToPath(output))),
    browser = await launch();
  try {
    await editorChecks({ browser, base: server.base });
    await editorAdapterChecks();
    const { editorToolChecks } = await import("./browser/editor-tool.mjs");
    await editorToolChecks({ base: server.base, output: resolve(fileURLToPath(output)) });
    console.log(
      "Editor: project round trip, GLB runtime load, desktop editing and draft-lock checks passed.",
    );
  } finally {
    await browser.close();
    server.close();
  }
} else if (!args.includes("--build")) {
  const server = createPreviewServer({
    root: resolve(fileURLToPath(output)),
    handle(request, response) {
      const { pathname } = new URL(request.url, "http://localhost");
      if (pathname === "/") {
        response.writeHead(302, { Location: "/workshop/" });
        response.end();
        return true;
      }
      // This preview serves only the workshop; the Games link goes to the real lobby.
      if (pathname === "/games") {
        response.writeHead(302, { Location: "https://fun.dev/games" });
        response.end();
        return true;
      }
      return false;
    },
  });
  const { port } = await listen(
    server,
    Number(process.env.PORT || 8001),
    "127.0.0.1",
  );
  console.log(
    `Workshop: http://127.0.0.1:${port}/workshop/ (local preview; refresh after edits)`,
  );
  let running = false,
    pending = false,
    timer;
  async function rebuild() {
    if (running) {
      pending = true;
      return;
    }
    running = true;
    do {
      pending = false;
      try {
        await build();
        console.log("Editor rebuilt; refresh the tab.");
      } catch (error) {
        console.error(error.message);
      }
    } while (pending);
    running = false;
  }
  const files = [
    ...(await readdir(new URL("site/workshop/", root))).map(
      (file) => `site/workshop/${file}`,
    ),
    "site/i18n.js",
    "site/platform.css",
    "scripts/build-three.mjs",
    "scripts/editor-tools.js",
  ];
  for (const path of files) {
    watchFile(new URL(path, root), { interval: 1000 }, (current, previous) => {
      if (
        current.mtimeMs === previous.mtimeMs &&
        current.size === previous.size
      )
        return;
      clearTimeout(timer);
      timer = setTimeout(rebuild, 200);
    });
  }
}
