import { env } from "cloudflare:workers";
import { DEFAULT_PROTOCOL_OPTIONS, assignFor, buildPlan, clipSource, sanitizeProtocolOptions, shortLabel } from "./protocol";
import { QUESTIONNAIRES, scoreQuestionnaire, validAnswers } from "./questionnaires";
import { STIMULI, stimulusById } from "./stimuli";
import { ARTIFACT_TYPES, CSI_CALIBRATION_SEC, CSI_SETUP_FIELDS, PARTICIPANT_FIELDS, heartRateAgreement, missingParticipantFields, openArtifactSpans, sanitizeFields } from "./rig";
import { GATE, SCREENING_QUESTIONS, evaluateGate, screeningComplete, skippedSafetySteps, updatePhysiology } from "./safety";
import { SAM_POINTS } from "./tasks";
import { DEFAULT_MEDIA, PROTOCOL_VERSION, SENSOR_CATALOG, type AcquisitionAgent, type ProtocolStep, type DeviceConfig, type DeviceInventory, type ExperimentEvent, type MediaConfig, type RecordingArtifact, type SensorChannel, type SensorQuality, type SensorStatus, type SessionSnapshot, type SubjectSnapshot } from "./types";

type Bindings = { DB: D1Database; MEDIA: R2Bucket };
const bindings = () => env as unknown as Bindings;
const now = () => new Date().toISOString();
const uid = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 18)}`;
const acquisitionToken = () => `mac_${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`;
const OPERATOR_LEASE_MS = 12_000;
const AUTO_ADVANCE_TOLERANCE_MS = 1_500;
const SAVE_ATTEMPTS = 6;
export const ACQUISITION_LEASE_MS = 10_000;
const TARGET_RATES: Record<string,number> = { face:30,audio:48000,oximeter:60,csi:100,emg:1000,gsr:20,ecg:125,thermal:9,photodiode:1000,csi2:100,resp:50,environment:1 };
const DEFAULT_DEVICE_CONFIG: DeviceConfig = { face:"auto",audio:"auto",oximeter:"auto",csi:"none",emg:"none",gsr:"none",ecg:"none",thermal:"none",photodiode:"none",csi2:"none",resp:"none",environment:"none" };
/** Streams the acquisition agent can record; the rest of SENSOR_CATALOG is reserved for future devices. */
const AGENT_SENSOR_IDS = Object.keys(DEFAULT_DEVICE_CONFIG);

let schemaReady: Promise<void> | null = null;

/** Creates tables once per worker instance instead of on every request. */
export function ensureSchema() {
  schemaReady ??= createSchema().catch((error) => { schemaReady = null; throw error; });
  return schemaReady;
}

async function createSchema() {
  const db = bindings().DB;
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, participant_id INTEGER NOT NULL, operator TEXT NOT NULL, protocol_version TEXT NOT NULL, status TEXT NOT NULL, step_index INTEGER NOT NULL, revision INTEGER NOT NULL, assignment_json TEXT NOT NULL, snapshot_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at DESC)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, sequence INTEGER NOT NULL, step_id TEXT NOT NULL, event_type TEXT NOT NULL, severity TEXT NOT NULL, source TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_events_session_sequence ON events(session_id, sequence)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS media_assets (id TEXT PRIMARY KEY, object_key TEXT NOT NULL, filename TEXT NOT NULL, content_type TEXT NOT NULL, size INTEGER NOT NULL, created_at TEXT NOT NULL)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_media_created ON media_assets(created_at DESC)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS annotations (id TEXT PRIMARY KEY, code TEXT NOT NULL, step_id TEXT NOT NULL, chunk INTEGER NOT NULL, samples_json TEXT NOT NULL, created_at TEXT NOT NULL)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_annotations_code ON annotations(code, step_id, chunk)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS session_telemetry (code TEXT PRIMARY KEY, sensors_json TEXT, acquisition_json TEXT, operator_last_seen_at TEXT, subject_last_seen_at TEXT, updated_at TEXT NOT NULL)`),
  ]);
}

/*
 * Live telemetry (sensor readings, agent status, presence) changes every second, while protocol state changes a few
 * hundred times per session. Telemetry lives in `session_telemetry`, written per source without revision checks, so
 * heartbeats neither rewrite the protocol snapshot nor conflict with operator actions.
 */
type TelemetrySource = "operator" | "subject" | "agent";
const TELEMETRY_SOURCES: Record<string,TelemetrySource> = {
  heartbeat:"operator", subjectHeartbeat:"subject", acquisitionHeartbeat:"agent", acquisitionFinalize:"agent", sensor:"agent",
};
const HEARTBEAT_ACTIONS = new Set(["heartbeat","subjectHeartbeat","acquisitionHeartbeat"]);

type SessionRow = { snapshot_json:string; sensors_json:string|null; acquisition_json:string|null; operator_last_seen_at:string|null; subject_last_seen_at:string|null };
const SESSION_SELECT = `SELECT s.snapshot_json, t.sensors_json, t.acquisition_json, t.operator_last_seen_at, t.subject_last_seen_at FROM sessions s LEFT JOIN session_telemetry t ON t.code = s.code`;

function snapshotFromRow(row: SessionRow) {
  const snapshot = JSON.parse(row.snapshot_json) as SessionSnapshot;
  if (row.sensors_json) snapshot.sensors = JSON.parse(row.sensors_json) as SensorChannel[];
  if (row.acquisition_json) snapshot.acquisition = JSON.parse(row.acquisition_json) as AcquisitionAgent;
  if (row.operator_last_seen_at) snapshot.operatorLastSeenAt = row.operator_last_seen_at;
  if (row.subject_last_seen_at) snapshot.subjectLastSeenAt = row.subject_last_seen_at;
  snapshot.serverTime = now();
  const hydrated = hydrateSnapshot(snapshot);
  const step = buildPlan(hydrated.assignment)[hydrated.stepIndex];
  hydrated.heartRateAgreement = heartRateAgreement(hydrated.sensors, Date.now());
  hydrated.gate = step?.type === "gate" && ["running","paused"].includes(hydrated.status) ? evaluateGate(hydrated.acquisition.physiology, Date.now(), Date.parse(hydrated.stepStartedAt)) : null;
  return hydrated;
}

/** Protocol snapshot as stored: telemetry and per-response fields are kept out of it. */
const UNSTORED_FIELDS = new Set(["sensors","acquisition","operatorLastSeenAt","subjectLastSeenAt","serverTime","gate","heartRateAgreement"]);
function storedSnapshot(snapshot: SessionSnapshot) {
  return JSON.stringify(Object.fromEntries(Object.entries(snapshot).filter(([key]) => !UNSTORED_FIELDS.has(key))));
}

