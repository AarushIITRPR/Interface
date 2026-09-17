import { screeningComplete } from "./safety";
import type { SessionSnapshot } from "./types";

/**
 * Dataset-rig metadata: participant descriptors needed to interpret contactless sensing, operator artifact labels,
 * and the WiFi CSI room setup. Values are categorical bands, never free text, to keep the dataset de-identified.
 */

export type ChoiceField = { id: string; label: string; kind: "choice"; options: readonly string[]; required?: boolean };
export type NumberField = { id: string; label: string; kind: "number"; unit: string; min: number; max: number };
export type MetadataField = ChoiceField | NumberField;

const YES_NO = ["No", "Yes"] as const;

export const PARTICIPANT_FIELDS: readonly MetadataField[] = [
  { id: "fitzpatrick", label: "Skin type (Fitzpatrick, use the reference card)", kind: "choice", options: ["I", "II", "III", "IV", "V", "VI"], required: true },
  { id: "ageBand", label: "Age band", kind: "choice", options: ["18-24", "25-34", "35-44", "45-54", "55-64", "65+"], required: true },
  { id: "sex", label: "Sex", kind: "choice", options: ["Female", "Male", "Intersex or other", "Prefer not to say"], required: true },
  { id: "handedness", label: "Handedness", kind: "choice", options: ["Right", "Left", "Both"] },
  { id: "bmiBand", label: "BMI band", kind: "choice", options: ["Under 18.5", "18.5-24.9", "25-29.9", "30 or over", "Not recorded"] },
  { id: "eyewear", label: "Eyewear during recording", kind: "choice", options: ["None", "Glasses", "Contact lenses"], required: true },
  { id: "facialHair", label: "Facial hair", kind: "choice", options: ["None", "Stubble", "Beard"] },
  { id: "makeup", label: "Face makeup", kind: "choice", options: YES_NO },
  { id: "caffeine2h", label: "Caffeine in the last 2 hours", kind: "choice", options: YES_NO },
  { id: "nicotine2h", label: "Nicotine in the last 2 hours", kind: "choice", options: YES_NO },
  { id: "exercise2h", label: "Exercise in the last 2 hours", kind: "choice", options: YES_NO },
  { id: "heartRateMedication", label: "Medication affecting heart rate", kind: "choice", options: ["No", "Yes", "Prefer not to say"] },
  { id: "cameraDistanceCm", label: "Face camera to face", kind: "number", unit: "cm", min: 20, max: 400 },
  { id: "thermalDistanceCm", label: "Thermal camera to face", kind: "number", unit: "cm", min: 20, max: 400 },
];

export type ParticipantMetadata = Record<string, string | number>;

export function missingParticipantFields(metadata: ParticipantMetadata | undefined) {
  return PARTICIPANT_FIELDS.filter((field) => field.kind === "choice" && field.required && !metadata?.[field.id]).map((field) => field.id);
}

/** Keeps only known fields with allowed values; numbers are clamped to their range. */
export function sanitizeFields(fields: readonly MetadataField[], raw: unknown): ParticipantMetadata {
  const input = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const result: ParticipantMetadata = {};
  for (const field of fields) {
    const value = input[field.id];
    if (value === undefined || value === null || value === "") continue;
    if (field.kind === "choice" && field.options.includes(String(value))) result[field.id] = String(value);
    if (field.kind === "number" && Number.isFinite(Number(value))) result[field.id] = Math.max(field.min, Math.min(field.max, Math.round(Number(value))));
  }
  return result;
}

export type ArtifactType = { id: string; label: string; key: string; kind: "point" | "span" };

/**
 * Point artifacts cover [press - before, press + after] because the operator reacts after the event; span artifacts
 * are toggled on and off.
 */
