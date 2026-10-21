// Reopen the final source and exercise another ordinary, isolated authoring edit.
// The accepted baseline is read-only; all outputs stay in duck-final-reedit.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {openWorkshop} from '../workshop-node.mjs';
import {evaluateProject} from '../../site/workshop/document.js';
import {compareSourceValues} from '../../site/workshop/export-integrity.js';
import {worldMatrix,point} from '../../site/workshop/spatial.js';

const source='test-results/duck-backing-jaw',out='test-results/duck-final-reedit';
const input=await readFile(`${source}/authored.json`),binary=await readFile(`${source}/duck.funmodel.glb`);
const {project}=JSON.parse(input),sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
await mkdir(out,{recursive:true});
const report={version:1,source:{path:source,jsonSha256:sha256(input),editableSha256:sha256(binary)},
 isolated:true,accepted:false,continuousMotionChecked:false};
const session=await openWorkshop({record:{project,revision:0},width:64,height:64});
try {
 const {importModel}=await import('../../site/workshop/import-glb.js');
 const {checkRelations}=await import('../../site/workshop/relation-checks.js');
 const api=session.api,imported=importModel(binary).project;
 report.initialStoredIntegrity=compareSourceValues(project,imported);
 assert.ok(report.initialStoredIntegrity.exact,'Embedded source differs from saved authored source');
 api.loadProject(imported);
 const before=api.getProject(),revision=api.inspect().revision;
 report.initialEvaluatedIntegrity=compareSourceValues(project,before);
 assert.ok(report.initialEvaluatedIntegrity.exact,'Reopened source differs after evaluation');
 const head=before.nodes.find(n=>n.id==='head'),chin=head.mesh.vertices.flatMap((v,i)=>v[1]<=-.65?[i]:[]);
 const walk=structuredClone(before.character.clips.find(c=>c.name==='walk'));
 const key=walk.tracks.find(t=>t.node==='wing_left_joint'&&t.channel==='rotation').keys.find(k=>k.time===.3);
 const previousKey=structuredClone(key);key.value[2]+=1;
 const commands=[
  {op:'recipeParameters',id:'head',values:{headWidth:.09,foreheadWidth:.135}},
  ...['upper_bill','lower_bill'].map(id=>({op:'recipeParameters',id,values:{extraThickness:.027}})),
  {op:'characterClip',...walk},
 ];
 report.commands=commands;report.previousKey=previousKey;report.editedKey=key;
 const candidate=await api.workflow({action:'prepare',commands,ifRevision:revision,
  protectedVertices:{head:chin},protectedIds:['body','foot_left','foot_right'],views:[],detail:'full'});
 await writeFile(`${out}/candidate.json`,JSON.stringify(candidate));
 report.candidate={ok:candidate.ok,scope:candidate.scope,error:candidate.error,validation:candidate.validation};
 assert.ok(compareSourceValues(before,api.getProject()).exact);
 assert.equal(api.inspect().revision,revision);report.previewPreservedCurrent=true;
 if(!candidate.ok){report.failure='candidate-rejected';throw new Error('Final re-edit candidate rejected; inspect candidate.json');}
 const authored=candidate.project,changedHead=authored.nodes.find(n=>n.id==='head');
 report.parameterChanges=commands.filter(c=>c.op==='recipeParameters').flatMap(c=>Object.entries(c.values).map(([parameter,expected])=>{
  const previous=before.nodes.find(n=>n.id===c.id).recipe.parameters[parameter].value;
  const actual=authored.nodes.find(n=>n.id===c.id).recipe.parameters[parameter].value;
  assert.equal(actual,expected);assert.notEqual(previous,actual);
  return {node:c.id,parameter,before:previous,after:actual};
 }));
 for(const index of chin)assert.deepEqual(changedHead.mesh.vertices[index],head.mesh.vertices[index]);
 report.protectedChin=chin;
 report.attachments=authored.nodes.filter(n=>n.attachment&&n.attachment.mode!=='deform'&&n.attachment.offset===0).map(n=>{
  const a=n.attachment,target=authored.nodes.find(t=>t.id===a.target);
  const positions=a.vertices.map(i=>point(worldMatrix(authored,target.id),target.mesh.vertices[i]));
  const expected=[0,1,2].map(k=>positions.reduce((sum,p,i)=>sum+p[k]*a.weights[i],0));
  const actual=point(worldMatrix(authored,n.id),a.anchor),errorMetres=Math.hypot(...actual.map((v,k)=>v-expected[k]));
  assert.ok(errorMetres<1e-8,`${n.id} attachment drifted`);return {id:n.id,errorMetres};
 });
 assert.equal(authored.relations.length,37);
 report.samples=[];
 for(const spec of JSON.parse(await readFile('test-results/duck-integrated/samples.json')).samples){
  const p=structuredClone(authored);delete p.character.pose;
  if(spec.pose)p.character.pose={clip:spec.pose.name,time:spec.pose.time};else p.character.values={...p.character.values,...spec.values};
  const checked=checkRelations(evaluateProject(p));
  report.samples.push({values:spec.values,pose:spec.pose,ok:checked.ok,relations:checked.results.map(r=>({id:r.id,status:r.status,reason:r.reason})),
   failures:checked.results.filter(r=>r.status!=='passed')});
 }
 assert.equal(report.samples.length,54);
 if(!report.samples.every(s=>s.ok)){report.failure='sampled-relations';throw new Error('Final re-edit contact checks failed; inspect report.json');}
 await api.acceptCandidate({candidateId:candidate.candidateId,ifRevision:revision,operationId:crypto.randomUUID()});
 const accepted=api.getProject();assert.ok(compareSourceValues(authored,accepted).exact);
 await api.undo();assert.ok(compareSourceValues(before,api.getProject()).exact);
 await api.redo();assert.ok(compareSourceValues(accepted,api.getProject()).exact);report.undoRedo=true;
 const exported=await api.exportProject(),bytes=Buffer.from(exported.data,'base64');
 const reread=importModel(bytes).project;report.storedIntegrity=compareSourceValues(accepted,reread);
 api.loadProject(reread);report.evaluatedIntegrity=compareSourceValues(accepted,api.getProject());
 assert.ok(report.storedIntegrity.exact&&report.evaluatedIntegrity.exact);
 await writeFile(`${out}/authored.json`,JSON.stringify({project:accepted}));
 await writeFile(`${out}/duck.funmodel.glb`,bytes);
 report.accepted=true;report.outputEditableSha256=sha256(bytes);
 console.log(JSON.stringify({ok:true,samples:report.samples.length,relations:37,attachments:report.attachments.length,
  protectedChin:chin.length,undoRedo:true,exactReload:true,out}));
}catch(error){report.error={message:error.message,stack:error.stack};throw error;}
finally{
 report.baselineUnchanged=(await readFile(`${source}/authored.json`)).equals(input)&&(await readFile(`${source}/duck.funmodel.glb`)).equals(binary);
 await writeFile(`${out}/report.json`,JSON.stringify(report,null,2));session.dispose();
 assert.ok(report.baselineUnchanged,'Accepted baseline changed during isolated acceptance');
}
