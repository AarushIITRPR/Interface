import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {rolldown} from 'rolldown';

// Real session SQL, transition code and recording commands. Only D1's transport,
// the clock and hardware reports are substituted. No participant database is used.
const sqlite=new DatabaseSync(':memory:');
function prepare(sql,args=[]) {
  return {bind:(...values)=>prepare(sql,values),first:()=>sqlite.prepare(sql).get(...args),
    run:()=>({meta:sqlite.prepare(sql).run(...args)}),all:()=>({results:sqlite.prepare(sql).all(...args)})};
}
globalThis.testBindings={DB:{prepare,batch:statements=>statements.map(s=>s.run())}};
const bundle=await rolldown({input:'lib/session-engine.ts',plugins:[{name:'local-d1',resolveId:id=>id==='cloudflare:workers'?'virtual:bindings':null,
  load:id=>id==='virtual:bindings'?'export const env=globalThis.testBindings':null}]});
const output=await bundle.generate({format:'es'});await bundle.close();
const {createSession,mutateSession,toSubjectSnapshot,acquisitionCommand}=await import('data:text/javascript;base64,'+Buffer.from(output.output[0].code).toString('base64'));
const choices=s=>({subjectRequest:true,participate:true,record:true,research:true,version:"research-consent-1",sources:toSubjectSnapshot(s).consentSources});
for(const pid of [1,2,3,4,5,6])test('Self-guided recording, assignment '+pid,async t=>{
  t.mock.timers.enable({apis:['Date'],now:Date.UTC(2026,10,2)});
  let s=await createSession(pid,'Test');
  const act=async(action,payload={})=>s=await mutateSession(s.code,action,payload);
  const subject=(action,payload={})=>act(action,{subjectRequest:true,expectedStepId:toSubjectSnapshot(s).step.id,expectedStepStartedAt:s.stepStartedAt,expectedAttempt:s.attempt,...payload});
  const report=(preflight,status='recording')=>act('acquisitionHeartbeat',{configRevision:s.configRevision,preflightTest:{status:preflight},
    sensors:s.requiredSensors.map(id=>({id,status,quality:'good',dataDetected:true}))});
  await subject("consent",choices(s));
  await assert.rejects(subject('subjectStart'),/not ready/);
  await report('idle','connected');
  assert.equal(acquisitionCommand(s).command,'test','device check does not need a subject or an instructor heartbeat');
  await subject('subjectHeartbeat');
  assert.equal(acquisitionCommand(s).command,'test');
  await report('pass','connected');await subject('subjectStart');
  assert.equal(acquisitionCommand(s).command,'record');
  assert.equal(toSubjectSnapshot(s).acquisitionReady,false);
  await subject('advance',{source:'subject'});assert.equal(s.stepIndex,0);
  await report('pass');
  let count=0;
  while(s.status==='running'&&count++<40){
    const {step}=toSubjectSnapshot(s),index=s.stepIndex;
    assert.equal(toSubjectSnapshot(s).canGoNext,false);
    await subject('subjectNavigate',{direction:1});assert.equal(s.stepIndex,index);
    if(index===1){
      t.mock.timers.tick(11000);await subject('subjectHeartbeat');assert.equal(s.status,'paused');
      t.mock.timers.tick(12000);await report('pass');await subject('subjectHeartbeat');
      assert.equal(s.status,'running');assert.equal(Date.now()-Date.parse(s.stepStartedAt),11000);
    }
    if(step.durationSec){
      assert.equal(toSubjectSnapshot(s).awaitingTaskStart,true);
      t.mock.timers.tick(step.durationSec*1000+2000);await report('pass');
      await subject(step.type==='gate'?'advance':'autoAdvance',{source:'subject'});
      assert.equal(s.stepIndex,index,"reading the instructions does not complete a timed activity");
      await subject("subjectBeginTask");
      assert.equal(toSubjectSnapshot(s).awaitingTaskStart,false);
      assert.equal(Date.parse(s.stepStartedAt),Date.now());
      const onset=s.stepStartedAt;
      t.mock.timers.tick(50);await subject("subjectBeginTask");assert.equal(s.stepStartedAt,onset);
      await subject(step.type==='gate'?'advance':'autoAdvance',{source:'subject'});assert.equal(s.stepIndex,index);
      t.mock.timers.tick(step.durationSec*1000);await report('pass');
    }
    const stale={expectedStepId:step.id,expectedStepStartedAt:s.stepStartedAt,expectedAttempt:s.attempt};
    if(step.type==='setup'||step.type==='gate'||step.type==='clip')await subject('advance',{source:'subject'});
    else if(step.type==='sam')await subject('rating',{valence:4,arousal:6,dominance:8});
    else if(step.advance==='timer')await subject('autoAdvance');
    else await subject('taskComplete',{eventType:step.type==='nback'?'nback_complete':step.type==='stroop'?'stroop_complete':'breath_hold_complete'});
    assert.equal(s.stepIndex,index+1,step.id);
    await subject('advance',{...stale,source:'subject'});assert.equal(s.stepIndex,index+1);
  }
  assert.equal(s.status,'complete');assert.equal(s.ratings.length,6);
  assert.equal(s.events.filter(e=>e.eventType==='session_complete').length,1);
  assert.equal(s.events.filter(e=>e.eventType==='step_skipped').length,0);
  assert.equal(acquisitionCommand(s).command,'finalize');
  await act('navigate',{direction:-1});assert.equal(s.status,'complete');
});
test('Supervised sessions keep their original gate and cannot self-start',async()=>{
  let s=await createSession(100,'Test','v7');assert.equal(toSubjectSnapshot(s).selfGuided,false);
  s=await mutateSession(s.code,"consent",choices(s));
  assert.equal((await mutateSession(s.code,'subjectStart',{subjectRequest:true})).status,'setup');
});
test('device edits invalidate old recorder checks; retry waits for a fresh result',async()=>{
  let s=await createSession(101,'Test');
  const act=async(action,p={})=>s=await mutateSession(s.code,action,p);
  const beat=(revision,status,completedAt=null)=>act('acquisitionHeartbeat',{configRevision:revision,
    preflightTest:{status,completedAt},sensors:s.requiredSensors.map(id=>({id,status:'connected',quality:'good',dataDetected:true}))});
  const old=s.configRevision;
  await act('deviceConfig',{devices:{face:'auto',audio:'none'},required:['face']});
  await act('consent',choices(s));
  assert.deepEqual(s.requiredSensors,['face']);
  await beat(old,'pass');assert.equal(s.preflightTest.status,'idle');
  await beat(s.configRevision,'idle');assert.equal(acquisitionCommand(s).command,'test');
  const first='2026-11-02T12:00:00.000Z';
  await beat(s.configRevision,'fail',first);
  await act('startPreflight');await beat(s.configRevision,'fail',first);
  assert.equal(acquisitionCommand(s).command,'test');
  await beat(s.configRevision,'running');await beat(s.configRevision,'pass','2026-11-02T12:00:12.000Z');
  assert.equal(toSubjectSnapshot(s).canStartRecording,true);
});

