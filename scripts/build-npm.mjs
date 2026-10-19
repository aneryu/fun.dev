import { readFile, writeFile } from "node:fs/promises";
import { bundleWorkshop } from "./workshop-bundle.mjs";

// npm run workshop:npm: fills packages/fundev-workshop/ for `npm publish` with the same
// workshop file the site serves (scripts/workshop-bundle.mjs) and the licences it bundles.
// Release: bump the version in packages/fundev-workshop/package.json, run this, then
// `npm publish packages/fundev-workshop` (docs/model-editor.md "Agents without the repository").
const root = new URL("../", import.meta.url),
  dir = new URL("packages/fundev-workshop/", root);
const bytes = await bundleWorkshop(root);
await writeFile(new URL("workshop.mjs", dir), bytes);
const licence = (path) => readFile(new URL(path, root), "utf8");
await writeFile(
  new URL("THIRD_PARTY_LICENSES.md", dir),
  `# Third-party licences

\`workshop.mjs\` bundles these packages.

## three (Three.js), MIT

${await licence("node_modules/three/LICENSE")}

## manifold-3d, Apache-2.0

${await licence("node_modules/manifold-3d/LICENSE")}
`,
);
const { version } = JSON.parse(await readFile(new URL("package.json", dir), "utf8"));
console.log(`packages/fundev-workshop ${version}: workshop.mjs ${(bytes.length / 1024 / 1024).toFixed(2)} MB`);
