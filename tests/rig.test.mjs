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

test("a required stream must stay lost for the grace period before the session pauses", () => {
  // Session 01326YVE paused 29 times when its oximeter dropped off USB and came back within seconds.
  const source = readFileSync(new URL("../lib/session-engine.ts", import.meta.url), "utf8");
  const grace = source.match(/export const SENSOR_LOSS_GRACE_MS = ([\d_]+);/);
  assert.ok(grace, "SENSOR_LOSS_GRACE_MS is missing");
  assert.ok(Number(grace[1].replaceAll("_", "")) >= 5_000, "the grace period is too short to ride out a USB replug");
  assert.match(source, /LOST_SENSOR_STATUSES\.has\(sensor\.status\) && \(!sensor\.lostSince \|\| at - Date\.parse\(sensor\.lostSince\) > SENSOR_LOSS_GRACE_MS\)/,
    "enforceLeases no longer waits out the grace period");
  assert.match(source, /sensor\.lostSince = LOST_SENSOR_STATUSES\.has\(status\)/, "heartbeats no longer track when a loss began");
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

test("a participant can finish a gate only after its timer and its BP reading", () => {
  // Session 2303V84Y: the participant saved BP on both gates and then sat on "Please wait" until the operator advanced.
  const source = readFileSync(new URL("../lib/session-engine.ts", import.meta.url), "utf8");
  const done = source.match(/const gateDone = step\?\.type === "gate"[^;]*;/s);
  assert.ok(done, "could not find the gate completion check");
  assert.match(done[0], /durationSec/, "a participant could skip the gate timer");
  assert.match(done[0], /bpRecorded\(current\.bpReadings, step\.id, current\.attempt\)/, "a participant could skip the gate BP reading");
  assert.match(source, /source:fromSubject \? "subject" : "operator", metadata:\{ gate \}/, "a participant's Continue no longer logs the gate outcome");
  const subject = readFileSync(new URL("../app/subject/subject-portal.tsx", import.meta.url), "utf8");
  assert.match(subject, /act\("advance",\{expectedStepId:step\.id,source:"subject"\}\)\);\}\}>Continue<\/button>/);
});

test("the participant's BP entry starts blank so an untouched default cannot be saved", () => {
  // 120/80/70 was saved unchanged twice in 2303V84Y.
  const subject = readFileSync(new URL("../app/subject/subject-portal.tsx", import.meta.url), "utf8");
  for (const field of ["systolic", "diastolic", "pulse"]) assert.match(subject, new RegExp(`\\[${field},set\\w+\\]=useState<number\\|null>\\(null\\)`));
});

test("participant defaults are valid options and leave skin type, age band and sex to the operator", () => {
  for (const [id, value] of Object.entries(rig.PARTICIPANT_DEFAULTS)) {
    const field = rig.PARTICIPANT_FIELDS.find((item) => item.id === id);
    assert.ok(field, `${id} is not a participant field`);
    assert.ok(field.options.includes(value), `${id}: "${value}" is not one of its options`);
  }
  for (const id of ["fitzpatrick", "ageBand", "sex"]) assert.ok(!(id in rig.PARTICIPANT_DEFAULTS), `${id} must not be pre-filled`);
  assert.deepEqual(rig.missingParticipantFields(rig.PARTICIPANT_DEFAULTS).sort(), ["ageBand", "fitzpatrick", "sex"]);
});

test("setup forms have one-click answers and the body scan plays once", () => {
  const console = readFileSync(new URL("../app/instructor/editorial-operator-console.tsx", import.meta.url), "utf8");
  assert.match(console, />MARK ALL YES \(PER SIGNED FORM\)</);
  assert.match(console, />ALL NO</);
  assert.match(console, /const pending = !locked && !saved && missing\.length === 0;/, "pre-filled details would save before the operator sets skin type, age band and sex");
  const subject = readFileSync(new URL("../app/subject/subject-portal.tsx", import.meta.url), "utf8");
  const bodyScan = subject.match(/<ProtocolVideo className="body-scan-video"[^>]*>/);
  assert.ok(bodyScan, "could not find the body scan video");
  assert.doesNotMatch(bodyScan[0], /\sloop[\s=]/, "the body scan loops and repeats its opening words");
});

test("a demo run starts as the open session's participant, so it runs the same tasks", () => {
  // A fixed participant 1 ran N-back in Part 1 while the open session (2304B6HY) had run Stroop.
  const console = readFileSync(new URL("../app/instructor/editorial-operator-console.tsx", import.meta.url), "utf8");
  assert.match(console, /const \[previewPid, setPreviewPid\] = useState\(String\(assignment\.pid\)\);/);
  assert.match(console, /buildPlan\(\{ \.\.\.assignFor\(demoPid\), protocol: template \}\)/, "the task line no longer mirrors how a session is built");
});
