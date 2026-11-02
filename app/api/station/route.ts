import {stationSchema,stationCookie as cookie} from "@/lib/subject-station-access";
import {getOperatorUser} from "@/app/operator-auth";
import {getBindings,getSession} from "@/lib/session-engine";
import {digest,opaque,mintTicket} from "@/lib/recorder-tickets";

const TRUST=90*24*60*60*1000, INVITE=30*60*1000;
const keyPattern=/^[a-f0-9]{48}$/;
type Station={console_digest:string;session_code:string;subject_digest:string|null;trusted_until:number;last_seen:number};
function reply(req:Request,data:unknown,status=200,set?:[string,string]){
  const headers=new Headers({"Cache-Control":"no-store"});
  if(set)headers.set("Set-Cookie",set[0]+"="+set[1]+"; Path="+(set[0]==="ms_subject"?"/api":"/api/station")+"; Max-Age="+TRUST/1000+"; HttpOnly; SameSite=Strict"+(new URL(req.url).protocol==="https:"?"; Secure":""));
  return Response.json(data,{status,headers});
}
export async function POST(req:Request){
  const url=new URL(req.url),origin=req.headers.get("origin");
  if(origin && origin!==url.origin)return reply(req,{error:"Use the same Meridian website on both computers."},403);
  if(!req.headers.get("content-type")?.includes("application/json"))return reply(req,{error:"Expected JSON."},415);
  if(url.protocol!=="https:"&&!["127.0.0.1","localhost","[::1]"].includes(url.hostname))return reply(req,{error:"Open Meridian using the lab’s shared HTTPS address."},403);
  const p=await req.json().catch(()=>null);
  if(!p)return reply(req,{error:"Invalid request."},400);
  const db=getBindings().DB, stationKey=cookie(req,"ms_subject");
  if(p.action==="discover" && !stationKey)return reply(req,{code:null});
  await db.prepare(stationSchema).run();
  if(p.action==="enroll"){
    if(typeof p.invite!=="string"||!keyPattern.test(p.invite))return reply(req,{error:"Invalid subject invitation."},400);
    if(stationKey && await db.prepare("SELECT 1 FROM recorder_stations WHERE subject_digest=? AND trusted_until>?").bind(await digest(stationKey),Date.now()).first())return reply(req,{error:"This browser is already paired. Open the subject portal without the invitation, or forget the existing computer after that study ends."},409);
    const secret=opaque();
    const row=await db.prepare("UPDATE recorder_stations SET subject_digest=?,trusted_until=?,invite_digest=NULL,invite_until=0 WHERE invite_digest=? AND invite_until>? AND (subject_digest IS NULL OR trusted_until<=?) AND EXISTS(SELECT 1 FROM sessions WHERE code=recorder_stations.session_code AND status='setup') RETURNING session_code")
      .bind(await digest(secret),Date.now()+TRUST,await digest(p.invite),Date.now(),Date.now()).first<{session_code:string}>();
    if(!row)return reply(req,{error:"That invitation expired or was used. Request a new one from Recording setup."},410);
    return reply(req,{code:row.session_code},200,["ms_subject",secret]);
  }
  if(p.action==="discover"||p.action==="ticket"){
    const sd=stationKey?await digest(stationKey):"";
    const row=sd && await db.prepare("SELECT session_code FROM recorder_stations WHERE subject_digest=? AND trusted_until>?").bind(sd,Date.now()).first<{session_code:string}>();
    if(!row || (p.action==="ticket" && p.code!==row.session_code))return p.action==="discover"?reply(req,{code:null}):reply(req,{error:"This browser is not paired to that session."},403);
    const session=await getSession(row.session_code);
    if(p.action==="discover"){
      await db.prepare("UPDATE recorder_stations SET last_seen=? WHERE subject_digest=? AND session_code=? AND last_seen<?").bind(Date.now(),sd,row.session_code,Date.now()-4500).run();
      return reply(req,{code:session && ["setup","running","paused"].includes(session.status)?session.code:null});
    }
    if(session?.status!=="setup" || (session.acquisition.lastSeenAt && Date.now()-Date.parse(session.acquisition.lastSeenAt)<10000))return reply(req,{error:"The recorder is connected or recording setup has ended."},409);
    const result=await mintTicket(row.session_code,sd);
    return result?reply(req,result):reply(req,{error:"The assignment changed. Refresh this page."},409);
  }
  const operator=await getOperatorUser();
  if(!["assign","invite","forget"].includes(p.action)||!operator)return reply(req,{error:"Instructor authorization required."},403);
  if(typeof p.code!=="string"||!/^[A-Z0-9]{5,16}$/.test(p.code))return reply(req,{error:"Invalid session."},400);
  const session=await getSession(p.code);
  if(!session)return reply(req,{error:"Session not found."},404);
  const instructorKey=cookie(req,"ms_console")||opaque();
  const id=await digest(operator.userId+":"+instructorKey);
  if(p.action==="forget"){
    const removed=await db.prepare("DELETE FROM recorder_stations WHERE console_digest=? AND session_code=? AND EXISTS(SELECT 1 FROM sessions WHERE code=recorder_stations.session_code AND status IN ('complete','aborted'))").bind(id,p.code).run();
    return removed.meta.changes?reply(req,{ok:true}):reply(req,{error:"Only the paired instructor can forget the computer, after this session ends."},409);
  }
  if(session.status!=="setup")return reply(req,{error:"This session has already started or ended."},409);
  const byOwner=()=>db.prepare("SELECT * FROM recorder_stations WHERE console_digest=?").bind(id).first<Station>();
  let row=await byOwner();
  if(!row){await db.prepare("INSERT OR IGNORE INTO recorder_stations(console_digest,session_code) VALUES(?,?)").bind(id,p.code).run();row=await byOwner();}
  if(!row)return reply(req,{error:"Another instructor browser has already assigned this session."},409);
  if(row.session_code!==p.code){
    const moved=await db.prepare("UPDATE OR IGNORE recorder_stations SET session_code=?,last_seen=0,invite_digest=NULL,invite_until=0 WHERE console_digest=? AND session_code=? AND EXISTS(SELECT 1 FROM sessions WHERE code=? AND status IN ('complete','aborted'))").bind(p.code,id,row.session_code,row.session_code).run();
    if(!moved.meta.changes)return reply(req,{error:"Finish or discard the earlier session on this instructor station before assigning another."},409);
  }
  const set:[string,string]|undefined=cookie(req,"ms_console")?undefined:["ms_console",instructorKey];
  if(row.subject_digest && row.trusted_until>Date.now())return reply(req,{paired:true,displayOnline:row.session_code===p.code && row.last_seen>Date.now()-15000},200,set);
  if(p.action==="assign")return reply(req,{paired:false},200,set);
  const invite=opaque();
  const updated=await db.prepare("UPDATE recorder_stations SET invite_digest=?,invite_until=? WHERE console_digest=? AND session_code=? AND (subject_digest IS NULL OR trusted_until<=?)").bind(await digest(invite),Date.now()+INVITE,id,p.code,Date.now()).run();
  return updated.meta.changes?reply(req,{paired:false,invite},200,set):reply(req,{error:"The station changed. Refresh Recording setup."},409);
}
