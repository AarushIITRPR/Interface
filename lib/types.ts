export const PROTOCOL_VERSION = "v6";

export const EMOTIONS = ["happy", "sad", "anger", "fear", "surprise", "disgust"] as const;
export type Emotion = (typeof EMOTIONS)[number];
export type BufferKind = "stroop" | "nback" | "conversation";
export type StepType = "setup" | "baseline" | "clip" | "sam" | "washout" | "gate" | "stroop" | "nback" | "conversation" | "sweep" | "bodyscan" | "recovery" | "end";
export type SessionStatus = "running" | "paused" | "complete" | "aborted";
export type SensorStatus = "connected" | "recording" | "delayed" | "missing" | "error" | "unknown";

export type Assignment = {
  pid: number;
  row: number;
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
  ratings: Array<{ emotion: Emotion; valence: number; arousal: number; dominance: number; createdAt: string }>;
  sensors: SensorChannel[];
  bpReadings: Array<{ stepId: string; label: string; systolic: number; diastolic: number; pulse: number | null; createdAt: string }>;
  media: MediaConfig;
  nbackLevel: 1 | 2 | 3;
  operatorLastSeenAt: string | null;
  acquisitionToken: string;
  acquisition: AcquisitionAgent;
  recordings: RecordingArtifact[];
  requiredSensors: string[];
  hardwareGateOverride: boolean;
  createdAt: string;
  updatedAt: string;
};

export type SubjectStep = Pick<ProtocolStep,
  "id" | "index" | "type" | "subjectPrompt" | "durationSec" | "safety" | "fixation" | "advance"
> & {
  variant: "box_breathing" | "breath_hold" | null;
};

export type SubjectSnapshot = {
  code: string;
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

export const DEFAULT_MEDIA: MediaConfig = {
  emotions: { happy: "", sad: "", anger: "", fear: "", surprise: "", disgust: "" },
  washout: "",
  boxBreathing: "",
  bodyScan: "",
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
