import {readFile,writeFile} from "node:fs/promises";
import assert from "node:assert/strict";
import {openWorkshop} from "../workshop-node.mjs";
import {compareSourceValues} from "../../site/workshop/export-integrity.js";
const out="test-results/duck-cheeks";
const baseline=JSON.parse(await readFile("test-results/duck-rim-repair/authored.json","utf8")).project;
const study=JSON.parse(await readFile(`${out}/study.json`,"utf8"));
assert.ok(study.samples.every(s=>s.ok),"Finish all seam samples before accepting the policy");
assert.equal(study.negativeRejected,true,"The detached-wall regression must fail before acceptance");
const session=await openWorkshop({record:{project:baseline,revision:0},width:64,height:64});
try {
  const api=session.api,original=api.getProject(),revision=api.inspect().revision;
  const candidate=await api.workflow({action:"prepare",project:study.project,views:[]});
  assert.equal(candidate.ok,true);
  assert.ok(compareSourceValues(original,api.getProject()).exact);
  await api.acceptCandidate({candidateId:candidate.candidateId,ifRevision:revision,operationId:crypto.randomUUID()});
  const accepted=api.getProject();
  const oldIds=new Set(original.nodes.map(n=>n.id));
  assert.ok(compareSourceValues(original.nodes,accepted.nodes.filter(n=>oldIds.has(n.id))).exact,'Existing character nodes must remain unchanged');
  await api.undo();assert.ok(compareSourceValues(original,api.getProject()).exact);
  await api.redo();assert.ok(compareSourceValues(accepted,api.getProject()).exact);
  const saved=await api.exportProject(),bytes=Buffer.from(saved.data,"base64");
  const {importModel}=await import("../../site/workshop/import-glb.js");
  api.loadProject(importModel(bytes).project);
  const integrity=compareSourceValues(accepted,api.getProject());assert.ok(integrity.exact);
  assert.equal(api.getProject().relations.find(r=>r.id==="bill_seam").version,4);
  await writeFile(`${out}/authored.json`,JSON.stringify({project:accepted}));
  await writeFile(`${out}/duck.funmodel.glb`,bytes);
  await writeFile(`${out}/policy-save.json`,JSON.stringify({isolated:true,undoRedo:true,integrity,
    samples:study.samples.length,negativeRejected:study.negativeRejected},null,2));
  console.log("Oral side walls: existing character nodes preserved; 54 samples, negative specimen, atomic acceptance, undo/redo and exact editable reload passed.");
} finally {session.dispose();}
