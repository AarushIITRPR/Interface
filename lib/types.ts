import type { GateStatus, Physiology } from "./safety";

export const PROTOCOL_VERSION = "v8";

export const EMOTIONS = ["happy", "sad", "anger", "fear", "surprise", "disgust"] as const;
export type Emotion = (typeof EMOTIONS)[number];
export type BufferKind = "stroop" | "nback" | "conversation";
export type StepType = "setup" | "baseline" | "clip" | "sam" | "washout" | "gate" | "stroop" | "nback" | "conversation" | "sweep" | "bodyscan" | "recovery" | "end";
export type SessionStatus = "setup" | "running" | "paused" | "complete" | "aborted";
export type SensorStatus = "connected" | "recording" | "delayed" | "missing" | "error" | "unknown";
export type SensorQuality = "disabled" | "waiting" | "good" | "degraded" | "bad";

export type DeviceInventoryItem = {
  id: string;
  label: string;
  kind: "video" | "audio" | "serial";
  description: string;
};

export type DeviceInventory = {
  video: DeviceInventoryItem[];
  audio: DeviceInventoryItem[];
  serial: DeviceInventoryItem[];
};

export type DeviceConfig = Record<string,string>;

export type Assignment = {
  pid: number;
  row: number;
  /** Task-order row (1-6), counterbalanced independently of the emotion row. Absent on sessions created before v8. */
  bufferRow?: number;
  buf1: BufferKind;
  buf2: BufferKind;
  buf3: BufferKind;
  block1: [Emotion, Emotion];
  block2: [Emotion, Emotion];
  block3: [Emotion, Emotion];
  fullOrder: Emotion[];
};

export type ProtocolStep = {
  id: string;
  index: number;
  type: StepType;
  title: string;
  subjectPrompt: string;
  operatorScript: string;
  operatorNote: string;
  phase: string;
  durationSec?: number;
  emo?: Emotion;
  safety?: boolean;
  bp?: boolean;
  bpLabel?: string;
  fixation?: boolean;
  /** Physical steps that participant screening can skip. */
  safetyKey?: "breath_hold" | "standing" | "exertion";
  advance: "operator" | "timer" | "media" | "task" | "gate" | "subject";
  estimatedSec: number;
};

export type ExperimentEvent = {
  id: string;
  sequence: number;
  stepId: string;
  stepIndex: number;
  stepLabel: string;
  eventType: string;
  label: string;
  detail: string;
  severity: "info" | "warn" | "error" | "critical";
  source: "system" | "subject" | "operator" | "sensor";
  createdAt: string;
  attempt: number;
  metadata: Record<string, unknown>;
};

export type SensorChannel = {
  id: string;
  label: string;
  group: "video" | "audio" | "physio" | "gaze" | "sync" | "interaction";
  status: SensorStatus;
  latencyMs: number | null;
  detail: string;
  rateHz: number | null;
  sampleCount: number;
  latestValue: string;
  device: string;
  recordingFile: string;
  bytesWritten: number;
  targetRateHz: number | null;
  hardwareDetected: boolean;
  dataDetected: boolean;
  quality: SensorQuality;
  droppedSamples: number;
  dropoutPct: number;
  metrics: Record<string, number | string | boolean>;
  series: number[];
  validation: string[];
  updatedAt: string;
};

export type AcquisitionAgent = {
  id: string;
  state: "waiting" | "online" | "offline" | "finalized";
  host: string;
  platform: string;
  version: string;
  recordingRoot: string;
  lastSeenAt: string | null;
  connectedAt: string | null;
  finalizedAt: string | null;
  inventory: DeviceInventory;
  diskFreeGb: number | null;
  estimatedHours: number | null;
  clockOffsetMs: number | null;
  openFileCount: number;
  droppedPct: number;
  previewUrls: Record<string,string>;
  configRevision: number;
  /** Rolling heart rate and skin conductance used by the return-to-baseline gate. */
  physiology?: Physiology;
};

export type RecordingArtifact = {
  sensorId: string;
  relativePath: string;
  format: string;
  sampleCount: number;
  bytes: number;
  sha256: string;
  startedAt: string;
  endedAt: string;
  quality: "pending" | "pass" | "warning" | "fail";
  durationSec: number;
  averageRateHz: number;
  droppedSamples: number;
  dropoutPct: number;
  gapCount: number;
  totalGapSec: number;
  longestGapSec: number;
  availabilityPct: number;
};

export type MediaConfig = {
  emotions: Record<Emotion, string>;
  washout: string;
  boxBreathing: string;
  bodyScan: string;
  fixation: string;
};

