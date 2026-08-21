# Meridian Multimodal Research Platform

Meridian is a dual-portal research instrument for controlled multimodal human-subject data collection.

## Product surfaces

- `/subject` presents one neutral activity at a time, with no study labels, sensor information, condition names, or operational detail.
- `/instructor` provides participant assignment, preflight readiness, live protocol progress, recording health, interventions, notes, recovery, configuration, and exports.
- `/api/sessions` is the authoritative session state and event mutation API.
- `/api/acquisition` is the token-authenticated command and telemetry channel for the local recording agent.
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

The `acquisition_agent` directory contains the local hardware service adapted from the supplied Dataset Sync, CSI HR C5, and EMG Checker projects. It records camera, microphone, CMS50E oximeter, ESP32 WiFi CSI, ESP32 EMG, ESP32 GSR, configured ECG serial, and thermal camera streams on the computer connected to the subject.

The agent receives session and task changes from Meridian, writes common-clock markers, keeps raw high-rate data local, and submits low-bandwidth health reports. The instructor sees device state, sample rate, sample count, latest values, disconnects, recording paths, and finalized file manifests. The subject remains on the waiting screen until the selected required sensors are receiving samples.

See `acquisition_agent/README.md` for installation, device configuration, Linux and Windows notes, and simulated verification.

## Media integration

Use the Configuration section in the instructor portal to upload or assign clips and audio. The subject portal resolves media through the session snapshot and logs onset, offset, completion, and playback failure events.
