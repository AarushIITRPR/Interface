import type { HeartRateAgreement } from "./rig";
import type { ClipKind } from "./stimuli";
import type { GateStatus, Physiology } from "./safety";

export const PROTOCOL_VERSION = "v9";

export const EMOTIONS = ["happy", "sad", "anger", "fear", "surprise", "disgust"] as const;
export type Emotion = (typeof EMOTIONS)[number];
export type BufferKind = "stroop" | "nback" | "conversation";
export type StepType = "setup" | "baseline" | "clip" | "sam" | "washout" | "gate" | "stroop" | "nback" | "conversation" | "sweep" | "bodyscan" | "recovery" | "questionnaire" | "annotation" | "wordlist" | "wordlist_delayed" | "end";

/** Optional protocol blocks, chosen per session during setup and fixed once recording starts. */
export type ProtocolOptions = {
  questionnaires: boolean;
  pacedBreathing: boolean;
  extendedExertion: boolean;
  neutralClip: boolean;
  annotationReplay: boolean;
  /** Word list study with immediate recall after Part 3, and delayed recall after the body scan. */
  wordList?: boolean;
};
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
  /** Protocol blocks for this session (v9+). Absent means the v8 protocol. */
  options?: ProtocolOptions;
  /** Stimulus id per clip kind from the registry (v9+). */
  stimuli?: Partial<Record<ClipKind, string>>;
  /** Index into WORD_LISTS in lib/tasks.ts. Absent on older sessions, which derive it from their two rows. */
  wordList?: number;
  /**
   * The protocol template this session was created from, copied at creation.
   *
   * Absent means the session predates the builder and renders through `createPlan`, so its step ids keep the
   * scheme its stored events were written against.
   */
  protocol?: ProtocolTemplate;
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
  /** Clip shown or rated: an emotion or the neutral control. */
  clip?: ClipKind;
  questionnaireId?: string;
  breathsPerMin?: number;
  /** Shortest run that still measures what the step exists to measure; the operator cannot advance before it. */
  minDurationSec?: number;
  safety?: boolean;
  bp?: boolean;
  bpLabel?: string;
  fixation?: boolean;
  /** Physical steps that participant screening can skip. */
  safetyKey?: "breath_hold" | "standing" | "exertion";
  advance: "operator" | "timer" | "media" | "task" | "gate" | "subject";
  estimatedSec: number;
  /** Template slot this step came from. Absent on sessions built before the protocol builder. */
  slotKey?: string;
  /** Non-clip media this step plays, so the subject display does not have to match on the title. */
  mediaKey?: MediaKey;
};

/** Which counterbalanced clip fills a clip or rating slot: the neutral control, or a position in a block. */
export type ClipSlot = "neutral" | "b1a" | "b1b" | "b2a" | "b2b" | "b3a" | "b3b";
/** Which of the three counterbalanced task positions a slot occupies. */
export type BufferSlot = 1 | 2 | 3;
/** Non-clip media a slot can carry. */
export type MediaKey = "washout" | "boxBreathing" | "bodyScan" | "fixation";

/**
 * One position in the protocol template.
 *
 * A slot says what happens and for how long; it does not say which emotion or which task lands in it. Those come
 * from the participant's counterbalancing at render time, so editing the template cannot disturb the Williams
 * square in `assignFor`.
 */
export type ProtocolSlot = Omit<ProtocolStep, "id" | "index" | "emo" | "clip" | "slotKey"> & {
  /** Stable identity, unique within the template. Becomes part of the rendered step id. */
  key: string;
  /** Present on clip and rating slots; the emotion is resolved per participant. */
  clipSlot?: ClipSlot;
  /** Present on task slots and on anything that follows one, such as the workload rating. */
  bufferSlot?: BufferSlot;
  /** Render this slot only when its buffer position resolved to one of these tasks. */
  requiresTask?: BufferKind[];
  /** Render this slot only when this clip kind has media. The neutral block drops out for participants without one. */
  requiresClip?: ClipKind;
};

/** A clip and the duration measured from the file itself, resolved when the template is saved. */
export type ClipMedia = {
  /** Uploaded asset in R2, or a registry entry from lib/stimuli.ts. Exactly one is set. */
  assetId?: string;
  stimulusId?: string;
  src: string;
  durationSec: number;
};

