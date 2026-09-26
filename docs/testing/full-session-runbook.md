# Meridian full-session runbook — first official trial, 21 September 2026

Protocol **version 13**. Participant **131**: **35 steps, about 40 minutes** of protocol. Plan on **75 minutes**
including setup. Emotion order for this participant: **surprise > disgust > fear > happy > anger > sad**. Tasks:
**N-back (Part 1) > Stroop (Part 3)**; no participant does the conversation step any more.

> Create the session **fresh on the morning of the trial**. A session keeps the protocol version it was created
> with forever, so a session made before today would run the old protocol.

## A. Known state of the rig (from the 16–17 September audit, nothing fixed since)

These are not faults to chase on the day. Expect them, and do not let them stop the session:

- **Skin conductance (GSR) is unusable.** It reads near zero and the export will not emit SCR counts. It is not a
  required stream. Do not spend the morning re-taping electrodes.
- **No respiration belt.** The paced-breathing steps have no independent breathing reference, so `breathing_rate`
  will be `n/a` for every step.
- **No photodiode.** `sync_check.tsv` will be empty and display latency stays unmeasured.
- **ECG and oximeter heart rate disagree by about 4 bpm** (13.6 bpm at worst). The console shows the disagreement
  live. It is not a timing artefact; do not stop a session over it.
- **Preflight passing is not evidence the data is good.** On 16 September preflight reported `"failed": []` on a rig
  with three damaged streams. Judge the signals by eye in Overview, not by the green badge.

## B. Before the participant arrives (20 min)

1. **Disk.** Measured on session 01326YVE: **199 GB** for a 60-minute session including its export and task
   folders, about **135 GB** for a 40-minute one (roughly 200 GB/h, dominated by the two lossless cameras).
   Recordings go to `acquisition_agent/recordings` on `/media/ai/OneTB`; check free space with
   `df -h /media/ai/OneTB`. Preflight requires the floor set in `start-linux.sh` (**150 GB**, `--min-free-gb`), which
   covers one normal session, and the agent terminal warns every minute once free space drops under **30 GB**.
   With less than about 200 GB free, archive a session before recording another. Never record to the NVMe system disk.
2. **Free the serial ports.** Stop anything else that opens them, in particular the **Breathing-Rate Streamlit
   dashboard** (it was running on port 8502 during preparation). `ss -ltnp | grep 8502` shows it.
3. **Cameras into the rear PC ports directly.** No USB hub — the Huasheng 2.0 hub reset three times in testing.
   In Recording setup: **Face camera = Sony a6700** (primary rPPG camera, uncompressed 1080p25) and **Face camera 2 =
   Logitech C270** (upper-body view for breathing and expression, 720p30 MJPG at gain 48).
   - **Sony body settings** (it ignores the software lock; preflight now fails if its brightness drifts):
     USB Streaming on, 1080p · **M mode** · shutter **1/50 or 1/100** (whole 50 Hz periods) · **fixed ISO**, the
     lowest that gives a mid-grey face · **manual white balance** (fixed K) · **DRO / Auto HDR off** · Picture Profile
     off · focus on the eyes, then **MF** · SteadyShot off. Frame head and shoulders; face at least 400 px wide.
   - **C270:** 50–70 cm away, framing the upper body including the chest.
   - **Light:** two diffuse, flicker-free LED panels 30–45° either side of the face, so the subject display is not
     the main light on the face. Avoid a bright green screen behind the participant: green spill lands on the skin,
     and green is the channel rPPG reads. Use matte grey or dim it.
   - Preflight now also fails when more than 5% of a face camera's face region is clipped ("overexposed"). Lower the
     light or the gain until it passes.
4. **Power and interruptions.** Both screens set to never sleep, machine on mains, notifications off, phones
   silent, door closed, blinds closed, lights fixed.
