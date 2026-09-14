import assert from "node:assert/strict";
import test from "node:test";
import { loadTs } from "./load-ts.mjs";

const stimuli = await loadTs("../lib/stimuli.ts");
const questionnaires = await loadTs("../lib/questionnaires.ts");

test("exemplars rotate evenly and every registered clip exists once per kind", () => {
  const registry = [
    { id: "happy-a", clip: "happy", src: "a", durationSec: 90, source: "" },
    { id: "happy-b", clip: "happy", src: "b", durationSec: 95, source: "" },
    { id: "sad-a", clip: "sad", src: "c", durationSec: 120, source: "" },
    { id: "neutral-a", clip: "neutral", src: "d", durationSec: 100, source: "" },
    { id: "neutral-b", clip: "neutral", src: "e", durationSec: 100, source: "" },
    { id: "neutral-c", clip: "neutral", src: "f", durationSec: 100, source: "" },
  ];
  const counts = {};
  for (let pid = 1; pid <= 36; pid++) {
    const chosen = stimuli.chooseStimuli(pid, registry);
    assert.equal(chosen.sad, "sad-a");
    assert.equal(chosen.anger, undefined);
    for (const id of [chosen.happy, chosen.neutral]) counts[id] = (counts[id] ?? 0) + 1;
  }
  assert.equal(counts["happy-a"], 18);
  assert.equal(counts["happy-b"], 18);
  assert.deepEqual([counts["neutral-a"], counts["neutral-b"], counts["neutral-c"]], [12, 12, 12]);
  assert.deepEqual(stimuli.chooseStimuli(1).happy, "happy-1");
  assert.equal(new Set(stimuli.STIMULI.map((item) => item.id)).size, stimuli.STIMULI.length);
});

test("questionnaire validation and scoring", () => {
  const panas = questionnaires.QUESTIONNAIRES.panas_pre;
  const all = (value) => Object.fromEntries(panas.items.map((item) => [item.id, value]));
  assert.equal(questionnaires.validAnswers(panas, { ...all(3), panas20: 6 }), null);
  assert.equal(questionnaires.validAnswers(panas, { panas1: 3 }), null);
  const answers = questionnaires.validAnswers(panas, { ...all(1), panas1: 5, panas2: 4 });
  assert.deepEqual(questionnaires.scoreQuestionnaire("panas_pre", answers), { positiveAffect: 14, negativeAffect: 13 });

  const tipi = Object.fromEntries(questionnaires.QUESTIONNAIRES.tipi.items.map((item, index) => [item.id, index + 1 <= 5 ? 7 : 1]));
  assert.deepEqual(questionnaires.scoreQuestionnaire("tipi", tipi), { extraversion: 7, agreeableness: 1, conscientiousness: 7, emotionalStability: 1, openness: 7 });

  const tlx = questionnaires.QUESTIONNAIRES.nasa_tlx;
  assert.equal(questionnaires.validAnswers(tlx, Object.fromEntries(tlx.items.map((item) => [item.id, 52]))), null);
  const load = questionnaires.validAnswers(tlx, { mental: 80, physical: 10, temporal: 60, performance: 30, effort: 70, frustration: 25 });
  assert.deepEqual(questionnaires.scoreQuestionnaire("nasa_tlx", load), { rawTlx: 45.8 });
});
