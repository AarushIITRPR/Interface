/**
 * Task and rating design for the subject display. Sequences are generated from a logged seed so every participant's
 * trial list can be reproduced exactly during analysis.
 */

export const TASK_COLOURS = [
  { name: "Red", hex: "#b83232" },
  { name: "Blue", hex: "#245fa9" },
  { name: "Green", hex: "#34743b" },
  { name: "Yellow", hex: "#d3a522" },
  { name: "Purple", hex: "#76509a" },
  { name: "Orange", hex: "#c66728" },
] as const;

export const STROOP = {
  trials: 30,
  congruentTrials: 15,
  /** Longest allowed run of trials with the same congruency. */
  maxRun: 3,
  deadlineMs: 2000,
  fixationMs: 400,
} as const;

export const NBACK = {
  scoredTrials: 20,
  targetShare: 0.3,
  practiceTrials: 8,
  positions: 9,
  stimulusMs: 800,
  soaMs: 1100,
} as const;

export const SAM_POINTS = 9;
export const DISCRETE_EMOTIONS = ["Happiness", "Sadness", "Anger", "Fear", "Surprise", "Disgust", "Neutral"] as const;
export const INTENSITY_POINTS = 9;
export const FAMILIARITY = ["Yes", "No", "Not sure"] as const;

export type Random = () => number;

/** Small deterministic PRNG (mulberry32). */
export function seededRandom(seed: number): Random {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function newSeed() {
  return Math.floor(Math.random() * 4294967296);
}

function shuffle<T>(items: T[], random: Random) {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function longestRun(values: boolean[]) {
  let longest = 0;
  let run = 0;
  values.forEach((value, index) => { run = index > 0 && value === values[index - 1] ? run + 1 : 1; longest = Math.max(longest, run); });
  return longest;
}

export type StroopTrial = { index: number; word: string; ink: string; hex: string; congruent: boolean };

/** Balanced Stroop list: fixed congruent share, bounded congruency runs, no immediate word repeats. */
export function stroopTrials(random: Random, trials: number = STROOP.trials, congruentTrials: number = STROOP.congruentTrials, maxRun: number = STROOP.maxRun): StroopTrial[] {
  const base = Array.from({ length: trials }, (_, index) => index < congruentTrials);
  let congruency = shuffle(base, random);
  for (let attempt = 0; attempt < 1000 && longestRun(congruency) > maxRun; attempt++) congruency = shuffle(base, random);
  const result: StroopTrial[] = [];
  for (let index = 0; index < trials; index++) {
    const choices = TASK_COLOURS.filter((colour) => colour.name !== result[index - 1]?.word);
    const word = choices[Math.floor(random() * choices.length)];
    const inkChoices = congruency[index] ? [word] : TASK_COLOURS.filter((colour) => colour.name !== word.name);
    const ink = inkChoices[Math.floor(random() * inkChoices.length)];
    result.push({ index, word: word.name, ink: ink.name, hex: ink.hex, congruent: congruency[index] });
  }
  return result;
}

export type StroopResponse = StroopTrial & { response: string | null; rtMs: number | null; correct: boolean; timedOut: boolean };

export function summarizeStroop(responses: StroopResponse[]) {
  const mean = (values: number[]) => values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : null;
  const correctRt = (congruent: boolean) => responses.filter((trial) => trial.congruent === congruent && trial.correct && trial.rtMs !== null).map((trial) => trial.rtMs as number);
  const congruentRtMs = mean(correctRt(true));
  const incongruentRtMs = mean(correctRt(false));
  return {
    trials: responses.length,
    accuracyPct: responses.length ? Math.round(100 * responses.filter((trial) => trial.correct).length / responses.length) : 0,
    timeouts: responses.filter((trial) => trial.timedOut).length,
    congruentRtMs,
    incongruentRtMs,
    interferenceMs: congruentRtMs !== null && incongruentRtMs !== null ? incongruentRtMs - congruentRtMs : null,
  };
}

export type NBackSequence = { level: number; positions: number[]; targets: boolean[]; scoredFrom: number };

/**
 * N-back sequence with exactly round(targetShare * scoredTrials) targets among scored trials and no accidental
 * matches: every non-target differs from the position shown N trials earlier. The first N trials are lead-in.
 */
export function nbackSequence(random: Random, level: number, scoredTrials: number = NBACK.scoredTrials, targetShare: number = NBACK.targetShare, positions: number = NBACK.positions): NBackSequence {
  const total = level + scoredTrials;
  const targetCount = Math.round(targetShare * scoredTrials);
  const targetSet = new Set(shuffle(Array.from({ length: scoredTrials }, (_, index) => level + index), random).slice(0, targetCount));
  const sequence: number[] = [];
  const targets: boolean[] = [];
  for (let index = 0; index < total; index++) {
    const isTarget = targetSet.has(index);
    if (isTarget) sequence.push(sequence[index - level]);
    else {
      const avoid = index >= level ? sequence[index - level] : -1;
      const choices = Array.from({ length: positions }, (_, position) => position).filter((position) => position !== avoid);
      sequence.push(choices[Math.floor(random() * choices.length)]);
    }
    targets.push(isTarget);
  }
  return { level, positions: sequence, targets, scoredFrom: level };
}

export type NBackTrial = { index: number; position: number; target: boolean; responded: boolean; rtMs: number | null; outcome: "hit" | "miss" | "false_alarm" | "correct_rejection" | "lead_in" };

export function nbackOutcome(target: boolean, responded: boolean, scored: boolean): NBackTrial["outcome"] {
  if (!scored) return "lead_in";
  if (target) return responded ? "hit" : "miss";
  return responded ? "false_alarm" : "correct_rejection";
}

export function summarizeNBack(level: number, trials: NBackTrial[]) {
  const count = (outcome: NBackTrial["outcome"]) => trials.filter((trial) => trial.outcome === outcome).length;
  const hits = count("hit");
  const misses = count("miss");
  const falseAlarms = count("false_alarm");
  const correctRejections = count("correct_rejection");
  const hitRts = trials.filter((trial) => trial.outcome === "hit" && trial.rtMs !== null).map((trial) => trial.rtMs as number);
  // d' with the log-linear correction so perfect scores stay finite.
  const hitRate = (hits + 0.5) / (hits + misses + 1);
  const falseAlarmRate = (falseAlarms + 0.5) / (falseAlarms + correctRejections + 1);
  return {
    level,
    trials: hits + misses + falseAlarms + correctRejections,
    hits,
    misses,
    falseAlarms,
    correctRejections,
    averageHitRtMs: hitRts.length ? Math.round(hitRts.reduce((sum, value) => sum + value, 0) / hitRts.length) : null,
    dPrime: Math.round((inverseNormal(hitRate) - inverseNormal(falseAlarmRate)) * 100) / 100,
  };
}

/** Acklam's rational approximation of the standard normal quantile. */
function inverseNormal(p: number) {
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const low = 0.02425;
  if (p < low) { const q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  if (p > 1 - low) { const q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  const q = p - 0.5;
  const r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

/** Breath hold ends automatically at this limit. */
export const BREATH_HOLD_MAX_SEC = 60;
