import { WORD_LIST_STEP, defaultTemplate, renderPlan } from "./protocol-template";
import { STIMULI, chooseStimuli, stimulusById, type ClipKind } from "./stimuli";
import { WORD_LISTS, wordListIndex } from "./tasks";
import { DEFAULT_CLIP_SECONDS, EMOTIONS, type Assignment, type BufferKind, type Emotion, type ProtocolOptions, type ProtocolStep, type ProtocolTemplate } from "./types";

/** Blocks enabled for new sessions. Annotation replay adds about 15 minutes, so it is opt-in. */
export const DEFAULT_PROTOCOL_OPTIONS: ProtocolOptions = { questionnaires: true, pacedBreathing: true, extendedExertion: true, neutralClip: true, annotationReplay: false, wordList: true };
/** Sessions created before v9 have no options and keep the v8 plan. */
const V8_OPTIONS: ProtocolOptions = { questionnaires: false, pacedBreathing: false, extendedExertion: false, neutralClip: false, annotationReplay: false, wordList: false };
export const PACED_BREATHING_RATES = [6, 10, 15, 20] as const;
/** Cycles needed before a breathing rate estimate is stable rather than a guess at a partial waveform. */
const PACED_BREATHING_MIN_CYCLES = 6;
/** Floor on window length, so the spectrum resolves 1.5 breaths/min - finer than the 4-5/min gaps between rates. */
const PACED_BREATHING_MIN_SEC = 40;

/** Shortest usable run of a paced-breathing step.
 *
 * Session 0101JUMR ran these for 35.2, 14.2, 12.4 and 19.6 s against 60 s planned - 2.4 to 3.5 cycles, resolving
 * only to 3.1-4.8 breaths/min when the conditions themselves are 5/min apart. The block could not have validated a
 * respiration estimator however well the sensors worked, so the floor is enforced rather than planned. */
export function pacedBreathingMinSec(rate: number) {
  return Math.max(PACED_BREATHING_MIN_SEC, Math.ceil((PACED_BREATHING_MIN_CYCLES / rate) * 60));
}

export function sanitizeProtocolOptions(raw: unknown, current: ProtocolOptions = DEFAULT_PROTOCOL_OPTIONS): ProtocolOptions {
  const input = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const result = { ...current };
  for (const key of Object.keys(DEFAULT_PROTOCOL_OPTIONS) as Array<keyof ProtocolOptions>) if (typeof input[key] === "boolean") result[key] = input[key] as boolean;
  return result;
}

const WILLIAMS6 = [[1,2,6,3,5,4],[2,3,1,4,6,5],[3,4,2,5,1,6],[4,5,3,6,2,1],[5,6,4,1,3,2],[6,1,5,2,4,3]];
const BUFFER_ORDERS: BufferKind[][] = [
  ["stroop","nback","conversation"],["stroop","conversation","nback"],["nback","stroop","conversation"],
  ["nback","conversation","stroop"],["conversation","stroop","nback"],["conversation","nback","stroop"],
];

/**
 * Emotion order follows the six-row Williams square by participant; task order cycles through its six permutations
 * independently (every sixth participant), so each emotion sequence is paired with every task order and all 36
 * combinations are balanced across 36 participants.
 */
export function assignFor(raw: number | string): Assignment {
  const pid = Math.max(1, Number.parseInt(String(raw), 10) || 1);
  const row = (pid - 1) % 6;
  const bufferRow = Math.floor((pid - 1) / 6) % 6;
  const order = WILLIAMS6[row].map((n) => EMOTIONS[n - 1]);
  const buffers = BUFFER_ORDERS[bufferRow];
  return { pid, row: row + 1, bufferRow: bufferRow + 1, buf1: buffers[0], buf2: buffers[1], buf3: buffers[2], block1: [order[0],order[1]], block2: [order[2],order[3]], block3: [order[4],order[5]], fullOrder: order, options: { ...DEFAULT_PROTOCOL_OPTIONS }, stimuli: chooseStimuli(pid), wordList: wordListIndex(row + 1, bufferRow + 1) };
}

/** Which recall list a session uses: stored at creation, or derived the same way for sessions that predate it. */
export function wordListIndexFor(a: Assignment): number {
  const index = a.wordList ?? wordListIndex(a.row, a.bufferRow ?? 1);
  return index >= 0 && index < WORD_LISTS.length ? index : 0;
}