test("Consent gates acquisition, includes every selected source, and feedback waits for recorder shutdown",async()=>{
  let s=await createSession(222,"Test");
  const act=async(a,p={})=>s=await mutateSession(s.code,a,p);
  await act("hardwareGateOverride",{enabled:true});
  for(const a of ["startPreflight","startSession","subjectStart"])await assert.rejects(act(a),/consent/);
  assert.equal(acquisitionCommand(s).command,"finalize");
  await assert.rejects(act("consent",{...choices(s),subjectRequest:false}),/participant/);
  for(const field of ["participate","record","research"])await assert.rejects(act("consent",{...choices(s),[field]:false}),/all three/);
  const old=choices(s);
  await act("consent",old);
  await act("deviceConfig",{devices:{thermal:"auto"}});
  assert.equal(toSubjectSnapshot(s).consentGiven,false);
  await assert.rejects(act("consent",old),/changed/);
  await assert.rejects(act("startSession"),/consent/);
  await act("consent",choices(s));
  await act("hardwareGateOverride",{enabled:true});
  await act("startSession");
  await act("subjectEnd",{subjectRequest:true});
  assert.equal(toSubjectSnapshot(s).feedbackStage,"stopping");
  const feedback={subjectRequest:true,rating:"Easy",comment:"Clear instructions."};
  await assert.rejects(act("feedback",feedback),/stops/);
  await act("acquisitionFinalize",{recordings:[]});
  assert.equal(toSubjectSnapshot(s).feedbackStage,"open");
  await act("feedback",feedback);
  await act("feedback",{subjectRequest:true,skip:true});
  assert.equal(s.feedback.comment,feedback.comment);
  assert.equal(toSubjectSnapshot(s).feedbackStage,"none");
  const declined=await createSession(223,"Test");
  const end=await mutateSession(declined.code,"declineConsent",{subjectRequest:true});
  assert.equal(end.status,"aborted");assert.equal(end.recordingStartedAt,null);
  assert.equal(toSubjectSnapshot(end).feedbackStage,"none");
});
