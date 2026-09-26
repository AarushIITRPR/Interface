/**
 * The protocol as data.
 *
 * `createPlan` in ./protocol.ts builds the step list with imperative statements, so every duration is a literal in
 * the source and the order is statement order. This module holds the same protocol as an editable template: a list
 * of slots, plus the clips, task definitions and media they draw on.
 *
 * A slot says *what happens and for how long*. It does not say which emotion or which task lands in it; those are
 * resolved per participant from the fixed emotion order and task counterbalancing in `assignFor`, so editing a
 * template can reorder and retime the protocol without touching either.
 *
 * `defaultTemplate(options)` renders identically to `createPlan` for the same options; `tests/protocol.test.mjs`
 * asserts that across all 32 option combinations.
 */
import { CLIP_KINDS, STIMULI, stimulusById, type ClipKind, type Stimulus } from "./stimuli";
import { BOX_BREATHING_ROUNDS, BOX_BREATHING_SEC } from "./tasks";
import {
  DEFAULT_CLIP_SECONDS, DEFAULT_MEDIA, EMOTIONS,
  type Assignment, type BufferKind, type BufferSlot, type ClipMedia, type ClipSlot, type Emotion,
  type MediaKey, type ProtocolOptions, type ProtocolSlot, type ProtocolStep, type ProtocolTemplate,
  type StepType, type TaskSlot,
} from "./types";

export const CLIP_SLOTS: readonly ClipSlot[] = ["neutral", "b1a", "b1b", "b2a", "b2b", "b3a", "b3b"];
export const MEDIA_KEYS: readonly MediaKey[] = ["washout", "boxBreathing", "bodyScan", "fixation"];
const STEP_TYPES: readonly StepType[] = ["setup","baseline","clip","sam","washout","gate","stroop","nback","conversation","sweep","bodyscan","recovery","questionnaire","annotation","wordlist","reading","end"];
const ADVANCE_MODES: readonly ProtocolStep["advance"][] = ["operator","timer","media","task","gate","subject"];
/** A duration longer than this is a typo, not a protocol. */
const MAX_DURATION_SEC = 3600;
/** Padding after a clip's own length, for the transition into the next screen. */
const CLIP_TAIL_SEC = 5;
const REPLAY_TAIL_SEC = 10;
/** Neutral clips have no entry in DEFAULT_CLIP_SECONDS; this is what createPlan assumed for them. */
const NEUTRAL_FALLBACK_SEC = 120;

/** Which emotion fills a clip slot for this participant. `neutral` is not part of the counterbalancing. */
export function resolveClipSlot(a: Assignment, slot: ClipSlot): ClipKind | undefined {
  if (slot === "neutral") return "neutral";
  const block = slot[1] === "1" ? a.block1 : slot[1] === "2" ? a.block2 : a.block3;
  return block?.[slot[2] === "a" ? 0 : 1];
}

/** Which task fills a buffer position for this participant. */
export function resolveBufferSlot(a: Assignment, slot: BufferSlot): BufferKind {
  return slot === 1 ? a.buf1 : slot === 2 ? a.buf2 : a.buf3;
}

export function clipDuration(template: ProtocolTemplate | undefined, a: Assignment, clip: ClipKind): number {
  const fromTemplate = template?.clips?.[clip]?.durationSec;
  if (typeof fromTemplate === "number" && fromTemplate > 0) return fromTemplate;
  const stimulus = stimulusById(a.stimuli?.[clip]);
  return stimulus?.durationSec ?? (clip === "neutral" ? NEUTRAL_FALLBACK_SEC : DEFAULT_CLIP_SECONDS[clip as Emotion]);
}

/** A registry stimulus as a template clip, so a template can point at lib/stimuli.ts as well as at an upload. */
export function clipFromStimulus(stimulus: Stimulus): ClipMedia {
  return { stimulusId: stimulus.id, src: stimulus.src, durationSec: stimulus.durationSec };
}

