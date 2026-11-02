import assert from "node:assert/strict";
import test from "node:test";
import {COLOURS, makeStroopTrials} from "../lib/stroop.ts";

test("Stroop ink colours are balanced and never repeat across adjacent trials", () => {
  let state = 17;
  const random = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 2**32;
  const palette = new Map(COLOURS.map(({name, hex}) => [name, hex]));
  for (let run = 0; run < 1000; run++) {
    const trials = makeStroopTrials(random);
    assert.equal(trials.length, 30);
    for (let i = 0; i < trials.length; i++) {
      assert.notEqual(trials[i].ink, trials[i - 1]?.ink);
      assert.equal(trials[i].hex, palette.get(trials[i].ink));
      if (i % 6 === 0) assert.equal(new Set(trials.slice(i, i + 6).map(t => t.ink)).size, 6);
    }
  }
});
