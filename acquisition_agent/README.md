# Meridian acquisition agent

This service runs on the computer physically connected to the subject's sensors. It records raw high-rate streams locally and sends only health telemetry, task markers, sample counts, latest readings, alerts, and final file manifests to Meridian.

The implementation adapts the supplied `dataset-sync`, `csi-hr-c5`, and `emg-checker` acquisition logic:

- CMS50E V7 9-byte packets, keepalive, HR, SpO2, signal strength, and pleth recording
- ESP32 WiFi CSI CSV recording with host clock anchors and RSSI telemetry
- ESP32 EMG `t_us,seq,raw` recording at 921600 baud with reconnect behavior
- ESP32 GSR JSON line recording
- Cross-platform OpenCV camera recording using DirectShow on Windows and V4L2 on Linux
- Optional microphone capture using the system audio input
- Generic timestamped newline recording for an explicitly configured ECG serial device

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

## Start a recording

Create or restore a session in the instructor portal. Copy the subject code and the separate acquisition token shown there. Then run:

```text
python -m meridian_agent --code 0009AB7K --token mac_REPLACE_ME
```

On Linux, serial ports normally look like `/dev/ttyUSB0` or `/dev/ttyACM0`.

The agent auto-detects the camera and CMS50E, then probes unclaimed serial ports for the EMG header, GSR JSON shape, and CSI CSV shape before opening any recorder. Explicit ports can still be provided when a lab has fixed device assignments:

```text
python -m meridian_agent --code 0009AB7K --token mac_REPLACE_ME --csi COM5 --emg COM6 --gsr COM7 --ecg COM8
```

Use `none` for unavailable devices. On multi-device production rigs, explicit stable port assignments remain preferable because they reduce preflight time and prevent operating-system port renumbering.

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
