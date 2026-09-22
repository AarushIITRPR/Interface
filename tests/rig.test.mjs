import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { loadTs } from "./load-ts.mjs";

const rig = await loadTs("../lib/rig.ts");
const now = Date.parse("2026-01-01T00:00:10Z");
const sensor = (id, metrics, updatedAt = "2026-01-01T00:00:09Z", dataDetected = true) => ({ id, metrics, updatedAt, dataDetected });

test("heart rate agreement compares fresh contact and contactless sources", () => {
  const agree = rig.heartRateAgreement([sensor("ecg", { heartRate: 72 }), sensor("oximeter", { heartRate: 74, fingerDetected: true }), sensor("face", { rppgHeartRate: 70, rppgQuality: 0.5 })], now);
  assert.equal(agree.status, "agree");
  assert.equal(agree.spreadBpm, 4);
  assert.deepEqual(agree.sources.map((source) => source.id), ["ecg", "oximeter", "face"]);

  const disagree = rig.heartRateAgreement([sensor("ecg", { heartRate: 72 }), sensor("oximeter", { heartRate: 95 })], now);
  assert.equal(disagree.status, "disagree");

  const filtered = rig.heartRateAgreement([
    sensor("ecg", { heartRate: 72 }, "2025-12-31T23:59:50Z"),
    sensor("oximeter", { heartRate: 74, fingerDetected: false }),
    sensor("face", { rppgHeartRate: 71, rppgQuality: 0.1 }),
  ], now);
  assert.equal(filtered.status, "insufficient");
  assert.equal(filtered.sources.length, 0);
});

test("metadata sanitizing keeps only known categories and clamps numbers", () => {
  const values = rig.sanitizeFields(rig.PARTICIPANT_FIELDS, { fitzpatrick: "V", sex: "Robot", cameraDistanceCm: "5", name: "Alice" });
  assert.deepEqual(values, { fitzpatrick: "V", cameraDistanceCm: 20 });
  assert.ok(rig.missingParticipantFields(values).includes("sex"));
  assert.ok(!rig.missingParticipantFields(values).includes("fitzpatrick"));
});

test("open artifact spans follow start and end events", () => {
  const events = [
    { eventType: "artifact", metadata: { type: "talking", kind: "start" } },
    { eventType: "artifact", metadata: { type: "cough", kind: "point" } },
    { eventType: "artifact", metadata: { type: "left_seat", kind: "start" } },
    { eventType: "artifact", metadata: { type: "talking", kind: "end" } },
  ];
  assert.deepEqual([...rig.openArtifactSpans(events)], ["left_seat"]);
  assert.equal(new Set(rig.ARTIFACT_TYPES.map((type) => type.key)).size, rig.ARTIFACT_TYPES.length);
});

test("consent needs only participation; unanswered sharing defaults to No", () => {
  assert.equal(rig.consentReady({ participation: "Yes" }), true);
  assert.equal(rig.consentReady({ participation: "No", shareAudio: "Yes" }), false);
  const filled = rig.withConsentDefaults({ participation: "Yes", shareFaceVideo: "Yes" });
  assert.equal(filled.shareFaceVideo, "Yes");
  assert.equal(filled.shareAudio, "No");
  assert.equal(rig.CONSENT_FIELDS.filter((field) => field.required).map((field) => field.id).join(), "participation");
});

test("only camera-relevant participant details are required", () => {
  assert.deepEqual(rig.missingParticipantFields({}), ["fitzpatrick", "ageBand", "sex", "eyewear"]);
});

test("start checks name every reason recording cannot start", () => {
  const at = Date.parse("2026-09-15T12:00:00Z");
  const fresh = "2026-09-15T11:59:58Z";
  const sensor = (id, label, quality = "good") => ({ id, label, quality, dataDetected: true, updatedAt: fresh });
  const snapshot = {
    hardwareGateOverride: false, consent: null, screening: null,
    requiredSensors: ["face", "ecg", "thermal"], deviceConfig: { face: "/dev/v4l/by-id/cam", ecg: "https://liveecg.frontierxapp.com/1/x", thermal: "none" },
    sensors: [sensor("face", "Face camera"), sensor("ecg", "ECG", "waiting"), sensor("thermal", "Thermal camera")],
    acquisition: { lastSeenAt: fresh }, preflightTest: { status: "fail", detail: "Check: ecg" }, subjectMedia: null,
  };
  const failing = Object.fromEntries(rig.startChecks(snapshot, at).filter((check) => !check.ok).map((check) => [check.id, check.detail]));
  assert.deepEqual(Object.keys(failing), ["consent", "screening", "assigned", "streaming", "preflight", "subject"]);
  assert.match(failing.assigned, /Thermal camera/);
  assert.match(failing.streaming, /ECG/);
  assert.doesNotMatch(failing.streaming, /Face camera/);
  const ready = { ...snapshot, requiredSensors: ["face"], consent: { values: { participation: "Yes" } }, preflightTest: { status: "pass", detail: "" },
    screening: { answers: { cardiac: false, respiratory: false, fainting: false, mobility: false, pregnancy: false, unwell: false } }, subjectMedia: { ready: true, loaded: 8, total: 8 } };
  assert.ok(rig.startChecks(ready, at).every((check) => check.ok));
});

