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

1. **Disk.** One full session is about 75 GB. Recordings go to `acquisition_agent/recordings` on `/media/ai/OneTB`.
   Check free space: `df -h /media/ai/OneTB`. Keep at least 150 GB free. Never record to the NVMe system disk.
2. **Free the serial ports.** Stop anything else that opens them, in particular the **Breathing-Rate Streamlit
   dashboard** (it was running on port 8502 during preparation). `ss -ltnp | grep 8502` shows it.
3. **Cameras into the rear PC ports directly.** No USB hub — the Huasheng 2.0 hub reset three times in testing.
   Sony a6700: **USB Streaming on**, 720p, and set exposure, ISO and white balance **manually**; it ignores the
   software lock.
4. **Power and interruptions.** Both screens set to never sleep, machine on mains, notifications off, phones
   silent, door closed, blinds closed, lights fixed.
5. **Start the server** from `/media/ai/OneTB/aarush_new_interface`: `npm run dev -- --port 3000`. Wait until
   `http://localhost:3000/instructor` answers.
   **Do not edit or save any file in the repository while a session is running** — the dev server watches files and
   a save reloads the subject display mid-protocol. (Git tag for today's state: `trial-2026-09-21`.)
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

1. Explain the session, get **signed consent**, then **Recording setup > Consent > SAVE CONSENT** with their real
   sharing choices.
2. **Safety screening:** ask all six questions and SAVE. Note: version 13 contains no breath hold, standing or
   exertion, so a "yes" no longer changes the session. Ask anyway — it is an ethics requirement, and it is logged.
3. **Participant details:** skin type, age band, sex, eyewear, facial hair, makeup, caffeine/nicotine/exercise in
   the last 2 h, heart-rate medication, camera distances. No names.
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
| 31–32 | Guided body scan (4 min), return to normal | ~4.5 min | Silence. Final BP reading |
| 33 | PANAS end | participant | Stay quiet |
| 34 | Session complete | (you) | End the session (section F) |

**Return-to-baseline gates** pass when heart rate and skin conductance are back near the resting baseline for 15 s.
With GSR broken, expect to **override with a written reason** — that is normal today, and the override is logged.

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
2. Wait for **"Analysis bundle written"** in the agent terminal (2–3 minutes for a full session). Don't close
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
6. **Back up before anything else:** copy `.wrangler/state` (the session database) and the session's recording
   folder to the archive drive. The database is the only copy of the session record the export depends on.

## G. If something goes wrong

| Symptom | Do this |
|---|---|
| Session says paused by itself | An instructor tab closed or lost focus. Reopen it and press resume |
| Agent terminal dies | Restart it with the **same code and token**; it rejoins and keeps recording to the same folder |
| A camera drops out | Note it with a hotkey, carry on, and do not replug during recording |
| Subject display shows the wrong session | Press CHANGE SESSION and enter today's code; it remembers the previous one |
| Subject display sleeps or goes blank | Wake it, press resume, and mark the gap with a hotkey |
| Power cut | After reboot, restart the server, recover the session by code in the console, restart the agent with the same code and token |
| Participant distressed | Safety stop button, bottom right of the subject display, then pause and attend to them |
