/**
 * Self-report instruments available without licence fees for research use. Check the terms for your institution
 * before publishing: PANAS (Watson, Clark & Tellegen, 1988), TIPI (Gosling, Rentfrow & Swann, 2003), and the raw
 * NASA Task Load Index (Hart & Staveland, 1988; NASA). Copyrighted scales such as STAI or TAS-20 are not included.
 */

export type Scale = { points: number; min: number; step: number; lowLabel: string; highLabel: string; labels?: readonly string[] };
export type QuestionnaireItem = { id: string; text: string; lowLabel?: string; highLabel?: string };
export type Questionnaire = { id: string; title: string; instructions: string; scale: Scale; items: readonly QuestionnaireItem[] };

const PANAS_WORDS = ["Interested", "Distressed", "Excited", "Upset", "Strong", "Guilty", "Scared", "Hostile", "Enthusiastic", "Proud", "Irritable", "Alert", "Ashamed", "Inspired", "Nervous", "Determined", "Attentive", "Jittery", "Active", "Afraid"] as const;
const PANAS_POSITIVE = new Set([1, 3, 5, 9, 10, 12, 14, 16, 17, 19]);

const panas = (id: string, when: string): Questionnaire => ({
  id,
  title: "How do you feel right now?",
  instructions: `Indicate to what extent you feel this way ${when}.`,
  scale: { points: 5, min: 1, step: 1, lowLabel: "Very slightly or not at all", highLabel: "Extremely", labels: ["Very slightly or not at all", "A little", "Moderately", "Quite a bit", "Extremely"] },
  items: PANAS_WORDS.map((text, index) => ({ id: `panas${index + 1}`, text })),
});

const TLX_ITEMS = [
  { id: "mental", text: "How mentally demanding was the task?" },
  { id: "physical", text: "How physically demanding was the task?" },
  { id: "temporal", text: "How hurried or rushed was the pace of the task?" },
  { id: "performance", text: "How successful were you in accomplishing what you were asked to do?", lowLabel: "Perfect", highLabel: "Failure" },
  { id: "effort", text: "How hard did you have to work to accomplish your level of performance?" },
  { id: "frustration", text: "How insecure, discouraged, irritated, stressed, and annoyed were you?" },
] as const;

export const QUESTIONNAIRES: Record<string, Questionnaire> = {
  panas_pre: panas("panas_pre", "right now, at the start"),
  panas_post: panas("panas_post", "right now, at the end"),
  tipi: {
    id: "tipi",
    title: "I see myself as:",
    instructions: "Rate how well each pair of words applies to you, even if one word applies more strongly than the other.",
    scale: { points: 7, min: 1, step: 1, lowLabel: "Disagree strongly", highLabel: "Agree strongly", labels: ["Disagree strongly", "Disagree moderately", "Disagree a little", "Neither agree nor disagree", "Agree a little", "Agree moderately", "Agree strongly"] },
    items: [
      "Extraverted, enthusiastic", "Critical, quarrelsome", "Dependable, self-disciplined", "Anxious, easily upset", "Open to new experiences, complex",
      "Reserved, quiet", "Sympathetic, warm", "Disorganized, careless", "Calm, emotionally stable", "Conventional, uncreative",
    ].map((text, index) => ({ id: `tipi${index + 1}`, text })),
  },
  nasa_tlx: {
    id: "nasa_tlx",
    title: "About the task you just did",
    instructions: "Choose a point on each scale.",
    scale: { points: 21, min: 0, step: 5, lowLabel: "Very low", highLabel: "Very high" },
    items: TLX_ITEMS,
  },
};

export type QuestionnaireScores = Record<string, number>;

/** Validates a full set of answers; returns null if any item is missing or off the scale. */
export function validAnswers(questionnaire: Questionnaire, raw: unknown): Record<string, number> | null {
  const input = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const answers: Record<string, number> = {};
  const { min, step, points } = questionnaire.scale;
  for (const item of questionnaire.items) {
    const value = Number(input[item.id]);
    const index = (value - min) / step;
    if (!Number.isInteger(index) || index < 0 || index >= points) return null;
    answers[item.id] = value;
  }
  return answers;
}

export function scoreQuestionnaire(id: string, answers: Record<string, number>): QuestionnaireScores {
  if (id.startsWith("panas")) {
    let positive = 0;
    let negative = 0;
    PANAS_WORDS.forEach((_, index) => {
      const value = answers[`panas${index + 1}`];
      if (PANAS_POSITIVE.has(index + 1)) positive += value;
      else negative += value;
    });
    return { positiveAffect: positive, negativeAffect: negative };
  }
  if (id === "tipi") {
    const item = (n: number) => answers[`tipi${n}`];
    const reverse = (n: number) => 8 - item(n);
    return {
      extraversion: (item(1) + reverse(6)) / 2,
      agreeableness: (reverse(2) + item(7)) / 2,
      conscientiousness: (item(3) + reverse(8)) / 2,
      emotionalStability: (reverse(4) + item(9)) / 2,
      openness: (item(5) + reverse(10)) / 2,
    };
  }
  if (id === "nasa_tlx") {
    const values = TLX_ITEMS.map((item) => answers[item.id]);
    // Performance runs from perfect (0) to failure (100), so higher is worse on every subscale.
    return { rawTlx: Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 10) / 10 };
  }
  return {};
}
