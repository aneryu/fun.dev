// Accept only the isolated, fully checked backing refinement, then reload exactly.
import {readFile,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {openWorkshop} from '../workshop-node.mjs';
import {compareSourceValues} from '../../site/workshop/export-integrity.js';
const out='test-results/duck-backing-jaw';
const {project}=JSON.parse(await readFile('test-results/duck-cheeks/authored.json'));
const study=JSON.parse(await readFile(`${out}/study.json`));
assert.ok(study.samples.every(s=>s.ok)&&study.negativeRejected);
const session=await openWorkshop({record:{project,revision:0},width:64,height:64});
try {
 const api=session.api,before=api.getProject(),revision=api.inspect().revision;
 const candidate=await api.workflow({action:'prepare',project:study.project,views:[]});assert.equal(candidate.ok,true);
 assert.ok(compareSourceValues(before,api.getProject()).exact);
 await api.acceptCandidate({candidateId:candidate.candidateId,ifRevision:revision,operationId:crypto.randomUUID()});
 const accepted=api.getProject();
 assert.ok(compareSourceValues(before.nodes.filter(n=>n.id!=='oral_backing'),accepted.nodes.filter(n=>n.id!=='oral_backing')).exact);
 await api.undo();assert.ok(compareSourceValues(before,api.getProject()).exact);
 await api.redo();assert.ok(compareSourceValues(accepted,api.getProject()).exact);
 const exported=await api.exportProject(),bytes=Buffer.from(exported.data,'base64');
 const {importModel}=await import('../../site/workshop/import-glb.js');api.loadProject(importModel(bytes).project);
 const integrity=compareSourceValues(accepted,api.getProject());assert.ok(integrity.exact);
 await writeFile(`${out}/authored.json`,JSON.stringify({project:accepted}));
 await writeFile(`${out}/duck.funmodel.glb`,bytes);
 await writeFile(`${out}/save.json`,JSON.stringify({isolated:true,otherNodesUnchanged:true,undoRedo:true,integrity,samples:study.samples.length,negativeRejected:true}));
 console.log('Backing refinement: atomic acceptance, other nodes preserved, undo/redo and exact editable reload passed.');
}finally{session.dispose();}