export type SessionSnapshot = {
  id: string;
  code: string;
  revision: number;
  participantId: number;
  operator: string;
  protocolVersion: string;
  assignment: Assignment;
  status: SessionStatus;
  stepIndex: number;
  attempt: number;
  stepStartedAt: string;
  pausedAt: string | null;
  announcement: { id: string; text: string; kind: "info" | "pause" | "safety"; createdAt: string } | null;
  events: ExperimentEvent[];
  notes: Array<{ id: string; body: string; category: string; stepId: string; stepLabel: string; createdAt: string }>;
  ratings: Array<{ emotion: Emotion; valence: number; arousal: number; dominance: number; scalePoints?: number; discreteEmotion?: string | null; intensity?: number | null; familiarity?: string | null; createdAt: string }>;
  sensors: SensorChannel[];
  bpReadings: Array<{ stepId: string; label: string; systolic: number; diastolic: number; pulse: number | null; createdAt: string }>;
  media: MediaConfig;
  nbackLevel: 1 | 2 | 3;
  operatorLastSeenAt: string | null;
  subjectLastSeenAt: string | null;
  acquisitionToken: string;
  acquisition: AcquisitionAgent;
  recordings: RecordingArtifact[];
  requiredSensors: string[];
  hardwareGateOverride: boolean;
  deviceConfig: DeviceConfig;
  configRevision: number;
  configurationLocked: boolean;
  recordingStartedAt: string | null;
  preflightTest: { status:"idle"|"running"|"pass"|"fail"; detail:string; completedAt:string | null };
  createdAt: string;
  updatedAt: string;
  /** Safety screening answers recorded by the operator before the session starts. */
  screening?: { answers: Record<string, boolean>; completedAt: string };
  /** Return-to-baseline evaluation for the current gate step, computed on read. */
  gate?: GateStatus | null;
  /** Stimulus preload progress reported by the subject display. */
  subjectMedia?: { loaded: number; total: number; failed: number; ready: boolean };
  /** Unique per saved revision; lets batched event inserts confirm their snapshot update won. */
  writeId?: string;
  /** Server clock when this snapshot was read; used to order responses that share a revision. */
  serverTime?: string;
};

export type SubjectStep = Pick<ProtocolStep,
  "id" | "index" | "type" | "subjectPrompt" | "durationSec" | "safety" | "fixation" | "advance"
> & {
  variant: "box_breathing" | "breath_hold" | null;
};

export type SubjectSnapshot = {
  serverTime: string;
  /** Every stimulus the session can play, so the display can load them all before the protocol starts. */
  mediaManifest: string[];
  code: string;
  participantId: number;
  revision: number;
  status: SessionStatus;
  stepIndex: number;
  stepCount: number;
  attempt: number;
  stepStartedAt: string;
  announcement: SessionSnapshot["announcement"];
  nbackLevel: 1 | 2 | 3;
  operatorConnected: boolean;
  acquisitionReady: boolean;
  mediaSrc: string;
  step: SubjectStep | null;
};

/** Measured durations of the registered clips in public/protocol-media, used for time estimates. */
export const DEFAULT_CLIP_SECONDS: Record<Emotion, number> = {
  happy: 93, sad: 148, anger: 151, fear: 95, surprise: 183, disgust: 151,
};

export const DEFAULT_MEDIA: MediaConfig = {
  emotions: {
    happy: "/protocol-media/happy.mp4",
    sad: "/protocol-media/sad.mp4",
    anger: "/protocol-media/anger.mp4",
    fear: "/protocol-media/fear.mp4",
    surprise: "/protocol-media/surprise.mp4",
    disgust: "/protocol-media/disgust.mp4",
  },
  washout: "",
  boxBreathing: "/protocol-media/relaxing-nature.mp4",
  bodyScan: "/protocol-media/bodyscan.mp4",
  fixation: "",
};

export const SENSOR_CATALOG: Array<Pick<SensorChannel, "id" | "label" | "group">> = [
  { id: "face", label: "Face camera", group: "video" },
  { id: "audio", label: "Room audio", group: "audio" },
  { id: "oximeter", label: "Pulse oximeter", group: "physio" },
  { id: "csi", label: "WiFi CSI", group: "physio" },
  { id: "emg", label: "EMG", group: "physio" },
  { id: "gsr", label: "EDA / GSR", group: "physio" },
  { id: "ecg", label: "ECG", group: "physio" },
  { id: "thermal", label: "Thermal camera", group: "video" },
  { id: "ppg", label: "PPG", group: "physio" },
  { id: "resp", label: "Respiration", group: "physio" },
  { id: "imu", label: "Motion IMU", group: "physio" },
  { id: "eye", label: "Eye tracking", group: "gaze" },
  { id: "photodiode", label: "Photodiode", group: "sync" },
  { id: "screen", label: "Screen capture", group: "video" },
  { id: "interaction", label: "Interaction log", group: "interaction" },
];
