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

/** Box breathing: in, hold, out, hold, four seconds each, so one cycle is 16 s and the step is a multiple of it. */
export const BOX_BREATHING_PHASE_SEC = 4;
/** Rounds of box breathing: the step lasts BOX_BREATHING_ROUNDS x 4 x BOX_BREATHING_PHASE_SEC seconds. */
export const BOX_BREATHING_ROUNDS = 4;
export const BOX_BREATHING_SEC = BOX_BREATHING_ROUNDS * 4 * BOX_BREATHING_PHASE_SEC;

/**
 * The read-aloud passage. Every participant reads the same text, so read speech can be compared across the cohort
 * the way spontaneous speech from the conversation step cannot.
 *
 * 147 words: about 48 s at the 183 wpm average for oral reading (Brysbaert 2019), and about a minute at the slower
 * rates that review reports for readers with English as a second language. The text is deliberately neutral and
 * concrete, because it sits inside an emotion protocol, and it shares no word with the Stroop colours or with the
 * word-list nouns and their look-alikes, so it cannot prime either task. A test enforces all of that.
 */
export const READING_PASSAGE = "The public library on the main road opens at nine on every weekday. Before the doors are unlocked, two members of staff walk along the shelves with a trolley, checking that each label still matches the volumes beside it. Anything returned overnight is sorted by subject and put back in order, so that the next visitor can find it without having to ask. A junior assistant measures the empty bays, notes the figures in a folder, and joins the short morning meeting upstairs. They decide which rooms need brighter lighting, whether the study area should be moved away from the entrance, and how many trolleys to keep near the stairs. By noon the work is finished and the building is quiet again. Through the afternoon people arrive slowly: students carrying heavy bags, parents with young children, and a few older members who come mainly for the newspapers.";
export const READING_WORDS = READING_PASSAGE.split(/\s+/).filter(Boolean).length;
/** Reading ends by itself at this limit, so a participant who never presses Done cannot strand the session. */
export const READING_MAX_SEC = 120;
export const READING_EVENT = "reading_complete";

export const WORD_LIST = {
  /** How long the whole list stays on screen before the recognition test. */
  studySec: 20,
  /** Blank screen between test words, so one word's response cannot carry into the next. */
  gapMs: 300,
  /** Longest allowed run of studied, or of look-alike, words in the test. */
  maxRun: 3,
} as const;

/**
 * Six study lists of ten concrete, emotionally neutral nouns: one word per semantic category within a list, four to
 * eight letters, no Stroop colour words, no word shared between lists.
 *
 * List 1 is the list from protocol_console_optimized.html, kept so results stay comparable with anything run on that
 * prototype; it pairs "river" with "ocean", which the others avoid. The lists were matched by hand, not against
 * published norms - check them against frequency and concreteness ratings before publishing.
 */
export const WORD_LISTS: readonly (readonly string[])[] = [
  ["apple", "river", "chair", "music", "garden", "pencil", "ocean", "candle", "bicycle", "window"],
  ["bread", "forest", "table", "coin", "clock", "rabbit", "bottle", "cloud", "hammer", "jacket"],
  ["lemon", "bridge", "carpet", "kettle", "pillow", "sheep", "mirror", "violin", "basket", "planet"],
  ["cheese", "valley", "desk", "rocket", "blanket", "horse", "wallet", "drum", "stamp", "brush"],
  ["carrot", "desert", "lamp", "saucer", "curtain", "eagle", "compass", "guitar", "anchor", "pocket"],
  ["onion", "mountain", "stool", "spoon", "turtle", "helmet", "piano", "castle", "kite", "pebble"],
];

/**
 * Which list a participant studies, from their two counterbalancing rows (both 1-6).
 *
 * `(emotionRow + taskRow) % 6` is a Latin square over the 6x6 grid: every list appears once in every emotion order and
 * once in every task order, so list difficulty can never masquerade as an order effect. Rotating on the participant
 * number alone would tie the list to the emotion order, since that row is itself `(pid - 1) % 6`.
 */
export function wordListIndex(emotionRow: number, taskRow: number): number {
  return (((emotionRow - 1) + (taskRow - 1)) % WORD_LISTS.length + WORD_LISTS.length) % WORD_LISTS.length;
}

/**
 * One look-alike per studied word, in the same order as WORD_LISTS: a near-synonym, a close relative, or a word that
 * contains it ("bicycle" and "cycle"). Mixed into the recognition test so a Yes has to mean "this exact word", not
 * "something like it". Several are chosen to be familiar in Indian English (flyover, torch, tabla, sitar, fort).
 * Hand-picked, not normed.
 */
export const WORD_LURES: readonly (readonly string[])[] = [
  ["pear", "stream", "seat", "song", "yard", "pen", "sea", "lantern", "cycle", "pane"],
  ["loaf", "woods", "counter", "penny", "watch", "bunny", "flask", "mist", "mallet", "coat"],
  ["lime", "flyover", "rug", "teapot", "cushion", "lamb", "glass", "fiddle", "hamper", "globe"],
  ["butter", "canyon", "bench", "missile", "quilt", "pony", "purse", "tabla", "seal", "comb"],
  ["radish", "dune", "torch", "plate", "drape", "hawk", "map", "sitar", "harbour", "pouch"],
  ["garlic", "hill", "footstool", "ladle", "tortoise", "hat", "keyboard", "fort", "glider", "stone"],
];

