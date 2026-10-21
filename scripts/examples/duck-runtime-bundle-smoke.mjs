// Run with the built standalone workshop bundle, without --connect.
import {readFile} from "node:fs/promises";
import assert from "node:assert/strict";
import {resolve} from "node:path";
export default async ws=>{
  const {project}=JSON.parse(await readFile("test-results/duck-cheeks/authored.json"));
  const candidate=await ws.candidate({project});assert.equal(candidate.ok,true);await ws.accept(candidate);
  const result=await ws.verifyRuntime({runtimeFile:resolve("test-results/duck-cheeks/duck.fun3d"),
    poses:[{clip:"mouth_close",time:.5},{clip:"walk",time:.3}],file:resolve("test-results/duck-cheeks/bundled-runtime-check.json")});
  assert.equal(result.ok,true);assert.equal(result.currentUnchanged,true);
  return {status:result.status,provenance:result.provenance,poses:result.samples.length};
};
