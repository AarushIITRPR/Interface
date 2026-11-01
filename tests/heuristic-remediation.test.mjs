import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const source=await readFile(new URL('../lib/subject-navigation.ts',import.meta.url),'utf8');
const js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext}}).outputText;
const {subjectNavigationTarget:target}=await import('data:text/javascript;base64,'+Buffer.from(js).toString('base64'));
const types=['setup','baseline','clip','sam','nback','gate','bodyscan','end'];
test('navigation respects study lifecycle, bounds and instructor gates',()=>{
  for(const status of ['setup','paused','complete','aborted'])assert.equal(target(status,3,types,1),null);
  assert.equal(target('running',3,types,-1),2);
  assert.equal(target('running',3,types,1),4);
  assert.equal(target('running',1,types,-1),null);
  assert.equal(target('running',0,types,1),null);
  assert.equal(target('running',5,types,1),null);
  assert.equal(target('running',5,types,-1),4);
  assert.equal(target('running',6,types,1),null);
  for(const invalid of [0,2,-2,NaN])assert.equal(target('running',3,types,invalid),null);
});
test('subject actions carry visit identity and navigation is explicitly logged',async()=>{
  const engine=await readFile(new URL('../lib/session-engine.ts',import.meta.url),'utf8');
  const subject=await readFile(new URL('../app/subject/subject-portal.tsx',import.meta.url),'utf8');
  assert.match(engine,/payload\.expectedStepStartedAt !== current\.stepStartedAt/);
  assert.match(engine,/disposition:"interrupted"/);
  assert.match(subject,/expectedAttempt:snapshot.attempt/);
  assert.match(subject,/aria-checked=\{values\[stage\]===value\}/);
  assert.match(subject,/pending.current=true;setSaving\(true\)/);
  assert.doesNotMatch(subject,/setTimeout\(\(\)=>setStage/);
});
function luminance(hex){const c=hex.match(/\w\w/g).map(v=>parseInt(v,16)/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4);return .2126*c[0]+.7152*c[1]+.0722*c[2];}
test('primary, muted and healthy text tokens meet 4.5:1 on both paper surfaces',()=>{
  for(const fg of ['1c2936','535e68','17694f'])for(const bg of ['f1ece2','f9f5ee']){
    const ratio=(luminance(bg)+.05)/(luminance(fg)+.05);
    assert.ok(ratio>=4.5,`${fg}/${bg}: ${ratio}`);
  }
});