export const ARTIFACT_TYPES: readonly ArtifactType[] = [
  { id: "talking", label: "Talking", key: "t", kind: "span" },
  { id: "cough", label: "Cough or sneeze", key: "c", kind: "point" },
  { id: "movement", label: "Large movement", key: "m", kind: "point" },
  { id: "left_seat", label: "Left the seat", key: "l", kind: "span" },
  { id: "operator_in_view", label: "Operator in view", key: "o", kind: "span" },
  { id: "other_person", label: "Door or other person", key: "d", kind: "point" },
  { id: "phone", label: "Phone or notification", key: "p", kind: "point" },
  // Started by INFLATE on a blood pressure step and ended by saving the reading.
  { id: "bp_cuff", label: "BP cuff inflated", key: "b", kind: "span" },
];
/** The cuff squeezes the arm and provokes a sympathetic response, so its window is excluded like any other artifact. */
export const BP_CUFF_ARTIFACT = "bp_cuff";
export const POINT_ARTIFACT_WINDOW = { beforeSec: 3, afterSec: 1 } as const;

/** Span artifacts (such as talking) currently switched on, from the event ledger. */
export function openArtifactSpans(events: ReadonlyArray<{ eventType: string; metadata?: Record<string, unknown> }>) {
  const open = new Set<string>();
  for (const event of events) {
    if (event.eventType !== "artifact") continue;
    if (event.metadata?.kind === "start") open.add(String(event.metadata.type));
    if (event.metadata?.kind === "end") open.delete(String(event.metadata.type));
  }
  return open;
}

export const CSI_SETUP_FIELDS: readonly MetadataField[] = [
  { id: "channel", label: "WiFi channel", kind: "number", unit: "", min: 1, max: 196 },
  { id: "bandwidthMhz", label: "Bandwidth", kind: "choice", options: ["20", "40", "80", "160"] },
  { id: "packetRateHz", label: "Transmit packet rate", kind: "number", unit: "Hz", min: 1, max: 5000 },
  { id: "transmitter", label: "Transmitter", kind: "choice", options: ["Access point", "ESP32 transmitter", "Other"] },
  { id: "antennas", label: "Receiver antennas", kind: "choice", options: ["Onboard PCB", "External 1", "External 2+"] },
  { id: "txToSubjectCm", label: "Transmitter to subject", kind: "number", unit: "cm", min: 10, max: 2000 },
  { id: "rx1ToSubjectCm", label: "Receiver 1 to subject", kind: "number", unit: "cm", min: 10, max: 2000 },
  { id: "rx2ToSubjectCm", label: "Receiver 2 to subject", kind: "number", unit: "cm", min: 10, max: 2000 },
  { id: "txRxAngleDeg", label: "Angle transmitter-subject-receiver 1", kind: "number", unit: "deg", min: 0, max: 180 },
  { id: "txHeightCm", label: "Transmitter height", kind: "number", unit: "cm", min: 0, max: 400 },
  { id: "rxHeightCm", label: "Receiver height", kind: "number", unit: "cm", min: 0, max: 400 },
];

export const CSI_CALIBRATION_SEC = 60;

export const HR_AGREEMENT = { maxSpreadBpm: 8, minRppgQuality: 0.3, freshMs: 10_000 } as const;

type HeartRateSensor = { id: string; dataDetected: boolean; updatedAt: string; metrics: Record<string, number | string | boolean> };
export type HeartRateAgreement = { status: "agree" | "disagree" | "insufficient"; spreadBpm: number | null; sources: Array<{ id: string; label: string; bpm: number }> };

/**
 * Compares heart rate from the ECG, the pulse oximeter, and the face-video rPPG estimate. Two or more fresh sources
 * within 8 bpm agree; a larger spread usually means a loose sensor, a missing finger, or a poor face view.
 */
