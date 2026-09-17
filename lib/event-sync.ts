/**
 * Incremental event delivery for the instructor console.
 *
 * The console polls every 1.8 s. It used to receive the whole event log each time: 232 KB per request for a finished
 * session, 92% of it events it already had. Now it says which events it holds and receives only newer ones.
 *
 * This is safe because an event's `sequence` is assigned once, from the log's length, and events are never removed or
 * reordered, so "everything up to N" means the same thing on the server and in every client.
 */
import type { SessionSnapshot } from "./types";

/** A snapshot carrying only events after `eventsSince`. The rest are the ones the client already holds. */
export type PartialSnapshot = SessionSnapshot & { eventsSince?: number };

/** The highest event sequence in a snapshot, or 0 when it has none. */
export function latestSequence(snapshot: Pick<SessionSnapshot, "events"> | null | undefined): number {
  const events = snapshot?.events ?? [];
  return events.length ? events[events.length - 1].sequence : 0;
}

/** Parse a client's `since` value. Anything that isn't a non-negative integer means "send everything". */
export function parseSince(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

/** Server side: drop the events the client says it already has. */
export function trimEvents(snapshot: SessionSnapshot, since: number | null): PartialSnapshot {
  if (since === null) return snapshot;
  return { ...snapshot, events: snapshot.events.filter((event) => event.sequence > since), eventsSince: since };
}

/**
 * Client side: rebuild the full snapshot from the one held and a reply.
 *
 * Only call this for a reply already judged newer than `current`. A stale reply must be discarded, not merged,
 * otherwise its older fields would be grafted onto newer state.
 */
export function mergeEvents(current: SessionSnapshot | null, next: PartialSnapshot): SessionSnapshot {
  const { eventsSince, ...full } = next;
  if (eventsSince === undefined) return full;
  if (!current || current.code !== next.code) {
    throw new Error("A partial event list cannot be applied without the events before it.");
  }
  const kept = current.events.filter((event) => event.sequence <= eventsSince);
  const seen = new Set(kept.map((event) => event.sequence));
  const events = [...kept, ...next.events.filter((event) => !seen.has(event.sequence))].sort((a, b) => a.sequence - b.sequence);
  return { ...full, events };
}

/** Whether a reply reflects a later state than the one shown: a higher revision, or the same revision read later. */
export function isNewerSnapshot(next: Pick<SessionSnapshot, "revision" | "serverTime">, current: Pick<SessionSnapshot, "revision" | "serverTime">) {
  if (next.revision !== current.revision) return next.revision > current.revision;
  return Date.parse(next.serverTime ?? "") >= Date.parse(current.serverTime ?? "");
}

/**
 * What the console should show after a reply: the merged snapshot, or the current one unchanged when the reply is
 * stale or cannot be applied. Replies overtake each other, so a slow one must never roll the view back.
 */
export function applyReply(current: SessionSnapshot | null, next: PartialSnapshot): SessionSnapshot | null {
  const sameSession = current !== null && current.code === next.code;
  if (sameSession && !isNewerSnapshot(next, current)) return current;
  if (next.eventsSince !== undefined && !sameSession) return current;
  return mergeEvents(sameSession ? current : null, next);
}
