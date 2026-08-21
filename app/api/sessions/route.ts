import { createSession, getSession, listSessions, mutateSession } from "@/lib/session-engine";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  if (url.searchParams.get("list") === "1") return Response.json({ sessions: await listSessions() });
  const code = url.searchParams.get("code")?.trim().toUpperCase() ?? "";
  if (!code) return Response.json({ error:"Session code is required." },{status:400});
  const session = await getSession(code);
  return session ? Response.json({ session }) : Response.json({ error:"Session not found." },{status:404});
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as { action?:string; code?:string; participantId?:number; operator?:string; payload?:Record<string,unknown> };
    if (body.action === "create") {
      if (!body.participantId || body.participantId < 1) return Response.json({error:"Participant ID is required."},{status:400});
      return Response.json({ session:await createSession(body.participantId,body.operator ?? "Operator") },{status:201});
    }
    if (!body.code || !body.action) return Response.json({error:"Session code and action are required."},{status:400});
    const session = await mutateSession(body.code,body.action,body.payload ?? {});
    return session ? Response.json({session}) : Response.json({error:"Session not found."},{status:404});
  } catch (error) {
    return Response.json({error:error instanceof Error ? error.message : "Unable to save the session."},{status:500});
  }
}
