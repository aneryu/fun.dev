// Run after duck-morphs.mjs through editor-script.mjs.
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import assert from "node:assert/strict";

export default async function(ws) {
  const input = JSON.parse(await readFile(process.env.DUCK_PROJECT ?? "test-results/duck-morphs/authored.json", "utf8"));
  const out = resolve("test-results/duck-character"); await mkdir(out, { recursive: true });
  const initial = await ws.candidate({ project: input.project ?? input });
  assert.ok(initial.ok); await ws.accept(initial);
  const project = await ws.call("getProject");
  const commands = ["blink", "smile", "surprise"].map(id => ({
    op: "characterControl", id, bindings: project.nodes.filter(n => n.morph).map(n =>
      ({ node: n.id, channel: "morph", target: id, gain: 1 })),
  }));
  const poses = { blink: { blink: 1 }, smile: { smile: 1 }, surprise: { surprise: 1 },
    combination: { blink: .5, smile: .5 } };
  for (const [name, values] of Object.entries(poses)) commands.push({
    op: "characterClip", name, duration: 1, fps: 12, loop: true,
    tracks: ["blink", "smile", "surprise"].map(control => ({
      control, channel: "control", keys: [
        { time: 0, value: 0 }, { time: .5, value: values[control] ?? 0 }, { time: 1, value: 0 },
      ],
    })),
  });
  const authored = await ws.candidate({ commands, file: resolve(out, "authored.json") });
  assert.ok(authored.ok, JSON.stringify(authored.error)); await ws.accept(authored);
  const neutral = await ws.call("getProject");
  for (const name of Object.keys(poses)) {
    const baseline = await ws.candidate({ project: neutral });
    const candidate = await ws.candidate({ project: neutral, commands: [
      { op: "characterPose", name, time: .5 },
    ], file: resolve(out, `${name}.json`) });
    assert.ok(candidate.ok, JSON.stringify(candidate.error));
    await ws.compare({ baseline, candidate, file: resolve(out, `${name}.html`), views: {
      front: { view: "front", size: 512 }, side: { view: "left", size: 512 },
      oblique: { view: "perspective", size: 512 },
    } });
  }
  await ws.exportProject({ file: resolve(out, "duck.funmodel.glb") });
  await ws.exportGLB({ file: resolve(out, "duck.glb") });
  const roundtrip = await ws.verifyExport({ file: resolve(out, "roundtrip.json") });
  assert.deepEqual(roundtrip.editable.scope.changed, []);
  await writeFile(resolve(out, "acceptance.json"), JSON.stringify({ controls: 3, clips: 4,
    editableRoundtrip: true, genericGLBImport: "Clip authoring data requires editable source; generic import still skips animation." }, null, 2));
  return { outputs: out, controls: 3, clips: 4 };
}
