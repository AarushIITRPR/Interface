import {digest as hash,mintTicket,ticketTable} from "@/lib/recorder-tickets";
import { getOperatorUser } from "@/app/operator-auth";
import { getSession } from "@/lib/session-engine";

const reply=(value:unknown,status=200)=>Response.json(value,{status,headers:{"Cache-Control":"no-store"}});
export async function POST(request:Request){
  const origin=request.headers.get("origin");
  if(origin && origin!==new URL(request.url).origin)return reply({error:"Origin not allowed."},403);
  const body=await request.json().catch(()=>null);
  if(!body || !/^[A-Z0-9]{5,16}$/.test(body.code||""))return reply({error:"Invalid session."},400);
  if(body.action!=="redeem" && (body.action!=="issue" || !await getOperatorUser()))return reply({error:"Instructor authorization required."},403);
  const db=await ticketTable();
  if(body.action==="redeem"){
    if(typeof body.secret!=="string" || !/^[a-f0-9]{48}$/.test(body.secret))return reply({error:"Invalid pairing link."},400);
    const consumed=await db.prepare("DELETE FROM recorder_pairing WHERE session_code=? AND digest=? AND expires>? RETURNING session_code")
      .bind(body.code,await hash(body.secret),Date.now()).first();
    if(!consumed)return reply({error:"Pairing link expired or already used. Request a new link."},410);
  }
  const session=await getSession(body.code);
  if(!session || session.status!=="setup")return reply({error:"Pairing is available only while preparing a session."},409);
  if(body.action==="redeem")return reply({code:session.code,token:session.acquisitionToken});
  return reply(await mintTicket(session.code));
}
