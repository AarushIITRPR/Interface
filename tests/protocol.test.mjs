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

test("paced breathing steps carry a floor of six cycles and at least 40 s", () => {
  const plan = protocol.buildPlan(protocol.assignFor(1));
  const paced = plan.filter((step) => step.breathsPerMin);
  assert.deepEqual(paced.map((step) => step.minDurationSec), [60, 40, 40, 40]);
  for (const step of paced) {
    // Six cycles, so an estimate rests on a repeated waveform rather than a fragment of one.
    assert.ok(step.minDurationSec * (step.breathsPerMin / 60) >= 6 - 1e-9, `${step.title} allows under six cycles`);
    // And never so short that the spectrum cannot separate the rates, which sit 4-5/min apart.
    assert.ok(60 / step.minDurationSec <= 1.5, `${step.title} resolves worse than 1.5 breaths/min`);
    assert.ok(step.minDurationSec <= step.durationSec, `${step.title} floor exceeds its planned duration`);
  }
});

const template = await loadTs("../lib/protocol-template.ts");

/** Every combination of the five protocol option booleans. */
function allOptionSets() {
  const keys = Object.keys(protocol.DEFAULT_PROTOCOL_OPTIONS);
  return Array.from({ length: 1 << keys.length }, (_, mask) =>
    Object.fromEntries(keys.map((key, bit) => [key, Boolean(mask & (1 << bit))])));
}

/** The rendered plan carries slotKey and mediaKey, which the hardcoded builder has no notion of. */
const withoutSlotKey = (plan) => plan.map((step) => {
  const copy = { ...step };
  delete copy.slotKey;
  delete copy.mediaKey;
  return copy;
});

test("the default template renders exactly what the hardcoded plan builds", () => {
  let compared = 0;
  for (const pid of [1, 2, 7, 13, 36, 1001]) {
    for (const options of allOptionSets()) {
      const assignment = { ...protocol.assignFor(pid), options };
      const hardcoded = protocol.buildPlan(assignment);
      const rendered = protocol.buildPlan({ ...assignment, protocol: protocol.defaultProtocolTemplate(options, assignment) });
      assert.deepEqual(withoutSlotKey(rendered), [...hardcoded],
        `plan differs for pid ${pid} with ${JSON.stringify(options)}`);
      compared += 1;
    }
  }
  // Every option combination, for every participant: grows by a factor of two with each option added.
  assert.equal(compared, 6 * (1 << Object.keys(protocol.DEFAULT_PROTOCOL_OPTIONS).length));
});

test("the neutral block renders only when the participant has a neutral clip", () => {
  const options = { ...protocol.DEFAULT_PROTOCOL_OPTIONS, neutralClip: true, annotationReplay: true };
  const base = { ...protocol.assignFor(3), options };
  const withNeutral = { ...base, stimuli: { ...base.stimuli, neutral: "neutral-1" } };
  for (const assignment of [base, withNeutral]) {
    const hardcoded = protocol.buildPlan(assignment);
    const rendered = protocol.buildPlan({ ...assignment, protocol: protocol.defaultProtocolTemplate(options, assignment) });
    assert.deepEqual(withoutSlotKey(rendered), [...hardcoded]);
  }
  // And the two differ, so the branch is actually exercised rather than both being empty.
  assert.ok(protocol.buildPlan(withNeutral).length > protocol.buildPlan(base).length);
});

test("every rendered step carries a slot key, and the keys are unique", () => {
  const assignment = protocol.assignFor(5);
  const plan = protocol.buildPlan({ ...assignment, protocol: protocol.defaultProtocolTemplate(assignment.options, assignment) });
  const keys = plan.map((step) => step.slotKey);
  assert.ok(keys.every(Boolean), "a step rendered without a slot key");
  assert.equal(new Set(keys).size, keys.length, "slot keys are not unique");
});