export function heartRateAgreement(sensors: readonly HeartRateSensor[], nowMs: number): HeartRateAgreement {
  const fresh = (sensor: HeartRateSensor | undefined) => Boolean(sensor?.dataDetected && nowMs - Date.parse(sensor.updatedAt) <= HR_AGREEMENT.freshMs);
  const value = (sensor: HeartRateSensor | undefined, key: string) => {
    const number = sensor?.metrics[key];
    return typeof number === "number" && number >= 30 && number <= 220 ? number : null;
  };
  const byId = (id: string) => sensors.find((sensor) => sensor.id === id);
  const sources: HeartRateAgreement["sources"] = [];
  const ecg = byId("ecg");
  if (fresh(ecg) && value(ecg, "heartRate") !== null) sources.push({ id: "ecg", label: "ECG", bpm: value(ecg, "heartRate") as number });
  const oximeter = byId("oximeter");
  if (fresh(oximeter) && oximeter?.metrics.fingerDetected !== false && value(oximeter, "heartRate") !== null) sources.push({ id: "oximeter", label: "Pulse oximeter", bpm: value(oximeter, "heartRate") as number });
  const face = byId("face");
  const quality = face?.metrics.rppgQuality;
  if (fresh(face) && value(face, "rppgHeartRate") !== null && typeof quality === "number" && quality >= HR_AGREEMENT.minRppgQuality) sources.push({ id: "face", label: "Face video (rPPG)", bpm: value(face, "rppgHeartRate") as number });
  if (sources.length < 2) return { status: "insufficient", spreadBpm: null, sources };
  const bpms = sources.map((source) => source.bpm);
  const spreadBpm = Math.round((Math.max(...bpms) - Math.min(...bpms)) * 10) / 10;
  return { status: spreadBpm <= HR_AGREEMENT.maxSpreadBpm ? "agree" : "disagree", spreadBpm, sources };
}

/**
 * Data-sharing consent per modality. Participation must be "Yes" to record; the other answers decide what the export
 * marks as shareable and whether de-identified substitutes (such as a face colour trace instead of face video) are made.
 */
export const CONSENT_FIELDS: readonly ChoiceField[] = [
  { id: "participation", label: "Signed consent to take part in this recording", kind: "choice", options: ["Yes", "No"], required: true },
  { id: "shareFaceVideo", label: "Share identifiable face video", kind: "choice", options: ["Yes", "No"] },
  { id: "shareThermalVideo", label: "Share thermal face video", kind: "choice", options: ["Yes", "No"] },
  { id: "shareAudio", label: "Share voice recordings", kind: "choice", options: ["Yes", "No"] },
  { id: "sharePhysiology", label: "Share physiological signals (ECG, PPG, EDA, EMG, respiration)", kind: "choice", options: ["Yes", "No"] },
  { id: "shareWifi", label: "Share WiFi CSI recordings", kind: "choice", options: ["Yes", "No"] },
  { id: "shareResponses", label: "Share ratings, questionnaires, and task responses", kind: "choice", options: ["Yes", "No"] },
  { id: "shareDerived", label: "Share de-identified features when raw data is withheld", kind: "choice", options: ["Yes", "No"] },
  { id: "futureResearch", label: "Data may be reused in future studies", kind: "choice", options: ["Yes", "No"] },
];

/** Sharing answers not given default to "No", the most private choice, so only participation must be chosen. */
export function withConsentDefaults(values: Record<string, string | number> | undefined) {
  const result: Record<string, string | number> = { ...(values ?? {}) };
  for (const field of CONSENT_FIELDS) if (field.id !== "participation" && !result[field.id]) result[field.id] = "No";
  return result;
}

export function consentReady(values: Record<string, string | number> | undefined) {
  return values?.participation === "Yes";
}

/**
 * While a preflight is running, a heartbeat that left the agent before the operator started it still carries the previous
 * result. Accepting it would end the new test before the agent ever receives the command.
 */
export function stalePreflightReport(current: { status: string; startedAt?: string | null }, status: string, completedAt: string | null) {
  if (current.status !== "running") return false;
  if (status === "idle") return true;
  if (status === "running" || !current.startedAt) return false;
  const completed = completedAt ? Date.parse(completedAt) : Number.NaN;
  return !Number.isFinite(completed) || completed < Date.parse(current.startedAt);
}

export const START_LEASE_MS = 10_000;