5. **Start the server** from `/media/ai/OneTB/aarush_new_interface`: `npm run dev -- --port 3000`. Wait until
   `http://localhost:3000/instructor` answers.
   **Do not edit or save any file in the repository while a session is running** — the dev server watches files and
   a save reloads the subject display mid-protocol. (Git tag for today's state: `trial-2026-09-21`.)
   The session database lives on the NVMe system disk: `.wrangler/state` is a symlink to
   `/home/ai/meridian-state/wrangler-state`. On the recording disk, every database write waited behind the camera
   data (requests at 1-2 s during a recording, about 15 ms from the NVMe). Keep it there; if the symlink is ever
   missing, the server silently starts an empty database.
6. **Open two tabs on this PC.**
   - Instructor: `http://localhost:3000/instructor` > create the session for participant 131 > note the **code** and
     the **acquisition token**. **Keep this tab open and in the foreground the whole session**: the session pauses
     itself whenever no instructor tab is live.
   - Subject display: `http://localhost:3000/subject` > enter the code > CONNECT. If it jumps straight into a
     different session, press **CHANGE SESSION**: the display remembers the last code it used.
   **Keep the subject display as the foreground window on its screen.** Chrome throttles timers in background tabs,
   which stretches the word list and the pacers.
7. **Start the acquisition agent** (one command, per session), from `acquisition_agent`:
   `./start-linux.sh <CODE> <TOKEN>` — or spell the ports out:
   `.venv/bin/python -m meridian_agent --code <CODE> --token <TOKEN> --csi COM_or_/dev/tty… --emg … --ecg …`
   The virtualenv lives at `acquisition_agent/.venv`. The console's Setup view should show the agent online within
   a few seconds.
8. **CSI empty-room baseline** (if CSI matters): nobody in the room, **Recording setup > CSI setup > SAVE CSI SETUP
   > RECORD EMPTY ROOM** (60 s).
9. **Media check:** the subject display must finish downloading all clips before Start is allowed. Watch for the
   "media ready" state.

## C. With the participant (15 min)

1. Explain the session, get **signed consent**, then **Recording setup > Consent**. If the form says Yes throughout,
   press **MARK ALL YES (PER SIGNED FORM)**; then change any answer the participant declined. It saves by itself.
2. **Safety screening:** ask all six questions aloud, press **ALL NO**, then switch any the participant answers
   yes. Note: version 13 contains no breath hold, standing or exertion, so a "yes" no longer changes the session. Ask anyway — it is an ethics requirement, and it is logged.
3. **Participant details:** the usual answers are pre-filled (right-handed, no eyewear, facial hair, makeup,
   caffeine, nicotine, exercise or heart-rate medication; BMI not recorded; camera distances from the last session).
   Check each with the participant, then set **skin type, age band and sex**. Nothing saves until those three are set.
   No names.
4. **Sensors on:**
   - ECG strap: wet electrodes, snug under the chest, Frontier X app streaming, phone charging and awake.
   - Oximeter on the **non-dominant** index finger, hand resting still on the table.
   - EMG (if used today) per its own placement notes; check the trace moves with a deliberate contraction.
   - DJI mics: **mic 1 on the participant** (left channel), **mic 2 on the operator** (right channel). Swapping
     them puts the operator's voice in the participant's channel for the whole session.
   - Seat 50–80 cm from the cameras, face centred in both previews, hair off the forehead.
5. Wait for **Overview** to look right: ECG heart rate plausible at rest (50–100), oximeter within ~8 bpm of it
   (expect a few bpm of disagreement), both face previews showing the face, audio meter moving when they speak.
6. **RUN PREFLIGHT** until it passes, then **START SESSION**.

## D. Running the protocol (about 40 minutes)

Most steps advance themselves. The ones you control are marked **(you)**.

| # | Step | Length | What you do |
|---|---|---|---|
| 0 | Sensor and synchronization check | (you) | Confirm the streams, then ADVANCE |
| 1–2 | PANAS mood, TIPI personality | participant | Stay quiet |
| 3 | Resting baseline, eyes open | 2 min | Silence, no movement in the room. Take the resting BP reading |
| 4–11 | **Part 1:** surprise clip, rating, washout, disgust clip, rating, **N-back**, NASA-TLX, gate | ~10 min | Don't help with the task. Gate: 25 s, passes when HR and skin conductance settle |
| 12–17 | **Part 2:** fear clip, rating, washout, happy clip, rating, gate | ~8 min | No task in Part 2 in this version |
| 18–24 | **Part 3:** anger clip, rating, washout, sad clip, rating, **Stroop**, NASA-TLX | ~10 min | The Stroop screen warns them each word disappears after ~2 s |
| 25 | Word list: study and recognise | ~1 min | Ten words for 20 s with a countdown, then 20 yes/no words |
| 26 | **Read aloud** | ~1 min **(participant ends it)** | They read the passage aloud once at a normal pace, then press **Done**. Don't rush them; it stops by itself at 2 min |
| 27–30 | Seated rest 20 s, **box breathing 64 s (4 rounds)**, paced breathing 6/min 60 s, 20/min 40 s | ~3 min | Silent on-screen bar. The marker holds 4 s at the top and bottom — that pause is intentional |
| 31–32 | Guided body scan (4 min 28 s, plays once), return to normal | ~4.5 min | At the start, say: "Please close your eyes now and relax. Keep them closed until I ask you to open them." Then silence. At "Return to normal", tell them to open their eyes (they cannot read the screen with eyes closed). Final BP reading |
| 33 | PANAS end | participant | Stay quiet |
| 34 | Session complete | (you) | End the session (section F) |

**Return-to-baseline gates** pass when heart rate and skin conductance are back near the resting baseline for 15 s.
With GSR broken, expect to **override with a written reason** — that is normal today, and the override is logged.
Once the 25 s timer has run and the participant has saved their BP, the subject display shows a **Continue** button,
so the session no longer waits on you. Their Continue is logged like an operator advance (`gate_verified`,
`gate_unverified`, or `gate_override` if HR/GSR had not settled) with source `subject`. You can still advance or
override from the console at any time.

**BP entry starts blank.** The participant sets each number with the +/- buttons (the first press starts at
120/80/70), and Save stays disabled until systolic and diastolic are both set. Before this, an untouched 120/80/70
could be saved; 2303V84Y has two such readings (s02 and s10).

**Artifact hotkeys** in the instructor console: T talking · L left seat · O operator in view · C cough/sneeze ·
M large movement · D door/other people · P phone.

## E. Do's and don'ts

**Do**
- Keep the instructor tab open and the subject display in the foreground.
- Mark every disturbance with the hotkeys straight away.
- Keep lighting, camera position and exposure unchanged for the whole session.
- Keep the Frontier X phone app open, awake and charging.
- Pause for anything unplanned; resume only when signals are back.
- Stop immediately if the participant feels unwell. Their safety comes before the recording.

**Don't**
- Don't edit any file in the repository while recording.
- Don't unplug or replug USB devices while recording; the cameras cannot reconnect without restarting the agent.
- Don't use the USB hub for cameras.
- Don't talk, move, or stand behind the participant.
- Don't change the Sony's settings, zoom or position after START SESSION.
- Don't let the subject display sleep, go to the background, or be closed.
- Don't let another program hold the ESP32 port.
- Don't enter names in participant details; categories only.

## F. Ending — and the one rule that has already cost a session

1. At step 34 (or to stop early), press **End session**.
2. Wait for **"Analysis bundle written"** in the agent terminal (about 30 min for a full session: it checksums every file, 184 GB for P132). Don't close
   anything before it appears.
3. **Do not reopen, replay or navigate the finished session in the instructor console before the export is done.**
   On 17 September a completed session was walked backwards through 24 steps in the console; that rewrote its record
   to `paused, step 5` and added 48 phantom events, and the export has still not been salvaged.
4. Remove sensors; thank the participant.
5. Check `export/qa_report.md` in `acquisition_agent/recordings/session_<CODE>_*/`:
   - every step at least 95% coverage for the required streams (face, audio, oximeter);
   - ECG and oximeter heart rate within a few bpm of each other;
   - face frames equal to the frame-timestamp rows;
   - `tasks.tsv` contains `stroop_complete`, `nback_complete`, `wordlist_recognition` and `reading_complete`;
   - expect `breathing_rate` to be `n/a` and `sync_check.tsv` to be empty — that is the missing belt and photodiode,
     not a fault of this session.
6. **Back up first**, before the slow extraction below, with the archive drive mounted, from `acquisition_agent`:
   `.venv/bin/python tools/backup_session.py recordings/session_<CODE>_<time> /media/ai/Elements/meridian`
   It copies the recording folder, takes a consistent snapshot of the session database (the only copy of the session
   record the export depends on), and verifies every file against `manifest.json`. Only delete the original after it
   prints "Backup verified". One session is about 190 GB, so back up after every session. (The tool verifies what
   `manifest.json` lists; a `tasks/` folder cut later is copied but not checksum-verified, so re-run the backup after
   step 7 if you want it on the archive.)
7. **Cut the per-task folders**, once the participant has left (it takes 30-60 min and needs the server up), from
   `acquisition_agent`:
   `MERIDIAN_URL=http://localhost:3000 .venv/bin/python -m meridian_agent --code <CODE> --token <TOKEN> --export-to recordings/session_<CODE>_<time> --extract-tasks --derive-video`
   This writes `tasks/<step_id>/` per step attempt: a video proxy, that step's physio rows, the audio slice, the
   frame timestamps and `step.json`, plus `face_colour_trace.tsv` for rPPG. The masters are not touched. Cutting
   during the session is deliberately not done: dropped frames are missing from the video while the container still
   claims a constant frame rate, so every cut is mapped through `<sensor>_frames.csv` afterwards.

## G. If something goes wrong

| Symptom | Do this |
|---|---|
| Session says paused by itself | An instructor tab closed or lost focus. Reopen it and press resume |
| Agent terminal dies | Restart it with `./start-linux.sh` and the **same code and token**. It rejoins the session but records into a **new** `session_<CODE>_<time>` folder, and the export covers only that folder, so note the time of the restart |
| "Another acquisition agent is already running" | One agent is already recording this session. Do not start a second one; two agents fight over every camera and port |
| A sensor drops off USB | Plug it back into the **same** port. The agent reopens it by physical port, and the protocol pauses only if it stays lost for more than 10 s |
| A camera drops out | Note it with a hotkey, carry on, and do not replug during recording |
| Subject display shows the wrong session | Press CHANGE SESSION and enter today's code; it remembers the previous one |
| Subject display sleeps or goes blank | Wake it, press resume, and mark the gap with a hotkey |
| Power cut | After reboot, restart the server, recover the session by code in the console, restart the agent with the same code and token |
| Participant distressed | Safety stop button, bottom right of the subject display, then pause and attend to them |
