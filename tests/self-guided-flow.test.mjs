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
for(const pid of [1,2,3,4,5,6])test('Self-guided recording, assignment '+pid,async t=>{
  t.mock.timers.enable({apis:['Date'],now:Date.UTC(2026,10,2)});
  let s=await createSession(pid,'Test');
  const act=async(action,payload={})=>s=await mutateSession(s.code,action,payload);
  const subject=(action,payload={})=>act(action,{subjectRequest:true,expectedStepId:toSubjectSnapshot(s).step.id,expectedStepStartedAt:s.stepStartedAt,expectedAttempt:s.attempt,...payload});
  const report=(preflight,status='recording')=>act('acquisitionHeartbeat',{configRevision:s.configRevision,preflightTest:{status:preflight},
    sensors:s.requiredSensors.map(id=>({id,status,quality:'good',dataDetected:true}))});
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
    if(toSubjectSnapshot(s).awaitingMovement && pid%2===0){
      t.mock.timers.tick(step.durationSec*1000);await report('pass');await subject('autoAdvance');
      assert.equal(s.stepIndex,index);await subject('subjectBeginMovement');assert.equal(toSubjectSnapshot(s).awaitingMovement,false);
    }
    if(step.durationSec){
      await subject(step.type==='gate'?'advance':'autoAdvance',{source:'subject'});assert.equal(s.stepIndex,index);
      t.mock.timers.tick(step.durationSec*1000);await report('pass');
    }
    const stale={expectedStepId:step.id,expectedStepStartedAt:s.stepStartedAt,expectedAttempt:s.attempt};
    if(step.safety && pid%2)await subject('subjectSkip');
    else if(step.type==='setup'||step.type==='gate'||step.type==='clip')await subject('advance',{source:'subject'});
    else if(step.type==='sam')await subject('rating',{valence:4,arousal:6,dominance:8});
    else if(step.advance==='timer')await subject('autoAdvance');
    else await subject('taskComplete',{eventType:step.type==='nback'?'nback_complete':step.type==='stroop'?'stroop_complete':'breath_hold_complete'});
    assert.equal(s.stepIndex,index+1,step.id);
    await subject('advance',{...stale,source:'subject'});assert.equal(s.stepIndex,index+1);
  }
  assert.equal(s.status,'complete');assert.equal(s.ratings.length,6);
  assert.equal(s.events.filter(e=>e.eventType==='session_complete').length,1);
  assert.equal(s.events.filter(e=>e.eventType==='step_skipped').length,pid%2?3:0);
  assert.equal(acquisitionCommand(s).command,'finalize');
  await act('navigate',{direction:-1});assert.equal(s.status,'complete');
});
test('Supervised sessions keep their original gate and cannot self-start',async()=>{
  const s=await createSession(100,'Test','v7');assert.equal(toSubjectSnapshot(s).selfGuided,false);
  assert.equal((await mutateSession(s.code,'subjectStart',{subjectRequest:true})).status,'setup');
});
test('device edits invalidate old recorder checks; retry waits for a fresh result',async()=>{
  let s=await createSession(101,'Test');
  const act=async(action,p={})=>s=await mutateSession(s.code,action,p);
  const beat=(revision,status,completedAt=null)=>act('acquisitionHeartbeat',{configRevision:revision,
    preflightTest:{status,completedAt},sensors:s.requiredSensors.map(id=>({id,status:'connected',quality:'good',dataDetected:true}))});
  const old=s.configRevision;
  await act('deviceConfig',{devices:{face:'auto',audio:'none'},required:['face']});
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