/** A required stream counts as ready when the agent and the stream reported recently and the stream is good. */
export function requiredSensorsReady(snapshot: Pick<SessionSnapshot, "acquisition" | "requiredSensors" | "sensors">, now: number, options: { recording?: boolean } = {}) {
  const fresh = (timestamp: string | null | undefined) => Boolean(timestamp && now - Date.parse(timestamp) <= START_LEASE_MS);
  return fresh(snapshot.acquisition.lastSeenAt) && snapshot.requiredSensors.every((id) => {
    const sensor = snapshot.sensors.find((item) => item.id === id);
    return Boolean(sensor && fresh(sensor.updatedAt) && sensor.dataDetected && (options.recording ? sensor.status === "recording" : sensor.quality === "good"));
  });
}

export type StartCheck = { id: string; label: string; ok: boolean; detail: string };

/** Everything that must be true before recording can start, with the reason for each item that is not. */
export function startChecks(snapshot: SessionSnapshot, now: number): StartCheck[] {
  const override = snapshot.hardwareGateOverride;
  const unassigned = snapshot.requiredSensors.filter((id) => !snapshot.deviceConfig[id] || snapshot.deviceConfig[id] === "none");
  const notStreaming = snapshot.requiredSensors.filter((id) => {
    const sensor = snapshot.sensors.find((item) => item.id === id);
    return !unassigned.includes(id) && !(sensor && sensor.dataDetected && sensor.quality === "good" && now - Date.parse(sensor.updatedAt) <= START_LEASE_MS);
  });
  const agentOnline = Boolean(snapshot.acquisition.lastSeenAt && now - Date.parse(snapshot.acquisition.lastSeenAt) <= START_LEASE_MS);
  const label = (id: string) => snapshot.sensors.find((sensor) => sensor.id === id)?.label ?? id;
  const media = snapshot.subjectMedia;
  // A demo has no participant to consent or screen and no hardware to check; it exists to walk the tasks.
  if (snapshot.demo) {
    return [{ id: "demo", label: "Demo run", ok: true, detail: "Hardware, consent and screening checks are skipped. Nothing is recorded to the cohort." }];
  }
  const checks: StartCheck[] = [
    { id: "consent", label: "Consent", ok: consentReady(snapshot.consent?.values), detail: !snapshot.consent ? "Not saved. Choose participation in Consent." : snapshot.consent.values.participation !== "Yes" ? "Participation consent is not Yes." : "Saved" },
    { id: "screening", label: "Safety screening", ok: screeningComplete(snapshot.screening?.answers), detail: snapshot.screening ? "Saved" : "Not saved. Answer all six questions." },
  ];
  if (override) {
    checks.push({ id: "override", label: "Hardware checks", ok: true, detail: "Skipped by hardware override" });
    return checks;
  }
  checks.push(
    { id: "agent", label: "Acquisition agent", ok: agentOnline, detail: agentOnline ? "Connected" : "Not connected. Start the acquisition agent." },
    { id: "assigned", label: "Required devices assigned", ok: unassigned.length === 0, detail: unassigned.length ? `Required but no device: ${unassigned.map(label).join(", ")}` : "All assigned" },
    { id: "streaming", label: "Required streams live", ok: agentOnline && notStreaming.length === 0, detail: notStreaming.length ? `No good data: ${notStreaming.map(label).join(", ")}` : agentOnline ? "All live" : "Waiting for the agent" },
    { id: "preflight", label: "Preflight", ok: snapshot.preflightTest.status === "pass", detail: snapshot.preflightTest.status === "pass" ? "Passed" : snapshot.preflightTest.status === "fail" ? `Failed. ${snapshot.preflightTest.detail}` : snapshot.preflightTest.status === "running" ? "Running" : "Not run since the last hardware change" },
    { id: "subject", label: "Subject display", ok: Boolean(media?.ready), detail: !media ? "Not connected. Open /subject and enter the session code." : media.ready ? `Loaded ${media.total} of ${media.total}` : `Loading ${media.loaded} of ${media.total}` },
  );
  return checks;
}