test("a result from before the current preflight started cannot end it", () => {
  const running = { status: "running", startedAt: "2026-09-15T00:30:00.000Z" };
  assert.equal(rig.stalePreflightReport(running, "fail", "2026-09-15T00:20:23.905533Z"), true);
  assert.equal(rig.stalePreflightReport(running, "idle", null), true);
  assert.equal(rig.stalePreflightReport(running, "running", null), false);
  assert.equal(rig.stalePreflightReport(running, "pass", "2026-09-15T00:30:11.000Z"), false);
  assert.equal(rig.stalePreflightReport({ status: "fail", startedAt: null }, "pass", "2026-09-15T00:40:00Z"), false);
});

test("a demo run starts with nothing attached and says so", () => {
  const at = Date.parse("2026-09-15T12:00:00Z");
  // Everything a real session needs is missing: no agent, no devices, no preflight, no consent, no screening.
  const snapshot = {
    demo: true, hardwareGateOverride: false, consent: null, screening: null,
    requiredSensors: ["face", "ecg", "thermal"], deviceConfig: {}, sensors: [],
    acquisition: { lastSeenAt: null }, preflightTest: { status: "idle", detail: "Not run" }, subjectMedia: null,
  };
  const checks = rig.startChecks(snapshot, at);
  assert.equal(checks.length, 1);
  assert.equal(checks[0].id, "demo");
  assert.ok(checks[0].ok, "a demo run must not be blocked by hardware it does not have");
  assert.match(checks[0].detail, /cohort/);
  // The same snapshot without the flag is blocked on every count.
  const real = rig.startChecks({ ...snapshot, demo: false }, at).filter((check) => !check.ok);
  assert.deepEqual(real.map((check) => check.id), ["consent", "screening", "agent", "assigned", "streaming", "preflight", "subject"]);
});

test("the demo flag covers the same ground the hardware override does", () => {
  // enforceLeases in lib/session-engine.ts pauses a running session when the agent goes quiet, and only skips
  // that for hardwareGateOverride. A demo has no agent by design, so it has to be exempt too or the walkthrough
  // pauses itself every few seconds with "Recording lost: acquisition agent".
  const source = readFileSync(new URL("../lib/session-engine.ts", import.meta.url), "utf8");
  const guard = source.match(/if \(![^)]*recordingFor > SENSOR_START_GRACE_MS\) \{/);
  assert.ok(guard, "could not find the sensor-lease guard");
  assert.match(guard[0], /snapshot\.demo/, "the sensor-lease guard does not exempt demo runs");
  assert.match(guard[0], /snapshot\.hardwareGateOverride/);
});

test("the BP cuff is a span artifact that opens and closes like any other", () => {
  assert.equal(rig.BP_CUFF_ARTIFACT, "bp_cuff");
  const type = rig.ARTIFACT_TYPES.find((item) => item.id === rig.BP_CUFF_ARTIFACT);
  assert.equal(type?.kind, "span");
  const start = { eventType: "artifact", metadata: { type: "bp_cuff", kind: "start" } };
  const end = { eventType: "artifact", metadata: { type: "bp_cuff", kind: "end" } };
  assert.ok(rig.openArtifactSpans([start]).has("bp_cuff"));
  assert.ok(!rig.openArtifactSpans([start, end]).has("bp_cuff"));
});

test("blood pressure readings are rounded, range-checked, and need systolic above diastolic", () => {
  assert.deepEqual(rig.sanitizeBp({ systolic: 120.4, diastolic: "80", pulse: 70 }), { ok: true, systolic: 120, diastolic: 80, pulse: 70 });
  assert.deepEqual(rig.sanitizeBp({ systolic: 118, diastolic: 76, pulse: "" }), { ok: true, systolic: 118, diastolic: 76, pulse: null });
  assert.deepEqual(rig.sanitizeBp({ systolic: 118, diastolic: 76 }), { ok: true, systolic: 118, diastolic: 76, pulse: null });
  assert.equal(rig.sanitizeBp({ systolic: 80, diastolic: 80 }).ok, false);
  assert.equal(rig.sanitizeBp({ systolic: 300, diastolic: 80 }).ok, false);
  assert.equal(rig.sanitizeBp({ systolic: 120, diastolic: 20 }).ok, false);
  assert.equal(rig.sanitizeBp({ systolic: 120, diastolic: 80, pulse: 250 }).ok, false);
  assert.equal(rig.sanitizeBp({ systolic: "abc", diastolic: 80 }).ok, false);
  assert.equal(rig.sanitizeBp({ diastolic: 80 }).ok, false);
  assert.equal(rig.BP_LIMITS.systolic.start, 120);
  assert.equal(rig.BP_LIMITS.diastolic.start, 80);
});

test("a blood pressure step counts as recorded only for the current attempt", () => {
  const readings = [{ stepId: "gate-1", attempt: 1 }, { stepId: "baseline" }];
  assert.ok(rig.bpRecorded(readings, "gate-1", 1));
  assert.ok(!rig.bpRecorded(readings, "gate-1", 2));
  assert.ok(rig.bpRecorded(readings, "baseline", 1), "readings saved before attempts were stored count as the first attempt");
  assert.ok(!rig.bpRecorded(readings, "standing", 1));
});