const TASK_DEFAULTS: Record<BufferKind, TaskSlot> = {
  stroop: { type:"stroop", title:"Stroop colour-word task", subjectPrompt:"Select the ink colour, not the word.", operatorScript:"Select the button matching the ink colour, not what the word says. Respond as quickly and accurately as you can.", operatorNote:"30 trials with reaction time and accuracy logging.", advance:"task", estimatedSec:90 },
  nback: { type:"nback", title:"N-back task", subjectPrompt:"Press Match when the position repeats from N steps ago.", operatorScript:"Press Match whenever the current position is the same as the position from N steps ago.", operatorNote:"20 scored trials with hits, misses, false alarms, and response time.", advance:"task", estimatedSec:50 },
  conversation: { type:"conversation", title:"Conversation", subjectPrompt:"Talk together about something familiar.", operatorScript:"Talk for a few minutes about a recent trip, a hobby, or how the day has been.", operatorNote:"Neutral semi-structured conversation.", durationSec:180, advance:"timer", estimatedSec:180 },
};

/** Tasks that are followed by a workload rating. Conversation is not a workload task. */
const WORKLOAD_TASKS: BufferKind[] = ["stroop", "nback"];

export function defaultTasks(): Record<BufferKind, TaskSlot> {
  return structuredClone(TASK_DEFAULTS);
}

/**
 * The clip files a template starts from: this participant's assigned exemplars when rendering for a session, or
 * the first registry entry per kind when seeding the study-level template with no participant in hand.
 */
export function defaultClips(a?: Assignment): Partial<Record<ClipKind, ClipMedia>> {
  const clips: Partial<Record<ClipKind, ClipMedia>> = {};
  for (const clip of CLIP_KINDS) {
    const stimulus = stimulusById(a?.stimuli?.[clip]) ?? STIMULI.find((entry) => entry.clip === clip);
    if (stimulus) clips[clip] = clipFromStimulus(stimulus);
  }
  return clips;
}

export function defaultMedia(): Partial<Record<MediaKey, string>> {
  return { washout: DEFAULT_MEDIA.washout, boxBreathing: DEFAULT_MEDIA.boxBreathing, bodyScan: DEFAULT_MEDIA.bodyScan, fixation: DEFAULT_MEDIA.fixation };
}

/** Immediate and delayed word list recall, as step definitions both plan builders use. */
/** Slot key for the word list step, so the builder can find it. */
export const WORD_LIST_KEY = "wordlist-recognition";
/** Slot key for the read-aloud step. */
export const READ_ALOUD_KEY = "read-aloud";

/** The word list step, shared by createPlan and defaultSlots so the two stay identical. */
export const WORD_LIST_STEP = {
  type:"wordlist", title:"Word list: study and recognise",
  subjectPrompt:"Study the words. Then say which ones you saw.",
  operatorScript:"You will see ten words for twenty seconds. Then words appear one at a time: press Yes only if it is exactly a word from the list, No if it is not.",
  operatorNote:"Recognition memory: the 10 studied words mixed with 10 look-alikes, scored automatically (hits, false alarms, d-prime).",
  phase:"Part 3", advance:"task", estimatedSec:65,
} as const satisfies Omit<ProtocolStep, "id" | "index">;

/** Read-aloud passage, shared by createPlan and defaultSlots. Every participant reads the same text. */
export const READ_ALOUD_STEP = {
  type:"reading", title:"Read aloud",
  subjectPrompt:"Read the passage aloud at a comfortable pace.",
  operatorScript:"Read this aloud at your normal speaking pace, as if you were reading to someone. Press Done when you reach the end.",
  operatorNote:"Read speech from a fixed passage, about a minute. The subject ends the step; the reading time is logged.",
  phase:"Part 3", advance:"subject", estimatedSec:75,
} as const satisfies Omit<ProtocolStep, "id" | "index">;

const SETUP_SLOT: ProtocolSlot = { key:"setup", type:"setup", title:"Sensor and synchronization check", subjectPrompt:"Look toward the screen and stay still.", operatorScript:"Stay fairly still and keep facing the screen while the recording is checked.", operatorNote:"Verify every required stream and trigger synchronization before continuing.", phase:"Getting settled", advance:"operator", estimatedSec:30 };

