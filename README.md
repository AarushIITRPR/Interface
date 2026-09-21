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

Every participant sees the clips in one fixed order, calmest first and heart-rate-raising last: surprise, disgust, happy, sad, fear, anger (ranked by mean heart-rate change in Siegel et al. 2018). Stroop and N-back swap between Part 1 and Part 3 every six participants; the order is deterministic per participant and supports participant IDs beyond 1000.

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

- **Clip order and counterbalancing:** since 21 Sep 2026 the emotion order is fixed for everyone (surprise, disgust, happy, sad, fear, anger), graded from the smallest to the largest mean heart-rate rise; sessions created earlier keep the Williams-square order they were assigned. Stroop and N-back alternate between Parts 1 and 3 every sixth participant; the conversation is no longer run.
- **Ratings after each clip:** 9-point SAM valence, arousal, and dominance, then the main felt emotion (six emotions or neutral) with 9-point intensity, then whether the clip was seen before.
- **Stroop:** 30 seeded trials, 15 congruent and 15 incongruent, congruency runs of at most 3, 400 ms fixation, 2 s deadline; per-trial data and congruent/incongruent RT with interference.
- **N-back:** 8-trial practice with feedback, then 20 scored trials with exactly 30% targets and no accidental matches; per-trial outcomes and d'. The level locks when practice starts.
- **Safety screening (`lib/safety.ts`):** six yes/no questions must be answered in Recording setup before starting. A yes skips the mapped physical steps (breath hold, standing, exertion), logged as `step_skipped`. Breath hold stops automatically at 60 s. The questions are study defaults for the research team to review.
- **Return-to-baseline gate:** heart rate and skin conductance recorded during the resting baselines define the reference. A gate is ready when each signal stays within max(2 SD, 5 bpm / 10%) of baseline for 15 s. Advancing earlier requires an override reason; outcomes are logged as `gate_verified`, `gate_override`, or `gate_unverified`.
- **Automatic pause:** while running, losing the instructor console or a required stream pauses the session with `operator_lost` or `sensor_lost`.
- **Photodiode sync:** assigning a photodiode port shows a 56 px screen-corner patch that flashes on clip start, clip end, and each step. The agent records the photodiode and the export reports the measured display latency for every flash.

## Dataset rig features

- **Participant details** (Recording setup): categorical descriptors that affect contactless sensing, including Fitzpatrick skin type, age band, sex, eyewear, facial hair, makeup, recent caffeine, nicotine, or exercise, heart-rate medication, and camera distances. No names or dates. Exported as BIDS-style `participants.tsv` and `participants.json`.
- **Artifact labels**: buttons in the Overview and keyboard shortcuts in every tab while the protocol runs. T talking, L left seat, and O operator in view toggle on and off; C cough, M movement, D door or other person, and P phone mark the 3 seconds before the press to 1 second after. Exported as `artifacts.tsv`; the QA report lists artifact seconds per step.
- **WiFi CSI setup**: channel, bandwidth, packet rate, and transmitter/receiver geometry, plus a 60-second empty-room baseline recorded during setup. A second CSI receiver is supported.
- **Heart rate agreement**: live comparison of ECG, pulse oximeter, and a face-video rPPG estimate, with a warning when they differ by more than 8 bpm.
- **Lossless face video, locked camera settings, radiometric thermal, respiration belt, and room environment sensor**: see `acquisition_agent/README.md`.

## Protocol v9 options and dataset tools

Chosen per session in Recording setup and fixed once recording starts (sessions created before v9 keep their original plan):

- **Questionnaires** (`lib/questionnaires.ts`): PANAS at the start and end, TIPI at the start (before the resting baselines), and raw NASA-TLX after the Stroop and N-back tasks. Only instruments usable without licence fees are included; confirm the terms for your institution. Exported as `questionnaire_items.tsv` and `questionnaire_scores.tsv`.
- **Paced breathing**: 60 seconds each at 6, 10, 15, and 20 breaths per minute, a reference for breathing-rate estimation from video, thermal, and CSI. **Longer exertion** runs 60 seconds instead of 20.
- **Stimulus registry** (`lib/stimuli.ts`): register alternative clips per emotion and a neutral control clip. Each session stores its assigned exemplars, rotated evenly across participants. The **neutral control** block appears only once a neutral clip is registered.
- **Continuous rating replay** (off by default; adds the clip durations): each clip replays while the participant moves a valence-arousal marker, sampled every 50 ms. Exported as `annotations.tsv`.

Also in Recording setup: **consent and data sharing** (participation is required to start; per-modality sharing drives `share_manifest.json`, and withheld face video or voice can be replaced by a face colour trace or audio envelope when derived features are allowed). The **Cohort** tab shows session status, the 6 x 6 counterbalancing coverage, skin type, sex, and age balance among completed sessions, and per-session pauses, overrides, skips, and missing details, with a TSV export.

## Audio channels and the 2026-09-16 changeover

Audio recorded **before 2026-09-16 is single-channel**: the agent averaged a stereo input to mono, so
where two microphones shared one receiver their signals are summed and cannot be separated again.

**From 2026-09-16**, sessions run with `--audio-channels stereo` keep both channels:

| Channel | Wearer |
|---|---|
| left (`ch0`) | participant — mic 1 |
| right (`ch1`) | operator — mic 2 |

Do not infer the format from the date alone. Every session records its own channel count in the
`audio` sensor's `channels` metric, and the WAV header is authoritative:
`python -c "import wave; print(wave.open('audio/audio.wav').getnchannels())"`. Mono remains the
default, so a session is stereo only when the flag was passed.

Two consequences for analysis. Mixed formats coexist in the dataset, so any audio step must branch on
the channel count rather than assume one. And **the operator's voice is on the right channel of every
stereo session** — participant consent (`shareAudio`) covers the participant, so sharing or
publishing raw stereo audio also discloses a member of staff. Use the left channel alone, or the
`derivatives/audio_envelope.tsv` derivative, when only the participant's speech is in scope.

The left/right assignment above is this rig's wiring, not a property of the format. It was
**verified on 2026-09-16** with `python tools/audio_check.py --device ILCE`, speaking into each
transmitter in turn with the other switched off: mic 1 moved `ch0`, mic 2 moved `ch1`. Re-run that
check after any change to the receiver's pairing or mode, and on any other rig before trusting the
mapping — a reversed pair would label every participant channel as the operator's.

## Analysis bundle

When a session ends (or with `python -m meridian_agent --code CODE --token TOKEN --export-to RECORDING_DIR`), the agent writes `export/` next to the raw recordings. It includes `derivatives/physio_summary.tsv` (per-step ECG heart rate and RMSSD, oximeter heart rate and SpO2, skin conductance level and SCR count, belt breathing rate; `--derive-video` adds offline face-video rPPG), a BIDS-style copy in `export/bids/`, `consent.json`, `share_manifest.json`, and: `events.tsv`, `steps.tsv`, `ratings.tsv`, `tasks.tsv`, `stroop_trials.tsv`, `nback_trials.tsv`, `sync_check.tsv` (with a photodiode), `session.json`, and `qa_report.json` / `qa_report.md`. Onsets are on the acquisition host clock, matching the `host_epoch_ns` column of every sensor CSV. The QA report flags per-step coverage gaps in required streams, pauses, interrupted or restarted stimuli, repeats, timer steps that ran long or short, skipped steps, and gate outcomes.
