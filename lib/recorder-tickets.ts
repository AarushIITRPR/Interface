import {getBindings} from "./session-engine";
export const opaque=()=>Array.from(crypto.getRandomValues(new Uint8Array(24)),b=>b.toString(16).padStart(2,"0")).join("");
export const digest=async(s:string)=>Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(s))),b=>b.toString(16).padStart(2,"0")).join("");
export async function ticketTable(){
  const db=getBindings().DB;
  await db.prepare("CREATE TABLE IF NOT EXISTS recorder_pairing (session_code TEXT PRIMARY KEY, digest TEXT NOT NULL, expires INTEGER NOT NULL)").run();
  return db;
}
export async function mintTicket(code:string,subjectDigest?:string){
  const db=await ticketTable(),secret=opaque(),expires=Date.now()+300_000,hashed=await digest(secret);
  const result=subjectDigest
    ?await db.prepare("INSERT OR REPLACE INTO recorder_pairing SELECT ?,?,? FROM recorder_stations r JOIN sessions s ON s.code=r.session_code WHERE r.subject_digest=? AND r.session_code=? AND s.status='setup' AND r.trusted_until>?").bind(code,hashed,expires,subjectDigest,code,Date.now()).run()
    :await db.prepare("INSERT OR REPLACE INTO recorder_pairing VALUES(?,?,?)").bind(code,hashed,expires).run();
  return result.meta.changes?{secret,expires}:null;
}