function telemetryStatement(snapshot: SessionSnapshot, source: TelemetrySource) {
  const db = bindings().DB;
  const updatedAt = now();
  if (source === "operator") return db.prepare(`INSERT INTO session_telemetry (code, operator_last_seen_at, updated_at) VALUES (?, ?, ?) ON CONFLICT(code) DO UPDATE SET operator_last_seen_at=excluded.operator_last_seen_at, updated_at=excluded.updated_at`).bind(snapshot.code,snapshot.operatorLastSeenAt,updatedAt);
  if (source === "subject") return db.prepare(`INSERT INTO session_telemetry (code, subject_last_seen_at, updated_at) VALUES (?, ?, ?) ON CONFLICT(code) DO UPDATE SET subject_last_seen_at=excluded.subject_last_seen_at, updated_at=excluded.updated_at`).bind(snapshot.code,snapshot.subjectLastSeenAt,updatedAt);
  return db.prepare(`INSERT INTO session_telemetry (code, sensors_json, acquisition_json, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(code) DO UPDATE SET sensors_json=excluded.sensors_json, acquisition_json=excluded.acquisition_json, updated_at=excluded.updated_at`).bind(snapshot.code,JSON.stringify(snapshot.sensors),JSON.stringify(snapshot.acquisition),updatedAt);
}

function eventStatement(sessionId: string, event: ExperimentEvent, guard?: { code:string; writeId:string }) {
  const db = bindings().DB;
  const values = [event.id,sessionId,event.sequence,event.stepId,event.eventType,event.severity,event.source,JSON.stringify(event),event.createdAt];
  if (!guard) return db.prepare(`INSERT OR IGNORE INTO events (id, session_id, sequence, step_id, event_type, severity, source, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(...values);
  // Only lands if this attempt's snapshot update won the revision check in the same batch.
  return db.prepare(`INSERT OR IGNORE INTO events (id, session_id, sequence, step_id, event_type, severity, source, payload_json, created_at) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM sessions WHERE code = ? AND json_extract(snapshot_json, '$.writeId') = ?)`).bind(...values,guard.code,guard.writeId);
}

function protocolSignature(snapshot: SessionSnapshot) {
  return JSON.stringify([snapshot.status,snapshot.stepIndex,snapshot.stepStartedAt,snapshot.preflightTest,snapshot.events.length,snapshot.subjectMedia,snapshot.csiCalibration]);
}

const SENSOR_START_GRACE_MS = 15_000;
const LOST_SENSOR_STATUSES = new Set(["missing","error","unknown","connected"]);

/**
 * While the protocol runs, losing the operator or a required stream pauses the session on the server and logs why,
 * instead of letting the subject display silently hide (and later restart) the current stimulus.
 */
function enforceLeases(snapshot: SessionSnapshot) {
  if (snapshot.status !== "running") return;
  const at = Date.now();
  const operatorLost = !snapshot.operatorLastSeenAt || at - Date.parse(snapshot.operatorLastSeenAt) > OPERATOR_LEASE_MS;
  let lostSensors: string[] = [];
  const recordingFor = snapshot.recordingStartedAt ? at - Date.parse(snapshot.recordingStartedAt) : 0;
  if (!snapshot.hardwareGateOverride && recordingFor > SENSOR_START_GRACE_MS) {
    const agentOnline = Boolean(snapshot.acquisition.lastSeenAt && at - Date.parse(snapshot.acquisition.lastSeenAt) <= ACQUISITION_LEASE_MS);
    lostSensors = agentOnline ? snapshot.requiredSensors.filter((id) => {
      const sensor = snapshot.sensors.find((item) => item.id === id);
      return !sensor || at - Date.parse(sensor.updatedAt) > ACQUISITION_LEASE_MS || LOST_SENSOR_STATUSES.has(sensor.status);
    }) : ["acquisition agent"];
  }
  if (!operatorLost && lostSensors.length === 0) return;
  const reason = operatorLost ? "Operator console disconnected" : `Recording lost: ${lostSensors.join(", ")}`;
  snapshot.status = "paused";
  snapshot.pausedAt = now();
  snapshot.announcement = { id:uid("ann"), text:"Please wait a moment.", kind:"pause", createdAt:snapshot.pausedAt };
  appendEvent(snapshot,{ eventType:operatorLost ? "operator_lost" : "sensor_lost", label:"Session paused automatically", detail:reason, severity:"warn", source:"system", metadata:{ lostSensors } });
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
  return { ...sensor, status:"unknown", latencyMs:null, detail:"Waiting for acquisition agent", rateHz:null, sampleCount:0, latestValue:"", device:"", recordingFile:"", bytesWritten:0,targetRateHz:TARGET_RATES[sensor.id]??null,hardwareDetected:false,dataDetected:false,quality:"waiting",droppedSamples:0,dropoutPct:0,metrics:{},series:[],validation:[],updatedAt:createdAt };
}

function emptyAcquisition(): AcquisitionAgent {
  return { id:"", state:"waiting", host:"", platform:"", version:"", recordingRoot:"", lastSeenAt:null, connectedAt:null, finalizedAt:null,inventory:{video:[],audio:[],serial:[]},diskFreeGb:null,estimatedHours:null,clockOffsetMs:null,openFileCount:0,droppedPct:0,previewUrls:{},configRevision:0 };
}

function hydrateSnapshot(snapshot: SessionSnapshot): SessionSnapshot {
  const source = Array.isArray(snapshot.sensors) ? snapshot.sensors : [];
  snapshot.sensors = SENSOR_CATALOG.map((catalog) => {
    const existing = source.find((sensor) => sensor.id === catalog.id);
    return { ...emptySensor(catalog,snapshot.createdAt), ...existing, ...catalog };
  });
  snapshot.acquisitionToken ||= `mac_${snapshot.id.replaceAll("-","").slice(-18)}${snapshot.code}`;
  snapshot.acquisition = { ...emptyAcquisition(), ...(snapshot.acquisition ?? {}) };
  const recordingDefaults: Partial<RecordingArtifact> = { durationSec:0, averageRateHz:0, droppedSamples:0, dropoutPct:0, gapCount:0, totalGapSec:0, longestGapSec:0, availabilityPct:0 };
  snapshot.recordings = Array.isArray(snapshot.recordings) ? snapshot.recordings.map((recording) => ({ ...recordingDefaults, ...recording })) : [];
  snapshot.requiredSensors = Array.isArray(snapshot.requiredSensors) ? snapshot.requiredSensors : ["face","oximeter","csi","emg"];
  snapshot.hardwareGateOverride = Boolean(snapshot.hardwareGateOverride);
  snapshot.deviceConfig = { ...DEFAULT_DEVICE_CONFIG, ...(snapshot.deviceConfig ?? {}) };
  snapshot.configRevision = Number.isFinite(snapshot.configRevision) ? snapshot.configRevision : 0;
  snapshot.configurationLocked = snapshot.configurationLocked === undefined ? ["running","paused","complete","aborted"].includes(snapshot.status) : Boolean(snapshot.configurationLocked);
  snapshot.recordingStartedAt = snapshot.recordingStartedAt ?? (["running","paused"].includes(snapshot.status) ? snapshot.createdAt : null);
  snapshot.preflightTest = snapshot.preflightTest ?? {status:"idle",detail:"Not run",completedAt:null};
  snapshot.subjectLastSeenAt = snapshot.subjectLastSeenAt ?? null;
  snapshot.media = {
    ...DEFAULT_MEDIA,
    ...(snapshot.media ?? {}),
    emotions: {
      ...DEFAULT_MEDIA.emotions,
      ...(snapshot.media?.emotions ?? {}),
    },
  };
  for (const emotion of Object.keys(DEFAULT_MEDIA.emotions) as Array<keyof typeof DEFAULT_MEDIA.emotions>) {
    snapshot.media.emotions[emotion] ||= DEFAULT_MEDIA.emotions[emotion];
  }
  snapshot.media.boxBreathing ||= DEFAULT_MEDIA.boxBreathing;
  snapshot.media.bodyScan ||= DEFAULT_MEDIA.bodyScan;
  return snapshot;
}

export async function createSession(participantId: number, operator: string) {
  await ensureSchema();
  const assignment = assignFor(participantId);
  const createdAt = now();
  const snapshot: SessionSnapshot = {
    id: uid("ses"), code: sessionCode(assignment.pid), revision: 1, participantId: assignment.pid,
    operator: operator.trim() || "Operator", protocolVersion: PROTOCOL_VERSION, assignment, status:"setup",
    stepIndex:0, attempt:1, stepStartedAt:createdAt, pausedAt:null, announcement:null, events:[], notes:[], ratings:[],
    sensors:SENSOR_CATALOG.map((sensor) => emptySensor(sensor,createdAt)),
    bpReadings:[], media:structuredClone(DEFAULT_MEDIA), nbackLevel:1, operatorLastSeenAt:createdAt,subjectLastSeenAt:null,
    acquisitionToken:acquisitionToken(), acquisition:emptyAcquisition(), recordings:[], requiredSensors:["face","audio","oximeter"], hardwareGateOverride:false,deviceConfig:{...DEFAULT_DEVICE_CONFIG},configRevision:1,configurationLocked:false,recordingStartedAt:null,preflightTest:{status:"idle",detail:"Not run",completedAt:null}, createdAt, updatedAt:createdAt,
  };
  const event = appendEvent(snapshot,{ eventType:"session_prepared", label:"Session prepared", detail:`Participant ${assignment.pid}, emotion row ${assignment.row}, task order ${assignment.bufferRow}`, source:"operator", metadata:{ assignment } });
  snapshot.revision = 2;
  snapshot.writeId = uid("w");
  const db = bindings().DB;
  for (let attempt = 0; attempt < 5; attempt++) {
    const taken = await db.prepare(`SELECT 1 FROM sessions WHERE code = ? LIMIT 1`).bind(snapshot.code).first();
    if (!taken) break;
    snapshot.code = sessionCode(assignment.pid);
  }
  await db.batch([
    db.prepare(`INSERT INTO sessions (id, code, participant_id, operator, protocol_version, status, step_index, revision, assignment_json, snapshot_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(snapshot.id,snapshot.code,snapshot.participantId,snapshot.operator,snapshot.protocolVersion,snapshot.status,snapshot.stepIndex,snapshot.revision,JSON.stringify(assignment),storedSnapshot(snapshot),createdAt,createdAt),
    eventStatement(snapshot.id,event),
    telemetryStatement(snapshot,"operator"),
    telemetryStatement(snapshot,"agent"),
  ]);
  snapshot.serverTime = now();
  return snapshot;
}

