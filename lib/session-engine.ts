import { env } from "cloudflare:workers";
import { assignFor, buildPlan, shortLabel } from "./protocol";
import { DEFAULT_MEDIA, PROTOCOL_VERSION, SENSOR_CATALOG, type AcquisitionAgent, type ExperimentEvent, type MediaConfig, type RecordingArtifact, type SensorChannel, type SensorStatus, type SessionSnapshot, type SubjectSnapshot } from "./types";

type Bindings = { DB: D1Database; MEDIA: R2Bucket };
const bindings = () => env as unknown as Bindings;
const now = () => new Date().toISOString();
const uid = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 18)}`;
const acquisitionToken = () => `mac_${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`;
const OPERATOR_LEASE_MS = 12_000;
export const ACQUISITION_LEASE_MS = 10_000;

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

function emptySensor(sensor: Pick<SensorChannel,"id"|"label"|"group">, createdAt: string): SensorChannel {
  return { ...sensor, status:"unknown", latencyMs:null, detail:"Waiting for acquisition agent", rateHz:null, sampleCount:0, latestValue:"", device:"", recordingFile:"", bytesWritten:0, updatedAt:createdAt };
}

function emptyAcquisition(): AcquisitionAgent {
  return { id:"", state:"waiting", host:"", platform:"", version:"", recordingRoot:"", lastSeenAt:null, connectedAt:null, finalizedAt:null };
}

function hydrateSnapshot(snapshot: SessionSnapshot): SessionSnapshot {
  const source = Array.isArray(snapshot.sensors) ? snapshot.sensors : [];
  snapshot.sensors = SENSOR_CATALOG.map((catalog) => {
    const existing = source.find((sensor) => sensor.id === catalog.id);
    return { ...emptySensor(catalog,snapshot.createdAt), ...existing, ...catalog };
  });
  snapshot.acquisitionToken ||= `mac_${snapshot.id.replaceAll("-","").slice(-18)}${snapshot.code}`;
  snapshot.acquisition = { ...emptyAcquisition(), ...(snapshot.acquisition ?? {}) };
  snapshot.recordings = Array.isArray(snapshot.recordings) ? snapshot.recordings : [];
  snapshot.requiredSensors = Array.isArray(snapshot.requiredSensors) ? snapshot.requiredSensors : ["face","oximeter","csi","emg"];
  snapshot.hardwareGateOverride = Boolean(snapshot.hardwareGateOverride);
  return snapshot;
}

export async function createSession(participantId: number, operator: string) {
  await ensureSchema();
  const assignment = assignFor(participantId);
  const createdAt = now();
  const snapshot: SessionSnapshot = {
    id: uid("ses"), code: sessionCode(assignment.pid), revision: 1, participantId: assignment.pid,
    operator: operator.trim() || "Operator", protocolVersion: PROTOCOL_VERSION, assignment, status:"running",
    stepIndex:0, attempt:1, stepStartedAt:createdAt, pausedAt:null, announcement:null, events:[], notes:[], ratings:[],
    sensors:SENSOR_CATALOG.map((sensor) => emptySensor(sensor,createdAt)),
    bpReadings:[], media:structuredClone(DEFAULT_MEDIA), nbackLevel:1, operatorLastSeenAt:createdAt,
    acquisitionToken:acquisitionToken(), acquisition:emptyAcquisition(), recordings:[], requiredSensors:["face","oximeter","csi","emg"], hardwareGateOverride:false, createdAt, updatedAt:createdAt,
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
  return row ? hydrateSnapshot(JSON.parse(row.snapshot_json) as SessionSnapshot) : null;
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
  const agentConnected = Boolean(snapshot.acquisition.lastSeenAt && Date.now() - Date.parse(snapshot.acquisition.lastSeenAt) <= ACQUISITION_LEASE_MS);
  const acquisitionReady = snapshot.hardwareGateOverride || (agentConnected && snapshot.requiredSensors.every((id) => {
    const sensor = snapshot.sensors.find((item)=>item.id===id);
    return sensor?.status === "recording" && Date.now() - Date.parse(sensor.updatedAt) <= ACQUISITION_LEASE_MS;
  }));
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
    acquisitionReady,
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
    if (action === "acquisitionHeartbeat") applyAcquisitionHeartbeat(current,payload);
    if (action === "acquisitionFinalize") applyAcquisitionFinalize(current,payload);
    if (action === "requiredSensors") {
      const ids = Array.isArray(payload.ids) ? payload.ids.map(String).filter((id)=>SENSOR_CATALOG.some((sensor)=>sensor.id===id)) : [];
      current.requiredSensors = [...new Set(ids)];
      current.hardwareGateOverride = false;
      appendEvent(current,{eventType:"required_sensors_updated",label:"Required sensors updated",detail:current.requiredSensors.join(", ")||"None",source:"operator"});
    }
    if (action === "hardwareGateOverride") {
      current.hardwareGateOverride = Boolean(payload.enabled);
      appendEvent(current,{eventType:"hardware_gate_override",label:current.hardwareGateOverride?"Hardware readiness override enabled":"Hardware readiness override cleared",severity:current.hardwareGateOverride?"warn":"info",source:"operator"});
    }
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

function applyAcquisitionHeartbeat(snapshot: SessionSnapshot, payload: ActionPayload) {
  const seenAt = now();
  const previous = snapshot.acquisition;
  const wasOffline = previous.state !== "online" || !previous.lastSeenAt || Date.now() - Date.parse(previous.lastSeenAt) > ACQUISITION_LEASE_MS;
  snapshot.acquisition = {
    id:clean(payload.agentId,80), state:"online", host:clean(payload.host,120), platform:clean(payload.platform,120),
    version:clean(payload.version,32), recordingRoot:clean(payload.recordingRoot,300), lastSeenAt:seenAt,
    connectedAt:previous.connectedAt ?? seenAt, finalizedAt:null,
  };
  if (wasOffline) appendEvent(snapshot,{eventType:"acquisition_connected",label:"Acquisition agent connected",detail:snapshot.acquisition.host,source:"sensor"});

  const reports = Array.isArray(payload.sensors) ? payload.sensors.slice(0,SENSOR_CATALOG.length) : [];
  for (const raw of reports) {
    if (!raw || typeof raw !== "object") continue;
    const report = raw as Record<string,unknown>;
    const sensor = snapshot.sensors.find((item) => item.id === report.id);
    if (!sensor) continue;
    const previousStatus = sensor.status;
    const status = validSensorStatus(report.status);
    sensor.status = status;
    sensor.latencyMs = finiteOrNull(report.latencyMs,0,60_000);
    sensor.detail = clean(report.detail,160);
    sensor.rateHz = finiteOrNull(report.rateHz,0,100_000);
    sensor.sampleCount = finite(report.sampleCount,0,Number.MAX_SAFE_INTEGER);
    sensor.latestValue = clean(report.latestValue,160);
    sensor.device = clean(report.device,180);
    sensor.recordingFile = clean(report.recordingFile,260);
    sensor.bytesWritten = finite(report.bytesWritten,0,Number.MAX_SAFE_INTEGER);
    sensor.updatedAt = seenAt;
    if (previousStatus !== status) appendEvent(snapshot,{
      eventType:"sensor_status", label:`${sensor.label}: ${status}`, detail:sensor.detail,
      severity:["missing","error"].includes(status)?"error":status==="delayed"?"warn":"info", source:"sensor",
      metadata:{sensorId:sensor.id,status,rateHz:sensor.rateHz,sampleCount:sensor.sampleCount},
    });
  }
}

function applyAcquisitionFinalize(snapshot: SessionSnapshot, payload: ActionPayload) {
  const endedAt = now();
  const artifacts = Array.isArray(payload.recordings) ? payload.recordings.slice(0,32) : [];
  snapshot.recordings = artifacts.flatMap((raw): RecordingArtifact[] => {
    if (!raw || typeof raw !== "object") return [];
    const item = raw as Record<string,unknown>;
    const sensorId = clean(item.sensorId,40);
    if (!SENSOR_CATALOG.some((sensor)=>sensor.id===sensorId)) return [];
    const quality = ["pending","pass","warning","fail"].includes(String(item.quality)) ? String(item.quality) as RecordingArtifact["quality"] : "pending";
    return [{sensorId,relativePath:clean(item.relativePath,260),format:clean(item.format,40),sampleCount:finite(item.sampleCount,0,Number.MAX_SAFE_INTEGER),bytes:finite(item.bytes,0,Number.MAX_SAFE_INTEGER),sha256:clean(item.sha256,64),startedAt:clean(item.startedAt,40),endedAt:clean(item.endedAt,40)||endedAt,quality}];
  });
  snapshot.acquisition.state = "finalized";
  snapshot.acquisition.lastSeenAt = endedAt;
  snapshot.acquisition.finalizedAt = endedAt;
  appendEvent(snapshot,{eventType:"recordings_finalized",label:"Acquisition files finalized",detail:`${snapshot.recordings.length} files`,source:"sensor",metadata:{recordings:snapshot.recordings.length}});
}

function clean(value: unknown, max: number) { return Array.from(String(value ?? "")).filter((character)=>character.charCodeAt(0)>=32).join("").slice(0,max); }
function finite(value: unknown, min: number, max: number) { const number=Number(value); return Number.isFinite(number)?Math.max(min,Math.min(max,Math.round(number))):min; }
function finiteOrNull(value: unknown, min: number, max: number) { const number=Number(value); return Number.isFinite(number)?Math.max(min,Math.min(max,Math.round(number*100)/100)):null; }
function validSensorStatus(value: unknown): SensorStatus { const status=String(value) as SensorStatus; return ["connected","recording","delayed","missing","error","unknown"].includes(status)?status:"unknown"; }

export function acquisitionCommand(snapshot: SessionSnapshot) {
  const step = buildPlan(snapshot.assignment)[snapshot.stepIndex] ?? null;
  return {
    serverTime:now(), sessionCode:snapshot.code, participantId:snapshot.participantId,
    command:["complete","aborted"].includes(snapshot.status)?"finalize":"record",
    sessionStatus:snapshot.status, revision:snapshot.revision, stepIndex:snapshot.stepIndex,
    step:step?{id:step.id,label:shortLabel(step),phase:step.phase,startedAt:snapshot.stepStartedAt,attempt:snapshot.attempt}:null,
  };
}
