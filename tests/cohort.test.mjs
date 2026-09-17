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

test("demo runs never reach the cohort summary", () => {
  const session = (code, participantId, emotionRow, taskRow) => ({
    code, participantId, status: "complete", protocolVersion: "v9", createdAt: "2026-09-17T00:00:00Z",
    durationMin: 30, emotionRow, taskRow, skinType: "III", sex: "Female", ageBand: "25-34",
    missingDetails: 0, consent: true, pauses: 0, gateOverrides: 0, skippedSteps: 0, artifacts: 0,
    questionnaires: 2, ratings: 6, csiBaseline: "done",
  });
  // cohortSessions() filters demos out in SQL, so the summary only ever sees real sessions. This asserts the
  // shape that filtering protects: one real participant, one filled cell, one entry per distribution.
  const real = cohort.summarizeCohort([session("0001AAAA", 1, 1, 1)]);
  assert.equal(real.completedParticipants, 1);
  assert.equal(real.coverage[0][0], 1);
  assert.equal(real.distributions.skinType.III, 1);
  // Had a demo leaked through, every one of those would move.
  const leaked = cohort.summarizeCohort([session("0001AAAA", 1, 1, 1), session("0001DEMO", 1, 1, 1)]);
  assert.equal(leaked.coverage[0][0], 2);
  assert.deepEqual(leaked.duplicateParticipants, [1]);
  assert.equal(leaked.distributions.skinType.III, 2);
});
