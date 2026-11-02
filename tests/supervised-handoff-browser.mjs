// Opt-in local integration test. All acquisition reports are simulated; no hardware is opened.
import {enrollStation} from "./enroll-station.mjs";
import assert from "node:assert/strict";
import {createRequire} from "node:module";
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||"playwright");
const base=process.env.MERIDIAN_TEST_URL||"http://localhost:3030";
assert.ok(["localhost","127.0.0.1"].includes(new URL(base).hostname));
const browser=await chromium.launch({channel:process.env.BROWSER_CHANNEL||"chrome"});
const context=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:"reduce"}),page=await context.newPage();
let session,beat,mode="connected",preflight="idle";
const call=async(path,data)=>{const r=await context.request.post(base+path,{data});assert.ok(r.ok(),await r.text());return r.json()};
const post=async(action,payload={})=>call("/api/sessions",{action,code:session.code,payload});
const report=()=>call("/api/acquisition",{action:"heartbeat",code:session.code,token:session.acquisitionToken,agent:{id:"sim",host:"Simulated recorder",configRevision:session.configRevision,preflightTest:{status:preflight}},sensors:session.requiredSensors.map(id=>({id,status:mode,dataDetected:true,hardwareDetected:true,quality:"good"}))});
try{
  session=(await call("/api/sessions",{action:"create",participantId:970000+Math.floor(Math.random()*10000),operator:"Setup UX test, simulated hardware",protocolVersion:"v7"})).session;
  await page.goto(base+"/instructor?session="+session.code);
  const participant=await browser.newPage();await enrollStation(page,participant);
  assert.equal((await report()).command.command,"test","preflight starts without a manual readiness action");
  preflight="running"; await report();
  await page.getByRole("heading",{name:"Check recording devices"}).waitFor();
  preflight="pass";await report();

  beat=setInterval(()=>report().catch(()=>{}),2000);
  await page.getByRole("button",{name:"Start recording",exact:true}).click();
  await page.getByRole("heading",{name:"Live study",exact:true}).waitFor();
  await page.getByText("Starting the recorder",{exact:true}).waitFor();
  mode="recording";await report();
  await page.getByRole("button",{name:"Confirm setup and begin baseline"}).click();
  await page.getByText("This activity advances automatically.",{exact:true}).waitFor();
  await page.reload();await page.getByRole("heading",{name:"Live study",exact:true}).waitFor();
  console.log("PASS: instructor start, actual capture confirmation, supervised clearance from Live study, and live reload");
}finally{clearInterval(beat);if(session)await post("abort").catch(()=>{});await browser.close();}
