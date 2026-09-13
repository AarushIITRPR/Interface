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
