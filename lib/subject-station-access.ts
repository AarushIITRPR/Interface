import {getBindings} from "./session-engine";
import {digest} from "./recorder-tickets";
export const stationSchema="CREATE TABLE IF NOT EXISTS recorder_stations(console_digest TEXT PRIMARY KEY,session_code TEXT NOT NULL UNIQUE,subject_digest TEXT UNIQUE,trusted_until INTEGER NOT NULL DEFAULT 0,last_seen INTEGER NOT NULL DEFAULT 0,invite_digest TEXT UNIQUE,invite_until INTEGER NOT NULL DEFAULT 0)";
export function stationCookie(req:Request,name:string){
  const raw=req.headers.get("cookie")?.split(";").map(s=>s.trim()).find(s=>s.startsWith(name+"="))?.slice(name.length+1);
  return raw && /^[a-f0-9]{48}$/.test(raw)?raw:null;
}
const initialized=new WeakSet<object>();
export async function allowedSubject(req:Request,code:string){
  const db=getBindings().DB;
  if(!initialized.has(db)){await db.prepare(stationSchema).run();initialized.add(db);}
  const bound=await db.prepare("SELECT subject_digest,trusted_until FROM recorder_stations WHERE session_code=?").bind(code.toUpperCase()).first<{subject_digest:string|null;trusted_until:number}>();
  if(!bound?.subject_digest)return true; // Preserve manually managed, unenrolled sessions.
  const key=stationCookie(req,"ms_subject");
  return !!key && bound.trusted_until>Date.now() && await digest(key)===bound.subject_digest;
}