const questionnaireSlot = (key: string, questionnaireId: string, title: string, phase: string, estimatedSec: number, extra: Partial<ProtocolSlot> = {}): ProtocolSlot =>
  ({ key, type:"questionnaire", title, subjectPrompt:"Answer each question.", operatorScript:"Please answer each question on the screen. There are no right or wrong answers.", operatorNote:"Self-report questionnaire; answers are scored automatically.", phase, questionnaireId, advance:"task", estimatedSec, ...extra });

const clipSlotDef = (key: string, clipSlot: ClipSlot, phase: string): ProtocolSlot =>
  ({ key, type:"clip", title:"", subjectPrompt:"Watch naturally.", operatorScript:"Watch the clip naturally and react however feels natural. There is no right or wrong response.", operatorNote:"Onset and offset are logged automatically.", phase, clipSlot, advance:"media", estimatedSec:0, ...(clipSlot === "neutral" ? { requiresClip:"neutral" as ClipKind } : {}) });

const ratingSlotDef = (key: string, clipSlot: ClipSlot, phase: string): ProtocolSlot =>
  ({ key, type:"sam", title:"", subjectPrompt:"Choose what fits best.", operatorScript:"Choose the response that best matches your experience. Go with your first instinct.", operatorNote:"Valence, arousal, and dominance on a 9-point SAM scale, then the main emotion felt with its intensity, then clip familiarity.", phase, clipSlot, advance:"task", estimatedSec:40, ...(clipSlot === "neutral" ? { requiresClip:"neutral" as ClipKind } : {}) });

const washoutSlot = (key: string, phase: string, extra: Partial<ProtocolSlot> = {}): ProtocolSlot =>
  ({ key, type:"washout", title:"Neutral washout", subjectPrompt:"", operatorScript:"Rest your eyes on the cross and breathe normally.", operatorNote:"Neutral fixation period.", phase, durationSec:20, advance:"timer", estimatedSec:20, mediaKey:"washout", ...extra });

const gateSlot = (key: string, phase: string, bpLabel: string, title = "Return-to-baseline gate"): ProtocolSlot =>
  ({ key, type:"gate", title, subjectPrompt:"Sit quietly and breathe normally.", operatorScript:"Sit quietly and breathe normally while we prepare the next activity.", operatorNote:"Advance after the return-to-baseline checks are complete.", phase, durationSec:25, bp:true, bpLabel, advance:"gate", estimatedSec:30 });

const replaySlotDef = (key: string, clipSlot: ClipSlot): ProtocolSlot =>
  ({ key, type:"annotation", title:"", subjectPrompt:"Watch again and keep the marker where your feeling is.", operatorScript:"Watch the clip again. Move the marker whenever your feeling changes: left to right for unpleasant to pleasant, bottom to top for calm to excited.", operatorNote:"Continuous valence and arousal sampled at 20 Hz.", phase:"Continuous rating", clipSlot, advance:"media", estimatedSec:0, ...(clipSlot === "neutral" ? { requiresClip:"neutral" as ClipKind } : {}) });

/** The three blocks of clip, rating, washout, clip, rating, task, gate that carry the emotion manipulation. */
function blockSlots(n: 1 | 2 | 3, options: ProtocolOptions): ProtocolSlot[] {
  const phase = `Part ${n}`;
  const a = `b${n}a` as ClipSlot;
  const b = `b${n}b` as ClipSlot;
  const slots: ProtocolSlot[] = [
    clipSlotDef(`clip-${a}`, a, phase), ratingSlotDef(`rating-${a}`, a, phase), washoutSlot(`washout-${n}`, phase),
    clipSlotDef(`clip-${b}`, b, phase), ratingSlotDef(`rating-${b}`, b, phase),
    { key:`task-${n}`, type:"stroop", title:"", subjectPrompt:"", operatorScript:"", operatorNote:"", phase, bufferSlot:n, advance:"task", estimatedSec:0 },
  ];
  // Conversation is not a workload task, so its position gets no NASA-TLX. Which position that is varies per
  // participant, so the slot is conditional on what the counterbalancing puts in front of it.
  if (options.questionnaires) slots.push(questionnaireSlot(`nasa-tlx-${n}`, "nasa_tlx", "Workload rating (NASA-TLX)", phase, 45, { bufferSlot:n, requiresTask:[...WORKLOAD_TASKS] }));
  if (n !== 3) slots.push(gateSlot(`gate-${n}`, phase, `After ${phase}`));
  return slots;
}