test("step ids keep the existing scheme, so stored events still match a rebuilt plan", () => {
  const assignment = protocol.assignFor(101);
  const plan = protocol.buildPlan(assignment);
  assert.equal(plan[0].id, "s00-setup");
  assert.equal(plan[1].id, "s01-questionnaire-panas_pre");
  assert.ok(plan.every((step, index) => step.id.startsWith(`s${String(index).padStart(2, "0")}-${step.type}`)));
});

test("sanitizeTemplate rejects what would change what the protocol measures", () => {
  const good = protocol.defaultProtocolTemplate();
  const clips = Object.fromEntries(["happy","sad","anger","fear","surprise","disgust"].map((clip) =>
    [clip, { src: `/protocol-media/${clip}.mp4`, durationSec: 100 }]));
  const base = { ...good, clips };
  assert.ok(template.sanitizeTemplate(base).slots.length === good.slots.length);

  const cases = [
    ["no steps", { ...base, slots: [] }, /at least one step/],
    ["duplicate keys", { ...base, slots: [base.slots[0], base.slots[0]] }, /share the key/],
    ["unknown type", { ...base, slots: [{ ...base.slots[0], type: "hypnosis" }] }, /unknown type/],
    ["unknown advance", { ...base, slots: [{ ...base.slots[0], advance: "vibes" }] }, /unknown advance/],
    ["duration under the floor", { ...base, slots: [{ ...base.slots[0], key: "p", type: "sweep", advance: "timer", durationSec: 10, minDurationSec: 40 }] }, /at least 40s/],
    ["clip with no measured duration", { ...base, clips: { ...clips, happy: { src: "/x.mp4" } } }, /no measured duration/],
    ["counterbalanced clip with no media", { ...base, clips: { ...clips, fear: undefined } }, /no media/],
    ["task shorter than its floor", { ...base, tasks: { ...good.tasks, conversation: { ...good.tasks.conversation, durationSec: 5, minDurationSec: 60 } } }, /at least 60s/],
  ];
  for (const [name, payload, pattern] of cases) {
    assert.throws(() => template.sanitizeTemplate(payload), pattern, `accepted ${name}`);
  }
});

test("sanitizeTemplate keeps a template renderable after a round trip", () => {
  const assignment = protocol.assignFor(9);
  const original = protocol.defaultProtocolTemplate(assignment.options, assignment);
  const cleaned = template.sanitizeTemplate(JSON.parse(JSON.stringify(original)), original);
  const before = protocol.buildPlan({ ...assignment, protocol: original });
  const after = protocol.buildPlan({ ...assignment, protocol: cleaned });
  assert.deepEqual(after.map((s) => [s.id, s.durationSec, s.estimatedSec]), before.map((s) => [s.id, s.durationSec, s.estimatedSec]));
  assert.equal(cleaned.version, original.version + 1);
});

test("a retimed template moves the plan and nothing else", () => {
  const assignment = protocol.assignFor(4);
  const original = protocol.defaultProtocolTemplate(assignment.options, assignment);
  const edited = template.sanitizeTemplate({
    ...original,
    slots: original.slots.map((slot) => slot.key === "baseline-eyes-open" ? { ...slot, durationSec: 300, estimatedSec: 300 } : slot),
  }, original);
  const plan = protocol.buildPlan({ ...assignment, protocol: edited });
  const baseline = plan.find((step) => step.slotKey === "baseline-eyes-open");
  assert.equal(baseline.durationSec, 300);
  assert.equal(plan.length, protocol.buildPlan({ ...assignment, protocol: original }).length);
  // The emotion order is still the participant's, not the template's.
  assert.deepEqual(plan.filter((s) => s.type === "clip").map((s) => s.clip), assignment.fullOrder);
});

test("a template clip replaces its registry source instead of preloading both", () => {
  const assignment = protocol.assignFor(903);
  const base = protocol.defaultProtocolTemplate(assignment.options, assignment);
  const swapped = {
    ...base,
    clips: { ...base.clips, anger: { src: "/protocol-media/anger-2.mp4", durationSec: 138.3 } },
  };
  const plan = protocol.buildPlan({ ...assignment, protocol: swapped });
  const angerClip = plan.find((step) => step.type === "clip" && step.clip === "anger");
  // The step takes its length from the replacement, not from the registry entry it supersedes.
  assert.equal(angerClip.estimatedSec, 143.3);
  assert.notEqual(swapped.clips.anger.src, base.clips.anger.src);
  // And the untouched clips keep their registry durations.
  const happyClip = plan.find((step) => step.type === "clip" && step.clip === "happy");
  assert.equal(happyClip.estimatedSec, base.clips.happy.durationSec + 5);
});

