# Meridian acquisition agent

This service runs on the computer physically connected to the subject's sensors. It records raw high-rate streams locally and sends only health telemetry, task markers, sample counts, latest readings, alerts, and final file manifests to Meridian.

The implementation adapts the supplied `dataset-sync`, `csi-hr-c5`, and `emg-checker` acquisition logic:

- CMS50E V7 9-byte packets, keepalive, HR, SpO2, signal strength, and pleth recording
- ESP32 WiFi CSI CSV recording with host clock anchors and RSSI telemetry
- ESP32 EMG `t_us,seq,raw` recording at 921600 baud with reconnect behavior
- ESP32 GSR JSON line recording
- Cross-platform OpenCV camera recording using DirectShow on Windows and V4L2 on Linux
- Optional microphone capture using the system audio input
- Frontier X live-share ECG capture over the manufacturer WebSocket, including packet deduplication, gap detection, heart rate telemetry, timestamp reconstruction, and reconnect behavior
- Generic timestamped newline recording remains available as a legacy ECG serial fallback

## Install

Use Python 3.11 or newer on the acquisition computer.

```text
cd acquisition_agent
python -m venv .venv
```

Windows:

```text
.venv\Scripts\activate
python -m pip install -r requirements.txt
```

Ubuntu:

```text
source .venv/bin/activate
python -m pip install -r requirements.txt
```

## Hardware-first workflow

Create or restore a session in the instructor portal. Copy the subject code and the separate acquisition token shown there. Start the agent once with the short command below. Device selection, hardware refresh, required-stream selection, the 10-second test, and recording start are then controlled from Meridian Setup.

```text
python -m meridian_agent --code 0009AB7K --token mac_REPLACE_ME
```

For a local Meridian server, include `--server http://localhost:3000`. The optional loopback camera preview is available only to the browser on the same Windows computer as the agent. Raw camera frames and sensor samples are never uploaded through the portal.

On Linux, serial ports normally look like `/dev/ttyUSB0` or `/dev/ttyACM0`.

The agent enumerates Windows cameras, microphone inputs, and serial devices for the Setup selectors. Serial Auto-detect validates the actual CMS50E packet stream, EMG header or packet sequence, GSR JSON shape, and CSI CSV shape. USB bridge identifiers are inventory metadata only because different sensors may use the same CP210x adapter. A COM port can be claimed by only one modality, and explicit assignments take priority. Explicit command-line ports remain available as fallback defaults for a lab with fixed assignments:

```text
python -m meridian_agent --code 0009AB7K --token mac_REPLACE_ME --csi COM5 --emg COM6 --gsr COM7 --ecg COM8
```

Use `none` for unavailable devices. On multi-device production rigs, explicit stable port assignments remain preferable because they reduce preflight time and prevent operating-system port renumbering.

## Frontier X ECG

ECG is the one network-fed modality. In **Recording setup**, enable ECG and paste the active Frontier X live ECG share link or its numeric user ID. Save the setup while the acquisition agent is connected. The agent subscribes to the Frontier X live-share WebSocket, validates the packet stream, and publishes its rolling waveform, device heart rate, 125 Hz sample rate, packet loss, and connection health through the same Meridian heartbeat used by the USB sensors.

During recording, Meridian writes `ecg/ecg.csv` with both the local monotonic clock and reconstructed Frontier X sample timestamps. It also keeps deduplicated source packets in `ecg/ecg_packets.jsonl`. The raw waveform remains on the acquisition computer.

The Frontier X integration follows the live-share protocol implemented in the supplied `Multimodal-Analysis-Dashboards` ECG capture. That endpoint is not a versioned public SDK, so a manufacturer webapp protocol change may require a corresponding adapter update.

## Video recording for contactless sensing

Face video is recorded losslessly by default (`--video-codec ffv1`, `.mkv`): JPEG-style compression removes the small colour changes remote photoplethysmography depends on. Lossless 1280x720 at 30 fps needs roughly 150 GB per hour, so for rPPG-focused studies consider `--camera-width 640 --camera-height 480` (about a quarter of that). `--video-codec mjpg` restores the old small, lossy files. Preflight now requires free disk for a 45-minute session with 50% margin.

About two seconds after the camera opens, the agent locks auto exposure, white balance, and gain at their settled values and writes `face/camera_settings.json`. The Setup view shows whether the camera accepted the lock; some webcams ignore it. `--no-camera-lock` leaves automatic control on. `--camera-fps 60` requests a higher frame rate.

For radiometric thermal cameras that expose 16-bit frames over UVC (for example FLIR Lepton on a PureThermal board), use `--thermal-format y16`. Frames are written as `thermal/thermal_y16.raw` (little-endian uint16) with `thermal_y16.json`; in the default `--thermal-units centikelvin`, degrees Celsius are `value / 100 - 273.15`. Every frame timestamp file has a `repeated` column that marks identical consecutive frames, such as a thermal camera's flat-field correction freeze.

The Overview shows heart rate from the ECG, the pulse oximeter, and a live face-video estimate (POS method on the face region) and warns when they differ by more than 8 bpm. The face-video estimate is operator feedback only, not a recorded reference.

## Additional serial sensors

| Stream | Option | Line format |
|---|---|---|
| Second WiFi CSI receiver | `--csi2 PORT` | Same as `--csi` |
| Respiration belt (ESP32 ADC) | `--resp PORT` (115200 baud) | `t_us,raw` or `t_us,seq,raw`; live breathing rate is shown |
| Room environment | `--environment PORT` (115200 baud) | `t_ms,temp_c,humidity_pct,lux[,pressure_hpa]` or JSON with those keys (`rh` accepted) |

These ports can also be assigned in Recording setup. In Setup, **Record empty room** captures a 60-second CSI baseline from every CSI receiver into `csi/empty_room_*.csv` before the participant sits down.

## Verification without hardware

```text
python -m meridian_agent --code SESSION_CODE --token ACQUISITION_TOKEN --simulate-all
```

The simulator exercises the same Meridian heartbeat, task marker, alert, manifest, and operator display path while writing clearly labeled simulated CSV files.

## Recording layout

Each run creates a new immutable session directory:

```text
recordings/session_CODE_TIMESTAMP/
  acquisition.json
  session_markers.jsonl
  manifest.json
  face/face.avi
  audio/audio.wav
  oximeter/oximeter.csv
  csi/csi.csv
  emg/emg.csv
  gsr/gsr.csv
  ecg/ecg.csv
  thermal/thermal.avi
```

Every stream contains a host timestamp or is anchored to the common monotonic session clock. The agent continues recording during temporary network loss. Raw sensor files are never sent through browser polling.

The acquisition token is a per-session secret. It is visible only in the instructor portal and must not be shown to the subject or committed to source control.