/** The slot list that renders exactly what `createPlan` produces for the same options. */
export function defaultSlots(options: ProtocolOptions, pacedMinSec: (rate: number) => number, pacedRates: readonly number[]): ProtocolSlot[] {
  const slots: ProtocolSlot[] = [SETUP_SLOT];
  if (options.questionnaires) {
    // Questionnaires come before the resting baselines so answering does not disturb them.
    slots.push(questionnaireSlot("panas-pre", "panas_pre", "Current mood (PANAS, start)", "Getting settled", 75));
    slots.push(questionnaireSlot("tipi", "tipi", "Personality (TIPI)", "Getting settled", 50));
  }
  slots.push({ key:"baseline-eyes-open", type:"baseline", title:"Resting baseline, eyes open", subjectPrompt:"Look at the cross. Breathe naturally.", operatorScript:"Look at the cross and breathe normally.", operatorNote:"Eyes-open resting reference. Take the resting BP reading after settling.", phase:"Getting settled", durationSec:120, fixation:true, bp:true, bpLabel:"Resting anchor", advance:"timer", estimatedSec:120, mediaKey:"fixation" });
  slots.push({ key:"baseline-eyes-closed", type:"baseline", title:"Resting baseline, eyes closed", subjectPrompt:"Close your eyes. Breathe naturally.", operatorScript:"Gently close your eyes and keep breathing naturally.", operatorNote:"Eyes-closed resting reference.", phase:"Getting settled", durationSec:90, advance:"timer", estimatedSec:90 });
  if (options.neutralClip) {
    slots.push(clipSlotDef("clip-neutral", "neutral", "Neutral control"), ratingSlotDef("rating-neutral", "neutral", "Neutral control"), washoutSlot("washout-neutral", "Neutral control", { requiresClip:"neutral" }));
  }
  slots.push(...blockSlots(1, options), ...blockSlots(2, options), ...blockSlots(3, options));
  if (options.wordList) slots.push({ key:WORD_LIST_KEY, ...WORD_LIST_STEP });
  if (options.reading) slots.push({ key:READ_ALOUD_KEY, ...READ_ALOUD_STEP });
  slots.push(gateSlot("gate-sweep", "Movement and breathing", "Before physiological sweep", "Settle before physiological sweep"));
  slots.push({ key:"seated-rest", type:"sweep", title:"Seated rest", subjectPrompt:"Sit comfortably and stay still.", operatorScript:"Sit comfortably and stay still for a short moment.", operatorNote:"20 second seated anchor.", phase:"Movement and breathing", durationSec:20, advance:"timer", estimatedSec:20 });
  slots.push({ key:"box-breathing", type:"sweep", title:"Box breathing", subjectPrompt:"Follow the marker.", operatorScript:"Breathe in as the marker rises, hold while it waits at the top, breathe out as it falls, then hold at the bottom.", operatorNote:`On-screen pacer only, ${BOX_BREATHING_ROUNDS} rounds of in, hold, out, hold. No audio and no background video.`, phase:"Movement and breathing", durationSec:BOX_BREATHING_SEC, advance:"timer", estimatedSec:BOX_BREATHING_SEC });
  if (options.pacedBreathing) {
    for (const rate of pacedRates) slots.push({ key:`paced-${rate}`, type:"sweep", title:`Paced breathing: ${rate} per minute`, subjectPrompt:"Breathe in as the bar rises and out as it falls.", operatorScript:`Follow the guide at ${rate} breaths per minute. Breathe gently; do not force it.`, operatorNote:"Reference for breathing-rate estimation from video, thermal, and CSI.", phase:"Movement and breathing", durationSec:60, minDurationSec:pacedMinSec(rate), breathsPerMin:rate, advance:"timer", estimatedSec:60 });
  }
  slots.push({ key:"breath-hold", type:"sweep", title:"Breath hold", safetyKey:"breath_hold", subjectPrompt:"Breathe in and hold. Release whenever you need to.", operatorScript:"Take a normal breath in and hold only for as long as feels comfortable.", operatorNote:"Voluntary and comfort limited. Skip if contraindicated.", phase:"Movement and breathing", safety:true, advance:"subject", estimatedSec:40 });
  slots.push({ key:"head-movement", type:"sweep", title:"Head movement and speaking", subjectPrompt:"Turn left. Turn right. Look up. Look down. Then speak.", operatorScript:"Slowly turn left, right, up, and down. Then speak aloud for a few seconds.", operatorNote:"Motion and speech segment.", phase:"Movement and breathing", durationSec:30, advance:"timer", estimatedSec:30 });
  slots.push({ key:"standing", type:"sweep", title:"Standing", safetyKey:"standing", subjectPrompt:"Stand up slowly. Stay still.", operatorScript:"Stand up slowly and remain still. Tell me immediately if you feel dizzy.", operatorNote:"Orthostatic measurement. Skip if contraindicated.", phase:"Movement and breathing", durationSec:45, safety:true, bp:true, bpLabel:"Orthostatic standing", advance:"timer", estimatedSec:45 });
  const exertionSec = options.extendedExertion ? 60 : 20;
  slots.push({ key:"exertion", type:"sweep", title:"Brief exertion", safetyKey:"exertion", subjectPrompt:"March in place or do sit-to-stands.", operatorScript:"March in place or do comfortable sit-to-stands.", operatorNote:`${exertionSec} second exertion period. Skip if contraindicated.`, phase:"Movement and breathing", durationSec:exertionSec, safety:true, advance:"timer", estimatedSec:exertionSec });
  slots.push({ key:"post-exertion", type:"sweep", title:"Post-exertion recovery", subjectPrompt:"Sit down. Stay still.", operatorScript:"Sit back down and stay still while your breathing settles.", operatorNote:"60 second recovery after exertion.", phase:"Movement and breathing", durationSec:60, advance:"timer", estimatedSec:60 });
  slots.push({ key:"bodyscan", type:"bodyscan", title:"Guided body scan", subjectPrompt:"Close your eyes and relax. Follow the guided voice.", operatorScript:"Please close your eyes now and relax. Follow the guided voice and keep your eyes closed until I ask you to open them.", operatorNote:"Four minute guided body scan.", phase:"Relaxation", durationSec:240, advance:"timer", estimatedSec:240, mediaKey:"bodyScan" });
  slots.push({ key:"return-to-normal", type:"recovery", title:"Return to normal", subjectPrompt:"Open your eyes when you are ready.", operatorScript:"Open your eyes whenever you are ready.", operatorNote:"Final eyes-open return and BP.", phase:"Relaxation", durationSec:60, bp:true, bpLabel:"Relaxed final", advance:"timer", estimatedSec:60 });
  if (options.questionnaires) slots.push(questionnaireSlot("panas-post", "panas_post", "Current mood (PANAS, end)", "Relaxation", 75));
  if (options.annotationReplay) {
    if (options.neutralClip) slots.push(replaySlotDef("replay-neutral", "neutral"));
    for (const slot of ["b1a","b1b","b2a","b2b","b3a","b3b"] as ClipSlot[]) slots.push(replaySlotDef(`replay-${slot}`, slot));
  }
  slots.push({ key:"end", type:"end", title:"Session complete", subjectPrompt:"Thank you.", operatorScript:"That is everything. Thank you.", operatorNote:"Confirm recorders saved, then export.", phase:"All done", advance:"operator", estimatedSec:15 });
  return slots;
}