export async function getSession(code: string) {
  await ensureSchema();
  const row = await bindings().DB.prepare(`${SESSION_SELECT} WHERE s.code = ? LIMIT 1`).bind(code.toUpperCase()).first<SessionRow>();
  return row ? snapshotFromRow(row) : null;
}

/** Joining by participant number is limited to sessions still in setup, so a guessed number cannot attach to a study in progress. */
export async function getLatestSetupSessionForParticipant(participantId: number) {
  await ensureSchema();
  if (!Number.isSafeInteger(participantId) || participantId < 1) return null;
  const row = await bindings().DB.prepare(`${SESSION_SELECT} WHERE s.participant_id = ? AND s.status = 'setup' ORDER BY s.created_at DESC LIMIT 1`)
    .bind(participantId).first<SessionRow>();
  return row ? snapshotFromRow(row) : null;
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
  if ((current?.type === "clip" || current?.type === "annotation") && current.clip) mediaSrc = clipSource(snapshot.assignment, current.clip, snapshot.media.emotions);
  if (current?.type === "washout") mediaSrc = snapshot.media.washout;
  if (current?.type === "bodyscan") mediaSrc = snapshot.media.bodyScan;
  if (current?.fixation) mediaSrc = snapshot.media.fixation;
  if (current?.title === "Box breathing") mediaSrc = snapshot.media.boxBreathing;

  const operatorConnected = Boolean(snapshot.operatorLastSeenAt && Date.now() - Date.parse(snapshot.operatorLastSeenAt) <= OPERATOR_LEASE_MS);
  const acquisitionReady = snapshot.hardwareGateOverride || requiredSensorsReady(snapshot,{recording:true});
  return {
    serverTime: now(),
    // A photodiode on the screen corner needs the sync patch; without one the patch stays hidden from the subject.
    syncPatch: Boolean(snapshot.deviceConfig.photodiode && snapshot.deviceConfig.photodiode !== "none"),
    mediaManifest: [...new Set([...Object.values(snapshot.assignment.stimuli ?? {}).map((id) => stimulusById(id, STIMULI)?.src ?? ""),...Object.values(snapshot.media.emotions),snapshot.media.washout,snapshot.media.boxBreathing,snapshot.media.bodyScan,snapshot.media.fixation].filter(Boolean))],
    code: snapshot.code,
    participantId: snapshot.participantId,
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
      questionnaireId: current.questionnaireId,
      breathsPerMin: current.breathsPerMin,
      variant: current.title === "Box breathing" ? "box_breathing" : current.title === "Breath hold" ? "breath_hold" : current.breathsPerMin ? "paced_breathing" : null,
    } : null,
  };
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
  skipScreenedSteps(snapshot, plan, 1);
  snapshot.attempt = 1;
  snapshot.stepStartedAt = now();
  snapshot.announcement = null;
  appendEvent(snapshot,{ eventType:"step_start", label:"Step started", detail:shortLabel(plan[snapshot.stepIndex]), source:"system" });
}

