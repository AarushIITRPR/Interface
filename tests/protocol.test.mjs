import assert from "node:assert/strict";
import test from "node:test";
import { loadTs } from "./load-ts.mjs";

const protocol = await loadTs("../lib/protocol.ts");

test("emotion order and task order are counterbalanced independently", () => {
  const combinations = new Set();
  const pairings = new Map();
  for (let pid = 1; pid <= 36; pid++) {
    const a = protocol.assignFor(pid);
    const emotions = a.fullOrder.join(">");
    const tasks = [a.buf1, a.buf2, a.buf3].join(">");
    combinations.add(`${emotions}|${tasks}`);
    pairings.set(emotions, (pairings.get(emotions) ?? new Set()).add(tasks));
  }
  assert.equal(combinations.size, 36);
  assert.equal(pairings.size, 6);
  for (const tasks of pairings.values()) assert.equal(tasks.size, 6);
});

test("Williams rows balance first-order carryover between emotions", () => {
  const follows = new Map();
  for (let pid = 1; pid <= 6; pid++) {
    const order = protocol.assignFor(pid).fullOrder;
    for (let i = 0; i < order.length - 1; i++) {
      const key = `${order[i]}>${order[i + 1]}`;
      follows.set(key, (follows.get(key) ?? 0) + 1);
    }
  }
  assert.equal(follows.size, 30);
  for (const count of follows.values()) assert.equal(count, 1);
});

test("participants beyond 36 wrap to the same assignments", () => {
  const first = protocol.assignFor(5);
  const later = protocol.assignFor(5 + 36);
  assert.deepEqual([later.fullOrder, later.buf1, later.buf2, later.buf3], [first.fullOrder, first.buf1, first.buf2, first.buf3]);
});

test("sessions without options keep the exact v8 plan", () => {
  const assignment = protocol.assignFor(1);
  delete assignment.options;
  delete assignment.stimuli;
  const ids = protocol.buildPlan(assignment).map((step) => step.id).join(" ");
  assert.equal(ids, "s00-setup s01-baseline s02-baseline s03-clip-happy s04-sam-happy s05-washout s06-clip-sad s07-sam-sad s08-stroop s09-gate s10-clip-disgust s11-sam-disgust s12-washout s13-clip-anger s14-sam-anger s15-nback s16-gate s17-clip-surprise s18-sam-surprise s19-washout s20-clip-fear s21-sam-fear s22-conversation s23-gate s24-sweep s25-sweep s26-sweep s27-sweep s28-sweep s29-sweep s30-sweep s31-bodyscan s32-recovery s33-end");
});

test("v9 options add questionnaires, paced breathing, longer exertion, and replay", () => {
  const assignment = protocol.assignFor(1);
  const plan = protocol.buildPlan(assignment);
  const questionnaires = plan.filter((step) => step.type === "questionnaire").map((step) => step.questionnaireId);
  assert.deepEqual(questionnaires, ["panas_pre", "tipi", "nasa_tlx", "nasa_tlx", "panas_post"]);
  assert.ok(plan.findIndex((step) => step.questionnaireId === "tipi") < plan.findIndex((step) => step.type === "baseline"));
  assert.deepEqual(plan.filter((step) => step.breathsPerMin).map((step) => step.breathsPerMin), [6, 10, 15, 20]);
  assert.equal(plan.find((step) => step.safetyKey === "exertion").durationSec, 60);
  assert.equal(plan.filter((step) => step.type === "annotation").length, 0);
  const replay = protocol.buildPlan({ ...assignment, options: { ...assignment.options, annotationReplay: true } });
  assert.deepEqual(replay.filter((step) => step.type === "annotation").map((step) => step.clip), assignment.fullOrder);
  assert.equal(replay.at(-1).type, "end");
});

test("neutral block appears only when a neutral stimulus is assigned", () => {
  const assignment = protocol.assignFor(3);
  assert.equal(protocol.buildPlan(assignment).some((step) => step.clip === "neutral"), false);
  const withNeutral = protocol.buildPlan({ ...assignment, stimuli: { ...assignment.stimuli, neutral: "neutral-1" } });
  const neutral = withNeutral.filter((step) => step.clip === "neutral").map((step) => step.type);
  assert.deepEqual(neutral, ["clip", "sam"]);
  assert.ok(withNeutral.findIndex((step) => step.clip === "neutral") < withNeutral.findIndex((step) => step.clip === assignment.fullOrder[0]));
});
