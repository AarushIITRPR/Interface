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

test("word lists are disjoint, ten words each, and free of Stroop colour words", () => {
  assert.equal(tasks.WORD_LISTS.length, 6);
  const all = tasks.WORD_LISTS.flat();
  for (const list of tasks.WORD_LISTS) assert.equal(new Set(list).size, 10);
  assert.equal(new Set(all).size, all.length, "a word appears in more than one list");
  const colours = tasks.TASK_COLOURS.map((colour) => colour.name.toLowerCase());
  assert.deepEqual(all.filter((word) => colours.includes(word)), []);
  assert.ok(all.every((word) => /^[a-z]{4,8}$/.test(word)), "every word is 4-8 lowercase letters");
});

test("list assignment is a Latin square over emotion order and task order", () => {
  for (let row = 1; row <= 6; row++) {
    const acrossTaskRows = new Set(Array.from({ length: 6 }, (_, t) => tasks.wordListIndex(row, t + 1)));
    const acrossEmotionRows = new Set(Array.from({ length: 6 }, (_, e) => tasks.wordListIndex(e + 1, row)));
    assert.equal(acrossTaskRows.size, 6, `emotion row ${row} does not see every list`);
    assert.equal(acrossEmotionRows.size, 6, `task row ${row} does not see every list`);
  }
});

test("recall scoring separates hits, near misses, intrusions and repeats", () => {
  const list = tasks.WORD_LISTS[0];
  const score = tasks.scoreRecall(list, "Apples, chain; dog\nRIVER river   bicycles");
  assert.deepEqual(score.hits, ["apple", "river", "bicycle"]);
  assert.deepEqual(score.near, [{ typed: "chain", word: "chair" }]);
  assert.deepEqual(score.intrusions, ["dog"]);
  assert.equal(score.repeats, 1);
  assert.equal(score.hitsLenient, 4);
  assert.equal(score.total, 10);
  assert.equal(score.misses.length, 7);
  // Short tokens are never stretched into a near miss: too many four-letter words are one letter apart.
  assert.deepEqual(tasks.scoreRecall(list, "aple").near, []);
  assert.equal(tasks.scoreRecall(list, "").hits.length, 0);
});

test("delayed recall reports retention and a delay measured on the server clock", () => {
  const list = tasks.WORD_LISTS[0];
  const start = Date.parse("2026-09-17T10:00:00Z");
  const immediate = tasks.wordListResult({
    phase: "immediate", list, listIndex: 0,
    raw: { response: "apple river chair music", studyMs: 30000, recallMs: 40000 },
    receivedAt: start + 100_000, stepStartedAt: start,
  });
  assert.equal(immediate.eventType, "wordlist_recall");
  assert.equal(immediate.metadata.hits, 4);
  // Study ended 40 s before the submission arrived.
  assert.equal(immediate.metadata.studyEndedAt, new Date(start + 60_000).toISOString());

  const delayed = tasks.wordListResult({
    phase: "delayed", list, listIndex: 0,
    raw: { response: "apple river" },
    receivedAt: start + 720_000, stepStartedAt: start + 660_000,
    immediate: immediate.metadata,
  });
  assert.equal(delayed.eventType, "wordlist_delayed_recall");
  assert.equal(delayed.metadata.hits, 2);
  assert.equal(delayed.metadata.retentionPct, 50);
  // From the end of study to the start of the delayed step, not to when typing finished.
  assert.equal(delayed.metadata.delaySec, 600);
  assert.equal(delayed.metadata.recallSec, 60);

  // A delayed recall with nothing before it reports no delay rather than inventing one.
  const orphan = tasks.wordListResult({ phase: "delayed", list, listIndex: 0, raw: { response: "apple" }, receivedAt: start, stepStartedAt: start });
  assert.equal(orphan.metadata.delaySec, null);
  assert.equal(orphan.metadata.retentionPct, null);
});
