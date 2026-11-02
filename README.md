# Meridian

**A dual-portal research application for guided, synchronized multimodal data collection.**

Participants follow one activity at a time. Instructors prepare recording, observe signals, control the protocol, send written instructions, and review evidence. A Python acquisition agent runs on the computer connected to the sensors and writes raw recordings there.

Meridian is a **research collection platform**, not an implemented diagnostic or engagement-prediction model. Sensor readiness, experimental condition, self-reported affect, and clinical diagnosis are different things.

This README describes the active editorial interface and **v8 self-guided protocol**. Existing v7 sessions retain instructor-guided recovery checks. Read the [full documentation PDF](docs/meridian_portal_documentation.pdf) or its [editable LaTeX source](docs/meridian_portal_documentation.tex) for workflow-by-workflow cognitive rationale, data definitions, and proposed task-specific modeling pipelines. Older console components remain in the repository but are not rendered by the current instructor route.

## Project credits

| Team member | Name | Student ID |
| --- | --- | --- |
| Member A | Aarush Gupta | 2024AIB1174 |
| Member B | Arjun Aggarwal | 2024AIB1289 |

Member A leads the submission documentation, GitHub collaboration materials, and evaluator setup instructions.

## Submission materials

| Material | Location |
| --- | --- |
| Presentation (PPT) | Link pending |
| Demonstration video | Link pending |
| Workflow and design report | [Portal documentation (PDF)](docs/meridian_portal_documentation.pdf) |
| Implementation history | [GitHub commits](https://github.com/AarushIITRPR/Interface/commits/main/) |

### YouTube links

1. [User evaluation 1](https://youtu.be/rcFMCu8EScA?si=0bJE7sqMtB-zBjzX)
2. [User evaluation 2](https://youtu.be/ArJVZTkAf3k?si=5ak34TCArXeEWPQ2)
3. [User evaluation 3](https://youtu.be/WiWRewQwbkc?si=ooakhyFuJwYsXVMW)
4. [User evaluation 4](https://youtu.be/2groqSur4pQ?si=V7gFkAp0GJ-VcVJL)

## Evaluator walkthrough

Use one laptop for this walkthrough. The web server and the recorder run in separate terminals. You can inspect both portals and the [standalone memory-task demo](http://localhost:3000/nback-practice) with only the web server running.

1. **Launch the web application.** Follow [Start the website](#start-the-website) for the exact clone, install and launch commands for your OS. Leave that terminal running. Open the [instructor portal](http://localhost:3000/instructor), enter an unused numeric test participant ID, and select **Continue**. You should see **Recording setup**.
2. **Pair a subject browser.** In **Connect the subject computer**, expand **Test both portals on this computer instead** and select **Create local test invitation**. Copy the invitation into a second browser profile or private window on the same laptop. Select **Pair this subject computer**. Keep both windows open using the same hostname and port.
3. **Review consent.** In the subject window, read the selected sensor and research-use information. To proceed with this test session, select all three statements and **Give consent**. The instructor should now see **Wait for the subject recorder**.
4. **Connect simulated sensors.** Open a second terminal at the cloned repository root. Follow the [manual acquisition setup](#start-the-acquisition-agent) for your OS to create the Python environment. In the instructor's **Manual connection (advanced)** section, find the session code and private token. From the **acquisition_agent** directory, run the command below for your OS, replacing both placeholders with the actual values. This route uses the Python agent directly; you do not need to launch the Windows installer as well.

   **Windows PowerShell**
   ```powershell
   .\.venv\Scripts\python.exe -m meridian_agent --server http://localhost:3000 --code YOUR_SESSION_CODE --token YOUR_ACQUISITION_TOKEN --simulate-all --output ./recordings
   ```
   **Linux / macOS**
   ```bash
   .venv/bin/python -m meridian_agent --server http://localhost:3000 --code YOUR_SESSION_CODE --token YOUR_ACQUISITION_TOKEN --simulate-all --output ./recordings
   ```
5. **Record a short session.** Leave the agent running. When required streams are ready and the readiness check passes, select **Start recording**, then **Begin first activity** on the subject display. On the baseline screen, the timer should stay at its full duration until you choose **Start task**. In the instructor's **Live study** view, confirm that sensor reports are arriving. Send a short instruction and acknowledge it on the subject display.
6. **Verify the result.** For a short evaluation, select **End session** in the instructor portal and confirm. Leave the recorder running until it finalizes. Submit or skip the optional feedback on the subject display. In **Recording review**, open the session ledger and export the JSON record. The agent prints the local session directory under `acquisition_agent/recordings/`; inspect its `manifest.json`. Simulation demonstrates the workflow and file reporting. To evaluate actual camera and microphone files, use the [physical sensor setup](#supported-sensors).

For a repeatable software check, run the [automated tests](#verification). If a control stays disabled, see [Troubleshooting](#troubleshooting).

The Windows walkthrough was checked with Node.js 24.13.0 and npm 11.6.2. In a clean checkout, `npm.cmd ci`, the production build and all 23 web tests passed. The instructor, subject, memory demo and session-list endpoints returned HTTP 200 on the local development server. The recorder’s 21 Python tests also passed in a separate Python 3.14.2 environment.

## Repository guide

| Path | What to inspect |
| --- | --- |
| [app/instructor](app/instructor/) | Instructor entry, recording setup, live monitoring, protocol and review. The active workspace is `editorial-operator-console.tsx`. |
| [app/subject](app/subject/) | Consent, participant instructions, timers, video playback, ratings, cognitive tasks and feedback. |
| [app/api](app/api/) and [lib](lib/) | Session and recorder APIs, authoritative state transitions, protocol assignment and timing rules. |
| [acquisition_agent](acquisition_agent/) | Python recorder, device detection, simulated inputs and recording writers. |
| [public/protocol-media](public/protocol-media/) | Bundled clips used by the subject portal. |
| [tests](tests/) | Session-state, interface, playback and browser checks. |
| [docs](docs/) and [engagement_model](engagement_model/) | Portal documentation, research material and the separate modeling project. |

### GitHub collaboration

For a change, branch from the current `main`, keep the implementation and its tests together, and open a pull request describing the operator or participant workflow affected. Include the test command and result. Keep session tokens, recordings and participant data out of Git. This describes the contribution workflow; the commit history is the record of work already submitted.

Examples of delivered changes include [subject workstation pairing](https://github.com/AarushIITRPR/Interface/commit/f63c591), [consent, paced tasks and video playback](https://github.com/AarushIITRPR/Interface/commit/8447f8c), and [rating-screen readability](https://github.com/AarushIITRPR/Interface/commit/d811671).

## Architecture and stack

```text
Subject browser <--> Meridian session API / D1 <--> Instructor browser
                              ^
                              | commands, health, manifests
                              v
                    Local Python acquisition agent
                       |                    |
                   USB / OS devices   Frontier X live ECG
                       |
                 Raw files on local disk

Registered stimuli / R2 --> browser playback
Local MJPEG preview --> browser on the acquisition computer
```

| Layer | Implementation |
| --- | --- |
| UI | React 19, TypeScript, App Router-style pages via **vinext**, Vite 8 |
| Presentation | CSS, Tailwind tooling, Lucide icons, Motion with reduced-motion handling |
| Backend | Server route handlers in the same application, Cloudflare Worker runtime |
| Persistence | D1 session snapshots and event records; Drizzle tooling |
| Stimuli | `public/protocol-media`; R2 `MEDIA` binding for uploads |
| Acquisition | Python, OpenCV, PortAudio via `sounddevice`, PySerial, `websocket-client` |
| Package manager | npm with committed lockfile; Python requirements for the agent |

**The web frontend and backend start together.** There is no separate Flask, Express, or Streamlit server for Meridian. The acquisition process is separate because it accesses local hardware and records independently of browser rendering.

| Route | Purpose |
| --- | --- |
| `/` | Portal selection |
| `/instructor` | Participant entry, Recording setup, Live study, Protocol, Recording review |
| `/subject` | Join by session code or numeric participant ID |
| `/subject?session=SESSION_CODE` | Join a specific session |
| `/api/sessions` | Authoritative session reads and mutations |
| `/api/acquisition` | Token-authenticated agent commands, telemetry, finalization |
| `/api/media` | Media storage workflow |

## Start the website

Prerequisites: **Node.js 22.13.0+**, npm, and Python **3.11+** for acquisition. Use a Python release with available wheels for the sensor dependencies. Physical devices also require OS drivers and permissions. Current preflight requires **10 GiB free disk space**.

### Windows PowerShell

```powershell
git clone https://github.com/AarushIITRPR/Interface.git
cd Interface
npm.cmd ci
npm.cmd run dev -- --hostname localhost --port 3000
```

For an existing checkout, open the directory containing `package.json`. Run `npm.cmd ci` after changing branches or pulling a new lockfile, then start the server. `npm.cmd` avoids PowerShell's `npm.ps1` execution-policy issue without changing machine policy.

### Linux / macOS

```bash
git clone https://github.com/AarushIITRPR/Interface.git
cd Interface
npm ci
npm run dev -- --hostname localhost --port 3000
```

Open the two portals separately:

- <http://localhost:3000/instructor>
- <http://localhost:3000/subject>

Keep the terminal running. **Use the port actually printed by the server.** Recording setup now generates its connection command using the current browser origin, including its port. On a different acquisition computer, use the server's reachable address instead of localhost.

Vite supplies local Cloudflare bindings from `.openai/hosting.json`: D1 `DB`, R2 `MEDIA`. Local runtime persistence is under `.wrangler`. The session engine creates session tables. Do not delete local state if you need existing sessions. `npm run db:generate` generates migration files, not a required action before every run.

For a production build:

```powershell
npm.cmd run build
npm.cmd run start
```

Development mode supplies a local operator identity. Production uses ChatGPT authentication and the allowlist in `app/operator-auth.ts`. A production build is not automatically a public instructor portal. Real deployment also needs actual D1/R2 bindings and suitable authentication. Never expose the development identity bypass to the internet.

## Start the acquisition agent

Run this on the **computer connected to the sensors**, in a second terminal. It may be the same laptop as the web server. The subject browser itself does not access the hardware.

### Windows: one-time installation

For the **manual or simulated agent**, run the commands below from the repository root. The Windows installer described afterward is an alternative for a physical lab station.

```powershell
cd acquisition_agent
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

**Two computers (normal lab setup).** Use the same authenticated, reachable HTTPS deployment on both PCs. Do not publish the development server with its local operator bypass. On the instructor PC, create a session and use **Recording setup → Connect the subject computer → Create subject invitation**. Open this private invitation on the subject PC, in the browser profile that will remain at that station, and select **Pair this subject computer**. Do not open it on the instructor PC. A first-use invitation is single-use, expires after 30 minutes, and is replaced if another is generated.

On the **subject display**, the participant first reviews the selected sensors, task data, and research use. All three acknowledgements are required to give consent. Declining ends preparation. Adding a recording source requires renewed consent. The server gates recorder polling, preflight, and both recording start paths.

After consent, expand **First time on this computer?** and install Meridian Recorder for Windows x64. Return to that display and choose **Connect recorder**. Windows and the native recorder ask for confirmation; the portal advances only when the agent reports back. The unsigned installer needs network access on first use; have lab IT review and sign it for managed distribution. No repository checkout, terminal or system Python is needed.

When a recorded session ends, the subject display waits for the recorder’s finalization confirmation. Two optional feedback questions follow. Submitted feedback is available in Recording review and in the session JSON export.

**Later studies:** Use the same instructor and subject browser profiles. Leave `/subject` open (or reopen it); it picks up the next assigned study after the previous one ends. The subject clicks **Connect recorder** to authorize hardware for the new session. There is no new invitation, session code to enter, or pairing link to transfer. The station trust lasts up to 90 days; clearing cookies requires enrollment again. The separate five-minute native launch credential is refreshed on the preparation screen and does not limit recording duration. To change subject machines, finish or discard the old session and use **Recording setup → Subject computer → Forget subject computer** in that session. A localhost invitation is only for testing on one machine.

**Manual fallback:** For a manually managed agent, expand **Manual connection** in the recorder step. Replace the placeholders below with the values for the current session:

```powershell
.\.venv\Scripts\python.exe -m meridian_agent --server http://localhost:3000 --code YOUR_SESSION_CODE --token YOUR_ACQUISITION_TOKEN --output "C:\MeridianRecordings"
```

Command Prompt, from the same `acquisition_agent` folder:

```bat
.venv\Scripts\python.exe -m meridian_agent --server http://localhost:3000 --code YOUR_SESSION_CODE --token YOUR_ACQUISITION_TOKEN --output "C:\MeridianRecordings"
```

Explicitly using the venv interpreter avoids both activation-policy issues and accidentally running another Python. `No module named meridian_agent` usually means the working directory or interpreter is wrong.

### Linux / macOS manual agent

From the repository root:

```bash
cd acquisition_agent
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
.venv/bin/python -m meridian_agent --server http://localhost:3000 --code YOUR_SESSION_CODE --token YOUR_ACQUISITION_TOKEN --output ./recordings
```

Depending on the distribution, install its Python venv, PortAudio and OpenCV runtime packages. Check access to `/dev/video*` and `/dev/ttyUSB*` or `/dev/ttyACM*`; do not routinely run acquisition as root to bypass permissions.

For separate computers, replace localhost with the reachable, authenticated Meridian server origin. **Localhost always means the machine running the command.** Camera previews currently remain local to the acquisition machine.

Saved portal assignments override command-line sensor defaults. Use Recording setup → Check recording devices → Change devices. Save and wait for the automatic readiness check. `--simulate-all` deliberately overrides devices with simulation. `--help` lists all flags. Bundled launcher scripts use the default remote server unless environment configuration changes it; explicit commands above are clearer for local testing.

## Run a session

1. **Enter a numeric participant ID.** Contextual resume appears if an active session is found for that participant. A participant ID is not the generated session code.
2. **Pair and obtain consent.** In Recording setup, prepare the subject invitation. Open it on the subject computer, pair that browser, and let the participant review and submit their consent. Then connect the recorder on the computer attached to the sensors.
3. **Assign devices.** Select Auto-detect or a specific device. A checkbox means **required for readiness**, not enabled. To disable a sensor, uncheck it **and** choose **Not assigned**. Use distinct physical indices for face and thermal cameras.
4. **Save device choices.** Selections are local drafts until saved. Refresh devices if hardware changed, then rerun the readiness check.
5. **Run readiness check.** After a 10-second observation interval, the agent checks required-stream quality, a JSON write/read test, at least 10 GiB free, and estimated server-clock offset below 100 ms. This is operational readiness, not medical certification or a complete media-integrity test. The setup screen explains what blocks Start.
6. **Check the subject display.** Keep the paired subject browser open. After consent, Meridian requests the readiness check when the acquisition computer reports fresh, usable samples with the saved configuration. Adding another recording source brings the participant back to the consent form.
7. **Start recording.** Once readiness passes, the participant chooses Start recording. Configuration locks; the first activity unlocks after the agent reports recording. The instructor can still start explicitly.
8. **Monitor if needed.** Start opens Live study whether the instructor or participant started the session. Its handoff tells you who acts next. Live study shows signals and communication. Protocol workspace has instructions, navigation, gate checks, N-back level, and manual BP entry.
9. **Pause or intervene.** Messages appear as participant announcements. Safety stages expose a stop action. **Pause holds the protocol while raw recording continues.** Markers identify pauses afterward.
10. **Finish or stop.** The default protocol closes the session after the final recovery. Either portal can end early. Keep the agent running until it reports that the manifest synchronized. The participant can then submit or skip feedback.
11. **Verify and archive.** Wait for agent finalization and manifest synchronization. Export review metadata and copy the complete local session directory to approved storage.

Do not treat reopening a completed session as an uninterrupted continuation of its old raw capture. Use a new acquisition and preserve provenance.

## Protocol and participant tests

`lib/protocol.ts` is the sequence source of truth; `lib/types.ts` declares v8 and default media. There are **34 stages**. Six emotion clips form three pairs using a deterministic six-row Williams-style schedule. Buffer-task order also depends on participant ID. Counterbalancing manages order effects; it does not prove an intended emotion was elicited.

| Stages | Activity | Timing / completion |
| --- | --- | --- |
| 1 | Sensor/synchronization check | Participant begins once streams report recording |
| 2 | Eyes-open baseline and BP anchor | 120 s |
| 3 | Eyes-closed baseline | 90 s |
| 4-10 | Clip, rating, neutral fixation, clip, rating, buffer, baseline gate | Clip end; rating completion; 20 s fixation; 40 s gate display |
| 11-17 | Second paired block | Same structure |
| 18-23 | Third paired block | Same structure without trailing gate |
| 24 | Settle before sweep | 40 s minimum, participant confirms readiness |
| 25 | Seated rest | 20 s |
| 26 | Box breathing | 45 s, four-second phases |
| 27 | Voluntary breath hold | Participant starts/releases, comfort limited |
| 28 | Head motion and speech | 30 s |
| 29 | Standing and BP | 45 s |
| 30 | Brief exertion | 20 s |
| 31 | Recovery and BP | 60 s |
| 32 | Guided body scan | 240 s |
| 33 | Return to normal and final BP | 60 s |
| 34 | Completion | System requests recorder finalization |

Each clip is followed by three plain-language questions: **How pleasant did you feel?**, **How calm or energized did you feel?**, and **How in control did you feel?** Ten numbered choices remain, with explicit Continue, Back and final submission. Arrow keys, 1-9 and 0 (for 10) work within the rating group. Saved fields remain `valence`, `arousal`, and `dominance`; events record the response UI version. These are affect ratings, not diagnostic or engagement labels. Revised wording requires validation before treating it as equivalent to a standardized instrument.

Open `/nback-practice` to watch the automatic 40-slide 1-back demonstration without joining a study. Select **Understood, start test** whenever the rule is clear to try the 20-square task. This standalone preview does not save responses.

In the study, a smaller corner grid displays the position N slides ago while the current square changes. An illustrated finger taps Match only on matching slides. No clicks or key presses are needed for the demonstration. The participant can start the separate 20-presentation task at any point during the example or after slide 40. The simulation is unscored; the first N presentations are warm-up. A scored-onset marker and trial-level results distinguish the phases. Each scored square is visible for 1,000 ms followed by a 1,500 ms blank. The response window covers both. The onset and completion events carry timingVersion (spatial-2500-v1), visibleMs, gapMs and intervalMs. Earlier unversioned runs used a different pace; do not pool them as equivalent exposures. One response is accepted per presentation; correctness is not revealed during scored trials.

In v8, Back and Continue belong to the editable three-question form. Timed exposures, fixation and scored trials have no generic skip/replay. Timed tasks show their instructions and full duration until the participant selects **Start task**. The server timestamps that action and starts the countdown. Participants can end the session at any time. The speaking buffer is an individual spoken response; recovery checks are minimum rests plus self-reported readiness, not proof that HR or GSR returned to baseline. New sessions created from the instructor entry screen are self-guided. Resuming an existing session preserves its original mode. Manual BP and physical setup still need appropriate staff; no measurements are inferred. Keep protocol version with all exported data.

In v7 only, participants can use **Previous task** during eligible running tasks. Confirmation warns about restarting unfinished work. Navigation is logged as interruption, previous saved responses remain, and revisits create a new attempt. Instructor-controlled gates, paused sessions and finalized sessions cannot be bypassed. Back within the rating form preserves its unsent answers.

Each buffer appears once:

- **Stroop:** 30 responses. Persisted output is trial count, accuracy percentage, mean reaction time. Full trial history is not exported.
- **N-back:** 20 spatial trials at selectable 1/2/3-back. The completion event records the configured pace, trial positions, responses, reaction times, hits, misses, false alarms and correct rejections. Practice is separate.
- **Conversation:** 180 seconds on familiar topics. Audio is recorded; the portal does not generate transcripts.

Bundled clips in `public/protocol-media`: happy, sad, anger, fear, surprise, disgust, bodyscan, relaxing-nature (all `.mp4`). Actual media duration governs emotion-clip completion, not the 12-second estimate in the plan. Never count a missing-media placeholder as valid stimulus delivery. Verify rights to use/distribute clips.

Breath hold, standing, and exertion require an approved protocol, participant screening, supervision, and withdrawal procedures. Software stop controls do not replace these safeguards.

## Supported sensors

| Modality | Integration | Recorded signal and limit |
| --- | --- | --- |
| Face camera | OpenCV index/path | RGB AVI, not computed microexpressions or engagement |
| Room audio | OS input via PortAudio | Mono 48 kHz 16-bit PCM WAV; receiver must be an OS recording input |
| Oximeter | CMS50E V7 serial | SpO2, HR, signal strength, pleth; not arbitrary USB oximeters |
| EMG | Compatible ESP32 firmware; 921600 baud default | Device time, sequence, ADC; interpretation depends on electrode site/gain |
| EDA/GSR | JSON-line firmware; 115200 baud default | Conductance, ADC, firmware stress/z-score; those scores are not clinical labels |
| ECG | Frontier X live-share WebSocket | Reconstructed 125 Hz waveform and HR; active link/user ID and running agent required |
| ECG fallback | Generic serial newline adapter | Raw lines, not a universal ECG decoder |
| Thermal | OpenCV-compatible camera | AVI image stream; no guaranteed Celsius/radiometric calibration |
| WiFi CSI | Compatible external ESP32 serial stream | Raw CSI line, packet/time fields, RSSI; ordinary laptop WiFi is insufficient |
| BP | Manual instructor entry from cuff | Systolic, diastolic, optional pulse, stage; no automatic cuff adapter |

Serial discovery checks protocol samples rather than inferring sensor identity from USB bridge VID/PID or fixed COM numbers. Explicit assignments reserve ports before automatic discovery. Keep explicit assignments unique and verify live signals. This is protocol-specific, not universal discovery.

Both video Auto-detect values currently mean index 0, **not semantic recognition of camera type**. Manually select distinct cameras. An analog headset-port receiver may appear under the existing sound-card input name; jack, cable, output level, and driver must support capture. A headphone output cannot act as an audio input.

## Where recordings are stored

Default: `recordings` relative to the agent working directory. Prefer an explicit `--output` path. The terminal prints **Monitoring locally in ...** with the resolved directory.

```text
session_CODE_TIMESTAMP/
  acquisition.json          # machine, devices, clocks
  preflight_test.json       # readiness evidence
  session_markers.jsonl     # observed task/status transitions
  manifest.json             # primary file paths, hashes, quality
  face/face.avi
  audio/audio.wav
  oximeter/oximeter.csv
  emg/emg.csv
  gsr/gsr.csv
  csi/csi.csv
  ecg/ecg.csv
  ecg/ecg_packets.jsonl     # Frontier X source sidecar
  thermal/thermal.avi
```

Only applicable files appear. Simulation produces `*_simulated.csv`, **not real AVI/WAV**. Failed manifest synchronization creates `pending_upload.json`; automatic replay is not implemented. Preserve and reconcile it deliberately.

Storage responsibilities:

1. **D1:** session state, ratings, BP, notes/events, telemetry snapshots, recording metadata.
2. **Acquisition disk:** original video/audio/CSV and sidecars.
3. **R2/public assets:** stimulus media, not automatic backup of raw recordings.

Recording review exports JSON manifest/session metadata and a separate JSON event ledger. It **does not download raw recordings**. Copy the complete acquisition directory. The exported snapshot strips the top-level acquisition token, but preview URLs and other metadata can still be sensitive; redact before sharing.

CSV includes host epoch nanoseconds and relative monotonic time, plus available device clocks. Current AVI/WAV writers lack per-frame/per-block timestamp sidecars. Polling markers and estimated clock offsets provide approximate alignment, not guaranteed hardware synchronization.

## Synchronization and recovery

- D1 is authoritative. Session writes use optimistic revisions; portals reject older snapshots and responses for previous sessions.
- Expected step IDs reject stale subject completions. This is not full exactly-once or attempt-level idempotency.
- Subject polling is about 850 ms, instructor refresh 1.8 s, agent heartbeat 2 s. These are near-real-time control updates, not raw-stream synchronization.
- Operator presence uses a 12-second lease; acquisition uses 10 seconds. Missing presence/readiness shows a waiting screen.
- Participants can change sessions while waiting/after completion; ended sessions can follow a newer active session for the same participant.
- After recording starts, temporary network loss does not stop local capture. Metadata delivery/protocol continuity are not guaranteed during the interruption.
- A browser refresh can restart client-only rating/Stroop/N-back state. Avoid refreshing mid-task and record interruptions/repeats.

## HCI improvements over time

These are code-supported design decisions and cognitive rationales, **not measured usability gains**. See [Nielsen's heuristics](https://www.nngroup.com/articles/ten-usability-heuristics/) and [WCAG 2.2](https://www.w3.org/TR/WCAG22/).

| Earlier issue | Current approach | Rationale |
| --- | --- | --- |
| Mixed participant/operator responsibilities | Separate portals | Less competing information and participant priming |
| Dense technical dashboard | Overview, Protocol, Review | Task-based grouping and less visual search |
| Separate resume workflow | Participant-first contextual resume | Recognition without premature workflow choice |
| Duplicate navigation/ledger | One sidebar, ledger in Review | Fewer competing destinations |
| Prominent command/token | Technical connection disclosure | Troubleshooting stays available but secondary |
| Trapped waiting/Thank you state | Change session and active-session following | User control and recovery |
| Slider precision during ratings | Ten buttons, one dimension at a time | Clear mapping and less fine-motor adjustment; scale equivalence requires validation |
| Stale state reverting tasks | Revision and active-code guards | Predictable feedback and continuity |
| Wrong serial identity | Protocol probes and reserved ports | Error prevention before recording |
| Dropdown disrupted by refresh | Local drafts and explicit Save | Preserves operator action during telemetry updates |
| Unclear preparation | Required streams, preflight, configuration lock | Externalizes checks and prevents mid-run changes |
| Speech interrupted by operator | Written announcements/acknowledgement | Lower audio contamination |
| Downloads confused with recordings | Review manifest plus local-file workflow | Clarifies where evidence actually resides |

Labels, alerts, skip link, dialog names, Escape-to-close, and reduced-motion support are present. **WCAG compliance has not been established.** Focus trapping/restoration, rating radio semantics, contrast, small-screen use, and assistive technology need systematic tests. Decorative labels and duplicate task copy remain in some screens; minimalism is a direction, not an absolute claim.

Milestones: `8b3450f` acquisition agent; `4405dde` acquisition workflow/sync; `2ec91d0` portal redesign/live monitoring; `a472855` Frontier X/autodetection; `74a6d45` stimulus media/SAM alignment.

## Verification

From repository root:

```powershell
npm.cmd run lint
npm.cmd test
```

`npm test` builds and checks rendered HTML/source assertions. The suite also checks consent gating, timed starts, session transitions, Stroop colour balance and seekable video responses. These checks run independently of physical hardware.

From `acquisition_agent`:

```powershell
.\.venv\Scripts\python.exe -m unittest discover -s tests -v
```

### Simulated smoke test

Use a dedicated test participant:

```powershell
.\.venv\Scripts\python.exe -m meridian_agent --server http://localhost:3000 --code YOUR_SESSION_CODE --token YOUR_ACQUISITION_TOKEN --simulate-all --output "C:\MeridianTestRecordings"
```

Run preflight, start, advance/pause/resume, send a message, end, then check ledger, CSV rows, primary-file hashes, and manifest. This verifies orchestration, not physical capture, actual audio/video encoding, or medical accuracy.

Before a real study:

- Identify each physical device; test unplug/reconnect without cross-assignment.
- Record a short camera/audio test with a visible clap and audible phrase. End, open AVI/WAV on disk, check duration/playback.
- Check serial counts, clocks, gaps, units and calibration against recording duration.
- Test network interruption, refresh, repeated session selection, and missing required devices in a test session.
- Confirm output path, storage, both portal origins, and full-directory archival including sidecars.
- Do not treat a green badge as proof of complete data.

## Troubleshooting

| Symptom | Action |
| --- | --- |
| No module named meridian_agent | Correct working directory and venv interpreter |
| Session not found | Same server/port, current session code and token |
| Camera warnings then no monitoring message | Inventory probing precedes monitoring; inspect drivers/access. No per-device process timeout currently protects against a blocking driver |
| Start disabled | Save, check required streams, run preflight; verify disk and clock condition |
| Preflight stays running | Check current agent heartbeat/configuration, not repeated clicks |
| Webcam cannot open | Close duplicate capture processes, allow desktop camera access, select device, avoid face/thermal sharing index 0 |
| Audio input missing | Check OS input and sounddevice inventory first; output-only jacks cannot capture |
| Wrong serial device | Current protocol probes, compatible firmware, unique assignments; no fixed COM assumptions |
| Thermal shows webcam | Explicitly select thermal index; radiometric output needs a dedicated adapter |
| Subject waits | Check operator/agent presence, required streams and session; use Change session if needed |
| Thank you but files pending | End session and await finalization |
| Export has no video/audio | Export is metadata; copy raw acquisition folder; simulation has no real media |
| Remote camera preview absent | Preview is loopback-only, not a video relay |

## Deployment, privacy, and limits

Production access is restricted by an allowlist. Configure it deliberately for another lab. Keep session codes private and treat acquisition tokens/Frontier X share links as credentials. Raw recordings stay local, but telemetry and metadata reach the backend. Use consent, encryption, access control, retention/deletion policy, and approved transfers.

There is no universal device discovery, guaranteed loss-free capture, automatic raw-file cloud backup, or trained diagnostic model. Preflight is operational evidence, not calibration or clinical validation. Stress/affect clips do not diagnose mental illness; single-lead ECG does not replace diagnostic 12-lead ECG; gaze/facial expression alone cannot establish engagement.

### Source map

```text
app/instructor/editorial-operator-console.tsx  Active operator UI
app/subject/subject-portal.tsx                Participant tasks
lib/protocol.ts                              Sequence/counterbalancing
lib/types.ts                                 Protocol/sensor/payload types
lib/session-engine.ts                        State, persistence, leases
app/api/{sessions,acquisition,media}/route.ts API handlers
acquisition_agent/meridian_agent/agent.py     Control/preflight/finalization
acquisition_agent/meridian_agent/sensors.py   Adapters/writers/discovery
acquisition_agent/meridian_agent/preview.py   Local preview
docs/meridian_portal_documentation.tex        Full documentation
```
