import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {rolldown} from "rolldown";
import {resolve} from "node:path";
const sql=new DatabaseSync(":memory:");
sql.exec("CREATE TABLE sessions(code TEXT PRIMARY KEY,status TEXT);INSERT INTO sessions VALUES('ABC12345','setup'),('XYZ12345','setup')");
function prepare(query,args=[]){return {bind:(...v)=>prepare(query,v),first:()=>sql.prepare(query).get(...args),run:()=>({meta:sql.prepare(query).run(...args)})};}
globalThis.stationDB={prepare};globalThis.stationSession=code=>sql.prepare("SELECT * FROM sessions WHERE code=?").get(code);
const bundle=await rolldown({input:"app/api/station/route.ts",plugins:[{name:"fixture",resolveId(id){if(id==="@/app/operator-auth")return "virtual:auth";
  if(id==="./session-engine"||id==="@/lib/session-engine")return "virtual:db";
  if(id==="@/lib/subject-station-access")return resolve("lib/subject-station-access.ts");
  if(id==="@/lib/recorder-tickets")return resolve("lib/recorder-tickets.ts");},
  load(id){if(id==="virtual:db")return 'export const getBindings=()=>({DB:globalThis.stationDB});export const getSession=async c=>{const s=globalThis.stationSession(c);return s?{...s,acquisition:{lastSeenAt:null}}:null}';
    if(id==="virtual:auth")return 'export const getOperatorUser=async()=>globalThis.operator?{userId:"staff"}:null';}}]});
const {output}=await bundle.generate({format:"es"});await bundle.close();
const {POST}=await import("data:text/javascript;base64,"+Buffer.from(output[0].code).toString("base64"));
const code="ABC12345",other="XYZ12345";
async function post(action,data={},cookie="",operator=false){globalThis.operator=operator;
  return POST(new Request("https://meridian.test/api/station",{method:"POST",headers:{"Content-Type":"application/json",origin:"https://meridian.test",cookie},body:JSON.stringify({action,...data})}));}
test("one-time enrollment, expiring trust, two-session assignment and revocation",async t=>{
  t.mock.timers.enable({apis:["Date"],now:Date.UTC(2026,10,2)});
  assert.equal((await post("assign",{code})).status,403);
  const assigned=await post("assign",{code},"",true);
  const owner=assigned.headers.get("set-cookie").split(";")[0];assert.match(assigned.headers.get("set-cookie"),/HttpOnly.*SameSite=Strict.*Secure/);
  const invite=async()=> (await (await post("invite",{code},owner,true)).json()).invite;
  const expired=await invite();t.mock.timers.tick(30*60000+1);
  assert.equal((await post("enroll",{invite:expired})).status,410);
  const valid=await invite(), enrolled=await post("enroll",{invite:valid});
  assert.equal(enrolled.status,200);const subject=enrolled.headers.get("set-cookie").split(";")[0];
  assert.equal((await post("enroll",{invite:valid})).status,410);
  assert.equal((await post("ticket",{code})).status,403);
  assert.equal((await post("ticket",{code:other},subject)).status,403);
  assert.equal((await post("ticket",{code},subject)).status,200);
  assert.equal((await post("assign",{code:other},owner,true)).status,409);
  assert.equal((await post("forget",{code},owner,true)).status,409);
  sql.prepare("UPDATE sessions SET status='complete' WHERE code=?").run(code);
  assert.equal((await post("assign",{code:other},owner,true)).status,200);
  assert.equal((await (await post("discover",{},subject)).json()).code,other);
  assert.equal((await post("ticket",{code},subject)).status,403);
  t.mock.timers.tick(91*86400000);
  assert.equal((await post("ticket",{code:other},subject)).status,403);
  sql.prepare("UPDATE sessions SET status='complete' WHERE code=?").run(other);
  assert.equal((await post("forget",{code:other},owner,true)).status,200);
});
