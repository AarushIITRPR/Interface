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
- A subject tab attached to an ended session automatically follows the newest session prepared for the same participant. Participant IDs can also be entered directly on the subject connection screen while that session is still in setup; once the protocol starts, the subject display must use the session code.
- Subject requests can only complete steps the subject controls: ratings on rating steps, tasks on task steps, clips, and timers that have actually elapsed on the server. Gates and operator checks can only be advanced from the instructor console.
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

All registered stimuli are normalized with `scripts/normalize-media.sh`: H.264 1280x720 (aspect preserved with black bars), 30 fps constant, faststart, and AAC 48 kHz stereo at -23 LUFS integrated (EBU R128, true peak at most -2 dBTP). Clip content and duration are unchanged (happy 93 s, fear 95 s, sad 148 s, anger 151 s, disgust 151 s, surprise 183 s), so duration should be kept as a covariate. Replacement media should go through the same script.

The subject display downloads every stimulus before the protocol starts and plays from memory; Start is blocked until loading finishes. Clip onset is logged when the video actually starts playing, with the display's server-corrected time and the load delay. Pauses pause the video in place and are logged with the media time. Every step also logs `step_displayed` when it appears on screen.

## Protocol v8 design

- **Counterbalancing:** emotion order follows the six-row Williams square by participant; task order (Stroop, N-back, conversation) cycles through its six permutations every sixth participant, so all 36 pairings balance across 36 participants.
- **Ratings after each clip:** 9-point SAM valence, arousal, and dominance, then the main felt emotion (six emotions or neutral) with 9-point intensity, then whether the clip was seen before.
- **Stroop:** 30 seeded trials, 15 congruent and 15 incongruent, congruency runs of at most 3, 400 ms fixation, 2 s deadline; per-trial data and congruent/incongruent RT with interference.
- **N-back:** 8-trial practice with feedback, then 20 scored trials with exactly 30% targets and no accidental matches; per-trial outcomes and d'. The level locks when practice starts.
- **Safety screening (`lib/safety.ts`):** six yes/no questions must be answered in Recording setup before starting. A yes skips the mapped physical steps (breath hold, standing, exertion), logged as `step_skipped`. Breath hold stops automatically at 60 s. The questions are study defaults for the research team to review.
- **Return-to-baseline gate:** heart rate and skin conductance recorded during the resting baselines define the reference. A gate is ready when each signal stays within max(2 SD, 5 bpm / 10%) of baseline for 15 s. Advancing earlier requires an override reason; outcomes are logged as `gate_verified`, `gate_override`, or `gate_unverified`.
- **Automatic pause:** while running, losing the instructor console or a required stream pauses the session with `operator_lost` or `sensor_lost`.
- **Photodiode sync:** assigning a photodiode port shows a 56 px screen-corner patch that flashes on clip start, clip end, and each step. The agent records the photodiode and the export reports the measured display latency for every flash.

## Analysis bundle

When a session ends (or with `python -m meridian_agent --code CODE --token TOKEN --export-to RECORDING_DIR`), the agent writes `export/` next to the raw recordings: `events.tsv`, `steps.tsv`, `ratings.tsv`, `tasks.tsv`, `stroop_trials.tsv`, `nback_trials.tsv`, `sync_check.tsv` (with a photodiode), `session.json`, and `qa_report.json` / `qa_report.md`. Onsets are on the acquisition host clock, matching the `host_epoch_ns` column of every sensor CSV. The QA report flags per-step coverage gaps in required streams, pauses, interrupted or restarted stimuli, repeats, timer steps that ran long or short, skipped steps, and gate outcomes.