/** Does this participant have media for this clip kind, from the template or from the registry? */
export function hasClip(template: ProtocolTemplate | undefined, a: Assignment, clip: ClipKind): boolean {
  if (template?.clips?.[clip]?.src) return true;
  return Boolean(a.stimuli?.[clip]);
}

export function defaultTemplate(options: ProtocolOptions, pacedMinSec: (rate: number) => number, pacedRates: readonly number[], a?: Assignment): ProtocolTemplate {
  return {
    id: "default", version: 0, label: "Meridian default protocol", updatedAt: "",
    slots: defaultSlots(options, pacedMinSec, pacedRates),
    clips: defaultClips(a), tasks: defaultTasks(), media: defaultMedia(),
  };
}

/**
 * Render a template into the concrete step list for one participant.
 *
 * Step ids keep the `s{index}-{type}{suffix}` scheme `createPlan` uses, because events store their `stepId` when
 * written while the plan is rebuilt from the assignment on every read - change the scheme and an old session stops
 * matching its own events. `slotKey` carries the stable identity instead, so exports can join on something that
 * does not shift when a step is added above it.
 */
export function renderPlan(template: ProtocolTemplate, a: Assignment): ProtocolStep[] {
  const steps: ProtocolStep[] = [];
  for (const slot of template.slots) {
    const step = renderSlot(template, a, slot);
    if (!step) continue;
    const suffix = step.type === "questionnaire" ? `-${step.questionnaireId}` : step.clip ? `-${step.clip}` : step.emo ? `-${step.emo}` : "";
    steps.push({ ...step, id:`s${String(steps.length).padStart(2,"0")}-${step.type}${suffix}`, index:steps.length });
  }
  return steps;
}

