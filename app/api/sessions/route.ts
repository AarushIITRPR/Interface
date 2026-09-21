import { getOperatorUser } from "@/app/operator-auth";
import { parseSince, trimEvents } from "@/lib/event-sync";
import { TemplateError, sanitizeTemplate } from "@/lib/protocol-template";
import { DISCRETE_EMOTIONS, FAMILIARITY, INTENSITY_POINTS, SAM_POINTS } from "@/lib/tasks";
import { summarizeCohort } from "@/lib/cohort";
import { appendAnnotationChunk, cohortSessions, createSession, getLatestSetupSessionForParticipant, getSession, listSessions, mutateSession, toSubjectSnapshot } from "@/lib/session-engine";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const receivedAt = new Date().toISOString();
  const url = new URL(request.url);
  const subjectView = url.searchParams.get("view") === "subject";
  const operator = subjectView ? null : await getOperatorUser();
  if (url.searchParams.get("cohort") === "1") {
    if (!operator) return unauthorized();
    return Response.json({ cohort:summarizeCohort(await cohortSessions()) },{headers:{"cache-control":"no-store"}});
  }
  if (url.searchParams.get("list") === "1") {
    if (!operator) return unauthorized();
    return Response.json({ sessions: await listSessions() });
  }
  const participantId = Number(url.searchParams.get("participantId"));
  if (subjectView && Number.isSafeInteger(participantId) && participantId > 0) {
    const active = await getLatestSetupSessionForParticipant(participantId);
    return active ? Response.json({session:toSubjectSnapshot(active),...clockStamps(receivedAt)}) : Response.json({error:"No session is waiting for this participant."},{status:404});
  }
  const code = url.searchParams.get("code")?.trim().toUpperCase() ?? "";
  if (!code) return Response.json({ error:"Session code is required." },{status:400});
  if (!subjectView && !operator) return unauthorized();
  const session = await getSession(code);
  // The console says which events it already holds, so a poll carries only newer ones.
  const since = parseSince(url.searchParams.get("since"));
  return session ? Response.json({ session:subjectView ? toSubjectSnapshot(session) : trimEvents(session, since), ...clockStamps(receivedAt) }) : Response.json({ error:"Session not found." },{status:404});
}

export async function POST(request: Request) {
  const receivedAt = new Date().toISOString();
  try {
    const body = await request.json() as { action?:string; code?:string; participantId?:number; operator?:string; view?:string; demo?:boolean; protocol?:unknown; since?:unknown; payload?:Record<string,unknown> };
    const subjectView = body.view === "subject";
    const operator = subjectView ? null : await getOperatorUser();
    if (body.action === "create") {
      if (!operator) return unauthorized();
      if (!body.participantId || body.participantId < 1) return Response.json({error:"Participant ID is required."},{status:400});
      // A preview carries the builder's draft template so an edit can be walked through before it is saved and
      // becomes what every future participant gets. It is validated exactly as a save would be.
      let protocol;
      try {
        protocol = body.protocol ? sanitizeTemplate(body.protocol) : undefined;
      } catch (error) {
        return Response.json({error:error instanceof TemplateError ? error.message : "That protocol could not be read."},{status:400});
      }
      return Response.json({ session:await createSession(body.participantId,body.operator ?? "Operator",{ demo:Boolean(body.demo), protocol }) },{status:201});
    }
    if (!body.code || !body.action) return Response.json({error:"Session code and action are required."},{status:400});
    if (subjectView && !isSubjectAction(body.action,body.payload ?? {})) return unauthorized();
    if (!subjectView && !operator) return unauthorized();
    const payload = subjectView ? sanitizeSubjectPayload(body.action,body.payload ?? {}) : body.payload ?? {};
    const session = body.action === "annotationChunk" ? await appendAnnotationChunk(body.code.trim().toUpperCase(),payload) : await mutateSession(body.code,body.action,payload);
    return session ? Response.json({session:subjectView ? toSubjectSnapshot(session) : trimEvents(session, parseSince(body.since)),...clockStamps(receivedAt)}) : Response.json({error:"Session not found."},{status:404});
  } catch (error) {
    return Response.json({error:error instanceof Error ? error.message : "Unable to save the session."},{status:500});
  }
}

const SUBJECT_ACTIONS = new Set(["ack","advance","autoAdvance","log","pause","rating","taskComplete","subjectHeartbeat","questionnaire","annotationChunk","startTimer"]);

function isSubjectAction(action:string,payload:Record<string,unknown>) {
  if (!SUBJECT_ACTIONS.has(action)) return false;
  if (action === "advance" || action === "pause") return payload.source === "subject";
  return true;
}