export function wordListFor(a: Assignment): readonly string[] {
  return WORD_LISTS[wordListIndexFor(a)];
}

function clipSeconds(a: Assignment, clip: ClipKind) {
  const stimulus = stimulusById(a.stimuli?.[clip]);
  return stimulus?.durationSec ?? (clip === "neutral" ? 120 : DEFAULT_CLIP_SECONDS[clip]);
}

// The plan depends only on the orders, options, assigned stimuli, and template, so few distinct plans are built.
const planCache = new Map<string, readonly ProtocolStep[]>();

export function buildPlan(a: Assignment): readonly ProtocolStep[] {
  const key = JSON.stringify([a.block1,a.block2,a.block3,a.buf1,a.buf2,a.buf3,a.options ?? null,a.stimuli ?? null,a.protocol ?? null]);
  let plan = planCache.get(key);
  if (!plan) { plan = Object.freeze(a.protocol ? renderPlan(a.protocol, a) : createPlan(a)); planCache.set(key, plan); }
  return plan;
}

/** The built-in protocol as an editable template, as the starting point for the builder. */
export function defaultProtocolTemplate(options: ProtocolOptions = DEFAULT_PROTOCOL_OPTIONS, a?: Assignment): ProtocolTemplate {
  return defaultTemplate(options, pacedBreathingMinSec, PACED_BREATHING_RATES, a);
}

