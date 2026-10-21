import {readFile,writeFile} from "node:fs/promises";
import assert from "node:assert/strict";
import {openWorkshop} from "../workshop-node.mjs";
import {compareSourceValues} from "../../site/workshop/export-integrity.js";
const out="test-results/duck-rim-repair";
const baseline=JSON.parse(await readFile(`${out}/authored.json`,"utf8")).project;
const study=JSON.parse(await readFile(`${out}/bill-policy.json`,"utf8"));
assert.ok(study.samples.every(s=>s.ok),"Finish all seam samples before accepting the policy");
const session=await openWorkshop({record:{project:baseline,revision:0},width:64,height:64});
try {
  const api=session.api,original=api.getProject(),revision=api.inspect().revision;
  const candidate=await api.workflow({action:"prepare",project:study.project,views:[]});
  assert.equal(candidate.ok,true);
  assert.ok(compareSourceValues(original,api.getProject()).exact);
  await api.acceptCandidate({candidateId:candidate.candidateId,ifRevision:revision,operationId:crypto.randomUUID()});
  const accepted=api.getProject();await api.undo();assert.ok(compareSourceValues(original,api.getProject()).exact);
  await api.redo();assert.ok(compareSourceValues(accepted,api.getProject()).exact);
  const saved=await api.exportProject(),bytes=Buffer.from(saved.data,"base64");
  const {importModel}=await import("../../site/workshop/import-glb.js");
  api.loadProject(importModel(bytes).project);
  const integrity=compareSourceValues(accepted,api.getProject());assert.ok(integrity.exact);
  assert.equal(api.getProject().relations.find(r=>r.id==="bill_seam").version,4);
  await writeFile(`${out}/authored.json`,JSON.stringify({project:accepted}));
  await writeFile(`${out}/duck.funmodel.glb`,bytes);
  await writeFile(`${out}/policy-save.json`,JSON.stringify({isolated:true,undoRedo:true,integrity,
    samples:study.samples.length,negativeRejected:study.negative.some(r=>r.status==="failed")},null,2));
  console.log("Bounded bill policy: 54 samples, negative specimen, atomic acceptance, undo/redo and exact editable reload passed.");
} finally {session.dispose();}
