import assert from "node:assert/strict";
import test from "node:test";
import { loadTs } from "./load-ts.mjs";

const sync = await loadTs("../lib/event-sync.ts");

const event = (sequence) => ({ id: `ev${sequence}`, sequence, eventType: "step_start", stepId: "s00", label: "", detail: "", createdAt: "", attempt: 1, metadata: {} });
const snapshot = (revision, count, code = "0001TEST") => ({ code, revision, serverTime: `2026-09-17T00:00:${String(revision).padStart(2, "0")}Z`, events: Array.from({ length: count }, (_, i) => event(i + 1)) });

test("the server sends only events after the client's position", () => {
  const trimmed = sync.trimEvents(snapshot(5, 10), 7);
  assert.deepEqual(trimmed.events.map((e) => e.sequence), [8, 9, 10]);
  assert.equal(trimmed.eventsSince, 7);
  // No position means the whole log, unmarked.
  const full = sync.trimEvents(snapshot(5, 10), null);
  assert.equal(full.events.length, 10);
  assert.equal(full.eventsSince, undefined);
});

test("merging a partial reply reproduces the full log", () => {
  const held = snapshot(5, 10);
  const server = snapshot(6, 13);
  const merged = sync.mergeEvents(held, sync.trimEvents(server, sync.latestSequence(held)));
  assert.deepEqual(merged, server, "merged state equals what a full fetch would have returned");
  assert.equal("eventsSince" in merged, false);
});

test("a reply trimmed at an older position still merges correctly", () => {
  // Request sent while holding 1-6; by the time it returns the console holds 1-10 from another reply.
  const held = snapshot(6, 10);
  const server = snapshot(7, 12);
  const merged = sync.mergeEvents(held, sync.trimEvents(server, 6));
  assert.deepEqual(merged.events.map((e) => e.sequence), Array.from({ length: 12 }, (_, i) => i + 1));
});

test("a partial reply cannot be applied without the events before it", () => {
  assert.throws(() => sync.mergeEvents(null, sync.trimEvents(snapshot(5, 10), 3)), /cannot be applied/);
  assert.throws(() => sync.mergeEvents(snapshot(5, 3, "OTHER"), sync.trimEvents(snapshot(5, 10), 3)), /cannot be applied/);
  // A full reply always applies.
  assert.equal(sync.mergeEvents(null, snapshot(5, 10)).events.length, 10);
});

test("since values that are not a non-negative integer mean a full reply", () => {
  for (const value of [null, undefined, "", "-1", "1.5", "abc", -3]) assert.equal(sync.parseSince(value), null, String(value));
  assert.equal(sync.parseSince("0"), 0);
  assert.equal(sync.parseSince("42"), 42);
});

test("a stale reply never rolls the view back", () => {
  const shown = snapshot(8, 12);
  const stale = sync.trimEvents(snapshot(7, 11), 5);
  assert.equal(sync.applyReply(shown, stale), shown, "an older revision is ignored");
  const newer = sync.trimEvents(snapshot(9, 14), 12);
  assert.equal(sync.applyReply(shown, newer).events.length, 14);
  // Same revision read later is accepted; read earlier is not.
  const sameLater = { ...snapshot(8, 12), serverTime: "2026-09-17T00:01:00Z" };
  assert.notEqual(sync.applyReply(shown, sameLater), shown);
  const sameEarlier = { ...snapshot(8, 12), serverTime: "2026-09-16T23:59:00Z" };
  assert.equal(sync.applyReply(shown, sameEarlier), shown);
  // A partial reply for a different session is never applied.
  assert.equal(sync.applyReply(shown, sync.trimEvents(snapshot(9, 14, "OTHER"), 3)), shown);
  // Nothing shown yet: only a full reply can be.
  assert.equal(sync.applyReply(null, sync.trimEvents(snapshot(9, 14), 3)), null);
  assert.equal(sync.applyReply(null, snapshot(9, 14)).events.length, 14);
});
