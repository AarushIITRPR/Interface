# Meridian full-session runbook

Session: **09004JW4** (participant 900). Clip order for this session: disgust > happy > surprise > sad > fear > anger. Task order: conversation > N-back > Stroop.
The protocol has 43 steps and takes about 50 minutes. Plan on 75 minutes including setup.

## Fix first (seen when this session was created)
- **Sony a6700:** shows up as "USB Bus-powered Device" (054c:0d68), not as a camera. Turn **USB Streaming** back on in the camera menu. Face camera 2 and the audio both come from it.
- **FLIR thermal:** not detected. Replug it straight into the PC (it's optional for this session).
- **Oximeter:** port open, but no data until a finger is inserted.
- **GSR:** 0.00 uS. Electrodes aren't on skin yet.
- **ECG:** subscribed, but no data. Start live streaming in the Frontier X app.

## A. Before the participant arrives (15 min)
1. Check disk space: one full session is about **75 GB** (two lossless cameras plus thermal).
2. Plug cameras straight into rear PC ports; don't use the Huasheng hub. Sony: USB Streaming on, 720p.
3. Set the Sony's exposure, ISO, and white balance **manually**; it ignores the software lock.
4. Room: fixed lighting (lights on, blinds closed), door closed, phones silent, no one walking behind the participant.
5. CSI empty-room baseline (if CSI matters): nobody in the room, **Recording setup > CSI setup > SAVE CSI SETUP > RECORD EMPTY ROOM** (60 s).
6. Open two browser tabs **on this PC**:
   - Instructor: `http://localhost:3000/instructor` > session **09004JW4**. **Keep this tab open the whole session.** If it closes, the session pauses automatically.
   - Subject display (participant screen): `http://localhost:3000/subject` > enter **09004JW4** > CONNECT. Wait until it has loaded the media.

## B. With the participant (15 min)
1. Explain the session and get **signed consent**. In **Recording setup**: Consent > SAVE CONSENT (their real sharing choices).
2. **Safety screening:** ask all 6 questions > SAVE SCREENING. A "yes" automatically skips breath hold, standing, or exertion.
3. **Participant details:** skin type, age band, sex, eyewear, facial hair, makeup, caffeine/nicotine/exercise in last 2 h, heart-rate medication, camera distances > SAVE PARTICIPANT DETAILS.
4. Sensors on:
   - ECG strap: wet the electrodes, snug under the chest, Frontier X app streaming (phone plugged in, screen awake).
   - Oximeter on the **non-dominant** index finger; hand resting on the table.
   - GSR electrodes on two fingers of the **same** hand as the oximeter, after the skin has been in contact for about 5 minutes.
   - Seat 50-80 cm from the cameras, face centred in both previews, no hair over the forehead.
5. Wait for signals to look right in **Overview**: ECG HR plausible (50-100 at rest), oximeter HR within 8 bpm of ECG, GSR above 0.5 uS and fairly stable, both face previews show the face, audio meter moves when they speak.
6. **RUN PREFLIGHT** until it passes, then **START SESSION**.

## C. Running the protocol (about 50 min)
Use the **play/pause** and **ADVANCE** buttons in the instructor console. Most steps advance by themselves; the ones you control are marked **(you)**.

| # | Step | Time | What you do |
|---|---|---|---|
| 0 | Sensor and synchronization check | (you) | Confirm all sensors green, then ADVANCE |
| 1-2 | PANAS mood, TIPI personality | participant | Stay quiet; they answer on screen |
| 3 | Resting baseline, eyes open | 2 min | Silence, no movement in the room |
| 4 | Resting baseline, eyes closed | 1.5 min | Silence |
| 5-11 | **Part 1:** disgust clip, rating, washout, happy clip, rating, **conversation (3 min)**, return-to-baseline gate | ~9 min | Conversation: talk with them naturally for 3 min (the only step where talking is intended). Gate: wait for HR and GSR to settle |
| 12-19 | **Part 2:** surprise clip, rating, washout, sad clip, rating, **N-back** (practice first), NASA-TLX, gate | ~10 min | Don't help with the task |
| 20-27 | **Part 3:** fear clip, rating, washout, anger clip, rating, **Stroop**, NASA-TLX, settle gate | ~10 min | Don't help with the task |
| 28-38 | **Movement and breathing:** seated rest, box breathing, paced breathing 6/10/15/20 per min, breath hold (max 60 s), head movement and speaking, standing, 60 s exertion (marching in place), recovery | ~9 min | Watch them for dizziness during breath hold, standing, exertion. Stop if unwell |
| 39-41 | Guided body scan (4 min), return to normal, PANAS end | ~6 min | Silence |
| 42 | Session complete | (you) | End the session (section E) |

**Return-to-baseline gates:** they pass when heart rate and skin conductance are back near the resting baseline for 15 s. If a gate won't pass (for example GSR drifting), override it **with a written reason**.

**Artifact hotkeys** (press in the instructor console whenever something happens):
T talking (on/off) · L left seat (on/off) · O operator in view (on/off) · C cough/sneeze · M large movement · D door/other people · P phone.

## D. Do's and don'ts

**Do**
- Keep the instructor tab open and visible; the session pauses itself if it closes.
- Mark every disturbance with the hotkeys straight away.
- Keep lighting, camera position, and exposure unchanged for the whole session.
- Keep the Frontier X phone app open, screen awake, and charging.
- Ask the participant to keep the oximeter/GSR hand still on the table.
- Pause (play/pause button) for anything unplanned: bathroom, discomfort, sensor falling off. Resume only when signals are back.
- Watch the Overview for red sensors; fix and note them in the session messages.
- Stop immediately if the participant feels unwell. Their safety comes before the recording.

**Don't**
- Don't unplug or replug USB devices while recording. The cameras can't reconnect without restarting the agent.
- Don't use the Huasheng USB 2.0 hub for cameras; it reset three times during testing.
- Don't talk, move, or stand behind the participant except in the conversation step.
- Don't change the Sony's settings, zoom, or position after START SESSION.
- Don't close the subject display or let the participant screen sleep.
- Don't let other programs use the ESP32 port (for example the Breathing-Rate Streamlit dashboard).
- Don't skip the screening or override a gate without writing why.
- Don't enter names in participant details; use categories only.

## E. Ending
1. At step 42 (or to stop early), press **End session** in the instructor console.
2. Wait for "Analysis bundle written" (about 2-3 minutes for a full session); don't close anything before then.
3. Remove sensors; thank the participant.
4. Check `export/qa_report.md` in `.local-run/recordings/session_09004JW4_*`:
   - Every step at least 95% coverage for the required streams
   - ECG and oximeter heart rate agree
   - GSR above 0 uS the whole time
   - Face frames equal the frame timestamp rows
