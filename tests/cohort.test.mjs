import assert from "node:assert/strict";
import test from "node:test";
import { loadTs } from "./load-ts.mjs";

const cohort = await loadTs("../lib/cohort.ts");

const session = (overrides) => ({
  code: "X", participantId: 1, status: "complete", protocolVersion: "v9", createdAt: "", durationMin: 40, emotionRow: 1, taskRow: 1,
  skinType: "IV", sex: "Female", ageBand: "25-34", missingDetails: 0, consent: true, pauses: 0, gateOverrides: 0, skippedSteps: 0,
  artifacts: 0, questionnaires: 5, ratings: 6, csiBaseline: "done", ...overrides,
});

test("cohort overview counts balance only from completed sessions", () => {
  const overview = cohort.summarizeCohort([
    session({ code: "A", participantId: 1 }),
    session({ code: "B", participantId: 7, emotionRow: 1, taskRow: 2, skinType: "VI", sex: "Male" }),
    session({ code: "C", participantId: 7, emotionRow: 1, taskRow: 2, skinType: "VI", sex: "Male" }),
    session({ code: "D", participantId: 9, status: "aborted", emotionRow: 3, taskRow: 2 }),
    session({ code: "E", participantId: 10, status: "setup", skinType: null }),
  ]);
  assert.deepEqual(overview.statusCounts, { complete: 3, aborted: 1, setup: 1 });
  assert.equal(overview.completedParticipants, 2);
  assert.deepEqual(overview.duplicateParticipants, [7]);
  assert.equal(overview.coverage[0][0], 1);
  assert.equal(overview.coverage[0][1], 2);
  assert.equal(overview.coverage[2][1], 0);
  assert.equal(overview.distributions.skinType.VI, 2);
  assert.equal(overview.distributions.skinType.I, 0);
  assert.equal(overview.distributions.sex.Female, 1);
});