function renderSlot(template: ProtocolTemplate, a: Assignment, slot: ProtocolSlot): Omit<ProtocolStep,"id"|"index"> | null {
  if (slot.requiresClip && !hasClip(template, a, slot.requiresClip)) return null;
  // Everything except the fields that exist to choose a slot's content, which have done their job by now.
  const { key, clipSlot, bufferSlot, requiresTask, requiresClip: _requiresClip, ...rest } = slot;
  void _requiresClip;
  const base = { ...rest, slotKey: key };

  if (bufferSlot) {
    const kind = resolveBufferSlot(a, bufferSlot);
    if (requiresTask && !requiresTask.includes(kind)) return null;
    // A task slot takes its whole definition from the task that landed here; a slot that merely follows one
    // (the workload rating) keeps its own.
    if (slot.type !== "questionnaire") {
      const task = template.tasks?.[kind] ?? defaultTasks()[kind];
      return { ...base, ...task, phase: slot.phase };
    }
    return base;
  }

  if (clipSlot) {
    const clip = resolveClipSlot(a, clipSlot);
    if (!clip) return null;
    const seconds = clipDuration(template, a, clip);
    const emo = clip === "neutral" ? undefined : clip;
    if (slot.type === "annotation") return { ...base, clip, emo, title:`Continuous rating: ${clip}`, estimatedSec:seconds + REPLAY_TAIL_SEC };
    if (slot.type === "sam") return { ...base, clip, emo, title:`Self-report: ${clip}` };
    return { ...base, clip, emo, title: clip === "neutral" ? "Neutral control clip" : `Emotion clip: ${clip}`, estimatedSec:seconds + CLIP_TAIL_SEC };
  }

  return base;
}

const str = (value: unknown, fallback = "") => typeof value === "string" ? value : fallback;
const bool = (value: unknown) => value === true || undefined;

/** A duration the operator typed, clamped to something a protocol could plausibly ask for. */
function duration(value: unknown): number | undefined {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.min(MAX_DURATION_SEC, Math.round(n * 10) / 10);
}

export class TemplateError extends Error {}