function screeningSkipReasons(snapshot: SessionSnapshot, step: ProtocolStep | undefined) {
  return step?.safetyKey ? skippedSafetySteps(snapshot.screening?.answers)[step.safetyKey] ?? null : null;
}

/** Moves past steps the participant's screening excluded, logging each one. */
function skipScreenedSteps(snapshot: SessionSnapshot, plan: readonly ProtocolStep[], direction: 1 | -1) {
  for (;;) {
    const step = plan[snapshot.stepIndex];
    const reasons = screeningSkipReasons(snapshot, step);
    const nextIndex = snapshot.stepIndex + direction;
    if (!reasons || nextIndex < 0 || nextIndex >= plan.length) return;
    appendEvent(snapshot,{ eventType:"step_skipped", label:"Step skipped by screening", detail:`${shortLabel(step)}: ${reasons.join(", ")}`, severity:"warn", source:"system", metadata:{ safetyKey:step.safetyKey, reasons } });
    snapshot.stepIndex = nextIndex;
  }
}

/**
 * One readiness rule for both portals: the agent is online and every required stream is fresh and delivering data.
 * Before starting, streams must also be of good quality; once running, the subject display only needs them recording,
 * so a brief quality dip does not interrupt the protocol.
 */
function requiredSensorsReady(snapshot: SessionSnapshot, options: { recording?: boolean } = {}) {
  const fresh = (timestamp: string | null) => Boolean(timestamp && Date.now()-Date.parse(timestamp)<=ACQUISITION_LEASE_MS);
  return fresh(snapshot.acquisition.lastSeenAt) && snapshot.requiredSensors.every((id)=>{
    const sensor=snapshot.sensors.find((item)=>item.id===id);
    return Boolean(sensor && fresh(sensor.updatedAt) && sensor.dataDetected && (options.recording ? sensor.status==="recording" : sensor.quality==="good"));
  });
}