export const WORD_LIST_EVENT = "wordlist_recognition";

export type RecognitionItem = { index: number; word: string; type: "old" | "lure" };

/** A stable seed from a session code, so a reloaded display shows the test in the same order. */
export function recognitionSeed(code: string): number {
  let hash = 0x811c9dc5;
  for (const character of code) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** The ten studied words and their ten look-alikes, shuffled with no long run of either kind. */
export function recognitionTrials(list: readonly string[], lures: readonly string[], random: Random, maxRun: number = WORD_LIST.maxRun): RecognitionItem[] {
  const kinds = [...list.map(() => true), ...lures.map(() => false)];
  let order = shuffle(kinds, random);
  for (let attempt = 0; attempt < 1000 && longestRun(order) > maxRun; attempt++) order = shuffle(kinds, random);
  const olds = shuffle([...list], random);
  const news = shuffle([...lures], random);
  return order.map((isOld, index) => ({ index, word: (isOld ? olds : news).shift() as string, type: isOld ? "old" : "lure" }));
}

/** The test a session shows and is scored against: always built the same way, from its list and its seed. */
export function recognitionItemsFor(listIndex: number, seed: number): RecognitionItem[] {
  return recognitionTrials(WORD_LISTS[listIndex], WORD_LURES[listIndex], seededRandom(seed));
}

export type RecognitionAnswer = { word: string; answer: "yes" | "no"; rtMs: number | null };
export type RecognitionTrial = { i: number; word: string; type: "old" | "lure"; answer: "yes" | "no" | null; correct: boolean | null; rtMs: number | null };

const bounded = (value: unknown, max: number) => {
  const number = Number(value);
  return value === null || value === undefined || !Number.isFinite(number) ? null : Math.max(0, Math.min(max, Math.round(number)));
};

/**
 * Score a recognition test against the items that were shown.
 *
 * Only words from this test count, and only the first answer to each; anything else the display sends is ignored.
 * d' and the criterion c use the log-linear correction summarizeNBack applies, so perfect scores stay finite.
 */
export function scoreRecognition(items: readonly RecognitionItem[], answers: unknown) {
  const byWord = new Map<string, RecognitionAnswer>();
  for (const raw of Array.isArray(answers) ? answers : []) {
    const entry = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
    const word = String(entry.word ?? "").toLowerCase();
    const answer = entry.answer === "yes" || entry.answer === "no" ? entry.answer : null;
    if (!answer || byWord.has(word) || !items.some((item) => item.word === word)) continue;
    byWord.set(word, { word, answer, rtMs: bounded(entry.rtMs, 120_000) });
  }
  const trialData: RecognitionTrial[] = items.map((item) => {
    const given = byWord.get(item.word);
    const answer = given?.answer ?? null;
    return { i: item.index, word: item.word, type: item.type, answer, correct: answer === null ? null : (answer === "yes") === (item.type === "old"), rtMs: given?.rtMs ?? null };
  });
  const count = (type: "old" | "lure", answer: "yes" | "no") => trialData.filter((trial) => trial.type === type && trial.answer === answer).length;
  const hits = count("old", "yes");
  const misses = count("old", "no");
  const falseAlarms = count("lure", "yes");
  const correctRejections = count("lure", "no");
  const hitRate = (hits + 0.5) / (hits + misses + 1);
  const falseAlarmRate = (falseAlarms + 0.5) / (falseAlarms + correctRejections + 1);
  const rts = trialData.map((trial) => trial.rtMs).filter((rt): rt is number => rt !== null);
  // `|| 0` folds a rounded -0 into 0, e.g. a criterion that is exactly neutral.
  const round2 = (value: number) => Math.round(value * 100) / 100 || 0;
  return {
    hits, misses, falseAlarms, correctRejections,
    answered: hits + misses + falseAlarms + correctRejections,
    total: items.length,
    hitRate: round2(hits / Math.max(1, hits + misses)),
    falseAlarmRate: round2(falseAlarms / Math.max(1, falseAlarms + correctRejections)),
    dPrime: round2(inverseNormal(hitRate) - inverseNormal(falseAlarmRate)),
    criterion: round2(-(inverseNormal(hitRate) + inverseNormal(falseAlarmRate)) / 2),
    meanRtMs: rts.length ? Math.round(rts.reduce((sum, value) => sum + value, 0) / rts.length) : null,
    trialData,
  };
}

/**
 * The event recorded when a participant finishes the recognition test, scored on the server against the session's
 * own list and order. The display reports only which word got which answer.
 */
export function wordListRecognitionResult(input: { listIndex: number; seed: number; raw: Record<string, unknown> }) {
  const list = WORD_LISTS[input.listIndex];
  const lures = WORD_LURES[input.listIndex];
  const items = recognitionItemsFor(input.listIndex, input.seed);
  const score = scoreRecognition(items, input.raw.answers);
  return {
    eventType: WORD_LIST_EVENT,
    label: `Word list: ${score.hits}/${list.length} recognised, ${score.falseAlarms} look-alikes accepted`,
    metadata: { listIndex: input.listIndex, seed: input.seed, words: [...list], lures: [...lures], studyMs: bounded(input.raw.studyMs, 120_000), ...score },
  };
}
