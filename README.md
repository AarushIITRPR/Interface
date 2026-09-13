# Meridian Multimodal Research Platform

Meridian is a dual-portal research instrument for controlled multimodal human-subject data collection.

## Product surfaces

- `/subject` presents one neutral activity at a time, with no study labels, sensor information, condition names, or operational detail.
- `/instructor` provides participant assignment, preflight readiness, live protocol progress, recording health, interventions, notes, recovery, configuration, and exports.
- `/api/sessions` is the authoritative session state and event mutation API.
- `/api/acquisition` is the token-authenticated command and telemetry channel for the local recording agent.
- `/api/media` stores uploaded video, audio, image, and animated stimuli in object storage.

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
- Both portals reject stale polling responses so a slower heartbeat cannot roll the UI back to an older task revision.
- A subject tab attached to an ended session automatically follows the newest active session for the same participant. Participant IDs can also be entered directly on the subject connection screen.
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

The agent receives hardware assignments, session changes, and task markers from Meridian. It writes raw high-rate data locally and submits only low-bandwidth metrics, downsampled rolling windows, and loopback camera previews. In Setup, the instructor selects devices and verifies hardware detection, protocol-valid data, signal quality, storage, synchronization, and a 10-second test. Configuration locks when recording begins. Monitor prioritizes the subject camera, expandable signals, actionable warnings, and an always-visible recording-health strip. Review reports rate, loss, gaps, availability, file size, and capture coverage for each finalized stream. The subject remains on the waiting screen until the instructor completes preflight and starts the protocol.

See `acquisition_agent/README.md` for installation, device configuration, Linux and Windows notes, and simulated verification.

## Media integration

The registered protocol media is stored in `public/protocol-media`. New and restored sessions receive the six emotion clips, the guided body-scan video, and the relaxing nature video used behind the box-breathing pacer by default. The neutral washout remains an unlabelled grey fixation screen so it does not introduce another affective stimulus.

The subject portal resolves media through the session snapshot and logs emotion-clip onset, offset, completion, and playback failure events. Instructor-supplied media can still replace any default through the existing session media configuration.
