/**
 * Participant safety screening and the physiological return-to-baseline gate.
 *
 * The screening questions and their step mappings are study defaults for the research team to review. A "yes" to any
 * question skips the listed physical steps for that participant; skipped steps are logged, never silently dropped.
 */

export type SafetyKey = "breath_hold" | "standing" | "exertion";

export const SCREENING_QUESTIONS: ReadonlyArray<{ id: string; question: string; skips: readonly SafetyKey[] }> = [
  { id: "cardiac", question: "Any heart condition, chest pain, or blood pressure condition under treatment?", skips: ["breath_hold", "exertion"] },
  { id: "respiratory", question: "Asthma, COPD, or another breathing condition?", skips: ["breath_hold", "exertion"] },
  { id: "fainting", question: "History of fainting, or dizziness when standing up?", skips: ["standing"] },
  { id: "mobility", question: "An injury or condition that makes standing up or marching in place difficult?", skips: ["standing", "exertion"] },
  { id: "pregnancy", question: "Currently pregnant?", skips: ["breath_hold", "exertion"] },
  { id: "unwell", question: "Unwell today, or advised by a doctor to avoid exercise?", skips: ["breath_hold", "exertion"] },
];

export type ScreeningAnswers = Record<string, boolean>;

export function screeningComplete(answers: ScreeningAnswers | undefined) {
  return Boolean(answers) && SCREENING_QUESTIONS.every((item) => typeof answers?.[item.id] === "boolean");
}

/** Safety keys to skip, each with the questions that caused it. */
export function skippedSafetySteps(answers: ScreeningAnswers | undefined): Partial<Record<SafetyKey, string[]>> {
  const result: Partial<Record<SafetyKey, string[]>> = {};
  for (const item of SCREENING_QUESTIONS) {
    if (!answers?.[item.id]) continue;
    for (const key of item.skips) result[key] = [...(result[key] ?? []), item.id];
  }
  return result;
}

export const GATE = {
  /** Baseline samples are taken after this much of each resting baseline step has passed. */
  baselineSettleSec: 15,
  /** Minimum baseline samples (about one per second) before the gate can be evaluated. */
  minBaselineSamples: 30,
  /** Physiology must stay within tolerance continuously for this long. */
  holdSec: 15,
  /** Tolerance is the larger of 2 SD of the baseline and these floors. */
  heartRateFloorBpm: 5,
  conductanceFloorPct: 10,
  /** Recent samples kept for evaluation. */
  recentWindowSec: 60,
} as const;

export type RunningStat = { n: number; mean: number; m2: number };
export type PhysioSample = { t: number; hr: number | null; gsr: number | null };
export type Physiology = { baseline: { hr: RunningStat; gsr: RunningStat }; recent: PhysioSample[] };

const emptyStat = (): RunningStat => ({ n: 0, mean: 0, m2: 0 });
export const emptyPhysiology = (): Physiology => ({ baseline: { hr: emptyStat(), gsr: emptyStat() }, recent: [] });

function addSample(stat: RunningStat, value: number): RunningStat {
  const n = stat.n + 1;
  const delta = value - stat.mean;
  const mean = stat.mean + delta / n;
  return { n, mean, m2: stat.m2 + delta * (value - mean) };
}

const sd = (stat: RunningStat) => (stat.n > 1 ? Math.sqrt(stat.m2 / (stat.n - 1)) : 0);

/** Fold one telemetry sample into the baseline (during resting baseline steps) and the recent window. */
export function updatePhysiology(current: Physiology | undefined, sample: PhysioSample, collectBaseline: boolean): Physiology {
  const physiology = current ?? emptyPhysiology();
  const baseline = { ...physiology.baseline };
  if (collectBaseline) {
    if (sample.hr !== null) baseline.hr = addSample(baseline.hr, sample.hr);
    if (sample.gsr !== null) baseline.gsr = addSample(baseline.gsr, sample.gsr);
  }
  const recent = [...physiology.recent, sample].filter((item) => sample.t - item.t <= GATE.recentWindowSec * 1000);
  return { baseline, recent };
}

export type GateSignal = { id: "hr" | "gsr"; label: string; unit: string; baselineMean: number; tolerance: number; current: number | null; within: boolean; heldSec: number };
export type GateStatus = { status: "ready" | "not_ready" | "unavailable"; holdSec: number; signals: GateSignal[] };

/** `sinceMs` is when the gate step started: the hold only counts time spent in the gate itself. */
export function evaluateGate(physiology: Physiology | undefined, nowMs: number, sinceMs = 0): GateStatus {
  const signals: GateSignal[] = [];
  const definitions = [
    { id: "hr" as const, label: "Heart rate", unit: "bpm", floor: () => GATE.heartRateFloorBpm },
    { id: "gsr" as const, label: "Skin conductance", unit: "µS", floor: (mean: number) => (Math.abs(mean) * GATE.conductanceFloorPct) / 100 },
  ];
  for (const definition of definitions) {
    const stat = physiology?.baseline[definition.id];
    if (!stat || stat.n < GATE.minBaselineSamples) continue;
    const tolerance = Math.max(2 * sd(stat), definition.floor(stat.mean));
    const samples = (physiology?.recent ?? []).filter((item) => item[definition.id] !== null);
    const latest = samples.at(-1);
    if (!latest || nowMs - latest.t > 5000) {
      signals.push({ id: definition.id, label: definition.label, unit: definition.unit, baselineMean: round(stat.mean), tolerance: round(tolerance), current: null, within: false, heldSec: 0 });
      continue;
    }
    const outside = (value: number) => Math.abs(value - stat.mean) > tolerance;
    const lastOutside = [...samples].reverse().find((item) => outside(item[definition.id] as number));
    const heldFrom = Math.max(lastOutside ? lastOutside.t : samples[0].t, sinceMs);
    const heldSec = Math.max(0, (nowMs - heldFrom) / 1000);
    const current = latest[definition.id] as number;
    signals.push({ id: definition.id, label: definition.label, unit: definition.unit, baselineMean: round(stat.mean), tolerance: round(tolerance), current: round(current), within: !outside(current), heldSec: round(heldSec) });
  }
  if (!signals.length) return { status: "unavailable", holdSec: GATE.holdSec, signals };
  const ready = signals.every((signal) => signal.within && signal.heldSec >= GATE.holdSec);
  return { status: ready ? "ready" : "not_ready", holdSec: GATE.holdSec, signals };
}

function round(value: number) {
  return Math.round(value * 100) / 100;
}
