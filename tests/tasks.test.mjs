import assert from "node:assert/strict";
import test from "node:test";
import { loadTs } from "./load-ts.mjs";

const tasks = await loadTs("../lib/tasks.ts");

test("Stroop lists are balanced with bounded congruency runs", () => {
  for (let seed = 1; seed <= 200; seed++) {
    const trials = tasks.stroopTrials(tasks.seededRandom(seed));
    assert.equal(trials.length, 30);
    assert.equal(trials.filter((trial) => trial.congruent).length, 15);
    let run = 1;
    for (let i = 1; i < trials.length; i++) {
      run = trials[i].congruent === trials[i - 1].congruent ? run + 1 : 1;
      assert.ok(run <= 3, `seed ${seed} has a congruency run of ${run}`);
      assert.notEqual(trials[i].word, trials[i - 1].word);
    }
    for (const trial of trials) assert.equal(trial.congruent, trial.word === trial.ink);
  }
});

test("Stroop sequences are reproducible from the seed", () => {
  assert.deepEqual(tasks.stroopTrials(tasks.seededRandom(42)), tasks.stroopTrials(tasks.seededRandom(42)));
});

test("Stroop summary reports interference from correct trials", () => {
  const trial = (congruent, rtMs, correct = true, timedOut = false) => ({ index: 0, word: "Red", ink: "Red", hex: "", congruent, response: timedOut ? null : "Red", rtMs, correct, timedOut });
  const summary = tasks.summarizeStroop([trial(true, 500), trial(true, 600), trial(false, 700), trial(false, 900), trial(false, 3000, false), trial(false, null, false, true)]);
  assert.deepEqual(summary, { trials: 6, accuracyPct: 67, timeouts: 1, congruentRtMs: 550, incongruentRtMs: 800, interferenceMs: 250 });
});

test("N-back sequences have exact targets and no accidental matches", () => {
  for (const level of [1, 2, 3]) {
    for (let seed = 1; seed <= 200; seed++) {
      const sequence = tasks.nbackSequence(tasks.seededRandom(seed), level);
      assert.equal(sequence.positions.length, level + 20);
      assert.equal(sequence.targets.filter(Boolean).length, 6);
      sequence.positions.forEach((position, index) => {
        const matches = index >= level && position === sequence.positions[index - level];
        assert.equal(matches, sequence.targets[index], `level ${level} seed ${seed} trial ${index}`);
        assert.ok(position >= 0 && position < 9);
      });
    }
  }
});

test("N-back outcomes and d-prime", () => {
  assert.equal(tasks.nbackOutcome(true, true, true), "hit");
  assert.equal(tasks.nbackOutcome(true, false, true), "miss");
  assert.equal(tasks.nbackOutcome(false, true, true), "false_alarm");
  assert.equal(tasks.nbackOutcome(false, false, true), "correct_rejection");
  assert.equal(tasks.nbackOutcome(true, true, false), "lead_in");
  const trials = [
    ...Array.from({ length: 6 }, () => ({ outcome: "hit", rtMs: 500 })),
    ...Array.from({ length: 14 }, () => ({ outcome: "correct_rejection", rtMs: null })),
  ];
  const summary = tasks.summarizeNBack(2, trials);
  assert.equal(summary.trials, 20);
  assert.equal(summary.averageHitRtMs, 500);
  assert.ok(summary.dPrime > 2.5 && summary.dPrime < 4, `d' ${summary.dPrime}`);
});
