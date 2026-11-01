// Explicit opt-in integration test. Creates and aborts ONE labelled local test session.
// No physical sensors or recording agent are started. Never run against production.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir} from 'node:fs/promises';
import {rolldown} from 'rolldown';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const base=process.env.MERIDIAN_TEST_URL||'http://127.0.0.1:3030';
assert.ok(['localhost','127.0.0.1'].includes(new URL(base).hostname),'Local test only');
const bundle=await rolldown({input:'lib/protocol.ts'});
const generated=await bundle.generate({format:'es'});await bundle.close();
const {buildPlan}=await import('data:text/javascript;base64,'+Buffer.from(generated.output[0].code).toString('base64'));
const browser=await chromium.launch({channel:process.env.BROWSER_CHANNEL||'chrome',headless:true});
const context=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce'});
const instructor=await context.newPage();const subject=await context.newPage();
const errors=[];for(const page of [instructor,subject])page.on('pageerror',e=>errors.push(e.message));
let code,beat;
async function post(action,payload={},view){const r=await context.request.post(base+'/api/sessions',{data:{action,code,payload,view}});const data=await r.json();assert.ok(r.ok(),data.error);return data.session;}
async function get(){return (await (await context.request.get(base+'/api/sessions?code='+code)).json()).session;}
async function until(check,message){for(let i=0;i<300;i++){if(await check())return;await new Promise(r=>setTimeout(r,100));}throw Error(message);}
const output='.local-run/heuristic-verification';await mkdir(output,{recursive:true});
try{
  const pid=980000+Math.floor(Math.random()*9999);
  const r=await context.request.post(base+'/api/sessions',{data:{action:'create',participantId:pid,operator:'Automated UX test, no hardware'}});
  assert.ok(r.ok());const initial=(await r.json()).session;code=initial.code;
  const plan=buildPlan(initial.assignment);
  beat=setInterval(()=>post('heartbeat').catch(()=>{}),3000);
  await instructor.goto(base+'/instructor');
  await instructor.waitForTimeout(3000);
  await instructor.getByLabel('Participant ID',{exact:true}).fill(String(pid));
  await instructor.getByRole('button',{name:'RESUME SESSION',exact:true}).click();
  await instructor.getByRole('button',{name:'PREPARE RECORDING'}).click();
  const dialog=instructor.getByRole('dialog');await dialog.waitFor();
  assert.equal(await dialog.getByRole('button',{name:'START SESSION',exact:true}).isDisabled(),true);
  await until(async()=> (await dialog.locator('pre').last().textContent()).includes(base),'command should use current origin');
  const close=dialog.getByRole('button',{name:'Close workspace settings'});
  await close.focus();await instructor.keyboard.press('Shift+Tab');
  assert.ok(await dialog.evaluate(el=>el.contains(document.activeElement)));
  for(let i=0;i<45;i++){await instructor.keyboard.press('Tab');assert.ok(await dialog.evaluate(el=>el.contains(document.activeElement)));}
  await dialog.getByLabel('Face camera device').selectOption('none');
  await instructor.waitForTimeout(2200);
  assert.equal(await dialog.getByLabel('Face camera device').inputValue(),'none','polling must preserve unsaved selection');
  await dialog.getByRole('button',{name:'SAVE DEVICE CHOICES'}).click();
  await until(async()=> (await get()).deviceConfig.face==='none','device save');
  await dialog.locator('.live-settings-body').evaluate(el=>{el.scrollTop=0;});
  await instructor.screenshot({path:output+'/setup-desktop.png'});
  await instructor.keyboard.press('Escape');
  await until(()=>instructor.getByRole('button',{name:'PREPARE RECORDING'}).evaluate(el=>el===document.activeElement),'restore opener focus');
  console.log('PASS: setup blockers, host-aware command, draft retention, modal containment and focus restoration');

  // Explicit test-only override; no claim of hardware or file-quality validation.
  await post('hardwareGateOverride',{enabled:true});await post('startSession');
  const sam=plan.findIndex(s=>s.type==='sam');
  for(let i=0;i<sam;i++)await post('navigate',{direction:1});
  await subject.goto(base+'/subject?session='+code);
  await subject.getByRole('heading',{name:'How pleasant did you feel?'}).waitFor();
  await subject.getByRole('radio',{name:'3 of 10',exact:true}).click();
  await subject.waitForTimeout(400);
  assert.equal(await subject.getByRole('heading',{name:'How pleasant did you feel?'}).count(),1);
  assert.equal(await subject.getByRole('radio',{name:'3 of 10',exact:true}).getAttribute('aria-checked'),'true');
  await subject.keyboard.press('ArrowRight');
  assert.equal(await subject.getByRole('radio',{name:'4 of 10',exact:true}).getAttribute('aria-checked'),'true');
  await subject.keyboard.press('0');
  assert.equal(await subject.getByRole('radio',{name:/10 of 10/}).getAttribute('aria-checked'),'true');
  await subject.getByRole('button',{name:'Continue',exact:true}).click();
  await subject.getByRole('radio',{name:'6 of 10',exact:true}).click();
  await subject.getByRole('button',{name:'Back',exact:true}).click();
  assert.equal(await subject.getByRole('radio',{name:/10 of 10/}).getAttribute('aria-checked'),'true');
  await subject.getByRole('button',{name:'Continue',exact:true}).click();
  assert.equal(await subject.getByRole('radio',{name:'6 of 10',exact:true}).getAttribute('aria-checked'),'true');
  await subject.getByRole('button',{name:'Continue',exact:true}).click();
  await subject.getByRole('radio',{name:'7 of 10',exact:true}).click();
  let failOnce=true;
  await subject.route('**/api/sessions',route=>{const body=route.request().postDataJSON();if(body?.action==='rating'&&failOnce){failOnce=false;return route.abort();}return route.continue();});
  await subject.getByRole('button',{name:'Submit responses'}).click();
  await subject.getByRole('alert').filter({hasText:'Your answers are still here'}).waitFor();
  await subject.screenshot({path:output+'/rating-recovery.png',fullPage:true});
  await subject.getByRole('button',{name:'Submit responses'}).click();
  await until(async()=> (await get()).ratings.length===1,'rating persisted once');
  const after=await get();assert.deepEqual([after.ratings[0].valence,after.ratings[0].arousal,after.ratings[0].dominance],[10,6,7]);
  console.log('PASS: plain-language rating, explicit continuation, arrow/numeric keys, correction, failed-save recovery');

  const from=await get();
  subject.once('dialog',d=>d.dismiss());await subject.getByRole('button',{name:'Previous task',exact:true}).click();
  assert.equal((await get()).stepIndex,from.stepIndex);
  subject.once('dialog',d=>d.accept());await subject.getByRole('button',{name:'Previous task',exact:true}).click();
  await until(async()=> (await get()).stepIndex===sam,'subject back synchronized');
  const revisited=await get();assert.ok(revisited.attempt>1);assert.equal(revisited.ratings.length,1);
  const stale={expectedStepId:plan[sam].id,expectedStepStartedAt:initial.stepStartedAt,expectedAttempt:1,valence:1,arousal:1,dominance:1};
  await post('rating',stale,'subject');assert.equal((await get()).ratings.length,1);
  subject.once('dialog',d=>d.accept());await subject.getByRole('button',{name:'Next task',exact:true}).click();
  await until(async()=> (await get()).stepIndex===sam+1,'subject next synchronized');
  assert.ok((await get()).events.some(e=>e.eventType==='subject_navigation'&&e.metadata.disposition==='interrupted'));
  console.log('PASS: subject back/next, cancel, retained history, stale-visit protection and audit markers');

  const nback=plan.findIndex(s=>s.type==='nback');let current=await get();
  while(current.stepIndex!==nback)current=await post('navigate',{direction:current.stepIndex<nback?1:-1});
  await subject.getByRole('heading',{name:'Remember the position'}).waitFor();
  await subject.getByRole('button',{name:'No match: wait',exact:true}).click();
  assert.equal(await subject.getByRole('button',{name:'Begin 20-square task'}).count(),0);
  await subject.getByRole('button',{name:'Match',exact:true}).click();
  await subject.getByRole('button',{name:'Try a different example'}).click();
  await subject.getByRole('button',{name:'No match: wait',exact:true}).click();
  await subject.screenshot({path:output+'/nback-practice.png',fullPage:true});
  await subject.setViewportSize({width:390,height:844});
  assert.ok(await subject.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1),'subject reflow');
  await subject.screenshot({path:output+'/nback-mobile.png',fullPage:true});
  await subject.getByRole('button',{name:'Begin 20-square task'}).click();
  await subject.locator('.nback-running').waitFor();
  await subject.waitForTimeout(50);
  await subject.getByRole('button',{name:'Match',exact:true}).click();
  assert.ok(await subject.getByRole('button',{name:'Match',exact:true}).isDisabled(),'one response per square');
  await until(async()=> (await get()).events.some(e=>e.eventType==='nback_complete'),'nback completion');
  const event=(await get()).events.find(e=>e.eventType==='nback_complete');
  assert.equal(event.metadata.trials,20);assert.equal(event.metadata.trialResults.length,20);assert.equal(event.metadata.practiceScored,false);
  assert.equal(event.metadata.hits+event.metadata.misses+event.metadata.falseAlarms+event.metadata.correctRejections,20-event.metadata.level);
  console.log('PASS: n-back practice, mobile reflow, one-response guard and separated 20-trial results');

  await instructor.getByRole('button',{name:'END SESSION',exact:true}).waitFor();
  instructor.once('dialog',d=>d.dismiss());await instructor.getByRole('button',{name:'END SESSION',exact:true}).click();
  assert.equal((await get()).status,'running');
  await post('pause');const paused=await get();
  await post('subjectNavigate',{direction:-1,expectedStepId:plan[paused.stepIndex].id,expectedStepStartedAt:paused.stepStartedAt},'subject');
  assert.equal((await get()).stepIndex,paused.stepIndex);
  await post('complete');const done=await get();
  await post('subjectNavigate',{direction:-1,expectedStepId:plan[done.stepIndex].id,expectedStepStartedAt:done.stepStartedAt},'subject');
  assert.equal((await get()).status,'complete');
  await instructor.getByRole('button',{name:'Recording review',exact:true}).click();
  await instructor.getByRole('button',{name:'OPEN LEDGER',exact:true}).click();
  const ledger=instructor.getByRole('dialog');await ledger.waitFor();
  await ledger.getByRole('button',{name:'Close session ledger'}).focus();await instructor.keyboard.press('Shift+Tab');
  assert.ok(await ledger.evaluate(el=>el.contains(document.activeElement)));
  await instructor.keyboard.press('Escape');
  await until(()=>instructor.getByRole('button',{name:'OPEN LEDGER',exact:true}).evaluate(el=>el===document.activeElement),'ledger focus restoration');
  await instructor.setViewportSize({width:720,height:500});
  await instructor.getByRole('button',{name:'Toggle workspace navigation'}).click();
  await instructor.getByRole('button',{name:'WORKSPACE SETTINGS'}).click();
  await instructor.getByRole('dialog').waitFor();
  assert.ok(await instructor.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1),'compact operator reflow');
  await instructor.screenshot({path:output+'/setup-compact.png'});
  await instructor.keyboard.press('Escape');
  console.log('PASS: visible end action, cancel safety, paused/finalized navigation rejected');
  assert.deepEqual(errors,[],'browser exceptions');
}catch(error){
  console.error('Browser exceptions:',errors);
  console.error((await instructor.locator('body').innerText()).slice(0,1600));
  await instructor.screenshot({path:output+'/failure.png',fullPage:true});
  throw error;
}finally{
  clearInterval(beat);
  if(code)await post('abort').catch(()=>{});
  await browser.close();
}