/**
 * Validate a template arriving from the console.
 *
 * Rejects rather than repairs anything that would change what the protocol measures - an unknown step type, a
 * duration under a slot's own floor, a clip slot with no media behind it. Cosmetic fields are coerced.
 */
export function sanitizeTemplate(raw: unknown, previous?: ProtocolTemplate): ProtocolTemplate {
  const input = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const rawSlots = Array.isArray(input.slots) ? input.slots : [];
  if (!rawSlots.length) throw new TemplateError("A protocol needs at least one step.");

  const seen = new Set<string>();
  const slots: ProtocolSlot[] = rawSlots.map((entry, index) => {
    const slot = entry && typeof entry === "object" ? entry as Record<string, unknown> : {};
    const key = str(slot.key).trim();
    if (!key) throw new TemplateError(`Step ${index + 1} has no key.`);
    if (seen.has(key)) throw new TemplateError(`Two steps share the key "${key}".`);
    seen.add(key);
    const type = str(slot.type) as StepType;
    if (!STEP_TYPES.includes(type)) throw new TemplateError(`Step "${key}" has an unknown type "${slot.type}".`);
    const advance = str(slot.advance) as ProtocolStep["advance"];
    if (!ADVANCE_MODES.includes(advance)) throw new TemplateError(`Step "${key}" has an unknown advance mode "${slot.advance}".`);

    const durationSec = duration(slot.durationSec);
    const minDurationSec = duration(slot.minDurationSec);
    if (durationSec !== undefined && minDurationSec !== undefined && durationSec < minDurationSec) {
      throw new TemplateError(`Step "${key}" is set to ${durationSec}s but needs at least ${minDurationSec}s to measure anything.`);
    }
    const estimatedSec = duration(slot.estimatedSec) ?? durationSec ?? 30;
    const clipSlot = CLIP_SLOTS.includes(slot.clipSlot as ClipSlot) ? slot.clipSlot as ClipSlot : undefined;
    const bufferSlotValue = Number(slot.bufferSlot);
    const bufferSlot = [1,2,3].includes(bufferSlotValue) ? bufferSlotValue as BufferSlot : undefined;
    const mediaKey = MEDIA_KEYS.includes(slot.mediaKey as MediaKey) ? slot.mediaKey as MediaKey : undefined;
    const requiresTask = Array.isArray(slot.requiresTask) ? slot.requiresTask.filter((kind): kind is BufferKind => kind === "stroop" || kind === "nback" || kind === "conversation") : undefined;
    const requiresClip = CLIP_KINDS.includes(slot.requiresClip as ClipKind) ? slot.requiresClip as ClipKind : undefined;

    return {
      key, type, advance, estimatedSec,
      title: str(slot.title), subjectPrompt: str(slot.subjectPrompt), operatorScript: str(slot.operatorScript),
      operatorNote: str(slot.operatorNote), phase: str(slot.phase, "Protocol"),
      ...(durationSec !== undefined ? { durationSec } : {}),
      ...(minDurationSec !== undefined ? { minDurationSec } : {}),
      ...(clipSlot ? { clipSlot } : {}), ...(bufferSlot ? { bufferSlot } : {}), ...(mediaKey ? { mediaKey } : {}),
      ...(requiresTask?.length ? { requiresTask } : {}), ...(requiresClip ? { requiresClip } : {}),
      ...(slot.questionnaireId ? { questionnaireId: str(slot.questionnaireId) } : {}),
      ...(Number.isFinite(Number(slot.breathsPerMin)) && Number(slot.breathsPerMin) > 0 ? { breathsPerMin: Number(slot.breathsPerMin) } : {}),
      ...(bool(slot.safety) ? { safety: true } : {}), ...(bool(slot.bp) ? { bp: true } : {}),
      ...(slot.bpLabel ? { bpLabel: str(slot.bpLabel) } : {}), ...(bool(slot.fixation) ? { fixation: true } : {}),
      ...(slot.safetyKey ? { safetyKey: str(slot.safetyKey) as ProtocolSlot["safetyKey"] } : {}),
    };
  });

  const clips = sanitizeClips(input.clips, previous);
  // A clip slot with nothing behind it renders an empty screen for however long the operator waits. The neutral
  // block is allowed to be empty because it drops out on its own; the counterbalanced ones are not.
  for (const slot of slots) {
    if (!slot.clipSlot || slot.clipSlot === "neutral" || slot.requiresClip) continue;
    const missing = EMOTIONS.filter((emotion) => !clips[emotion]?.src);
    if (missing.length) throw new TemplateError(`Step "${slot.key}" plays a counterbalanced clip, but ${missing.join(", ")} ${missing.length === 1 ? "has" : "have"} no media.`);
    break;
  }

  return {
    id: str(input.id, previous?.id ?? "protocol"),
    // A save always advances past the active version; the version the client sends is only kept for a preview,
    // which has no previous. Trusting it on a save let two different templates share one version number.
    version: previous ? previous.version + 1 : Number(input.version) || 1,
    label: str(input.label, previous?.label ?? "Protocol").slice(0, 120),
    updatedAt: new Date().toISOString(),
    slots, clips,
    tasks: sanitizeTasks(input.tasks, previous),
    media: sanitizeMedia(input.media, previous),
  };
}

