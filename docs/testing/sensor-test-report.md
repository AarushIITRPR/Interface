# Meridian sensor test report

Status as of 15 September 2026. Evidence:
- **Emulator run:** session `0030KU2P`, all 12 streams, 11 minutes, full export.
- **Real hardware:** session `0900NDYW`, still in setup. Sensors streamed live and preflight passed, but **no real-hardware recording or export exists yet**. Its recording folders hold only CSV header rows and camera settings.

Legend: [x] verified, [ ] still to test.

## A. Real hardware, checked live only (never recorded)

| Sensor | Device | Verified | Still to test |
|---|---|---|---|
| Face camera 1 | Logitech BCC950 (`/dev/v4l/by-id/usb-046d_BCC950...`) | 640x480 at 30 fps, 0 dropped frames, exposure/white balance/gain lock accepted | Face detection, live rPPG, recorded `face.mkv`, rPPG vs ECG |
| Face camera 2 | Sony a6700 USB streaming | 1280x720 at 25 fps, 0 dropped frames | Exposure lock (not accepted; set manually on camera), face detection, rPPG, recording, disk rate, `face2` in export |
| Audio | DJI Mic Mini into Sony mic jack | 48 kHz, signal detected; mic arrives on right channel only, stereo averaged to mono | Recorded `audio.wav` level, speech clarity, audio envelope derivative |
| Pulse oximeter | CMS50E (`/dev/ttyUSB1`) | 58-60 Hz packets; HR 84-90 and SpO2 97-98% decoded | Stable finger-on signal through a session, recording, HR agreement panel |
| ECG | Frontier X live share link | 125 Hz packets; HR 78-87 plausible | Reading of 182 bpm (likely poor contact), app-side stream stops, R-peaks and RMSSD in export |
| EDA / GSR | ESP32 JSON (`/dev/ttyUSB2`) | 20 Hz lines parsed | Any real signal (always 0.00 uS so far), skin conductance responses, baseline gate |
| WiFi CSI receiver 1 | ESP32 I/Q, transmitter on powerbank | 100 Hz, 57 subcarriers; I/Q line format now parsed | Empty-room baseline, breathing from real CSI, amplitudes in BIDS export (board currently unplugged) |
| Thermal camera | FLIR UVC, YUYV 640x480 | About 10-11 fps (RGB) | Recording, temperature values (this camera offers no 16-bit radiometric mode), currently unplugged |

## B. Tested only with emulators

| Sensor | Wire format the agent expects | Real test needed |
|---|---|---|
| EMG | ESP32 `t_us,seq,raw` at 1 kHz, 921600 baud, answers `?` with `# emg1` header | Board and electrodes; RMS at rest vs exertion |
| WiFi CSI receiver 2 | Same as receiver 1 | Second ESP32 receiver; both receivers in the empty-room baseline |
| Respiration belt | ESP32 `t_us,raw` at 50 Hz, 115200 baud | Belt on chest; detected rate during 6 and 20 breaths/min pacers |
| Photodiode | ESP32 `t_us,raw` at 1 kHz, 921600 baud | Sensor on subject screen corner; every display event matched, latency median/p95 |
| Room environment | `t_ms,temp_c,humidity_pct,lux[,pressure_hpa]` or JSON at 1 Hz | BME280 plus light sensor at the participant's face |

## C. Listed in the sensor catalogue but no driver exists
PPG, motion IMU, eye tracking, screen capture, interaction log. These can't be tested until drivers are written.

## D. System features never run end to end on real hardware
- Full recording: session start, protocol steps, finalize (the subject display has never connected)
- Export: QA report, derivatives, BIDS copy, share manifest with real consent
- Empty-room CSI baseline
- Return-to-baseline gate with real heart rate and skin conductance
- Heart-rate agreement panel with three real sources (ECG, oximeter, face rPPG)
- Photodiode display-latency check
- Two lossless cameras recording together (disk throughput, dropped frames)
- Continuous replay rating, LSL output, radiometric thermal (Y16)

## Fix before testing
- [ ] GSR reads 0.00 uS: check electrodes and wiring
- [ ] ECG shows 182 bpm: wet electrodes, tighten strap; keep the app streaming
- [ ] Oximeter "searching for finger": insert finger fully
- [ ] Sony a6700: set exposure, ISO, and white balance manually (USB lock not supported)
- [ ] Reconnect FLIR thermal camera and CSI receiver
- [ ] Web server listens on 127.0.0.1 only: restart with a LAN address if the subject display is on another computer
- [ ] Commit the uncommitted code changes: CSI I/Q parsing, `face2` camera, stereo audio downmix, preflight race fix

## Test plan

### 1. Short real recording with the current kit (face, face2, audio, oximeter, ECG, GSR)
- [ ] Start session with subject display connected; record 5 minutes; end and finalize
- [ ] `face/face.mkv` and `face2/face2.mkv` frame counts equal their `*_frames.csv` rows; dropped frames < 1%
- [ ] `audio/audio.wav` has speech well above the room noise
- [ ] Oximeter and ECG heart rate agree within 8 bpm at rest
- [ ] GSR above 0 uS and changes when the participant takes a deep breath
- [ ] Export folder has `qa_report.md`, `derivatives/physio_summary.tsv`, `bids/`

### 2. Thermal and CSI
- [ ] Reconnect both; preflight passes with them required
- [ ] Empty room: record 60 s baseline, packets reported for the receiver
- [ ] Participant seated: CSI amplitude variation clearly higher than empty room
- [ ] Thermal recording plays back; nose and face region visible

### 3. Emulator-only boards, one at a time (EMG, respiration belt, photodiode, environment, CSI receiver 2)
- [ ] Identify port from its data lines; assign in Recording setup; preflight
- [ ] 2-minute recording; rate within 5% of target, no dropped samples
- [ ] Sensor-specific check from section B

### 4. Full protocol pilot (about 50 minutes)
- [ ] All connected sensors required; subject display runs every step
- [ ] Return-to-baseline gate passes on real data (or override logged)
- [ ] Heart-rate agreement panel shows all sources
- [ ] Photodiode check matches every display event
- [ ] QA report reviewed; issues noted for the next participant
