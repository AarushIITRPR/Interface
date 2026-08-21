import { env } from "cloudflare:workers";
import { assignFor, buildPlan, shortLabel } from "./protocol";
import { DEFAULT_MEDIA, PROTOCOL_VERSION, SENSOR_CATALOG, type ExperimentEvent, type MediaConfig, type SensorStatus, type SessionSnapshot, type SubjectSnapshot } from "./types";

type Bindings = { DB: D1Database; MEDIA: R2Bucket };
const bindings = () => env as unknown as Bindings;
const now = () => new Date().toISOString();
const uid = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 18)}`;
const OPERATOR_LEASE_MS = 12_000;

export async function ensureSchema() {
  const db = bindings().DB;
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, participant_id INTEGER NOT NULL, operator TEXT NOT NULL, protocol_version TEXT NOT NULL, status TEXT NOT NULL, step_index INTEGER NOT NULL, revision INTEGER NOT NULL, assignment_json TEXT NOT NULL, snapshot_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at DESC)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, sequence INTEGER NOT NULL, step_id TEXT NOT NULL, event_type TEXT NOT NULL, severity TEXT NOT NULL, source TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_events_session_sequence ON events(session_id, sequence)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS media_assets (id TEXT PRIMARY KEY, object_key TEXT NOT NULL, filename TEXT NOT NULL, content_type TEXT NOT NULL, size INTEGER NOT NULL, created_at TEXT NOT NULL)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_media_created ON media_assets(created_at DESC)`),
  ]);
}

function appendEvent(snapshot: SessionSnapshot, input: Partial<ExperimentEvent> & Pick<ExperimentEvent,"eventType"|"label"|"source">) {
  const plan = buildPlan(snapshot.assignment);
  const step = plan[snapshot.stepIndex];
  const event: ExperimentEvent = {
    id: uid("ev"), sequence: snapshot.events.length + 1, stepId: step?.id ?? "", stepIndex: snapshot.stepIndex,
    stepLabel: step ? shortLabel(step) : "", eventType: input.eventType, label: input.label, detail: input.detail ?? "",
    severity: input.severity ?? "info", source: input.source, createdAt: now(), attempt: snapshot.attempt,
    metadata: input.metadata ?? {},
  };
  snapshot.events.push(event);
  return event;
}

function sessionCode(pid: number) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const suffix = Array.from(crypto.getRandomValues(new Uint8Array(4)), (n) => alphabet[n % alphabet.length]).join("");
  return `${String(pid).padStart(4,"0")}${suffix}`;
}