type ActionPayload = Record<string, unknown>;
export async function mutateSession(code: string, action: string, payload: ActionPayload) {
  await ensureSchema();
  for (let attempt = 0; attempt < SAVE_ATTEMPTS; attempt++) {
    // Jittered backoff so simultaneous writers stop colliding on the same revision.
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, attempt * 25 + Math.random() * 50));
    const current = await getSession(code);
    if (!current) return null;
    const beforeRevision = current.revision;
    const beforeCount = current.events.length;
    const beforeSignature = protocolSignature(current);
    const plan = buildPlan(current.assignment);
    const step = plan[current.stepIndex];
    const expectedStepId = String(payload.expectedStepId ?? "");
    if (expectedStepId && step?.id !== expectedStepId) return current;

    const running = current.status === "running";
    if (action === "advance" && running) {
      const fromSubject = payload.source === "subject";
      // Subjects may only finish steps they control; gates, timers, and operator checks stay with the operator.
      if (!fromSubject && step?.type === "gate") {
        const gate = evaluateGate(current.acquisition.physiology, Date.now(), Date.parse(current.stepStartedAt));
        const override = payload.override === true;
        if (gate.status === "not_ready" && !override) throw new Error("Physiology has not returned to baseline yet. Wait, or advance with an override.");
        const eventType = gate.status === "ready" ? "gate_verified" : gate.status === "unavailable" ? "gate_unverified" : "gate_override";
        const label = gate.status === "ready" ? "Return to baseline verified" : gate.status === "unavailable" ? "Return to baseline not measurable" : "Return-to-baseline gate overridden";
        appendEvent(current,{ eventType, label, detail:String(payload.reason ?? ""), severity:eventType === "gate_override" ? "warn" : "info", source:"operator", metadata:{ gate } });
      }
      if (!fromSubject || step?.advance === "media" || step?.advance === "subject") advance(current,String(payload.reason ?? ""),fromSubject ? "subject" : "operator");
    }
    if (action === "heartbeat") {
      const previousSeen = current.operatorLastSeenAt ? Date.parse(current.operatorLastSeenAt) : NaN;
      const gap = Number.isFinite(previousSeen) ? Date.now() - previousSeen : 0;
      if (gap > OPERATOR_LEASE_MS && current.status === "running") {
        current.stepStartedAt = new Date(Date.parse(current.stepStartedAt) + gap - OPERATOR_LEASE_MS).toISOString();
      }
      current.operatorLastSeenAt = now();
    }
    if (action === "subjectHeartbeat") {
      current.subjectLastSeenAt=now();
      const media = payload.media as { loaded:number; total:number; failed:number } | undefined;
      if (media && media.total > 0) current.subjectMedia = { ...media, ready: media.loaded >= media.total && media.failed === 0 };
    }
    if (action === "navigate" && !["setup","aborted"].includes(current.status)) {
      const direction = Number(payload.direction) < 0 ? -1 : 1;
      let targetIndex = Math.max(0,Math.min(plan.length - 1,current.stepIndex + direction));
      while (screeningSkipReasons(current,plan[targetIndex]) && targetIndex + direction >= 0 && targetIndex + direction < plan.length) targetIndex += direction;
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
    if (action === "autoAdvance" && running && step?.advance === "timer" && step.durationSec && Date.now()-Date.parse(current.stepStartedAt) >= step.durationSec*1000-AUTO_ADVANCE_TOLERANCE_MS) advance(current,"Timer completed","system");
    if (action === "pause" && current.status === "running") { current.status="paused"; current.pausedAt=now(); current.announcement={id:uid("ann"),text:"Please wait a moment.",kind:"pause",createdAt:now()}; appendEvent(current,{eventType:"session_paused",label:"Session paused",detail:String(payload.reason ?? ""),severity:"warn",source:payload.source === "subject" ? "subject" : "operator"}); }
    if (action === "resume" && current.status === "paused") { const delta = current.pausedAt ? Date.now()-Date.parse(current.pausedAt) : 0; current.stepStartedAt=new Date(Date.parse(current.stepStartedAt)+delta).toISOString(); current.status="running"; current.pausedAt=null; current.announcement=null; appendEvent(current,{eventType:"session_resumed",label:"Session resumed",source:"operator",metadata:{pauseMs:delta}}); }
    if (action === "repeat") { current.attempt += 1; current.stepStartedAt=now(); appendEvent(current,{eventType:"step_repeated",label:"Step repeated by operator",detail:String(payload.reason ?? "No reason entered"),severity:"warn",source:"operator",metadata:{attempt:current.attempt}}); }
    if (action === "message") { const text=String(payload.text ?? "").trim().slice(0,180); if(text){ current.announcement={id:uid("ann"),text,kind:payload.kind === "safety" ? "safety" : "info",createdAt:now()}; appendEvent(current,{eventType:"operator_message",label:"Operator message sent",detail:text,source:"operator"}); } }
    if (action === "ack") { if(current.announcement) appendEvent(current,{eventType:"message_ack",label:"Message acknowledged",source:"subject"}); current.announcement=null; }
    if (action === "log") appendEvent(current,{eventType:String(payload.eventType ?? "subject_event"),label:String(payload.label ?? "Subject event"),detail:String(payload.detail ?? ""),severity:(payload.severity as ExperimentEvent["severity"]) ?? "info",source:(payload.source as ExperimentEvent["source"]) ?? "subject",metadata:(payload.metadata as Record<string,unknown>) ?? {}});
    if (action === "rating" && running && step?.type === "sam" && step.clip) {
      const rating = { emotion:step.clip, valence:Number(payload.valence), arousal:Number(payload.arousal), dominance:Number(payload.dominance), scalePoints:SAM_POINTS, discreteEmotion:(payload.discreteEmotion as string | null) ?? null, intensity:(payload.intensity as number | null) ?? null, familiarity:(payload.familiarity as string | null) ?? null, createdAt:now() };
      current.ratings.push(rating);
      appendEvent(current,{eventType:"rating_submitted",label:"Rating submitted",source:"subject",metadata:{...rating}});
      advance(current,"Response submitted","subject");
    }
    if (action === "taskComplete" && running && (step?.type === "stroop" || step?.type === "nback" || step?.advance === "subject")) { appendEvent(current,{eventType:String(payload.eventType ?? "task_complete"),label:String(payload.label ?? "Task completed"),source:"subject",metadata:(payload.metadata as Record<string,unknown>) ?? {}}); advance(current,"Task completed","subject"); }
    if (action === "note") { const body=String(payload.body ?? "").trim().slice(0,500); if(body){ current.notes.push({id:uid("note"),body,category:String(payload.category ?? "general"),stepId:step?.id ?? "",stepLabel:step ? shortLabel(step) : "",createdAt:now()}); appendEvent(current,{eventType:"operator_note",label:"Operator note",detail:body,source:"operator"}); } }
    if (action === "sensor") { const sensor=current.sensors.find((item)=>item.id===payload.id); if(sensor){ sensor.status=String(payload.status) as SensorStatus; sensor.detail=String(payload.detail ?? sensor.detail); sensor.updatedAt=now(); appendEvent(current,{eventType:"sensor_status",label:`${sensor.label}: ${sensor.status}`,severity:["missing","error"].includes(sensor.status)?"error":sensor.status==="delayed"?"warn":"info",source:"sensor",metadata:{sensorId:sensor.id,status:sensor.status}}); } }
    if (action === "acquisitionHeartbeat") applyAcquisitionHeartbeat(current,payload);
    if (action === "acquisitionFinalize") applyAcquisitionFinalize(current,payload);
    if (action === "deviceConfig") {
      if (current.configurationLocked) throw new Error("Device configuration is locked while recording.");
      const incoming = payload.devices && typeof payload.devices === "object" ? payload.devices as Record<string,unknown> : {};
      current.deviceConfig = { ...current.deviceConfig };
      for (const id of AGENT_SENSOR_IDS) current.deviceConfig[id]=clean(incoming[id]??current.deviceConfig[id]??"none",180)||"none";
      current.configRevision += 1;
      current.preflightTest={status:"idle",detail:"Run preflight after changing hardware",completedAt:null};
      appendEvent(current,{eventType:"device_configuration",label:"Device assignments updated",detail:`Configuration ${current.configRevision}`,source:"operator"});
    }
    if (action === "refreshDevices" && current.status === "setup" && !current.configurationLocked) {
      current.configRevision += 1;
      current.preflightTest={status:"idle",detail:"Run preflight after refreshing hardware",completedAt:null};
      appendEvent(current,{eventType:"device_refresh",label:"Hardware discovery requested",source:"operator"});
    }
    if (action === "startPreflight" && current.status === "setup") {
      current.preflightTest={status:"running",detail:"Validating selected devices for 10 seconds",completedAt:null};
      appendEvent(current,{eventType:"preflight_started",label:"Preflight test started",source:"operator"});
    }
    if (action === "protocolOptions" && current.status === "setup" && current.stepIndex === 0) {
      const options = sanitizeProtocolOptions(payload.options, current.assignment.options ?? DEFAULT_PROTOCOL_OPTIONS);
      current.assignment = { ...current.assignment, options };
      appendEvent(current,{ eventType:"protocol_options", label:"Protocol options saved", detail:Object.entries(options).filter(([,on]) => on).map(([name]) => name).join(", ") || "Core protocol only", source:"operator", metadata:{ options, steps:buildPlan(current.assignment).length } });
    }
    if (action === "questionnaire" && running && step?.type === "questionnaire" && step.questionnaireId) {
      const definition = QUESTIONNAIRES[step.questionnaireId];
      const answers = definition ? validAnswers(definition, payload.answers) : null;
      if (!answers) throw new Error("Answer every question.");
      const scores = scoreQuestionnaire(definition.id, answers);
      current.questionnaires = [...(current.questionnaires ?? []), { questionnaireId:definition.id, stepId:step.id, answers, scores, createdAt:now() }];
      appendEvent(current,{ eventType:"questionnaire_submitted", label:`${definition.id} submitted`, source:"subject", metadata:{ questionnaireId:definition.id, scores } });
      advance(current,"Questionnaire submitted","subject");
    }
    if (action === "participantMetadata" && !["complete","aborted"].includes(current.status)) {
      const values = sanitizeFields(PARTICIPANT_FIELDS, payload.values);
      current.participantMetadata = { values, updatedAt:now() };
      const missing = missingParticipantFields(values);
      appendEvent(current,{ eventType:"participant_metadata", label:"Participant details saved", detail:missing.length ? `Missing: ${missing.join(", ")}` : "Complete", source:"operator", metadata:{ values, missing } });
    }
    if (action === "csiSetup" && !["complete","aborted"].includes(current.status)) {
      const values = sanitizeFields(CSI_SETUP_FIELDS, payload.values);
      current.csiSetup = { values, updatedAt:now() };
      appendEvent(current,{ eventType:"csi_setup", label:"WiFi CSI setup saved", source:"operator", metadata:{ values } });
    }
    if (action === "csiCalibration" && current.status === "setup" && current.csiCalibration?.status !== "running") {
      current.csiCalibration = { status:"running", detail:"Recording the empty room", startedAt:now(), completedAt:null, rows:0, durationSec:CSI_CALIBRATION_SEC };
      appendEvent(current,{ eventType:"csi_calibration_started", label:"Empty-room CSI baseline started", detail:`${CSI_CALIBRATION_SEC} s`, source:"operator" });
    }
    if (action === "artifact" && ["running","paused"].includes(current.status)) {
      const type = ARTIFACT_TYPES.find((item) => item.id === payload.type);
      if (!type) throw new Error("Unknown artifact type.");
      let kind: "point" | "start" | "end" = "point";
      if (type.kind === "span") kind = openArtifactSpans(current.events).has(type.id) ? "end" : "start";
      appendEvent(current,{ eventType:"artifact", label:`Artifact: ${type.label}${kind === "start" ? " started" : kind === "end" ? " ended" : ""}`, severity:"warn", source:"operator", metadata:{ type:type.id, kind } });
    }
    if (action === "screening" && current.status === "setup") {
      const incoming = payload.answers && typeof payload.answers === "object" ? payload.answers as Record<string,unknown> : {};
      const answers = Object.fromEntries(SCREENING_QUESTIONS.filter((item) => typeof incoming[item.id] === "boolean").map((item) => [item.id, incoming[item.id] as boolean]));
      if (!screeningComplete(answers)) throw new Error("Answer every screening question.");
      current.screening = { answers, completedAt:now() };
      const skipped = skippedSafetySteps(answers);
      appendEvent(current,{ eventType:"screening_recorded", label:"Safety screening recorded", detail:Object.keys(skipped).length ? `Skipping: ${Object.keys(skipped).join(", ")}` : "No steps skipped", source:"operator", metadata:{ answers, skipped } });
    }
    if (action === "startSession" && current.status === "setup") {
      if (!screeningComplete(current.screening?.answers)) throw new Error("Complete the safety screening before starting the session.");
      if (!current.hardwareGateOverride && (!requiredSensorsReady(current) || current.preflightTest.status!=="pass")) throw new Error("Complete a successful preflight before starting the session.");
      if (!current.hardwareGateOverride && !current.subjectMedia?.ready) throw new Error("Wait for the subject display to finish loading the study media.");
      current.status="running";
      current.configurationLocked=true;
      current.recordingStartedAt=now();
      current.stepStartedAt=current.recordingStartedAt;
      appendEvent(current,{eventType:"session_start",label:"Recording started",detail:`Participant ${current.participantId}`,source:"operator"});
      appendEvent(current,{eventType:"step_start",label:"Step started",detail:shortLabel(plan[current.stepIndex]),source:"system"});
    }
    if (action === "requiredSensors" && !current.configurationLocked) {
      const ids = Array.isArray(payload.ids) ? payload.ids.map(String).filter((id)=>SENSOR_CATALOG.some((sensor)=>sensor.id===id)) : [];
      current.requiredSensors = [...new Set(ids)];
      current.hardwareGateOverride = false;
      appendEvent(current,{eventType:"required_sensors_updated",label:"Required sensors updated",detail:current.requiredSensors.join(", ")||"None",source:"operator"});
    }
    if (action === "hardwareGateOverride" && !current.configurationLocked) {
      current.hardwareGateOverride = Boolean(payload.enabled);
      appendEvent(current,{eventType:"hardware_gate_override",label:current.hardwareGateOverride?"Hardware readiness override enabled":"Hardware readiness override cleared",severity:current.hardwareGateOverride?"warn":"info",source:"operator"});
    }
    if (action === "bp") { if (!Number.isFinite(Number(payload.systolic)) || !Number.isFinite(Number(payload.diastolic))) throw new Error("Enter systolic and diastolic values."); current.bpReadings.push({stepId:step?.id ?? "",label:String(payload.label ?? step?.bpLabel ?? "Reading"),systolic:Number(payload.systolic),diastolic:Number(payload.diastolic),pulse:Number.isFinite(Number(payload.pulse)) && payload.pulse !== "" && payload.pulse != null ? Number(payload.pulse) : null,createdAt:now()}); appendEvent(current,{eventType:"bp_recorded",label:"Blood pressure recorded",source:"operator",metadata:{systolic:payload.systolic,diastolic:payload.diastolic,pulse:payload.pulse}}); }
    if (action === "nbackLevel" && Number.isFinite(Number(payload.level))) current.nbackLevel = Math.max(1,Math.min(3,Math.round(Number(payload.level)))) as 1|2|3;
    if (action === "media") { current.media = payload.media as MediaConfig; appendEvent(current,{eventType:"media_config",label:"Media configuration updated",source:"operator"}); }
    if (action === "complete") { current.status="complete"; current.stepIndex=plan.length-1; current.stepStartedAt=now(); appendEvent(current,{eventType:"session_complete",label:"Session completed by operator",source:"operator"}); }
    if (action === "abort") { current.status="aborted"; appendEvent(current,{eventType:"session_aborted",label:"Session aborted",severity:"warn",source:"operator"}); }

    if (HEARTBEAT_ACTIONS.has(action)) enforceLeases(current);
    const db = bindings().DB;
    const telemetrySource = TELEMETRY_SOURCES[action];
    if (HEARTBEAT_ACTIONS.has(action) && protocolSignature(current) === beforeSignature) {
      await telemetryStatement(current,telemetrySource).run();
      return current;
    }

    current.revision = beforeRevision + 1;
    current.updatedAt = now();
    current.writeId = uid("w");
    const guard = { code:current.code, writeId:current.writeId };
    const statements = [
      db.prepare(`UPDATE sessions SET status=?, step_index=?, revision=?, snapshot_json=?, updated_at=? WHERE code=? AND revision=?`)
        .bind(current.status,current.stepIndex,current.revision,storedSnapshot(current),current.updatedAt,current.code,beforeRevision),
      ...current.events.slice(beforeCount).map((event) => eventStatement(current.id,event,guard)),
    ];
    if (telemetrySource) statements.push(telemetryStatement(current,telemetrySource));
    const [result] = await db.batch(statements);
    if (result.meta.changes === 1) return current;
  }
  throw new Error("The session changed while saving. Please try again.");
}

