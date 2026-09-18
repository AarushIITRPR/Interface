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

test("look-alikes are aligned with the lists, unique, and never a studied word", () => {
  assert.equal(tasks.WORD_LURES.length, tasks.WORD_LISTS.length);
  for (const [index, lures] of tasks.WORD_LURES.entries()) {
    assert.equal(lures.length, tasks.WORD_LISTS[index].length, `list ${index + 1} has one look-alike per word`);
  }
  const lures = tasks.WORD_LURES.flat();
  const studied = new Set(tasks.WORD_LISTS.flat());
  assert.equal(new Set(lures).size, lures.length, "a look-alike is used twice");
  assert.deepEqual(lures.filter((word) => studied.has(word)), [], "a look-alike is a studied word somewhere");
  const colours = tasks.TASK_COLOURS.map((colour) => colour.name.toLowerCase());
  assert.deepEqual(lures.filter((word) => colours.includes(word)), []);
  assert.ok(lures.every((word) => /^[a-z]{3,9}$/.test(word)));
  // The pair from the request.
  assert.equal(tasks.WORD_LURES[0][tasks.WORD_LISTS[0].indexOf("bicycle")], "cycle");
});

test("the recognition test mixes ten studied words and ten look-alikes, reproducibly, without long runs", () => {
  for (let listIndex = 0; listIndex < tasks.WORD_LISTS.length; listIndex++) {
    for (let seed = 1; seed <= 60; seed++) {
      const items = tasks.recognitionItemsFor(listIndex, seed);
      assert.equal(items.length, 20);
      assert.deepEqual(items.filter((item) => item.type === "old").map((item) => item.word).sort(), [...tasks.WORD_LISTS[listIndex]].sort());
      assert.deepEqual(items.filter((item) => item.type === "lure").map((item) => item.word).sort(), [...tasks.WORD_LURES[listIndex]].sort());
      let run = 0;
      items.forEach((item, i) => { run = i > 0 && item.type === items[i - 1].type ? run + 1 : 1; assert.ok(run <= tasks.WORD_LIST.maxRun, `run of ${run} for seed ${seed}`); });
      assert.deepEqual(tasks.recognitionItemsFor(listIndex, seed), items, "same seed, same order");
    }
  }
  assert.notEqual(tasks.recognitionSeed("0001ABCD"), tasks.recognitionSeed("0001ABCE"));
  assert.equal(tasks.recognitionSeed("0001ABCD"), tasks.recognitionSeed("0001ABCD"));
});

test("recognition scoring counts each shown word once and ignores anything else", () => {
  const items = tasks.recognitionItemsFor(0, 42);
  const studied = new Set(tasks.WORD_LISTS[0]);
  // Yes to 8 studied words and 2 look-alikes; No to the rest.
  const oldWords = items.filter((item) => item.type === "old").map((item) => item.word);
  const lureWords = items.filter((item) => item.type === "lure").map((item) => item.word);
  const yes = new Set([...oldWords.slice(0, 8), ...lureWords.slice(0, 2)]);
  const answers = items.map((item) => ({ word: item.word, answer: yes.has(item.word) ? "yes" : "no", rtMs: 900 }));
  answers.push({ word: oldWords[9], answer: "yes", rtMs: 100 });       // a second answer to a word: ignored
  answers.push({ word: "dragon", answer: "yes", rtMs: 100 });          // not in this test: ignored
  answers.push({ word: oldWords[0], answer: "maybe", rtMs: 100 });     // not a valid answer: ignored
  const score = tasks.scoreRecognition(items, answers);
  assert.deepEqual([score.hits, score.misses, score.falseAlarms, score.correctRejections], [8, 2, 2, 8]);
  assert.equal(score.answered, 20);
  assert.equal(score.hitRate, 0.8);
  assert.equal(score.falseAlarmRate, 0.2);
  // Log-linear corrected rates: H = 8.5/11, F = 2.5/11.
  assert.equal(score.dPrime, 1.5);
  assert.equal(score.criterion, 0);
  assert.equal(score.meanRtMs, 900);
  const bicycle = score.trialData.find((trial) => trial.word === "cycle");
  assert.equal(bicycle.type, "lure");
  assert.ok(score.trialData.every((trial) => trial.type === (studied.has(trial.word) ? "old" : "lure")));
  // Nothing answered: counts are zero and rates stay finite.
  const empty = tasks.scoreRecognition(items, "not a list");
  assert.equal(empty.answered, 0);
  assert.ok(Number.isFinite(empty.dPrime));
});

test("the recognition result is scored against the session's own list and order", () => {
  const seed = tasks.recognitionSeed("0001TEST");
  const items = tasks.recognitionItemsFor(2, seed);
  const answers = items.map((item) => ({ word: item.word, answer: item.type === "old" ? "yes" : "no", rtMs: 700 }));
  const result = tasks.wordListRecognitionResult({ listIndex: 2, seed, raw: { answers, studyMs: 20000 } });
  assert.equal(result.eventType, "wordlist_recognition");
  assert.equal(result.metadata.hits, 10);
  assert.equal(result.metadata.falseAlarms, 0);
  assert.equal(result.metadata.studyMs, 20000);
  assert.deepEqual(result.metadata.words, [...tasks.WORD_LISTS[2]]);
  assert.match(result.label, /10\/10 recognised, 0 look-alikes accepted/);
  assert.equal(tasks.WORD_LIST.studySec, 20);
});