export async function createSession(participantId: number, operator: string) {
  await ensureSchema();
  const assignment = assignFor(participantId);
  const createdAt = now();
  const snapshot: SessionSnapshot = {
    id: uid("ses"), code: sessionCode(assignment.pid), revision: 1, participantId: assignment.pid,
    operator: operator.trim() || "Operator", protocolVersion: PROTOCOL_VERSION, assignment, status:"running",
    stepIndex:0, attempt:1, stepStartedAt:createdAt, pausedAt:null, announcement:null, events:[], notes:[], ratings:[],
    sensors:SENSOR_CATALOG.map((sensor) => ({ ...sensor, status:"recording", latencyMs:Math.floor(18 + Math.random()*24), detail:"Signal present", updatedAt:createdAt })),
    bpReadings:[], media:structuredClone(DEFAULT_MEDIA), nbackLevel:1, operatorLastSeenAt:createdAt, createdAt, updatedAt:createdAt,
  };
  const event = appendEvent(snapshot,{ eventType:"session_start", label:"Session started", detail:`Participant ${assignment.pid}, Williams row ${assignment.row}`, source:"operator", metadata:{ assignment } });
  appendEvent(snapshot,{ eventType:"step_start", label:"Step started", detail:shortLabel(buildPlan(assignment)[0]), source:"system" });
  snapshot.revision = 2;
  const db = bindings().DB;
  await db.prepare(`INSERT INTO sessions (id, code, participant_id, operator, protocol_version, status, step_index, revision, assignment_json, snapshot_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(snapshot.id,snapshot.code,snapshot.participantId,snapshot.operator,snapshot.protocolVersion,snapshot.status,snapshot.stepIndex,snapshot.revision,JSON.stringify(assignment),JSON.stringify(snapshot),createdAt,createdAt).run();
  await persistEvent(snapshot.id,event);
  await persistEvent(snapshot.id,snapshot.events[1]);
  return snapshot;
}

export async function getSession(code: string) {
  await ensureSchema();
  const row = await bindings().DB.prepare(`SELECT snapshot_json FROM sessions WHERE code = ? LIMIT 1`).bind(code.toUpperCase()).first<{snapshot_json:string}>();
  return row ? JSON.parse(row.snapshot_json) as SessionSnapshot : null;
}

export async function listSessions() {
  await ensureSchema();
  const result = await bindings().DB.prepare(`SELECT code, participant_id, operator, status, step_index, revision, created_at, updated_at FROM sessions ORDER BY updated_at DESC LIMIT 50`).all();
  return result.results;
}

export function toSubjectSnapshot(snapshot: SessionSnapshot): SubjectSnapshot {
  const plan = buildPlan(snapshot.assignment);
  const current = plan[snapshot.stepIndex] ?? null;
  let mediaSrc = "";
  if (current?.type === "clip" && current.emo) mediaSrc = snapshot.media.emotions[current.emo];
  if (current?.type === "washout") mediaSrc = snapshot.media.washout;
  if (current?.type === "bodyscan") mediaSrc = snapshot.media.bodyScan;
  if (current?.fixation) mediaSrc = snapshot.media.fixation;
  if (current?.title === "Box breathing") mediaSrc = snapshot.media.boxBreathing;

  const operatorConnected = Boolean(snapshot.operatorLastSeenAt && Date.now() - Date.parse(snapshot.operatorLastSeenAt) <= OPERATOR_LEASE_MS);
  return {
    code: snapshot.code,
    revision: snapshot.revision,
    status: snapshot.status,
    stepIndex: snapshot.stepIndex,
    stepCount: plan.length,
    attempt: snapshot.attempt,
    stepStartedAt: snapshot.stepStartedAt,
    announcement: snapshot.announcement,
    nbackLevel: snapshot.nbackLevel,
    operatorConnected,
    mediaSrc,
    step: current ? {
      id: current.id,
      index: current.index,
      type: current.type,
      subjectPrompt: current.subjectPrompt,
      durationSec: current.durationSec,
      safety: current.safety,
      fixation: current.fixation,
      advance: current.advance,
      variant: current.title === "Box breathing" ? "box_breathing" : current.title === "Breath hold" ? "breath_hold" : null,
    } : null,
  };
}

async function persistEvent(sessionId: string, event: ExperimentEvent) {
  await bindings().DB.prepare(`INSERT OR IGNORE INTO events (id, session_id, sequence, step_id, event_type, severity, source, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(event.id,sessionId,event.sequence,event.stepId,event.eventType,event.severity,event.source,JSON.stringify(event),event.createdAt).run();
}

function advance(snapshot: SessionSnapshot, reason: string, source: "subject"|"operator"|"system") {
  const plan = buildPlan(snapshot.assignment);
  const current = plan[snapshot.stepIndex];
  appendEvent(snapshot,{ eventType:"step_end", label:"Step completed", detail:reason || shortLabel(current), source });
  if (snapshot.stepIndex >= plan.length - 1) {
    snapshot.status = "complete";
    appendEvent(snapshot,{ eventType:"session_complete", label:"Session completed", source:"system" });
    return;
  }
  snapshot.stepIndex += 1;
  snapshot.attempt = 1;
  snapshot.stepStartedAt = now();
  snapshot.announcement = null;
  appendEvent(snapshot,{ eventType:"step_start", label:"Step started", detail:shortLabel(plan[snapshot.stepIndex]), source:"system" });
}

type ActionPayload = Record<string, unknown>;
export async function mutateSession(code: string, action: string, payload: ActionPayload) {
  await ensureSchema();
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = await getSession(code);
    if (!current) return null;
    const beforeRevision = current.revision;
    const beforeCount = current.events.length;
    const plan = buildPlan(current.assignment);
    const step = plan[current.stepIndex];
    const expectedStepId = String(payload.expectedStepId ?? "");
    if (expectedStepId && step?.id !== expectedStepId) return current;

    if (action === "advance" && current.status === "running") advance(current,String(payload.reason ?? ""),(payload.source === "subject" ? "subject" : "operator"));
    if (action === "heartbeat") {
      const previousSeen = current.operatorLastSeenAt ? Date.parse(current.operatorLastSeenAt) : NaN;
      const gap = Number.isFinite(previousSeen) ? Date.now() - previousSeen : 0;
      if (gap > OPERATOR_LEASE_MS && current.status === "running") {
        current.stepStartedAt = new Date(Date.parse(current.stepStartedAt) + gap - OPERATOR_LEASE_MS).toISOString();
      }
      current.operatorLastSeenAt = now();
    }
    if (action === "navigate" && current.status !== "aborted") {
      const direction = Number(payload.direction) < 0 ? -1 : 1;
      const targetIndex = Math.max(0,Math.min(plan.length - 1,current.stepIndex + direction));
      if (targetIndex !== current.stepIndex) {
        const previousLabel = step ? shortLabel(step) : "Unknown step";
        const target = plan[targetIndex];
        appendEvent(current,{eventType:"operator_navigation",label:direction < 0 ? "Moved to previous task" : "Moved to next task",detail:`${previousLabel} to ${shortLabel(target)}`,source:"operator",metadata:{fromIndex:current.stepIndex,toIndex:targetIndex}});
        current.stepIndex = targetIndex;
        current.attempt = 1;
        current.stepStartedAt = now();
        if (current.status === "complete") current.status = "running";
        if (current.status === "paused") current.pausedAt = current.stepStartedAt;
        appendEvent(current,{eventType:"step_start",label:"Step started",detail:shortLabel(target),source:"operator"});
      }
    }
    if (action === "autoAdvance" && current.status === "running" && step?.durationSec) advance(current,"Timer completed","system");
    if (action === "pause" && current.status === "running") { current.status="paused"; current.pausedAt=now(); current.announcement={id:uid("ann"),text:"Please wait a moment.",kind:"pause",createdAt:now()}; appendEvent(current,{eventType:"session_paused",label:"Session paused",detail:String(payload.reason ?? ""),severity:"warn",source:payload.source === "subject" ? "subject" : "operator"}); }
    if (action === "resume" && current.status === "paused") { const delta = current.pausedAt ? Date.now()-Date.parse(current.pausedAt) : 0; current.stepStartedAt=new Date(Date.parse(current.stepStartedAt)+delta).toISOString(); current.status="running"; current.pausedAt=null; current.announcement=null; appendEvent(current,{eventType:"session_resumed",label:"Session resumed",source:"operator",metadata:{pauseMs:delta}}); }
    if (action === "repeat") { current.attempt += 1; current.stepStartedAt=now(); appendEvent(current,{eventType:"step_repeated",label:"Step repeated by operator",detail:String(payload.reason ?? "No reason entered"),severity:"warn",source:"operator",metadata:{attempt:current.attempt}}); }
    if (action === "message") { const text=String(payload.text ?? "").trim().slice(0,180); if(text){ current.announcement={id:uid("ann"),text,kind:payload.kind === "safety" ? "safety" : "info",createdAt:now()}; appendEvent(current,{eventType:"operator_message",label:"Operator message sent",detail:text,source:"operator"}); } }
    if (action === "ack") { if(current.announcement) appendEvent(current,{eventType:"message_ack",label:"Message acknowledged",source:"subject"}); current.announcement=null; }
    if (action === "log") appendEvent(current,{eventType:String(payload.eventType ?? "subject_event"),label:String(payload.label ?? "Subject event"),detail:String(payload.detail ?? ""),severity:(payload.severity as ExperimentEvent["severity"]) ?? "info",source:(payload.source as ExperimentEvent["source"]) ?? "subject",metadata:(payload.metadata as Record<string,unknown>) ?? {}});
    if (action === "rating") { current.ratings.push({emotion:step?.emo ?? "happy",valence:Number(payload.valence),arousal:Number(payload.arousal),dominance:Number(payload.dominance),createdAt:now()}); appendEvent(current,{eventType:"rating_submitted",label:"Rating submitted",source:"subject",metadata:{emotion:step?.emo,valence:payload.valence,arousal:payload.arousal,dominance:payload.dominance}}); advance(current,"Response submitted","subject"); }
    if (action === "taskComplete") { appendEvent(current,{eventType:String(payload.eventType ?? "task_complete"),label:String(payload.label ?? "Task completed"),source:"subject",metadata:(payload.metadata as Record<string,unknown>) ?? {}}); advance(current,"Task completed","subject"); }
    if (action === "note") { const body=String(payload.body ?? "").trim().slice(0,500); if(body){ current.notes.push({id:uid("note"),body,category:String(payload.category ?? "general"),stepId:step?.id ?? "",stepLabel:step ? shortLabel(step) : "",createdAt:now()}); appendEvent(current,{eventType:"operator_note",label:"Operator note",detail:body,source:"operator"}); } }
    if (action === "sensor") { const sensor=current.sensors.find((item)=>item.id===payload.id); if(sensor){ sensor.status=String(payload.status) as SensorStatus; sensor.detail=String(payload.detail ?? sensor.detail); sensor.updatedAt=now(); appendEvent(current,{eventType:"sensor_status",label:`${sensor.label}: ${sensor.status}`,severity:["missing","error"].includes(sensor.status)?"error":sensor.status==="delayed"?"warn":"info",source:"sensor",metadata:{sensorId:sensor.id,status:sensor.status}}); } }
    if (action === "bp") { current.bpReadings.push({stepId:step?.id ?? "",label:String(payload.label ?? step?.bpLabel ?? "Reading"),systolic:Number(payload.systolic),diastolic:Number(payload.diastolic),pulse:payload.pulse ? Number(payload.pulse) : null,createdAt:now()}); appendEvent(current,{eventType:"bp_recorded",label:"Blood pressure recorded",source:"operator",metadata:{systolic:payload.systolic,diastolic:payload.diastolic,pulse:payload.pulse}}); }
    if (action === "nbackLevel") current.nbackLevel = Math.max(1,Math.min(3,Number(payload.level))) as 1|2|3;
    if (action === "media") { current.media = payload.media as MediaConfig; appendEvent(current,{eventType:"media_config",label:"Media configuration updated",source:"operator"}); }
    if (action === "complete") { current.status="complete"; current.stepIndex=plan.length-1; current.stepStartedAt=now(); appendEvent(current,{eventType:"session_complete",label:"Session completed by operator",source:"operator"}); }
    if (action === "abort") { current.status="aborted"; appendEvent(current,{eventType:"session_aborted",label:"Session aborted",severity:"warn",source:"operator"}); }

    current.revision = beforeRevision + 1;
    current.updatedAt = now();
    const result = await bindings().DB.prepare(`UPDATE sessions SET status=?, step_index=?, revision=?, snapshot_json=?, updated_at=? WHERE code=? AND revision=?`)
      .bind(current.status,current.stepIndex,current.revision,JSON.stringify(current),current.updatedAt,current.code,beforeRevision).run();
    if (result.meta.changes === 1) { for(const event of current.events.slice(beforeCount)) await persistEvent(current.id,event); return current; }
  }
  throw new Error("The session changed while saving. Please try again.");
}

export function getBindings() { return bindings(); }
