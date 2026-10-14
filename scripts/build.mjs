import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { transform } from "esbuild";
import { gameOrigin } from "./game-origin.mjs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const output = new URL("dist/", root);
const origin = gameOrigin(process.env.FUNDEV_GAME_ORIGIN);
await rm(output, { recursive: true, force: true });
await cp(new URL("site/", root), output, {
  recursive: true,
  // A source bundle is independently editable/testable; publish only its runtime files.
  filter: (path) => !/[/\\]games[/\\][^/\\]+[/\\][^/\\]+[/\\](?:dev|package\.json|README\.md)(?:[/\\]|$)/.test(path),
});
const vendor = new URL("vendor/three/", output);
await mkdir(vendor, { recursive: true });
for (const name of ["three.module.js", "three.core.js"]) {
  const source = await readFile(new URL(`node_modules/three/build/${name}`, root), "utf8");
  const result = await transform(source, { loader: "js", minify: true, target: "es2022", legalComments: "eof" });
  await writeFile(new URL(name, vendor), result.code);
}
await cp(new URL("node_modules/three/LICENSE", root), new URL("LICENSE.txt", vendor));
const skillFiles = ["SKILL.md", "agents/openai.yaml", "assets/game.js", "references/runtime.md", "references/release.md", "references/security.md"];
const skillOutput = new URL("skills/fun-dev-games/", output);
for (const file of skillFiles) {
  const target = new URL(file, skillOutput);
  await mkdir(new URL("./", target), { recursive: true });
  await cp(new URL(`skills/fun-dev-games/${file}`, root), target);
}
execFileSync("tar", ["-czf", fileURLToPath(new URL("skills/fun-dev-games.tar.gz", output)), "-C", fileURLToPath(new URL("skills/", output)), ...skillFiles.map((file) => `fun-dev-games/${file}`)]);
await writeFile(new URL("game-source.js", output), `export const gameOrigin = ${JSON.stringify(origin)};\n`);
await writeFile(new URL("progress-config.js", output), `export const transferProgress = ${process.env.FUNDEV_TRANSFER === "1"};\n`);
if (origin) {
  // The deployed website contains no bundled registry or game releases.
  const { readdir } = await import("node:fs/promises");
  for (const entry of await readdir(new URL("games/", output), { withFileTypes: true })) {
    if (entry.isDirectory()) await rm(new URL(`games/${entry.name}/`, output), { recursive: true });
  }
  await rm(new URL("games.json", output));
  const path = new URL("_headers", output);
  const headers = (await readFile(path, "utf8"))
    .replace("script-src 'self'", `script-src 'self' ${origin}`)
    .replace("connect-src 'self'", `connect-src 'self' ${origin}`)
    .replace("; base-uri", `; img-src 'self' ${origin}; media-src 'self' ${origin}; base-uri`);
  await writeFile(path, headers);
}
console.log("Built dist/ with the pinned, locally served Three.js runtime.");