function sanitizeClips(raw: unknown, previous?: ProtocolTemplate): Partial<Record<ClipKind, ClipMedia>> {
  const input = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const clips: Partial<Record<ClipKind, ClipMedia>> = {};
  for (const clip of CLIP_KINDS) {
    const entry = input[clip] && typeof input[clip] === "object" ? input[clip] as Record<string, unknown> : null;
    if (!entry) { if (previous?.clips?.[clip]) clips[clip] = previous.clips[clip]; continue; }
    const src = str(entry.src).trim();
    if (!src) continue;
    const durationSec = Number(entry.durationSec);
    // The duration comes from the file itself; a clip without one would silently mis-estimate the whole session.
    if (!Number.isFinite(durationSec) || durationSec <= 0) throw new TemplateError(`The ${clip} clip has no measured duration.`);
    clips[clip] = { src, durationSec: Math.round(durationSec * 10) / 10, ...(entry.assetId ? { assetId: str(entry.assetId) } : {}), ...(entry.stimulusId ? { stimulusId: str(entry.stimulusId) } : {}) };
  }
  return clips;
}

function sanitizeTasks(raw: unknown, previous?: ProtocolTemplate): Record<BufferKind, TaskSlot> {
  const input = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const tasks = previous?.tasks ? structuredClone(previous.tasks) : defaultTasks();
  for (const kind of ["stroop","nback","conversation"] as BufferKind[]) {
    const entry = input[kind] && typeof input[kind] === "object" ? input[kind] as Record<string, unknown> : null;
    if (!entry) continue;
    const durationSec = duration(entry.durationSec);
    const minDurationSec = duration(entry.minDurationSec);
    if (durationSec !== undefined && minDurationSec !== undefined && durationSec < minDurationSec) {
      throw new TemplateError(`The ${kind} task is set to ${durationSec}s but needs at least ${minDurationSec}s.`);
    }
    tasks[kind] = {
      ...tasks[kind],
      title: str(entry.title, tasks[kind].title), subjectPrompt: str(entry.subjectPrompt, tasks[kind].subjectPrompt),
      operatorScript: str(entry.operatorScript, tasks[kind].operatorScript), operatorNote: str(entry.operatorNote, tasks[kind].operatorNote),
      estimatedSec: duration(entry.estimatedSec) ?? tasks[kind].estimatedSec,
      ...(durationSec !== undefined ? { durationSec } : {}),
      ...(minDurationSec !== undefined ? { minDurationSec } : {}),
    };
  }
  return tasks;
}

function sanitizeMedia(raw: unknown, previous?: ProtocolTemplate): Partial<Record<MediaKey, string>> {
  const input = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const media = { ...(previous?.media ?? defaultMedia()) };
  for (const key of MEDIA_KEYS) if (key in input) media[key] = str(input[key]).trim();
  return media;
}