function createPlan(a: Assignment): ProtocolStep[] {
  const options = a.options ?? V8_OPTIONS;
  const steps: ProtocolStep[] = [];
  const add = (step: Omit<ProtocolStep,"id"|"index">) => {
    const suffix = step.type === "questionnaire" ? `-${step.questionnaireId}` : step.clip ? `-${step.clip}` : step.emo ? `-${step.emo}` : "";
    steps.push({ ...step, id:`s${String(steps.length).padStart(2,"0")}-${step.type}${suffix}`, index:steps.length });
  };
  const emotionOf = (clip: ClipKind) => clip === "neutral" ? undefined : clip;
  const clip = (kind: ClipKind, phase: string) => add({ type:"clip", title:kind === "neutral" ? "Neutral control clip" : `Emotion clip: ${kind}`, subjectPrompt:"Watch naturally.", operatorScript:"Watch the clip naturally and react however feels natural. There is no right or wrong response.", operatorNote:"Onset and offset are logged automatically.", phase, emo:emotionOf(kind), clip:kind, advance:"media", estimatedSec:clipSeconds(a, kind) + 5 });
  const questionnaire = (id: string, title: string, phase: string, estimatedSec: number) => add({ type:"questionnaire", title, subjectPrompt:"Answer each question.", operatorScript:"Please answer each question on the screen. There are no right or wrong answers.", operatorNote:"Self-report questionnaire; answers are scored automatically.", phase, questionnaireId:id, advance:"task", estimatedSec });
  const rating = (kind: ClipKind, phase: string) => add({ type:"sam", title:`Self-report: ${kind}`, clip:kind, emo:emotionOf(kind), subjectPrompt:"Choose what fits best.", operatorScript:"Choose the response that best matches your experience. Go with your first instinct.", operatorNote:"Valence, arousal, and dominance on a 9-point SAM scale, then the main emotion felt with its intensity, then clip familiarity.", phase, advance:"task", estimatedSec:40 });
  const washout = (phase: string) => add({ type:"washout", title:"Neutral washout", subjectPrompt:"", operatorScript:"Rest your eyes on the cross and breathe normally.", operatorNote:"Neutral fixation period.", phase, durationSec:20, advance:"timer", estimatedSec:20 });
  const gate = (phase: string, bpLabel: string, title="Return-to-baseline gate") => add({ type:"gate", title, subjectPrompt:"Sit quietly and breathe normally.", operatorScript:"Sit quietly and breathe normally while we prepare the next activity.", operatorNote:"Advance after the return-to-baseline checks are complete.", phase, durationSec:40, bp:true, bpLabel, advance:"gate", estimatedSec:45 });
  const buffer = (kind: BufferKind, phase: string) => {
    if (kind === "stroop") add({ type:"stroop", title:"Stroop colour-word task", subjectPrompt:"Select the ink colour, not the word.", operatorScript:"Select the button matching the ink colour, not what the word says. Respond as quickly and accurately as you can.", operatorNote:"30 trials with reaction time and accuracy logging.", phase, advance:"task", estimatedSec:90 });
    else if (kind === "nback") add({ type:"nback", title:"N-back task", subjectPrompt:"Press Match when the position repeats from N steps ago.", operatorScript:"Press Match whenever the current position is the same as the position from N steps ago.", operatorNote:"20 scored trials with hits, misses, false alarms, and response time.", phase, advance:"task", estimatedSec:50 });
    else add({ type:"conversation", title:"Conversation", subjectPrompt:"Talk together about something familiar.", operatorScript:"Talk for a few minutes about a recent trip, a hobby, or how the day has been.", operatorNote:"Neutral semi-structured conversation.", phase, durationSec:180, advance:"timer", estimatedSec:180 });
    if (options.questionnaires && kind !== "conversation") questionnaire("nasa_tlx", "Workload rating (NASA-TLX)", phase, 45);
  };

  add({ type:"setup", title:"Sensor and synchronization check", subjectPrompt:"Look toward the screen and stay still.", operatorScript:"Stay fairly still and keep facing the screen while the recording is checked.", operatorNote:"Verify every required stream and trigger synchronization before continuing.", phase:"Getting settled", advance:"operator", estimatedSec:30 });
  if (options.questionnaires) {
    // Questionnaires come before the resting baselines so answering does not disturb them.
    questionnaire("panas_pre", "Current mood (PANAS, start)", "Getting settled", 75);
    questionnaire("tipi", "Personality (TIPI)", "Getting settled", 50);
  }
  add({ type:"baseline", title:"Resting baseline, eyes open", subjectPrompt:"Look at the cross. Breathe naturally.", operatorScript:"Look at the cross and breathe normally.", operatorNote:"Eyes-open resting reference. Take the resting BP reading after settling.", phase:"Getting settled", durationSec:120, fixation:true, bp:true, bpLabel:"Resting anchor", advance:"timer", estimatedSec:120 });
  add({ type:"baseline", title:"Resting baseline, eyes closed", subjectPrompt:"Close your eyes. Breathe naturally.", operatorScript:"Gently close your eyes and keep breathing naturally.", operatorNote:"Eyes-closed resting reference.", phase:"Getting settled", durationSec:90, advance:"timer", estimatedSec:90 });

  if (options.neutralClip && a.stimuli?.neutral) {
    clip("neutral","Neutral control"); rating("neutral","Neutral control"); washout("Neutral control");
  }
  const block = (pair:[Emotion,Emotion], kind:BufferKind, phase:string, withGate=true) => { clip(pair[0],phase); rating(pair[0],phase); washout(phase); clip(pair[1],phase); rating(pair[1],phase); buffer(kind,phase); if(withGate) gate(phase, `After ${phase}`); };
  block(a.block1,a.buf1,"Part 1"); block(a.block2,a.buf2,"Part 2"); block(a.block3,a.buf3,"Part 3",false);
  if (options.wordList) add({ ...WORD_LIST_STEP });
  gate("Movement and breathing","Before physiological sweep","Settle before physiological sweep");
  add({ type:"sweep", title:"Seated rest", subjectPrompt:"Sit comfortably and stay still.", operatorScript:"Sit comfortably and stay still for a short moment.", operatorNote:"20 second seated anchor.", phase:"Movement and breathing", durationSec:20, advance:"timer", estimatedSec:20 });
  add({ type:"sweep", title:"Box breathing", subjectPrompt:"Follow the circle.", operatorScript:"Breathe in as the circle grows, hold, breathe out as it shrinks, then hold again.", operatorNote:"Use the registered media when available, otherwise use the visual pacer.", phase:"Movement and breathing", durationSec:45, advance:"timer", estimatedSec:45 });
  if (options.pacedBreathing) {
    for (const rate of PACED_BREATHING_RATES) add({ type:"sweep", title:`Paced breathing: ${rate} per minute`, subjectPrompt:"Breathe in as the bar rises and out as it falls.", operatorScript:`Follow the guide at ${rate} breaths per minute. Breathe gently; do not force it.`, operatorNote:"Reference for breathing-rate estimation from video, thermal, and CSI.", phase:"Movement and breathing", durationSec:60, minDurationSec:pacedBreathingMinSec(rate), breathsPerMin:rate, advance:"timer", estimatedSec:60 });
  }
  add({ type:"sweep", title:"Breath hold", safetyKey:"breath_hold", subjectPrompt:"Breathe in and hold. Release whenever you need to.", operatorScript:"Take a normal breath in and hold only for as long as feels comfortable.", operatorNote:"Voluntary and comfort limited. Skip if contraindicated.", phase:"Movement and breathing", safety:true, advance:"subject", estimatedSec:40 });
  add({ type:"sweep", title:"Head movement and speaking", subjectPrompt:"Turn left. Turn right. Look up. Look down. Then speak.", operatorScript:"Slowly turn left, right, up, and down. Then speak aloud for a few seconds.", operatorNote:"Motion and speech segment.", phase:"Movement and breathing", durationSec:30, advance:"timer", estimatedSec:30 });
  add({ type:"sweep", title:"Standing", safetyKey:"standing", subjectPrompt:"Stand up slowly. Stay still.", operatorScript:"Stand up slowly and remain still. Tell me immediately if you feel dizzy.", operatorNote:"Orthostatic measurement. Skip if contraindicated.", phase:"Movement and breathing", durationSec:45, safety:true, bp:true, bpLabel:"Orthostatic standing", advance:"timer", estimatedSec:45 });
  const exertionSec = options.extendedExertion ? 60 : 20;
  add({ type:"sweep", title:"Brief exertion", safetyKey:"exertion", subjectPrompt:"March in place or do sit-to-stands.", operatorScript:"March in place or do comfortable sit-to-stands.", operatorNote:`${exertionSec} second exertion period. Skip if contraindicated.`, phase:"Movement and breathing", durationSec:exertionSec, safety:true, advance:"timer", estimatedSec:exertionSec });
  add({ type:"sweep", title:"Post-exertion recovery", subjectPrompt:"Sit down. Stay still.", operatorScript:"Sit back down and stay still while your breathing settles.", operatorNote:"60 second recovery after exertion.", phase:"Movement and breathing", durationSec:60, advance:"timer", estimatedSec:60 });
  add({ type:"bodyscan", title:"Guided body scan", subjectPrompt:"Get comfortable. Close your eyes.", operatorScript:"Sit comfortably, close your eyes, and follow the guided audio.", operatorNote:"Four minute guided body scan.", phase:"Relaxation", durationSec:240, advance:"timer", estimatedSec:240 });
  add({ type:"recovery", title:"Return to normal", subjectPrompt:"Open your eyes when you are ready.", operatorScript:"Open your eyes whenever you are ready.", operatorNote:"Final eyes-open return and BP.", phase:"Relaxation", durationSec:60, bp:true, bpLabel:"Relaxed final", advance:"timer", estimatedSec:60 });
  if (options.questionnaires) questionnaire("panas_post", "Current mood (PANAS, end)", "Relaxation", 75);
  if (options.annotationReplay) {
    const replayed: ClipKind[] = [...(options.neutralClip && a.stimuli?.neutral ? ["neutral" as const] : []), ...a.fullOrder];
    for (const kind of replayed) add({ type:"annotation", title:`Continuous rating: ${kind}`, subjectPrompt:"Watch again and keep the marker where your feeling is.", operatorScript:"Watch the clip again. Move the marker whenever your feeling changes: left to right for unpleasant to pleasant, bottom to top for calm to excited.", operatorNote:"Continuous valence and arousal sampled at 20 Hz.", phase:"Continuous rating", clip:kind, emo:emotionOf(kind), advance:"media", estimatedSec:clipSeconds(a, kind) + 10 });
  }
  add({ type:"end", title:"Session complete", subjectPrompt:"Thank you.", operatorScript:"That is everything. Thank you.", operatorNote:"Confirm recorders saved, then export.", phase:"All done", advance:"operator", estimatedSec:15 });
  return steps;
}

export function shortLabel(step: ProtocolStep) {
  const clip = step.clip ?? step.emo;
  if (step.type === "clip") return `Clip: ${clip}`;
  if (step.type === "sam") return `Rating: ${clip}`;
  if (step.type === "annotation") return `Replay rating: ${clip}`;
  return step.title;
}

/** Media source for a clip step: the session's assigned registry stimulus, falling back to the configured default. */
export function clipSource(a: Assignment, clip: ClipKind | undefined, fallback: Partial<Record<string, string>>) {
  if (!clip) return "";
  return stimulusById(a.stimuli?.[clip], STIMULI)?.src ?? fallback[clip] ?? "";
}

export function estimateRemaining(plan: readonly ProtocolStep[], index: number) {
  return plan.slice(index).reduce((sum, step) => sum + step.estimatedSec, 0);
}