test("the word list is one step, on by default, followed by the read-aloud passage", () => {
  const plan = protocol.buildPlan(protocol.assignFor(1));
  const wordLists = plan.filter((step) => step.type === "wordlist");
  assert.equal(wordLists.length, 1, "exactly one word list step, with no later check");
  const at = plan.indexOf(wordLists[0]);
  assert.equal(plan[at + 1].title, "Read aloud");
  assert.equal(plan[at + 2].title, "Settle before physiological sweep");
  assert.equal(wordLists[0].title, "Word list: study and recognise");
  assert.equal(wordLists[0].estimatedSec, 65);
  // Sessions stored before the option existed keep their plan.
  const { wordList, ...older } = protocol.DEFAULT_PROTOCOL_OPTIONS;
  assert.equal(wordList, true);
  const olderPlan = protocol.buildPlan({ ...protocol.assignFor(1), options: older });
  assert.ok(!olderPlan.some((step) => step.type === "wordlist"));
});

test("each participant gets the list their counterbalancing rows select", () => {
  const a = protocol.assignFor(1);
  assert.equal(a.wordList, 0);
  assert.equal(protocol.wordListFor(a)[0], "apple", "participant 1 studies the prototype's list");
  // Participant 7 is emotion row 1, task row 2: list 2.
  assert.equal(protocol.assignFor(7).wordList, 1);
  // An older session without the field derives the same list.
  const older = { ...protocol.assignFor(7) };
  delete older.wordList;
  assert.equal(protocol.wordListIndexFor(older), 1);
});


test("saving always advances the version, whatever version the draft carries", () => {
  const active = { ...protocol.defaultProtocolTemplate(), version: 1 };
  // The builder sends back the template it loaded, so the draft still says version 1.
  const saved = template.sanitizeTemplate({ ...active, version: 1 }, active);
  assert.equal(saved.version, 2);
  assert.equal(template.sanitizeTemplate({ ...active, version: 99 }, { ...active, version: 5 }).version, 6);
  // A preview has no previous version to advance from, so it keeps the draft's.
  assert.equal(template.sanitizeTemplate({ ...active, version: 3 }).version, 3);
});

test("every participant reads the same passage aloud, on a step they end themselves", () => {
  const plan = protocol.buildPlan(protocol.assignFor(1));
  const reading = plan.filter((step) => step.type === "reading");
  assert.equal(reading.length, 1);
  assert.equal(reading[0].advance, "subject", "the subject ends it, so a slow reader is never cut off");
  assert.equal(reading[0].phase, "Part 3");
  // Task order changes per participant; the passage step does not.
  for (const pid of [1, 7, 13, 19, 25, 31]) {
    const other = protocol.buildPlan(protocol.assignFor(pid)).filter((step) => step.type === "reading");
    assert.equal(other.length, 1, `participant ${pid} reads the passage`);
  }
  // Sessions stored before the option existed keep their plan.
  const { reading: flag, ...older } = protocol.DEFAULT_PROTOCOL_OPTIONS;
  assert.equal(flag, true);
  assert.ok(!protocol.buildPlan({ ...protocol.assignFor(1), options: older }).some((step) => step.type === "reading"));
});

test("box breathing is a silent on-screen pacer of whole rounds", () => {
  const plan = protocol.buildPlan(protocol.assignFor(1));
  const box = plan.find((step) => step.title === "Box breathing");
  assert.equal(box.durationSec, 64);
  assert.equal(box.durationSec % 16, 0, "whole rounds of in, hold, out, hold");
  assert.equal(box.mediaKey, undefined, "no background video, so no soundtrack either");
});
