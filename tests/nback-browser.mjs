// Isolated participant UI: fixtures only, virtual time, no data written or devices opened.
import assert from "node:assert/strict";
import {createRequire} from "node:module";
import {createServer} from "node:http";
import {mkdir,readFile} from "node:fs/promises";
import {resolve,sep,extname} from "node:path";
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||"playwright");
// Serve the actual production build when no development server is supplied.
let base=process.env.MERIDIAN_TEST_URL,server;
if(!base){
  const {default:worker}=await import("../dist/server/index.js");
  const root=resolve("dist/client");
  server=createServer(async(req,res)=>{
    try{
      const url=new URL(req.url,"http://localhost");
      if(url.pathname==="/subject"||url.pathname==="/nback-practice"){
        const reply=await worker.fetch(new Request(url,{headers:{accept:"text/html"}}),{ASSETS:{fetch:()=>new Response(null,{status:404})}},{waitUntil(){},passThroughOnException(){}});
        res.writeHead(reply.status,{"Content-Type":"text/html"});res.end(await reply.text());return;
      }
      const path=resolve(root,"."+decodeURIComponent(url.pathname));
      if(!path.startsWith(root+sep))throw Error();
      const bytes=await readFile(path);res.writeHead(200,{"Content-Type":({".js":"application/javascript",".css":"text/css",".svg":"image/svg+xml"})[extname(path)]||"application/octet-stream"});res.end(bytes);
    }catch{res.writeHead(404);res.end();}
  });
  await new Promise(r=>server.listen(0,"127.0.0.1",r));
  base="http://127.0.0.1:"+server.address().port;
}
assert.ok(["localhost","127.0.0.1"].includes(new URL(base).hostname));
const browser=await chromium.launch({channel:"chrome"});
try{
  const preview=await browser.newPage({viewport:{width:1440,height:900}});
  const api=[];preview.on("request",r=>{if(new URL(r.url()).pathname.startsWith("/api/"))api.push(r.url());});
  const clockStart=new Date("2026-11-02T10:00:00Z"),clockHold=new Date(clockStart.getTime()+500);
  await preview.clock.install({time:clockStart});await preview.clock.pauseAt(clockHold);await preview.goto(base+"/nback-practice");
  const phaseAt=async(page,ms,phase)=>{await page.clock.runFor(ms);await page.locator('.nb-simulation[data-phase="'+phase+'"]').waitFor();};
  await preview.locator('.nb-simulation[data-playing="true"]').waitFor();
  for(let i=0;i<7;i++){await phaseAt(preview,350,1);await phaseAt(preview,650,2);await phaseAt(preview,1500,0);}
  await phaseAt(preview,350,1);
  assert.match(await preview.locator(".nb-mast").innerText(),/Slide 08 of 40/);
  assert.equal(await preview.locator(".nb-current .lit").getAttribute("class"),"lit");
  assert.equal(await preview.locator(".nb-reference .nback-grid").getAttribute("aria-label"),"Lit square: top right");
  assert.equal(await preview.locator(".nb-hand").getAttribute("data-tap"),"true");
  await mkdir(".local-run/nback-verification",{recursive:true});
  const checkLayout=async()=>assert.ok(await preview.evaluate(()=>{
    const hand=document.querySelector(".nb-hand").getBoundingClientRect();
    const caption=document.querySelector(".nb-explanation").getBoundingClientRect();
    return hand.bottom<=caption.top && document.documentElement.scrollWidth<=innerWidth+1;
  }),"the finger must stay above the caption without horizontal scrolling");
  await checkLayout();
  await preview.screenshot({path:".local-run/nback-verification/watch-desktop.png"});
  await preview.setViewportSize({width:375,height:812});
  assert.ok(await preview.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  await preview.screenshot({path:".local-run/nback-verification/watch-mobile.png",fullPage:true});
  await checkLayout();
  await phaseAt(preview,650,2);
  await preview.clock.runFor(250);await checkLayout();
  await preview.getByRole("button",{name:"Understood, start test"}).click();
  await preview.locator(".nback-running").waitFor();
  for(let i=0;i<23;i++)await preview.clock.runFor(2500);
  await preview.getByText("Test complete.",{exact:true}).waitFor();
  assert.deepEqual(api,[]);await preview.close();
  for(const level of [1,2,3]){
    const page=await browser.newPage({reducedMotion:level===2?"reduce":"no-preference",viewport:{width:375,height:812}});
    let rev=0,done=false;const sent=[];
    const snapshot=()=>({code:"DEMO1234",participantId:1,revision:++rev,status:done?"complete":"running",stepIndex:8,stepCount:34,attempt:1,
      nbackLevel:level,stepStartedAt:"2026-01-01T10:00:00Z",operatorConnected:true,acquisitionReady:true,selfGuided:true,
      step:{id:"nback-test",type:"nback",subjectPrompt:"Watch the grid.",advance:"task"}});
    await page.route("**/api/station",r=>r.fulfill({json:{code:null}}));
    await page.route("**/api/sessions**",r=>{const body=r.request().postDataJSON();if(body && body.action!=="subjectHeartbeat"){sent.push(body);if(body.action==="taskComplete")done=true;}return r.fulfill({json:{session:snapshot()}});});
    await page.clock.install({time:clockStart});await page.clock.pauseAt(clockHold);await page.goto(base+"/subject?session=DEMO1234");
    const btn=name=>page.getByRole("button",{name,exact:true});
    // The subject portal bootstraps the session via zero-delay timers.
    for(let i=0;i<100 && !await page.locator('.nb-simulation[data-playing="true"]').count();i++){
      await page.clock.runFor(10);await page.waitForTimeout(25);
    }
    await page.locator('.nb-simulation[data-playing="true"]').waitFor();
    const history=[];
    for(let i=0;i<(level===3?6:40);i++){
      await phaseAt(page,350,1);
      assert.match(await page.locator(".nb-mast").innerText(),new RegExp("Slide "+String(i+1).padStart(2,"0")+" of 40"));
      assert.equal(await page.locator(".nb-simulation button").count(),0);
      assert.ok(await btn("Understood, start test").isEnabled());
      const now=await page.locator(".nb-current .nback-grid").getAttribute("aria-label");
      const prior=history[i-level]||"Blank grid";
      assert.equal(await page.locator(".nb-reference .nback-grid").getAttribute("aria-label"),prior);
      assert.equal(await page.locator(".nb-hand").getAttribute("data-tap"),String(i>=level && prior===now));
      history.push(now);await phaseAt(page,650,2);
      assert.equal(await page.locator(".nb-current .lit").count(),0);
      await phaseAt(page,1500,0);
    }
    assert.deepEqual(sent,[],"watching does not emit scored events");
    await btn("Understood, start test").click();await page.locator(".nback-running").waitFor();
    await page.clock.runFor(1200);
    assert.equal(await page.locator(".nback-grid .lit").count(),0);
    await btn("Match").click();assert.ok(await btn("Match").isDisabled());
    await page.clock.runFor(1350);
    assert.match(await page.locator(".nback-running").innerText(),/Square 2 of 20/);
    for(let i=1;i<24 && !done;i++)await page.clock.runFor(2500);
    assert.ok(done,"the fixture received the task-complete event");
    await page.getByText("Thank you.",{exact:true}).waitFor();
    assert.deepEqual(sent.map(b=>b.action),["log","taskComplete"]);
    const result=sent[1].payload.metadata;
    assert.equal(result.timingVersion,"spatial-2500-v1");assert.equal(result.trialResults.length,20);
    assert.equal(result.trialResults[0].response,true);assert.ok(result.trialResults[0].rtMs>=1000);
    assert.equal(result.scoredTrials,20-level);assert.equal(result.practiceScored,false);
    await page.close();console.log("PASS: "+level+"-back passive example, reference grid and finger, blank-window response and 20 isolated results");
  }
}finally{await browser.close();server?.close();}