export function getBindings() { return bindings(); }

/**
 * Continuous annotation samples are append-only and high volume, so they go to their own table instead of the
 * session snapshot. Only the step currently being replayed accepts samples.
 */
export async function appendAnnotationChunk(code: string, payload: ActionPayload) {
  await ensureSchema();
  const session = await getSession(code);
  if (!session) return null;
  const step = buildPlan(session.assignment)[session.stepIndex];
  if (step?.type !== "annotation" || step.id !== payload.expectedStepId || !["running","paused"].includes(session.status)) return session;
  const samples = Array.isArray(payload.samples) ? payload.samples : [];
  if (!samples.length) return session;
  await bindings().DB.prepare(`INSERT OR IGNORE INTO annotations (id, code, step_id, chunk, samples_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(`${session.code}:${step.id}:${session.attempt}:${payload.chunk}`, session.code, step.id, Number(payload.chunk), JSON.stringify({ attempt:session.attempt, samples }), now()).run();
  return session;
}

export async function listAnnotations(code: string) {
  await ensureSchema();
  const result = await bindings().DB.prepare(`SELECT step_id, chunk, samples_json FROM annotations WHERE code = ? ORDER BY step_id, chunk`).bind(code).all<{ step_id:string; chunk:number; samples_json:string }>();
  return result.results.map((row) => ({ stepId:row.step_id, chunk:row.chunk, ...(JSON.parse(row.samples_json) as { attempt:number; samples:unknown[] }) }));
}

function applyAcquisitionHeartbeat(snapshot: SessionSnapshot, payload: ActionPayload) {
  const seenAt = now();
  const previous = snapshot.acquisition;
  const wasOffline = previous.state !== "online" || !previous.lastSeenAt || Date.now() - Date.parse(previous.lastSeenAt) > ACQUISITION_LEASE_MS;
  snapshot.acquisition = {
    id:clean(payload.agentId,80), state:"online", host:clean(payload.host,120), platform:clean(payload.platform,120),
    version:clean(payload.version,32), recordingRoot:clean(payload.recordingRoot,300), lastSeenAt:seenAt,
    connectedAt:previous.connectedAt ?? seenAt, finalizedAt:null,inventory:sanitizeInventory(payload.inventory),
    diskFreeGb:finiteOrNull(payload.diskFreeGb,0,1_000_000),estimatedHours:finiteOrNull(payload.estimatedHours,0,100_000),
    clockOffsetMs:finiteOrNull(payload.clockOffsetMs,-60_000,60_000),openFileCount:finite(payload.openFileCount,0,100),
    droppedPct:finiteOrNull(payload.droppedPct,0,100)??0,previewUrls:sanitizePreviewUrls(payload.previewUrls),
    configRevision:finite(payload.configRevision,0,1_000_000),
    physiology:previous.physiology,
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
    sensor.targetRateHz = finiteOrNull(report.targetRateHz,0,100_000) ?? sensor.targetRateHz;
    sensor.hardwareDetected = Boolean(report.hardwareDetected);
    sensor.dataDetected = Boolean(report.dataDetected);
    sensor.quality = validSensorQuality(report.quality);
    sensor.droppedSamples = finite(report.droppedSamples,0,Number.MAX_SAFE_INTEGER);
    sensor.dropoutPct = finiteOrNull(report.dropoutPct,0,100)??0;
    sensor.metrics = sanitizeMetrics(report.metrics);
    sensor.series = Array.isArray(report.series) ? report.series.slice(-160).map((value)=>finiteOrNull(value,-1_000_000_000,1_000_000_000)).filter((value):value is number=>value!==null) : [];
    sensor.validation = Array.isArray(report.validation) ? report.validation.slice(0,8).map((value)=>clean(value,100)) : [];
    sensor.updatedAt = seenAt;
    if (previousStatus !== status) appendEvent(snapshot,{
      eventType:"sensor_status", label:`${sensor.label}: ${status}`, detail:sensor.detail,
      severity:["missing","error"].includes(status)?"error":status==="delayed"?"warn":"info", source:"sensor",
      metadata:{sensorId:sensor.id,status,rateHz:sensor.rateHz,sampleCount:sensor.sampleCount},
    });
  }
  recordPhysiology(snapshot);
  if (payload.csiCalibration && typeof payload.csiCalibration === "object" && snapshot.csiCalibration?.status === "running") {
    const report = payload.csiCalibration as Record<string,unknown>;
    if (["done","failed"].includes(String(report.status))) {
      snapshot.csiCalibration = { ...snapshot.csiCalibration, status:String(report.status) as "done" | "failed", detail:clean(report.detail,200), completedAt:now(), rows:finite(report.rows,0,Number.MAX_SAFE_INTEGER) };
      appendEvent(snapshot,{ eventType:"csi_calibration_completed", label:`Empty-room CSI baseline ${report.status}`, detail:snapshot.csiCalibration.detail, severity:report.status === "failed" ? "error" : "info", source:"sensor", metadata:{ rows:snapshot.csiCalibration.rows } });
    }
  }
  if (payload.preflightTest && typeof payload.preflightTest === "object") {
    const test=payload.preflightTest as Record<string,unknown>;
    const status=["idle","running","pass","fail"].includes(String(test.status)) ? String(test.status) as SessionSnapshot["preflightTest"]["status"] : "idle";
    const completedAt=clean(test.completedAt,40)||null;
    if (!(snapshot.preflightTest.status==="running"&&status==="idle")) {
      const changed=status!==snapshot.preflightTest.status || completedAt!==snapshot.preflightTest.completedAt;
      snapshot.preflightTest={status,detail:clean(test.detail,220),completedAt};
      if(changed&&["pass","fail"].includes(status)) appendEvent(snapshot,{eventType:"preflight_completed",label:`Preflight ${status}`,detail:snapshot.preflightTest.detail,severity:status==="fail"?"error":"info",source:"sensor"});
    }
  }
}

/** Heart rate and skin conductance feed the resting baseline (during baseline steps) and the gate's recent window. */
function recordPhysiology(snapshot: SessionSnapshot) {
  const metric = (id: string, key: string, min: number, max: number) => {
    const sensor = snapshot.sensors.find((item) => item.id === id);
    const value = sensor?.metrics[key];
    return sensor?.dataDetected && sensor.metrics.fingerDetected !== false && typeof value === "number" && value >= min && value <= max ? value : null;
  };
  const hr = metric("oximeter","heartRate",30,220) ?? metric("ecg","heartRate",30,220);
  const gsr = metric("gsr","conductance",0.01,100);
  if (hr === null && gsr === null) return;
  const step = buildPlan(snapshot.assignment)[snapshot.stepIndex];
  const collectBaseline = snapshot.status === "running" && step?.type === "baseline" && Date.now() - Date.parse(snapshot.stepStartedAt) >= GATE.baselineSettleSec * 1000;
  snapshot.acquisition.physiology = updatePhysiology(snapshot.acquisition.physiology, { t:Date.now(), hr, gsr }, collectBaseline);
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
    return [{sensorId,relativePath:clean(item.relativePath,260),format:clean(item.format,40),sampleCount:finite(item.sampleCount,0,Number.MAX_SAFE_INTEGER),bytes:finite(item.bytes,0,Number.MAX_SAFE_INTEGER),sha256:clean(item.sha256,64),startedAt:clean(item.startedAt,40),endedAt:clean(item.endedAt,40)||endedAt,quality,durationSec:finiteOrNull(item.durationSec,0,1_000_000)??0,averageRateHz:finiteOrNull(item.averageRateHz,0,100_000)??0,droppedSamples:finite(item.droppedSamples,0,Number.MAX_SAFE_INTEGER),dropoutPct:finiteOrNull(item.dropoutPct,0,100)??0,gapCount:finite(item.gapCount,0,Number.MAX_SAFE_INTEGER),totalGapSec:finiteOrNull(item.totalGapSec,0,1_000_000)??0,longestGapSec:finiteOrNull(item.longestGapSec,0,1_000_000)??0,availabilityPct:finiteOrNull(item.availabilityPct,0,100)??0}];
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
function validSensorQuality(value: unknown): SensorQuality { const quality=String(value) as SensorQuality; return ["disabled","waiting","good","degraded","bad"].includes(quality)?quality:"waiting"; }
function sanitizeMetrics(value: unknown) { const result:Record<string,number|string|boolean>={}; if(!value||typeof value!=="object")return result; for(const [key,raw] of Object.entries(value as Record<string,unknown>).slice(0,24)){const safeKey=clean(key,40);if(typeof raw==="number"&&Number.isFinite(raw))result[safeKey]=Math.round(raw*1000)/1000;else if(typeof raw==="boolean")result[safeKey]=raw;else if(typeof raw==="string")result[safeKey]=clean(raw,100)}return result; }
function sanitizeInventory(value: unknown):DeviceInventory { const result:DeviceInventory={video:[],audio:[],serial:[]};if(!value||typeof value!=="object")return result;for(const kind of ["video","audio","serial"] as const){const items=(value as Record<string,unknown>)[kind];if(!Array.isArray(items))continue;result[kind]=items.slice(0,24).flatMap((raw)=>{if(!raw||typeof raw!=="object")return[];const item=raw as Record<string,unknown>;return[{id:clean(item.id,180),label:clean(item.label,220),kind,description:clean(item.description,220)}]})}return result; }
function sanitizePreviewUrls(value: unknown){const result:Record<string,string>={};if(!value||typeof value!=="object")return result;for(const id of ["face","thermal"]){const url=clean((value as Record<string,unknown>)[id],300);if(/^http:\/\/(127\.0\.0\.1|localhost):\d+\/preview\//.test(url))result[id]=url}return result;}

export function acquisitionCommand(snapshot: SessionSnapshot) {
  const step = buildPlan(snapshot.assignment)[snapshot.stepIndex] ?? null;
  const command = ["complete","aborted"].includes(snapshot.status)?"finalize":snapshot.status==="setup"?(snapshot.csiCalibration?.status==="running"?"calibrate":snapshot.preflightTest.status==="running"?"test":"probe"):"record";
  return {
    serverTime:now(), sessionCode:snapshot.code, participantId:snapshot.participantId,
    command,calibrationSec:snapshot.csiCalibration?.durationSec ?? CSI_CALIBRATION_SEC,calibrationStartedAt:snapshot.csiCalibration?.startedAt ?? null,deviceConfig:snapshot.deviceConfig,configRevision:snapshot.configRevision,requiredSensors:snapshot.requiredSensors,
    sessionStatus:snapshot.status, revision:snapshot.revision, stepIndex:snapshot.stepIndex,
    step:step?{id:step.id,label:shortLabel(step),phase:step.phase,startedAt:snapshot.stepStartedAt,attempt:snapshot.attempt}:null,
    // Recent ledger entries let the agent write event markers stamped with when they happened, not when it polled.
    recentEvents:snapshot.events.slice(-50).map(agentEvent),
  };
}

function agentEvent(event: ExperimentEvent) {
  const clientTime = typeof event.metadata?.clientTime === "string" ? event.metadata.clientTime : null;
  return { id:event.id, sequence:event.sequence, eventType:event.eventType, label:event.label, detail:event.detail, severity:event.severity, source:event.source, stepId:event.stepId, stepIndex:event.stepIndex, attempt:event.attempt, serverTime:event.createdAt, clientTime, metadata:event.metadata ?? {} };
}

/** Everything the acquisition computer needs to write an analysis-ready bundle next to the raw recordings. */
export function acquisitionExport(snapshot: SessionSnapshot) {
  const plan = buildPlan(snapshot.assignment);
  return {
    exportedAt:now(), sessionCode:snapshot.code, participantId:snapshot.participantId, operator:snapshot.operator,
    protocolVersion:snapshot.protocolVersion, status:snapshot.status, assignment:snapshot.assignment,
    createdAt:snapshot.createdAt, recordingStartedAt:snapshot.recordingStartedAt, requiredSensors:snapshot.requiredSensors,
    deviceConfig:snapshot.deviceConfig, media:snapshot.media, hardwareGateOverride:snapshot.hardwareGateOverride,
    plan:plan.map((step) => ({ id:step.id, index:step.index, type:step.type, title:step.title, label:shortLabel(step), phase:step.phase, emotion:step.emo ?? null, durationSec:step.durationSec ?? null, advance:step.advance })),
    events:snapshot.events.map(agentEvent), ratings:snapshot.ratings, notes:snapshot.notes, bpReadings:snapshot.bpReadings,
    participantMetadata:snapshot.participantMetadata?.values ?? {}, participantFields:PARTICIPANT_FIELDS,
    protocolOptions:snapshot.assignment.options ?? null, stimuli:Object.fromEntries(Object.entries(snapshot.assignment.stimuli ?? {}).map(([clip,id]) => [clip, stimulusById(id, STIMULI) ?? { id }])),
    questionnaires:snapshot.questionnaires ?? [], questionnaireItems:QUESTIONNAIRES,
    csiSetup:snapshot.csiSetup?.values ?? {}, csiSetupFields:CSI_SETUP_FIELDS, csiCalibration:snapshot.csiCalibration ?? null,
  };
}
