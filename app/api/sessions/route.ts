import { getOperatorUser } from "@/app/operator-auth";
import { createSession, getLatestActiveSessionForParticipant, getSession, listSessions, mutateSession, toSubjectSnapshot } from "@/lib/session-engine";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const subjectView = url.searchParams.get("view") === "subject";
  const operator = subjectView ? null : await getOperatorUser();
  if (url.searchParams.get("list") === "1") {
    if (!operator) return unauthorized();
    return Response.json({ sessions: await listSessions() });
  }
  const participantId = Number(url.searchParams.get("participantId"));
  if (subjectView && Number.isSafeInteger(participantId) && participantId > 0) {
    const active = await getLatestActiveSessionForParticipant(participantId);
    return active ? Response.json({session:toSubjectSnapshot(active)}) : Response.json({error:"No active session for this participant."},{status:404});
  }
  const code = url.searchParams.get("code")?.trim().toUpperCase() ?? "";
  if (!code) return Response.json({ error:"Session code is required." },{status:400});
  if (!subjectView && !operator) return unauthorized();
  const session = await getSession(code);
  return session ? Response.json({ session:subjectView ? toSubjectSnapshot(session) : session }) : Response.json({ error:"Session not found." },{status:404});
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as { action?:string; code?:string; participantId?:number; operator?:string; view?:string; payload?:Record<string,unknown> };
    const subjectView = body.view === "subject";
    const operator = subjectView ? null : await getOperatorUser();
    if (body.action === "create") {
      if (!operator) return unauthorized();
      if (!body.participantId || body.participantId < 1) return Response.json({error:"Participant ID is required."},{status:400});
      return Response.json({ session:await createSession(body.participantId,body.operator ?? "Operator") },{status:201});
    }
    if (!body.code || !body.action) return Response.json({error:"Session code and action are required."},{status:400});
    if (subjectView && !isSubjectAction(body.action,body.payload ?? {})) return unauthorized();
    if (!subjectView && !operator) return unauthorized();
    const payload = subjectView ? sanitizeSubjectPayload(body.action,body.payload ?? {}) : body.payload ?? {};
    const session = await mutateSession(body.code,body.action,payload);
    return session ? Response.json({session:subjectView ? toSubjectSnapshot(session) : session}) : Response.json({error:"Session not found."},{status:404});
  } catch (error) {
    return Response.json({error:error instanceof Error ? error.message : "Unable to save the session."},{status:500});
  }
}

const SUBJECT_ACTIONS = new Set(["ack","advance","autoAdvance","log","pause","rating","taskComplete","subjectHeartbeat","subjectNavigate"]);

function isSubjectAction(action:string,payload:Record<string,unknown>) {
  if (!SUBJECT_ACTIONS.has(action)) return false;
  if (action === "advance" || action === "pause") return payload.source === "subject";
  return true;
}

function sanitizeSubjectPayload(action:string,payload:Record<string,unknown>): Record<string,unknown> {
  return {...subjectPayload(action,payload), expectedStepStartedAt:String(payload.expectedStepStartedAt ?? "").slice(0,40), expectedAttempt:payload.expectedAttempt == null ? undefined : Number(payload.expectedAttempt)};
}
function subjectPayload(action:string,payload:Record<string,unknown>): Record<string,unknown> {
  const expectedStepId = String(payload.expectedStepId ?? "").slice(0,80);
  if (action === "subjectNavigate") return {expectedStepId,direction:Number(payload.direction)};
  if (action === "subjectHeartbeat") return {};
  if (action === "ack") return {};
  if (action === "pause") return {reason:"Subject requested a stop",source:"subject"};
  if (action === "advance") return {expectedStepId,reason:"Subject completed the step",source:"subject"};
  if (action === "autoAdvance") return {expectedStepId};
  if (action === "rating") return {expectedStepId,valence:scale(payload.valence),arousal:scale(payload.arousal),dominance:scale(payload.dominance)};
  if (action === "taskComplete") return {expectedStepId,eventType:String(payload.eventType ?? "task_complete").slice(0,80),label:String(payload.label ?? "Task completed").slice(0,120),metadata:payload.metadata ?? {}};
  if (action === "log" && payload.eventType === "nback_scored_onset") return {expectedStepId,eventType:"nback_scored_onset",label:"N-back scored sequence started after practice",source:"subject",metadata:{level:Math.max(1,Math.min(3,Number(payload.level)||1)),practiceScored:false}};
  const eventType = ["media_onset","media_offset","media_error"].includes(String(payload.eventType)) ? String(payload.eventType) : "subject_event";
  return {eventType,label:eventType === "media_onset" ? "Video started" : eventType === "media_offset" ? "Video completed" : eventType === "media_error" ? "Media failed to load" : "Subject event",severity:eventType === "media_error" ? "error" : "info",source:"subject"};
}

function scale(value:unknown) { return Math.max(1,Math.min(10,Math.round(Number(value) || 1))); }
function unauthorized() { return Response.json({error:"Instructor authorization is required."},{status:401}); }
