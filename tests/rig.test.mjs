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
