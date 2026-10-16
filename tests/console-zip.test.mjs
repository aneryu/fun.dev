import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { groupVersions, readZip } from "../console/zip.js";
import { inspectVersion } from "../server/model-rules.js";
import { boxGLB } from "./helpers/models.mjs";

test("the console reads deflated and stored zip entries and groups them into versions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "console-zip-"));
  const zip = join(directory, "upload.zip");
  const glb = Buffer.from(boxGLB({ size: [0.5, 1, 0.5] })).toString("base64");
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2]).toString("base64");
  // A Drive-style download: a top folder, a Finder leftover, one stored and one deflated entry.
  execFileSync("python3", ["-I", "-c", `
import base64, sys, zipfile
with zipfile.ZipFile(sys.argv[1], "w") as z:
    z.writestr("fundev-upload/lamp_01/v001/meta.json", '{"name":{"zh":"灯","en":"Lamp"},"type":"prop","description":{"zh":"台灯。","en":"A lamp."}}', zipfile.ZIP_DEFLATED)
    z.writestr("fundev-upload/lamp_01/v001/model.glb", base64.b64decode(sys.argv[2]), zipfile.ZIP_DEFLATED)
    z.writestr("fundev-upload/lamp_01/v001/preview.png", base64.b64decode(sys.argv[3]), zipfile.ZIP_STORED)
    z.writestr("fundev-upload/lamp_01/v001/.DS_Store", "x")
    z.writestr("__MACOSX/fundev-upload/lamp_01/v001/._model.glb", "x")
    z.writestr("fundev-upload/notes.txt", "ignored")
`, zip, glb, png]);
  const files = await readZip(new Blob([await readFile(zip)]));
  const versions = groupVersions(files);
  assert.deepEqual(versions.map((version) => [version.id, version.version, version.files.map((file) => file.name).sort()]), [["lamp_01", "v001", ["model.glb", "preview.png"]]]);
  // The upload page adds the thumbnail it renders before checking.
  const result = inspectVersion({ ...versions[0], files: [...versions[0].files, { name: "thumbnail.png", bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) }] });
  assert.deepEqual(result.problems, []);
  assert.deepEqual(result.stats.size, [0.5, 1, 0.5]);
  // Without WebGL the page uploads no thumbnail: a warning for review, not a problem.
  const plain = inspectVersion(versions[0]);
  assert.deepEqual(plain.problems, []);
  assert.match(plain.warnings.join(), /no thumbnail yet/);
  await assert.rejects(readZip(new Blob([Buffer.from("not a zip")])), /not a zip file/);
  await rm(directory, { recursive: true, force: true });
});
