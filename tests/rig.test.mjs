import assert from "node:assert/strict";
import test from "node:test";
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
