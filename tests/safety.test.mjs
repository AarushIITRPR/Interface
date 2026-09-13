import assert from "node:assert/strict";
import test from "node:test";
import { loadTs } from "./load-ts.mjs";

const safety = await loadTs("../lib/safety.ts");
const protocol = await loadTs("../lib/protocol.ts");

test("screening maps answers to skipped physical steps", () => {
  const none = Object.fromEntries(safety.SCREENING_QUESTIONS.map((item) => [item.id, false]));
  assert.equal(safety.screeningComplete(none), true);
  assert.equal(safety.screeningComplete({ cardiac: false }), false);
  assert.deepEqual(safety.skippedSafetySteps(none), {});
  assert.deepEqual(safety.skippedSafetySteps({ ...none, fainting: true, respiratory: true }), { breath_hold: ["respiratory"], exertion: ["respiratory"], standing: ["fainting"] });
});

test("every screening skip key exists in the protocol", () => {
  const keys = new Set(protocol.buildPlan(protocol.assignFor(1)).map((step) => step.safetyKey).filter(Boolean));
  for (const item of safety.SCREENING_QUESTIONS) for (const key of item.skips) assert.ok(keys.has(key), key);
});

test("gate needs physiology within baseline tolerance for the hold time", () => {
  let physiology;
  const start = 1_000_000;
  for (let i = 0; i < 60; i++) physiology = safety.updatePhysiology(physiology, { t: start + i * 1000, hr: 70 + (i % 3), gsr: 3 + (i % 2) * 0.1 }, true);
  assert.equal(physiology.baseline.hr.n, 60);

  const gateStart = start + 200_000;
  // Elevated heart rate at first, then back near baseline.
  for (let i = 0; i < 10; i++) physiology = safety.updatePhysiology(physiology, { t: gateStart + i * 1000, hr: 95, gsr: 3.05 }, false);
  let status = safety.evaluateGate(physiology, gateStart + 9_000, gateStart);
  assert.equal(status.status, "not_ready");
  assert.equal(status.signals.find((signal) => signal.id === "hr").within, false);

  for (let i = 10; i < 30; i++) physiology = safety.updatePhysiology(physiology, { t: gateStart + i * 1000, hr: 71, gsr: 3.05 }, false);
  status = safety.evaluateGate(physiology, gateStart + 29_000, gateStart);
  assert.equal(status.status, "ready");
  assert.ok(status.signals.every((signal) => signal.heldSec >= 15));
});

test("gate hold only counts time inside the gate step", () => {
  let physiology;
  for (let i = 0; i < 60; i++) physiology = safety.updatePhysiology(physiology, { t: i * 1000, hr: 70, gsr: null }, true);
  const early = safety.evaluateGate(physiology, 59_000, 50_000);
  assert.equal(early.status, "not_ready");
  assert.equal(early.signals[0].heldSec, 9);
});

test("gate is unavailable without enough baseline and stale when samples stop", () => {
  assert.equal(safety.evaluateGate(undefined, 0).status, "unavailable");
  let physiology;
  for (let i = 0; i < 40; i++) physiology = safety.updatePhysiology(physiology, { t: i * 1000, hr: 70, gsr: null }, true);
  const stale = safety.evaluateGate(physiology, 120_000);
  assert.equal(stale.status, "not_ready");
  assert.equal(stale.signals[0].current, null);
});