function sanitizeSubjectPayload(action:string,payload:Record<string,unknown>): Record<string,unknown> {
  const expectedStepId = String(payload.expectedStepId ?? "").slice(0,80);
  if (action === "subjectHeartbeat") return {media:sanitizeMediaProgress(payload.media)};
  if (action === "ack") return {};
  if (action === "pause") return {reason:"Subject requested a stop",source:"subject"};
  if (action === "advance") return {expectedStepId,reason:"Subject completed the step",source:"subject"};
  if (action === "autoAdvance") return {expectedStepId};
  if (action === "startTimer") return {expectedStepId,source:"subject"};
  if (action === "rating") return {
    expectedStepId,valence:scale(payload.valence,SAM_POINTS),arousal:scale(payload.arousal,SAM_POINTS),dominance:scale(payload.dominance,SAM_POINTS),
    discreteEmotion:oneOf(payload.discreteEmotion,DISCRETE_EMOTIONS),
    intensity:payload.discreteEmotion === "Neutral" || payload.intensity == null ? null : scale(payload.intensity,INTENSITY_POINTS),
    familiarity:oneOf(payload.familiarity,FAMILIARITY),
  };
  if (action === "questionnaire") {
    const raw = payload.answers && typeof payload.answers === "object" ? payload.answers as Record<string,unknown> : {};
    return {expectedStepId,answers:Object.fromEntries(Object.entries(raw).slice(0,64).map(([key,value]) => [key.slice(0,32),Number(value)]))};
  }
  if (action === "annotationChunk") {
    // Each sample is [server-corrected epoch ms, valence, arousal] with valence and arousal in [-1, 1].
    const samples = (Array.isArray(payload.samples) ? payload.samples : []).slice(0,400).flatMap((raw) => {
      if (!Array.isArray(raw) || raw.length !== 3) return [];
      const [time, valence, arousal] = raw.map(Number);
      return Number.isFinite(time) && Math.abs(valence) <= 1 && Math.abs(arousal) <= 1 ? [[Math.round(time), Math.round(valence*1000)/1000, Math.round(arousal*1000)/1000]] : [];
    });
    return {expectedStepId,chunk:Math.max(0,Math.min(100_000,Math.round(Number(payload.chunk) || 0))),samples};
  }
  if (action === "taskComplete") return {expectedStepId,eventType:String(payload.eventType ?? "task_complete").slice(0,80),label:String(payload.label ?? "Task completed").slice(0,120),metadata:boundedMetadata(payload.metadata)};
  const eventType = String(payload.eventType) in MEDIA_EVENT_LABELS ? String(payload.eventType) : "subject_event";
  return {expectedStepId,eventType,label:MEDIA_EVENT_LABELS[eventType] ?? "Subject event",severity:eventType === "media_error" ? "error" : "info",source:"subject",metadata:sanitizeMediaTiming(payload.metadata)};
}

const MEDIA_EVENT_LABELS: Record<string,string> = {
  media_onset:"Video started", media_offset:"Video completed", media_error:"Media failed to load",
  media_paused:"Video paused", media_resumed:"Video resumed", step_displayed:"Step shown on display",
};

/** Browser-side timing for stimulus events: clientTime is already corrected to the server clock by the subject display. */
function sanitizeMediaTiming(value:unknown) {
  const raw = value && typeof value === "object" ? value as Record<string,unknown> : {};
  const result: Record<string,string|number> = {};
  const clientTime = String(raw.clientTime ?? "");
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(clientTime)) result.clientTime = clientTime;
  for (const [key,max] of [["loadDelayMs",600_000],["mediaTimeSec",100_000],["durationSec",100_000]] as const) {
    const number = Number(raw[key]);
    if (raw[key] !== undefined && Number.isFinite(number)) result[key] = Math.max(0,Math.min(max,Math.round(number*1000)/1000));
  }
  return result;
}

function sanitizeMediaProgress(value:unknown) {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string,unknown>;
  const count = (input:unknown) => Math.max(0,Math.min(64,Math.round(Number(input) || 0)));
  return {loaded:count(raw.loaded),total:count(raw.total),failed:count(raw.failed)};
}

function scale(value:unknown,points:number) { return Math.max(1,Math.min(points,Math.round(Number(value) || 1))); }
function oneOf(value:unknown,options:readonly string[]) { return options.includes(String(value)) ? String(value) : null; }
/** Task results include per-trial data; keep them to a sane size. */
function boundedMetadata(value:unknown) { if (!value || typeof value !== "object") return {}; return JSON.stringify(value).length <= 64_000 ? value : {truncated:true}; }
/** Receive and reply times let clients estimate clock offset without counting server processing time. */
function clockStamps(receivedAt: string) { return { serverReceivedAt:receivedAt, serverRepliedAt:new Date().toISOString() }; }
function unauthorized() { return Response.json({error:"Instructor authorization is required."},{status:401}); }