/** The editable half of a task step. Which of the three runs where is counterbalancing's business. */
export type TaskSlot = Pick<ProtocolSlot, "title" | "subjectPrompt" | "operatorScript" | "operatorNote" | "durationSec" | "minDurationSec" | "advance" | "estimatedSec"> & {
  type: Extract<StepType, "stroop" | "nback" | "conversation">;
};

export type ProtocolTemplate = {
  id: string;
  version: number;
  label: string;
  updatedAt: string;
  slots: ProtocolSlot[];
  clips: Partial<Record<ClipKind, ClipMedia>>;
  tasks: Record<BufferKind, TaskSlot>;
  media: Partial<Record<MediaKey, string>>;
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
  group: "video" | "audio" | "physio" | "gaze" | "sync" | "interaction" | "environment";
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
  ratings: Array<{ emotion: ClipKind; valence: number; arousal: number; dominance: number; scalePoints?: number; discreteEmotion?: string | null; intensity?: number | null; familiarity?: string | null; createdAt: string }>;
  sensors: SensorChannel[];
  bpReadings: Array<{ stepId: string; label: string; systolic: number; diastolic: number; pulse: number | null; createdAt: string; cuffStartedAt?: string; cuffSec?: number }>;
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
  preflightTest: { status:"idle"|"running"|"pass"|"fail"; detail:string; completedAt:string | null; startedAt?:string | null };
  createdAt: string;
  updatedAt: string;
  /** Participation and per-modality data-sharing consent. */
  consent?: { values: Record<string, string | number>; updatedAt: string };
  /** Scored questionnaire responses. */
  questionnaires?: Array<{ questionnaireId: string; stepId: string; answers: Record<string, number>; scores: Record<string, number>; createdAt: string }>;
  /** Categorical participant descriptors (skin type, age band, eyewear, ...) for interpreting contactless sensing. */
  participantMetadata?: { values: Record<string, string | number>; updatedAt: string };
  /** WiFi CSI room geometry and radio settings. */
  csiSetup?: { values: Record<string, string | number>; updatedAt: string };
  /** Empty-room CSI baseline recorded during setup. */
  csiCalibration?: { status: "running" | "done" | "failed"; detail: string; startedAt: string; completedAt: string | null; rows: number; durationSec: number };
  /** Safety screening answers recorded by the operator before the session starts. */
  screening?: { answers: Record<string, boolean>; completedAt: string };
  /** ECG vs oximeter vs face-video heart rate, computed on read. */
  heartRateAgreement?: HeartRateAgreement;
  /** Return-to-baseline evaluation for the current gate step, computed on read. */
  gate?: GateStatus | null;
  /** Stimulus preload progress reported by the subject display. */
  subjectMedia?: { loaded: number; total: number; failed: number; ready: boolean };
  /**
   * A rehearsal, not a participant.
   *
   * Starts without an acquisition agent, consent or screening, and is kept out of the cohort so it cannot be
   * counted as a participant or fill a cell in the counterbalancing grid.
   */
  demo?: boolean;
  /** Unique per saved revision; lets batched event inserts confirm their snapshot update won. */
  writeId?: string;
  /** Server clock when this snapshot was read; used to order responses that share a revision. */
  serverTime?: string;
};

export type SubjectStep = Pick<ProtocolStep,
  "id" | "index" | "type" | "subjectPrompt" | "durationSec" | "safety" | "fixation" | "advance" | "questionnaireId" | "breathsPerMin"
> & {
  variant: "box_breathing" | "breath_hold" | "paced_breathing" | null;
  /** The list to study. Sent for the study step only: the delayed recall step must not carry it. */
  words?: string[];
};

export type SubjectSnapshot = {
  serverTime: string;
  /** A rehearsal; the display says so, so nobody mistakes a demo for a real session or the reverse. */
  demo: boolean;
  /** Every stimulus the session can play, so the display can load them all before the protocol starts. */
  mediaManifest: string[];
  /** Show the photodiode sync patch, which flashes when stimuli start and steps appear. */
  syncPatch: boolean;
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
  { id: "csi2", label: "WiFi CSI receiver 2", group: "physio" },
  { id: "environment", label: "Room environment", group: "environment" },
  { id: "face2", label: "Face camera 2", group: "video" },
];
