# Meridian Multimodal Research Platform

Meridian is a dual-portal research instrument for controlled multimodal human-subject data collection.

## Product surfaces

- `/subject` presents one neutral activity at a time, with no study labels, sensor information, condition names, or operational detail.
- `/instructor` provides participant assignment, preflight readiness, live protocol progress, recording health, interventions, notes, recovery, configuration, and exports.
- `/api/sessions` is the authoritative session state and event mutation API.
- `/api/media` stores future video, audio, image, and animated stimuli in object storage.

## Protocol integrity

The protocol is defined in `lib/protocol.ts`. It preserves the supplied order and timings:

1. Synchronization check
2. Eyes-open baseline
3. Eyes-closed baseline
4. Three counterbalanced emotion blocks with ratings and interleaved tasks
5. Return-to-baseline gates
6. Seated rest, breathing, breath hold, head motion and speaking, standing, exertion, and recovery
7. Guided body scan
8. Return to normal
9. Completion

Stimuli use the six-row Williams-style sequence. Stroop, N-back, and conversation order is deterministic per participant and supports participant IDs beyond 1000.

## Reliability model

- Cloudflare D1 stores session snapshots and an append-only event ledger.
- Cloudflare R2 stores future media files separately from session records.
- Every response, task completion, operator intervention, sensor state change, note, pause, resume, repeat, and timing transition produces a structured event.
- Session mutations use optimistic revision checks to reduce conflicting writes.
- The instructor can recover a saved session by code without restarting the protocol.

## Local development

Use Node.js 22 or later.

```sh
npm install
npm run dev
```

Run the quality gates with:

```sh
npm run lint
npm test
```

The Sites runtime provides local D1 and R2 bindings from `.openai/hosting.json`.

## Sensor integration

The current sensor panel exposes the integration contract and operational states. Replace manual status updates with authenticated device heartbeat calls that submit channel ID, state, latency, and diagnostic detail. The subject interface does not need to change when real devices are connected.

## Media integration

Use the Configuration section in the instructor portal to upload or assign clips and audio. The subject portal resolves media through the session snapshot and logs onset, offset, completion, and playback failure events.
