from __future__ import annotations

import csv
import hashlib
import json
import math
import os
import platform
import queue
import random
import threading
import time
import wave
from collections import deque
from datetime import datetime, timezone
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterable
from urllib.parse import urlparse

from .models import RecordingArtifact, SensorReport
from .derivatives import csi_amplitudes
from .rppg import LiveRppg


TARGET_RATES = {"face":30.0,"audio":48000.0,"oximeter":60.0,"csi":100.0,"emg":1000.0,"gsr":20.0,"ecg":125.0,"thermal":9.0,"photodiode":1000.0,"csi2":100.0,"resp":50.0,"environment":1.0,"face2":30.0}

FRONTIERX_SCALE_PER_COUNT = 0.0000038146972
FRONTIERX_SAMPLE_RATE_HZ = 125.0
# A stream that lost this share of its samples is not a clean recording, whatever rate the device reported.
MAX_DROPOUT_PCT = 2.0
# The ESP32 receiver's timestamp is a 32-bit microsecond counter, so it returns to zero every 71.6 minutes.
CSI_TIMESTAMP_WRAP = 1 << 32
FRONTIERX_SERVER_COUNTS = {"frontierxapp.com":5,"frontierxs.com":5,"frontierxd.in":1}


def iso_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


CHECKSUM_PENDING = "pending"


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


class Sensor:
    def __init__(self, sensor_id: str, device: str, session_dir: Path, origin_mono: float):
        self.sensor_id = sensor_id
        self.device = device
        self.session_dir = session_dir
        self.origin_mono = origin_mono
        self.started_at = iso_now()
        self.ended_at = ""
        self.path: Path | None = None
        self._report = SensorReport(id=sensor_id, device=device)
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._sample_times: deque[float] = deque(maxlen=4096)
        self._last_sample_mono = 0.0
        self._series: deque[float] = deque(maxlen=160)
        self._metrics: dict[str, object] = {}
        self._validation: list[str] = []
        self._recording = threading.Event()
        self._recording_started_mono = 0.0
        self._recording_ended_mono = 0.0
        self._recorded_samples = 0
        self._dropped_samples = 0
        # Samples that reached the file, when that differs from the samples that reached the process (cameras).
        self._persisted_samples: int | None = None
        self._gap_count = 0
        self._total_gap_s = 0.0
        self._longest_gap_s = 0.0
        self._previous_sample_mono = 0.0
        self._side_capture: tuple | None = None
        self._final_report: SensorReport | None = None
        # Set by a sensor that is receiving samples which cannot be trusted, such as a frozen CSI
        # channel estimate. sample() rewrites status and detail on every frame, so a fault that
        # outlives one frame cannot live there; report() consults this instead.
        self._health_fault: str | None = None
        # Optional callback (sensor_id, rate_hz, value, monotonic_s), used for Lab Streaming Layer output.
        self.sample_listener: Callable[[str, float | None, float, float], None] | None = None
        self._side_rows = 0
        self._report.targetRateHz = TARGET_RATES.get(sensor_id)

    def start(self) -> None:
        self._thread = threading.Thread(target=self.run, name=f"meridian-{self.sensor_id}", daemon=True)
        self._thread.start()

    def run(self) -> None:
        raise NotImplementedError

    def stop(self) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=5)
        self.ended_at = iso_now()

    def start_recording(self) -> None:
        if not self._recording.is_set():
            self._recording_started_mono = time.monotonic()
            self.started_at = iso_now()
            self._recording.set()

    def start_side_capture(self, relative_path: str, header: list[str]) -> Path:
        """Write rows to a separate file outside the main recording, e.g. an empty-room CSI baseline during setup."""
        path = self.session_dir / relative_path
        path.parent.mkdir(parents=True, exist_ok=True)
        handle = path.open("w", newline="", buffering=1)
        writer = csv.writer(handle)
        writer.writerow(header)
        with self._lock:
            self._side_capture = (handle, writer)
            self._side_rows = 0
        return path

    def stop_side_capture(self) -> int:
        with self._lock:
            capture, self._side_capture = self._side_capture, None
            rows = self._side_rows
        if capture:
            capture[0].close()
        return rows

    def _side_write(self, row: list[object]) -> None:
        with self._lock:
            if self._side_capture is None:
                return
            self._side_capture[1].writerow(row)
            self._side_rows += 1

    def record_dropped(self, sample_count: int) -> None:
        """Count samples lost before they reached the recorder, such as a full audio or video queue."""
        if sample_count <= 0 or not self._recording.is_set():
            return
        with self._lock:
            self._dropped_samples += sample_count
            self._gap_count += 1

    def stop_recording(self) -> None:
        if self._recording.is_set():
            # Judge stream health when recording ends; later checks would count the finalization time as a stall.
            self._final_report = self.report()
            self._recording_ended_mono = time.monotonic()
            self.ended_at = iso_now()
            self._recording.clear()

    @property
    def is_recording(self) -> bool:
        return self._recording.is_set()

    def set_state(self, status: str, detail: str) -> None:
        with self._lock:
            self._report.status = status
            self._report.detail = detail[:160]
            self._report.hardwareDetected = status in ("connected", "recording", "delayed")

    def sample(self, latest: str, byte_count: int = 0, sample_count: int = 1,
               rate_hz: float | None = None, point: float | None = None,
               metrics: dict | None = None, validation: list[str] | None = None) -> None:
        current = time.monotonic()
        with self._lock:
            target = self._report.targetRateHz or 0.0
            # Like record_dropped, gaps only count as lost samples while recording; setup streams have no recorded denominator.
            if self._previous_sample_mono and target and self._recording.is_set():
                gap = current - self._previous_sample_mono
                expected = max(0.001, sample_count / target)
                if gap > max(0.5, expected * 5):
                    self._gap_count += 1
                    lost = max(0, round(gap * target) - sample_count)
                    self._dropped_samples += lost
                    self._total_gap_s += gap
                    self._longest_gap_s = max(self._longest_gap_s, gap)
            self._previous_sample_mono = current
            self._sample_times.append(current)
            self._last_sample_mono = current
            self._report.sampleCount += max(1,sample_count)
            self._report.latestValue = latest[:160]
            if self._recording.is_set():
                self._recorded_samples += max(1,sample_count)
                self._report.bytesWritten += max(0, byte_count)
            if rate_hz is not None:
                self._report.rateHz = rate_hz
            self._report.status = "recording" if self._recording.is_set() else "connected"
            self._report.detail = "Recording samples" if self._recording.is_set() else "Samples arriving"
            self._report.hardwareDetected = True
            self._report.dataDetected = True
            if point is not None and math.isfinite(float(point)):
                self._series.append(round(float(point),4))
            if metrics:
                self._metrics.update(metrics)
            if validation is not None:
                self._validation = validation[:8]
        listener = self.sample_listener
        if listener is not None and point is not None and math.isfinite(float(point)):
            try:
                listener(self.sensor_id, rate_hz, float(point), current)
            except Exception:
                self.sample_listener = None

    def report(self) -> SensorReport:
        with self._lock:
            result = SensorReport(**self._report.payload())
            now_mono = time.monotonic()
            recent = [stamp for stamp in self._sample_times if now_mono - stamp <= 5]
            if result.rateHz is None and len(recent) > 1:
                result.rateHz = round((len(recent) - 1) / max(0.001, recent[-1] - recent[0]), 2)
            if self._last_sample_mono:
                result.latencyMs = round((now_mono - self._last_sample_mono) * 1000, 1)
                if result.latencyMs > 8000:
                    result.status = "error"
                    result.detail = "Sample stream stopped"
                elif result.latencyMs > 3000:
                    result.status = "delayed"
                    result.detail = "Samples delayed"
            result.series = list(self._series)
            result.metrics = dict(self._metrics)
            result.validation = list(self._validation)
            result.droppedSamples = self._dropped_samples
            denominator = self._recorded_samples + self._dropped_samples
            result.dropoutPct = round(100 * self._dropped_samples / denominator,3) if denominator else 0.0
            if result.status == "missing":
                result.quality = "disabled" if self.device in ("", "none") else "bad"
            elif result.status == "error":
                result.quality = "bad"
            elif not result.dataDetected:
                result.quality = "waiting"
            elif self._health_fault:
                result.quality = "bad"
                result.detail = self._health_fault[:160]
            elif result.status == "delayed" or result.dropoutPct >= MAX_DROPOUT_PCT or (result.targetRateHz and result.rateHz is not None and result.rateHz < result.targetRateHz * 0.8):
                result.quality = "degraded"
            else:
                result.quality = "good"
            if self.path:
                result.recordingFile = str(self.path.relative_to(self.session_dir)).replace("\\", "/")
                try:
                    result.bytesWritten = self.path.stat().st_size
                except OSError:
                    pass
            return result

    def artifact(self, hash_file: bool = True) -> RecordingArtifact | None:
        """The manifest entry for this stream. `hash_file=False` defers the checksum, which takes minutes for video."""
        if not self.path or not self.path.exists():
            return None
        report = self._final_report or self.report()
        duration = max(0.0,(self._recording_ended_mono or time.monotonic()) - self._recording_started_mono) if self._recording_started_mono else 0.0
        # Count what reached the file, not what reached the process. On session 0101JUMR the face camera delivered a
        # clean 25.0 fps while the encoder queue discarded 42.6% of it; scoring the capture rate returned "pass" on a
        # 14.34 Hz recording.
        persisted = self._recorded_samples if self._persisted_samples is None else self._persisted_samples
        average_rate = persisted / duration if duration else 0.0
        quality = "pass" if persisted > 0 and report.status not in ("error", "missing") else "fail"
        if quality == "pass" and (report.dropoutPct >= MAX_DROPOUT_PCT or (report.targetRateHz and average_rate < report.targetRateHz * 0.8)):
            quality = "warning"
        return RecordingArtifact(
            sensorId=self.sensor_id,
            relativePath=str(self.path.relative_to(self.session_dir)).replace("\\", "/"),
            format=self.path.suffix.lstrip(".") or "binary",
            sampleCount=persisted,
            bytes=self.path.stat().st_size,
            sha256=sha256_file(self.path) if hash_file else CHECKSUM_PENDING,
            startedAt=self.started_at,
            endedAt=self.ended_at or iso_now(),
            quality=quality,
            durationSec=round(duration,3),
            averageRateHz=round(average_rate,3),
            droppedSamples=self._dropped_samples,
            dropoutPct=report.dropoutPct,
            gapCount=self._gap_count,
            totalGapSec=round(self._total_gap_s,3),
            longestGapSec=round(self._longest_gap_s,3),
            availabilityPct=round(100 * persisted / max(1,persisted+self._dropped_samples),3),
        )


class UnavailableSensor(Sensor):
    def __init__(self, sensor_id: str, detail: str, session_dir: Path, origin_mono: float):
        super().__init__(sensor_id, "", session_dir, origin_mono)
        self.reason = detail

    def run(self) -> None:
        self.set_state("missing", self.reason)
        self._stop.wait()


class SimulatedSensor(Sensor):
    RATES = {"face":30.0,"audio":48000.0,"oximeter":60.0,"csi":100.0,"emg":1000.0,"gsr":50.0,"ecg":500.0,"thermal":9.0,"photodiode":1000.0,"csi2":100.0,"resp":50.0,"environment":1.0,"face2":30.0}

    def __init__(self, sensor_id: str, session_dir: Path, origin_mono: float):
        super().__init__(sensor_id,"simulator",session_dir,origin_mono)
        self.path = session_dir / sensor_id / f"{sensor_id}_simulated.csv"

    def run(self) -> None:
        rate = self.RATES.get(self.sensor_id,10.0)
        interval = 0.1
        batch = max(1,round(rate*interval))
        self.path.parent.mkdir(parents=True,exist_ok=True)
        with self.path.open("a",newline="",buffering=1) as handle:
            writer = csv.writer(handle)
            if self.path.stat().st_size == 0:
                writer.writerow(["host_epoch_ns","monotonic_s","sample_count","value"])
            self.set_state("connected","Simulator active")
            phase = 0.0
            while not self._stop.wait(interval):
                phase += 0.28
                point = math.sin(phase) + 0.22 * math.sin(phase * 2.7)
                metrics: dict[str,object] = {}
                latest = "Simulated samples"
                validation = ["Hardware detected", "Samples arriving", "Rate within target"]
                if self.sensor_id == "oximeter":
                    point = 62 + 38 * max(0,math.sin(phase))
                    latest = "HR 72, SpO2 98%"
                    metrics = {"heartRate":72,"spo2":98,"signalStrength":82,"fingerDetected":True}
                    validation.append("Finger detected")
                elif self.sensor_id == "csi":
                    latest = "RSSI -47 dBm"
                    metrics = {"rssi":-47,"lostPackets":0,"subcarriers":52}
                elif self.sensor_id == "gsr":
                    point = 3.1 + 0.25 * math.sin(phase / 3)
                    latest = f"{point:.2f} uS"
                    metrics = {"conductance":round(point,2),"baseline":2.84,"zscore":round((point-2.84)/0.6,2)}
                elif self.sensor_id == "audio":
                    point = 38 + 24 * abs(math.sin(phase * 1.8))
                    metrics = {"levelPct":round(point),"sampleRate":48000}
                elif self.sensor_id in ("face","face2","thermal"):
                    metrics = {"width":640 if self.sensor_id == "thermal" else 1280,"height":480 if self.sensor_id == "thermal" else 720,"fps":rate,"droppedFrames":0}
                    if self.sensor_id in ("face","face2"):
                        metrics.update({"faceDetected":True,"rppgHeartRate":round(71.5 + 1.5 * math.sin(phase / 9),1),"rppgQuality":0.52})
                elif self.sensor_id == "resp":
                    point = 2048 + 600 * math.sin(phase / 1.6)
                    latest = "15 breaths/min"
                    metrics = {"breathingRate":15.0,"raw":round(point)}
                elif self.sensor_id == "environment":
                    latest = "23.4 C, 48% RH, 310 lux"
                    metrics = {"tempC":23.4,"humidityPct":48.0,"lux":310.0}
                elif self.sensor_id == "csi2":
                    latest = "RSSI -52 dBm"
                    metrics = {"rssi":-52,"lostPackets":0,"subcarriers":52}
                row = [time.time_ns(),f"{time.monotonic()-self.origin_mono:.6f}",batch,latest]
                if self._recording.is_set():
                    writer.writerow(row)
                self._side_write(row)
                self.sample(latest,32 if self._recording.is_set() else 0,batch,rate,point,metrics,validation)


class SerialLineSensor(Sensor):
    header: list[str] = ["host_epoch_ns", "monotonic_s", "raw_line"]

    def __init__(self, sensor_id: str, port: str, baud: int, session_dir: Path, origin_mono: float):
        super().__init__(sensor_id, port, session_dir, origin_mono)
        self.port = port
        self.baud = baud
        self.path = session_dir / sensor_id / f"{sensor_id}.csv"

    def parse(self, line: str) -> tuple[list[object], str] | None:
        return [line], line

    def on_open(self, serial_port) -> None:
        del serial_port

    def telemetry(self, values: list[object]) -> tuple[float | None,dict,list[str]]:
        point = None
        try:
            point = float(values[-1])
        except (ValueError,TypeError,IndexError):
            pass
        return point,{},["Hardware detected","Protocol validated","Samples arriving"]

    def run(self) -> None:
        try:
            import serial
        except Exception as exc:
            self.set_state("error",f"Serial support unavailable: {type(exc).__name__}")
            return

        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.path.open("a", newline="", buffering=1) as handle:
            writer = csv.writer(handle)
            if self.path.stat().st_size == 0:
                writer.writerow(self.header)
            while not self._stop.is_set():
                serial_port = None
                try:
                    self.set_state("unknown", f"Opening {self.port}")
                    serial_port = serial.Serial(self.port, self.baud, timeout=0.2)
                    serial_port.reset_input_buffer()
                    self.on_open(serial_port)
                    self.set_state("connected", f"{self.port} at {self.baud}")
                    while not self._stop.is_set():
                        raw = serial_port.readline()
                        if not raw:
                            continue
                        line = raw.decode("utf-8", "replace").strip()
                        if not line:
                            continue
                        parsed = self.parse(line)
                        if parsed is None:
                            continue
                        values, latest = parsed
                        row = [time.time_ns(), f"{time.monotonic() - self.origin_mono:.6f}", *values]
                        if self._recording.is_set():
                            writer.writerow(row)
                        self._side_write(row)
                        point,metrics,validation = self.telemetry(values)
                        self.sample(latest,len(raw) if self._recording.is_set() else 0,point=point,metrics=metrics,validation=validation)
                except Exception as exc:
                    self.set_state("error", f"{type(exc).__name__}: {str(exc)[:120]}")
                    self._stop.wait(1)
                finally:
                    if serial_port is not None:
                        try:
                            serial_port.close()
                        except Exception:
                            pass


class EmgSensor(SerialLineSensor):
    header = ["host_epoch_ns", "monotonic_s", "device_t_us", "sequence", "raw_adc"]

    def on_open(self, serial_port) -> None:
        serial_port.write(b"?")
        serial_port.flush()

    def parse(self, line: str) -> tuple[list[object], str] | None:
        if line.startswith("#"):
            return None
        parts = line.split(",")
        if len(parts) != 3:
            return None
        try:
            device_t, sequence, raw = (int(value) for value in parts)
        except ValueError:
            return None
        return [device_t, sequence, raw], f"Raw {raw}"

    def telemetry(self, values: list[object]) -> tuple[float | None,dict,list[str]]:
        raw = int(values[2]); sequence = int(values[1])
        previous = self._metrics.get("lastSequence")
        if isinstance(previous,int) and sequence > previous + 1:
            self._dropped_samples += sequence - previous - 1
        self._metrics["lastSequence"] = sequence
        centered = raw - 2048
        return float(centered),{"raw":raw,"rms":round(abs(centered)/2048,3),"clippingPct":100.0 if raw in (0,4095) else 0.0},["Hardware detected","EMG packet format valid","Samples arriving"]


class AdcLineSensor(SerialLineSensor):
    """ESP32 analogue channel sent as `t_us,raw` or `t_us,seq,raw` lines."""

    header = ["host_epoch_ns", "monotonic_s", "device_t_us", "raw"]

    def parse(self, line: str) -> tuple[list[object], str] | None:
        if line.startswith("#"):
            return None
        parts = line.split(",")
        if len(parts) not in (2, 3):
            return None
        try:
            device_t, raw = int(parts[0]), int(parts[-1])
        except ValueError:
            return None
        return [device_t, raw], f"Level {raw}"


class PhotodiodeSensor(AdcLineSensor):
    """Light sensor on the subject screen's sync patch."""

    def telemetry(self, values: list[object]) -> tuple[float | None,dict,list[str]]:
        raw = int(values[1])
        low = min(raw, int(self._metrics.get("minLevel", raw)))
        high = max(raw, int(self._metrics.get("maxLevel", raw)))
        return float(raw),{"level":raw,"minLevel":low,"maxLevel":high},["Hardware detected","Photodiode line format valid","Samples arriving"]


def breathing_rate_bpm(times_s: list[float], values: list[float]) -> float | None:
    """Breaths per minute from a respiration belt trace: smoothed, mean-removed, upward zero crossings with hysteresis."""
    if len(values) < 20 or times_s[-1] - times_s[0] < 10:
        return None
    window = max(1, len(values) // max(1, round(times_s[-1] - times_s[0])) // 2)
    smoothed = [sum(values[max(0, i - window):i + window + 1]) / len(values[max(0, i - window):i + window + 1]) for i in range(len(values))]
    mean = sum(smoothed) / len(smoothed)
    centred = [value - mean for value in smoothed]
    spread = (max(centred) - min(centred)) or 1.0
    band = 0.1 * spread
    crossings = []
    state = centred[0] > 0
    for stamp, value in zip(times_s, centred):
        if not state and value > band:
            crossings.append(stamp)
            state = True
        elif state and value < -band:
            state = False
    if len(crossings) < 2:
        return None
    return round(60 * (len(crossings) - 1) / (crossings[-1] - crossings[0]), 1)


class RespirationSensor(AdcLineSensor):
    """Chest respiration belt (strain gauge or conductive rubber) on an ESP32 ADC, the breathing-rate reference."""

    def __init__(self, sensor_id: str, port: str, baud: int, session_dir: Path, origin_mono: float):
        super().__init__(sensor_id, port, baud, session_dir, origin_mono)
        self._trace: deque[tuple[float, float]] = deque(maxlen=3000)
        self._last_rate_mono = 0.0

    def telemetry(self, values: list[object]) -> tuple[float | None,dict,list[str]]:
        raw = float(values[1])
        current = time.monotonic()
        self._trace.append((current, raw))
        while self._trace and current - self._trace[0][0] > 30:
            self._trace.popleft()
        metrics: dict = {"raw": raw}
        if current - self._last_rate_mono >= 2:
            self._last_rate_mono = current
            rate = breathing_rate_bpm([t for t, _ in self._trace], [v for _, v in self._trace])
            if rate is not None:
                metrics["breathingRate"] = rate
        return raw,metrics,["Hardware detected","Respiration line format valid","Samples arriving"]


class EnvironmentSensor(SerialLineSensor):
    """Room temperature, humidity, light at the face, and pressure (e.g. BME280 + light sensor), about 1 Hz.

    Accepts `t_ms,temp_c,humidity_pct,lux[,pressure_hpa]` or JSON with the same keys (`rh` for humidity).
    """

    header = ["host_epoch_ns", "monotonic_s", "device_t_ms", "temp_c", "humidity_pct", "lux", "pressure_hpa"]

    def parse(self, line: str) -> tuple[list[object], str] | None:
        if line.startswith("#"):
            return None
        try:
            if line.startswith("{"):
                data = json.loads(line)
                values = [data.get("t_ms", ""), data.get("temp_c"), data.get("humidity_pct", data.get("rh")), data.get("lux"), data.get("pressure_hpa", "")]
            else:
                parts = line.split(",")
                if len(parts) not in (4, 5):
                    return None
                values = parts + ([""] if len(parts) == 4 else [])
            temp, humidity, lux = float(values[1]), float(values[2]), float(values[3])
        except (ValueError, TypeError, json.JSONDecodeError):
            return None
        pressure = "" if values[4] in ("", None) else float(values[4])
        return [values[0], temp, humidity, lux, pressure], f"{temp:.1f} C, {humidity:.0f}% RH, {lux:.0f} lux"

    def telemetry(self, values: list[object]) -> tuple[float | None,dict,list[str]]:
        metrics = {"tempC": float(values[1]), "humidityPct": float(values[2]), "lux": float(values[3])}
        if values[4] != "":
            metrics["pressureHpa"] = float(values[4])
        return float(values[3]),metrics,["Hardware detected","Environment line format valid","Samples arriving"]


# esptool's reset sequence, ported from the csi-hr-c5 rig (host/preflight.py). pyserial asserts DTR
# when it opens a port, but an assert without an edge is not a reset: a C5 left asleep by a replug
# stays asleep and the port reads silent indefinitely. Measured there: silent for 6 s before the
# pulse, 931 CSI rows in the 10 s after it.
CSI_RESET_HOLD_S = 0.12
# Frozen-channel gates from the same rig (host/validate_csi.py, esp-idf#18493). The 5 GHz path can
# return a channel estimate that never updates while frame rate, RSSI and I/Q stay plausible, so
# nothing downstream notices: the FFT of a constant is a clean DC line, which reads as "no motion"
# rather than "no data". A healthy reference capture: 1931/1931 frames unique, amplitude std 1.43.
CSI_MIN_AMPLITUDE_STD = 0.5
CSI_MAX_REPEAT_FRACTION = 0.5
CSI_MIN_UNIQUE_FRAMES = 10
CSI_FROZEN_WINDOW = 2000       # 20 s at the nominal 100 Hz, matching the reference capture length
CSI_FROZEN_MIN_FRAMES = 100    # below this there is nothing to test, so no verdict either way
CSI_FROZEN_INTERVAL = 100      # recheck about once per second rather than on every frame


class CsiSensor(SerialLineSensor):
    header = ["host_epoch_ns", "monotonic_s", "device_timestamp", "packet_id", "rssi", "raw_line"]

    def __init__(self, sensor_id: str, port: str, baud: int, session_dir: Path, origin_mono: float):
        super().__init__(sensor_id, port, baud, session_dir, origin_mono)
        self._csi_frames: deque[tuple[float, ...]] = deque(maxlen=CSI_FROZEN_WINDOW)
        self._csi_since_check = 0
        self._csi_stats: dict[str, object] = {}
        self._csi_reset = False
        self._csi_last_raw_timestamp: int | None = None
        self._csi_timestamp_epochs = 0

    def on_open(self, serial_port) -> None:
        """Pulse the auto-reset line so a receiver asleep after a replug starts streaming.

        Only while no frame has ever arrived. The C5 takes about 1.5 s to boot, so pulsing on every
        reconnect attempt resets a board that is already booting and it never reaches the point of
        streaming.
        """
        with self._lock:
            if self._report.dataDetected:
                return
        try:
            serial_port.dtr = False
            serial_port.rts = True
            time.sleep(CSI_RESET_HOLD_S)
        finally:
            # Leaving RTS asserted holds EN low forever, which looks exactly like a dead board.
            serial_port.rts = False
        serial_port.reset_input_buffer()
        serial_port.readline()  # discard the partial line the reset cut in half
        self._csi_reset = True

    def _track_frozen(self, amplitudes: list[float]) -> None:
        """Flag a channel estimate that is not updating, using the reference rig's three gates.

        Amplitudes stand in for the raw I/Q vectors the reference compares: a stuck estimate repeats
        its I/Q exactly, so the magnitudes repeat exactly too, and this stays correct for both line
        layouts csi_amplitudes accepts.
        """
        self._csi_frames.append(tuple(amplitudes))
        self._csi_since_check += 1
        if self._csi_since_check < CSI_FROZEN_INTERVAL or len(self._csi_frames) < CSI_FROZEN_MIN_FRAMES:
            return
        self._csi_since_check = 0
        frames = list(self._csi_frames)
        width = min(len(frame) for frame in frames)
        if not width:
            return
        trimmed = [frame[:width] for frame in frames]
        count = len(trimmed)
        repeats = sum(1 for index in range(1, count) if trimmed[index] == trimmed[index - 1])
        repeat_fraction = repeats / max(1, count - 1)
        unique = len(set(trimmed))
        max_std = 0.0
        for column in range(width):
            mean = math.fsum(frame[column] for frame in trimmed) / count
            variance = math.fsum((frame[column] - mean) ** 2 for frame in trimmed) / count
            max_std = max(max_std, math.sqrt(variance))
        if max_std < CSI_MIN_AMPLITUDE_STD:
            fault = f"CSI frozen: amplitude std {max_std:.2f} under {CSI_MIN_AMPLITUDE_STD} on every subcarrier (esp-idf#18493)"
        elif repeat_fraction > CSI_MAX_REPEAT_FRACTION:
            fault = f"CSI frozen: {repeat_fraction:.0%} of frames identical to the previous one (esp-idf#18493)"
        elif unique < CSI_MIN_UNIQUE_FRAMES:
            fault = f"CSI frozen: only {unique} distinct frames in {count} (esp-idf#18493)"
        else:
            fault = None
        self._csi_stats = {"amplitudeStd":round(max_std,3),"repeatFraction":round(repeat_fraction,3),"uniqueFrames":unique,"frozenWindow":count}
        with self._lock:
            self._health_fault = fault

    def parse(self, line: str) -> tuple[list[object], str] | None:
        if line.startswith("#"):
            return None
        raw_line = line[9:] if line.startswith("CSI_DATA,") else line
        parts = raw_line.split(",")
        if len(parts) < 8:
            return None
        try:
            timestamp = self._unwrap_device_timestamp(int(parts[0]))
            packet_id = parts[1]
            rssi = float(parts[2])
        except (ValueError, IndexError):
            return None
        return [timestamp, packet_id, rssi, line], f"RSSI {rssi:g} dBm"

    def _unwrap_device_timestamp(self, raw: int) -> int:
        """Extend the receiver's 32-bit microsecond counter so it keeps increasing past its 71.6 minute wrap.

        The counter is board uptime, not capture time, so the headroom is whatever is left when recording starts:
        session 0101JUMR began at 233 s of uptime and ended with 36 min to spare. A rig powered on during setup
        and recorded an hour later wraps mid-session, and the timestamps go backwards.
        """
        if self._csi_last_raw_timestamp is not None and raw < self._csi_last_raw_timestamp - CSI_TIMESTAMP_WRAP // 2:
            self._csi_timestamp_epochs += 1
        self._csi_last_raw_timestamp = raw
        return raw + self._csi_timestamp_epochs * CSI_TIMESTAMP_WRAP

    def telemetry(self, values: list[object]) -> tuple[float | None,dict,list[str]]:
        rssi = float(values[2]); amplitudes = csi_amplitudes(str(values[3]))
        if amplitudes:
            self._series.clear(); self._series.extend(amplitudes[:64])
            self._track_frozen(amplitudes)
        metrics: dict = {"rssi":rssi,"subcarriers":len(amplitudes) or 52}
        metrics.update(self._csi_stats)
        validation = ["Hardware detected","CSI packet format valid"]
        if self._csi_reset:
            validation.append("Reset pulse sent")
        fault = self._health_fault
        validation.append(fault if fault else "Samples arriving")
        return rssi,metrics,validation


class GsrSensor(SerialLineSensor):
    header = ["host_epoch_ns", "monotonic_s", "conductance_us", "raw_adc", "stress", "zscore"]

    def parse(self, line: str) -> tuple[list[object], str] | None:
        try:
            data = json.loads(line)
            conductance = float(data.get("uS", 0))
            raw = int(data.get("raw", 0))
            stress = float(data.get("stress", 0))
            zscore = float(data.get("zScore", 0))
        except (ValueError, TypeError, json.JSONDecodeError):
            return None
        return [conductance, raw, stress, zscore], f"{conductance:.2f} uS"

    def telemetry(self, values: list[object]) -> tuple[float | None,dict,list[str]]:
        conductance=float(values[0]); zscore=float(values[3])
        baseline_values=list(self._series)[-60:]
        baseline=sum(baseline_values)/len(baseline_values) if baseline_values else conductance
        return conductance,{"conductance":round(conductance,3),"baseline":round(baseline,3),"zscore":round(zscore,3)},["Hardware detected","GSR packet format valid","Conductance samples arriving"]


class GenericSerialSensor(SerialLineSensor):
    header = ["host_epoch_ns", "monotonic_s", "raw_line"]


def parse_frontierx_source(source: str) -> tuple[str,str]:
    """Return the Frontier X user id and API domain from a safe source value."""
    value = (source or "").strip()
    if value.lower().startswith("frontierx:"):
        value = value.split(":",1)[1]
        if "@" in value:
            user_id,domain = value.split("@",1)
            domain = domain.lower().strip()
            if user_id.isdigit() and domain in FRONTIERX_SERVER_COUNTS:
                return user_id,domain
            raise ValueError("Invalid Frontier X source")
    if value.startswith(("http://","https://")):
        parsed = urlparse(value)
        host = (parsed.hostname or "").lower()
        matching = next((domain for domain in FRONTIERX_SERVER_COUNTS if host == f"liveecg.{domain}"),None)
        parts = [part for part in parsed.path.split("/") if part]
        if parsed.scheme != "https" or not matching or not parts or not parts[0].isdigit():
            raise ValueError("Use a valid HTTPS Frontier X live ECG share link")
        return parts[0],matching
    if value.isdigit():
        return value,"frontierxapp.com"
    raise ValueError("Use a Frontier X live ECG share link or numeric user id")


def is_frontierx_source(source: str) -> bool:
    value = (source or "").strip().lower()
    return value.startswith("frontierx:") or value.startswith("https://liveecg.") or value.isdigit()


def frontierx_subscribe_payload(user_id: str, server_number: int) -> str:
    return json.dumps({"action":"sendmessage","data":{"userid":str(user_id),"role":"USER","type":"STREAMING","server":f"server{server_number}"}},separators=(",",":"))


def frontierx_clock_offset_ms(lags_ms: Iterable[float]) -> float | None:
    """Transport delay between the Frontier X device clock and the host clock, as the smallest lag observed.

    Packets arrive over a WebSocket in ~1 s bursts, so an individual arrival time says almost nothing about when
    its samples were measured: in session 0101JUMR the lag ranged 3.84-21.02 s, 17.2 s of pure queueing jitter.
    The floor of that distribution is the one arrival that queued the least, so it is the best estimate of the
    fixed part of the delay. Measured on that session the floor drifts -4.7 ppm (8.5 ms over 32 min), well under
    its own 14.3 ms scatter, so a constant beats a fitted line - there is no drift to fit, only noise.
    """
    floor = None
    for lag in lags_ms:
        if floor is None or lag < floor:
            floor = lag
    return floor


def restamp_frontierx_csv(path: Path) -> dict | None:
    """Rewrite an ecg.csv so host_epoch_ns comes from the device clock, using the whole file's arrival floor.

    The live writer tracks the floor as it goes, so its earliest rows carry whatever the floor was worth after a
    handful of packets. This second pass sees every arrival and re-stamps uniformly. It also upgrades a file
    written before arrival_epoch_ns existed, where host_epoch_ns still holds the arrival time.
    """
    if not path.exists():
        return None
    with path.open(newline="", encoding="utf-8") as handle:
        rows = list(csv.reader(handle))
    if len(rows) < 2:
        return None
    header = rows[0]
    legacy = "arrival_epoch_ns" not in header
    try:
        host_at, mono_at, sample_at = (header.index(name) for name in ("host_epoch_ns", "monotonic_s", "sample_time_ms"))
        index_at = header.index("sample_index")
        arrival_at = host_at if legacy else header.index("arrival_epoch_ns")
    except ValueError:
        return None
    body = [row for row in rows[1:] if len(row) == len(header)]
    if not body:
        return None
    lags = [int(row[arrival_at]) / 1e6 - float(row[sample_at]) for row in body]
    offset_ms = frontierx_clock_offset_ms(lags)
    if offset_ms is None:
        return None
    # Anchor tying monotonic_s to the epoch clock. In a legacy file monotonic_s runs from the packet's arrival
    # plus sample_index/rate, so back out both to recover the instant the recording origin fell on.
    first = body[0]
    if legacy:
        origin_ns = int(first[arrival_at]) - round((float(first[mono_at]) - int(first[index_at]) / FRONTIERX_SAMPLE_RATE_HZ) * 1e9)
    else:
        origin_ns = int(first[host_at]) - round(float(first[mono_at]) * 1e9)
    for row in body:
        arrival = row[arrival_at]
        host_ns = round((float(row[sample_at]) + offset_ms) * 1e6)
        row[host_at] = str(host_ns)
        row[mono_at] = f"{(host_ns - origin_ns) / 1e9:.6f}"
        if legacy:
            row.insert(mono_at + 1, arrival)
    if legacy:
        header.insert(mono_at + 1, "arrival_epoch_ns")
    with path.open("w", newline="", encoding="utf-8") as handle:
        csv.writer(handle).writerows([header, *body])
    return {"offsetSec": round(offset_ms / 1000.0, 3), "jitterSec": round((max(lags) - offset_ms) / 1000.0, 3), "rows": len(body)}


class FrontierXEcgSensor(Sensor):
    """Capture Frontier X live-share ECG packets through the vendor WebSocket."""

    def __init__(self, source: str, session_dir: Path, origin_mono: float):
        self.user_id,self.domain = parse_frontierx_source(source)
        super().__init__("ecg",f"Frontier X API · user {self.user_id}",session_dir,origin_mono)
        self.path = session_dir / "ecg" / "ecg.csv"
        self.raw_path = session_dir / "ecg" / "ecg_packets.jsonl"
        self.last_packet_no: int | None = None
        self.session_timestamp: int | None = None
        self.accepted_packets = 0
        self.duplicate_packets = 0
        self.missed_packets = 0
        # Smallest arrival lag seen so far; see frontierx_clock_offset_ms. Converges within a few packets
        # (3.88 s after one packet against a 3.84 s final floor on session 0101JUMR).
        self.clock_offset_ms: float | None = None
        self.arrival_jitter_ms = 0.0
        # Epoch instant of the monotonic recording origin, so monotonic_s stays a pure function of host_epoch_ns
        # and a re-stamp can recover both from either one.
        self.epoch_at_origin_ns: int | None = None

    def accept_packet(self, packet: dict) -> dict | None:
        """Validate and deduplicate one wire packet for recording and telemetry."""
        data = packet.get("data")
        if not isinstance(data,list) or not data:
            return None
        try:
            counts = [float(value) for value in data]
            packet_no = int(packet["packetNo"])
            timestamp = int(packet["Timestamp"])
        except (KeyError,TypeError,ValueError):
            return None
        if self.session_timestamp is not None and timestamp != self.session_timestamp:
            self.last_packet_no = None
        self.session_timestamp = timestamp
        if self.last_packet_no is not None and packet_no <= self.last_packet_no:
            self.duplicate_packets += 1
            return None
        missed = max(0,packet_no - self.last_packet_no - 1) if self.last_packet_no is not None else 0
        self.last_packet_no = packet_no
        self.accepted_packets += 1
        self.missed_packets += missed
        if missed and self._recording.is_set():
            self._dropped_samples += missed * len(counts)
        heart_rate = packet.get("heartrate")
        try:
            heart_rate = round(float(heart_rate))
        except (TypeError,ValueError):
            heart_rate = None
        return {"packetNo":packet_no,"timestamp":timestamp,"counts":counts,"heartRate":heart_rate,"missed":missed}

    def run(self) -> None:
        try:
            import websocket
        except Exception as exc:
            self.set_state("error",f"Frontier X WebSocket support unavailable: {type(exc).__name__}")
            return

        self.path.parent.mkdir(parents=True,exist_ok=True)
        with self.path.open("a",newline="",buffering=1) as csv_handle,self.raw_path.open("a",encoding="utf-8",buffering=1) as raw_handle:
            writer = csv.writer(csv_handle)
            if self.path.stat().st_size == 0:
                writer.writerow(["host_epoch_ns","monotonic_s","arrival_epoch_ns","packet_no","session_start_ms","sample_time_ms","sample_index","raw_count","scaled_value","heart_rate"])
            while not self._stop.is_set():
                socket_client = None
                server_number = random.randint(1,FRONTIERX_SERVER_COUNTS[self.domain])
                try:
                    self.set_state("unknown",f"Connecting to Frontier X server {server_number}")
                    # MERIDIAN_FRONTIERX_WS_URL points at a local emulator for testing (tools/emulate_devices.py).
                    socket_url = os.environ.get("MERIDIAN_FRONTIERX_WS_URL") or f"wss://liveecgwsapi.{self.domain}/server{server_number}?Authorization=token"
                    socket_client = websocket.create_connection(socket_url,timeout=10)
                    socket_client.settimeout(1)
                    socket_client.send(frontierx_subscribe_payload(self.user_id,server_number))
                    self.set_state("connected","Frontier X live stream subscribed")
                    while not self._stop.is_set():
                        try:
                            raw_message = socket_client.recv()
                        except websocket.WebSocketTimeoutException:
                            continue
                        if not raw_message:
                            raise ConnectionError("Frontier X stream closed")
                        try:
                            message = json.loads(raw_message)
                        except (json.JSONDecodeError,TypeError):
                            continue
                        for packet in message if isinstance(message,list) else [message]:
                            if not isinstance(packet,dict):
                                continue
                            message_type = packet.get("type")
                            if message_type == "livecg-begin":
                                self.last_packet_no = None
                                self.set_state("connected","Frontier X device started streaming")
                            elif message_type == "livecg-end":
                                self.set_state("delayed","Frontier X device stopped streaming")
                            accepted = self.accept_packet(packet)
                            if accepted is None:
                                continue
                            counts = accepted["counts"]
                            scaled = [value * FRONTIERX_SCALE_PER_COUNT for value in counts]
                            arrival_epoch_ns = time.time_ns()
                            if self.epoch_at_origin_ns is None:
                                self.epoch_at_origin_ns = arrival_epoch_ns - round((time.monotonic() - self.origin_mono) * 1e9)
                            base_ms = accepted["timestamp"] + accepted["packetNo"] * 1000
                            # Timestamp from the device clock, not from arrival. base_ms is exact - the device emits
                            # one packet per second and 125 samples inside it, giving deltas of exactly 8 ms with no
                            # gaps - so the only unknown is the fixed transport delay, tracked as the running floor.
                            lag_ms = arrival_epoch_ns / 1e6 - base_ms
                            if self.clock_offset_ms is None or lag_ms < self.clock_offset_ms:
                                self.clock_offset_ms = lag_ms
                            self.arrival_jitter_ms = max(self.arrival_jitter_ms, lag_ms - self.clock_offset_ms)
                            if self._recording.is_set():
                                raw_handle.write(json.dumps(packet,separators=(",",":")) + "\n")
                                for index,(count,value) in enumerate(zip(counts,scaled)):
                                    sample_time_ms = base_ms + index * 1000 / FRONTIERX_SAMPLE_RATE_HZ
                                    host_epoch_ns = round((sample_time_ms + self.clock_offset_ms) * 1e6)
                                    monotonic_s = (host_epoch_ns - self.epoch_at_origin_ns) / 1e9
                                    writer.writerow([host_epoch_ns,f"{monotonic_s:.6f}",arrival_epoch_ns,accepted["packetNo"],accepted["timestamp"],round(sample_time_ms),index,count,value,accepted["heartRate"] if accepted["heartRate"] is not None else ""])
                            with self._lock:
                                self._series.extend(round(value,6) for value in scaled)
                            latest = f"HR {accepted['heartRate']} bpm" if accepted["heartRate"] is not None else "ECG samples arriving"
                            packet_total = self.accepted_packets + self.missed_packets
                            packet_loss = round(100 * self.missed_packets / packet_total,3) if packet_total else 0.0
                            metrics = {"heartRate":accepted["heartRate"] if accepted["heartRate"] is not None else "Unavailable","packetNo":accepted["packetNo"],"acceptedPackets":self.accepted_packets,"duplicatePackets":self.duplicate_packets,"missedPackets":self.missed_packets,"packetLossPct":packet_loss,"transportDelaySec":round(self.clock_offset_ms / 1000.0,2),"arrivalJitterSec":round(self.arrival_jitter_ms / 1000.0,2),"source":"Frontier X live API"}
                            wire_bytes = len(raw_message) if isinstance(raw_message,bytes) else len(str(raw_message).encode("utf-8"))
                            self.sample(latest,wire_bytes if self._recording.is_set() else 0,len(counts),FRONTIERX_SAMPLE_RATE_HZ,None,metrics,["Frontier X stream connected","ECG packet format validated","ECG samples arriving","Packet sequence monitored"])
                except Exception as exc:
                    if not self._stop.is_set():
                        self.set_state("error",f"Frontier X stream: {type(exc).__name__}: {str(exc)[:90]}")
                        self._stop.wait(3)
                finally:
                    if socket_client is not None:
                        try:
                            socket_client.close()
                        except Exception:
                            pass


class OximeterSensor(Sensor):
    START = bytes([0x7D, 0x81, 0xA1, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80])
    STOP = bytes([0x7D, 0x81, 0xA2, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80])

    def __init__(self, port: str, session_dir: Path, origin_mono: float):
        super().__init__("oximeter", port, session_dir, origin_mono)
        self.port = port
        self.path = session_dir / "oximeter" / "oximeter.csv"

    @staticmethod
    def parse_packet(packet: bytes) -> dict | None:
        if len(packet) != 9 or packet[0] != 0x01:
            return None
        values = [value & 0x7F for value in packet]
        heart_rate = values[5]
        spo2 = values[6]
        searching = spo2 >= 127 or heart_rate == 0
        return {"ppg":values[3],"heart_rate":heart_rate,"spo2":0 if searching else spo2,"signal":values[2],"searching":searching}

    def run(self) -> None:
        try:
            import serial
        except Exception as exc:
            self.set_state("error",f"Serial support unavailable: {type(exc).__name__}")
            return

        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.path.open("a", newline="", buffering=1) as handle:
            writer = csv.writer(handle)
            if self.path.stat().st_size == 0:
                writer.writerow(["host_epoch_ns","monotonic_s","spo2","heart_rate","signal_strength","pleth"])
            while not self._stop.is_set():
                serial_port = None
                try:
                    self.set_state("unknown", f"Opening {self.port}")
                    serial_port = serial.Serial(self.port,115200,timeout=0.05,write_timeout=1)
                    serial_port.reset_input_buffer()
                    serial_port.write(self.START)
                    serial_port.flush()
                    self.set_state("connected", f"{self.port} at 115200")
                    buffer = bytearray()
                    keepalive = time.monotonic()
                    while not self._stop.is_set():
                        if time.monotonic() - keepalive > 5:
                            serial_port.write(self.START)
                            keepalive = time.monotonic()
                        chunk = serial_port.read(512)
                        if not chunk:
                            continue
                        buffer.extend(chunk)
                        while len(buffer) >= 9:
                            start = buffer.find(0x01)
                            if start < 0:
                                buffer.clear()
                                break
                            if start:
                                del buffer[:start]
                            if len(buffer) < 9:
                                break
                            packet = bytes(buffer[:9])
                            parsed = self.parse_packet(packet)
                            if parsed is None:
                                del buffer[0]
                                continue
                            del buffer[:9]
                            if self._recording.is_set():
                                writer.writerow([time.time_ns(),f"{time.monotonic()-self.origin_mono:.6f}",parsed["spo2"],parsed["heart_rate"],parsed["signal"],parsed["ppg"]])
                            latest = "Searching for finger" if parsed["searching"] else f"HR {parsed['heart_rate']}, SpO2 {parsed['spo2']}%"
                            signal_pct = round(min(100,max(0,parsed["signal"] / 127 * 100)))
                            validation = ["Hardware detected","CMS50E-compatible packets detected","Samples arriving"]
                            if not parsed["searching"]:
                                validation.extend(["Finger detected","Signal strength available"])
                            self.sample(latest,9 if self._recording.is_set() else 0,point=float(parsed["ppg"]),metrics={"heartRate":parsed["heart_rate"],"spo2":parsed["spo2"],"signalStrength":signal_pct,"fingerDetected":not parsed["searching"]},validation=validation)
                except Exception as exc:
                    self.set_state("error",f"{type(exc).__name__}: {str(exc)[:120]}")
                    self._stop.wait(1)
                finally:
                    if serial_port is not None:
                        try:
                            serial_port.write(self.STOP)
                            serial_port.close()
                        except Exception:
                            pass


def _frames_equal(left, right) -> bool:
    try:
        import numpy as np
        return bool(np.array_equal(left, right))
    except Exception:
        return False


VIDEO_CODECS = {
    # fourcc, file extension, rough compressed size as a share of raw frames (for disk estimates)
    "ffv1": ("FFV1", ".mkv", 0.5),
    "mjpg": ("MJPG", ".avi", 0.08),
}


@dataclass
class CameraOptions:
    codec: str = "ffv1"
    width: int = 0
    height: int = 0
    fps: float = 0.0
    lock_settings: bool = True
    thermal_format: str = "rgb"
    thermal_units: str = "centikelvin"
    # Mains frequency of the room lighting; 0 leaves the camera's anti-flicker setting and exposure alone.
    power_line_hz: int = 50
    # The operator set exposure, ISO and white balance by hand on a camera that exposes no controls (Sony over USB).
    exposure_on_body: bool = False
    # Pixel format asked of the camera; "" keeps the driver default. A Logitech C270 reaches 1280x720 at 30 fps only
    # as MJPG - uncompressed YUYV tops out at 7.5 fps at that size.
    input_format: str = ""
    # Sensor gain fixed after the exposure lock; -1 leaves whatever the device holds. A C270 left at gain 192 of 255
    # clipped 74% of its pixels for a whole session (01326YVE), which no exposure lock can undo.
    gain: int = -1


def fourcc_text(value: float) -> str:
    code = int(value)
    return "".join(chr((code >> shift) & 0xFF) for shift in (0, 8, 16, 24)).strip("\x00 ") if code > 0 else ""


# A face region with more than this share of clipped pixels has lost the colour variation rPPG measures.
MAX_CLIPPED_PCT = 5.0


def clipped_pct(frame, roi: tuple[int, int, int, int] | None = None) -> float:
    """Percentage of pixels in the face region (or the central third when no face is known) with a channel at 250+."""
    height, width = frame.shape[:2]
    x0, y0, x1, y1 = roi if roi else (width // 3, height // 3, 2 * width // 3, 2 * height // 3)
    patch = frame[y0:y1, x0:x1]
    if patch.ndim != 3 or not patch.size:
        return 0.0
    return round(float((patch.max(axis=2) >= 250).mean() * 100), 2)


def set_gain(capture, cv2, device: object, gain: int) -> dict:
    """Fix the sensor gain through OpenCV, falling back to v4l2-ctl, and report what the device now holds."""
    capture.set(cv2.CAP_PROP_GAIN, gain)
    readback = capture.get(cv2.CAP_PROP_GAIN)
    backend = "opencv"
    if abs(readback - gain) > 0.5 and isinstance(device, str) and device.startswith("/dev/"):
        import subprocess
        backend = "v4l2-ctl"
        try:
            subprocess.run(["v4l2-ctl", "-d", device, "--set-ctrl", f"gain={gain}"], capture_output=True, text=True, timeout=5)
            out = subprocess.run(["v4l2-ctl", "-d", device, "--get-ctrl", "gain"], capture_output=True, text=True, timeout=5).stdout
            readback = float(out.split(":")[-1]) if ":" in out else readback
        except (OSError, ValueError, subprocess.SubprocessError):
            pass
    return {"requested": gain, "readback": readback, "set": abs(readback - gain) <= 0.5, "backend": backend}


def gb_per_hour(width: int, height: int, fps: float, bytes_per_pixel: float, share: float) -> float:
    return width * height * bytes_per_pixel * fps * share * 3600 / 1e9


FFMPEG_THREADS = max(1, min(8, os.cpu_count() or 1))


def ffmpeg_available() -> bool:
    import shutil
    return shutil.which("ffmpeg") is not None


class FfmpegWriter:
    """Lossless FFV1 through an ffmpeg process, using FFV1's multithreaded (level 3, sliced) mode.

    OpenCV's FFV1 writer encodes on one core. On the lab machine it managed 74.7 ms per 1080p frame - 13.3 fps -
    which is why session 0101JUMR's face camera landed at 14.3 fps with 43% of its frames dropped. The same frames
    through this writer take 18.4 ms (54.5 fps), bit-for-bit lossless and slightly smaller, because no alpha plane
    is coded. OpenCV's files probe as `bgra`; these probe as `bgr0`, where the 0 is padding, not stored data.
    """

    def __init__(self, path: str, fps: float, size: tuple[int, int]):
        import shutil
        import subprocess
        executable = shutil.which("ffmpeg")
        if not executable:
            raise FileNotFoundError("ffmpeg is not installed")
        self.path = Path(path)
        self.size = size
        self.log_path = self.path.with_name(f"{self.path.stem}.ffmpeg.log")
        self._log = self.log_path.open("w", encoding="utf-8")
        width, height = size
        command = [
            executable, "-hide_banner", "-nostats", "-loglevel", "error", "-y",
            "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{width}x{height}", "-r", f"{fps:g}", "-i", "-",
            # Level 3 is FFV1's sliced mode, the only one that encodes on several cores. Every frame is a keyframe
            # and every slice carries a CRC, so a damaged archive shows where, instead of silently decoding wrong.
            "-c:v", "ffv1", "-level", "3", "-g", "1", "-slices", "16", "-slicecrc", "1",
            "-threads", str(FFMPEG_THREADS), "-pix_fmt", "gbrp", str(self.path),
        ]
        self._process = subprocess.Popen(command, stdin=subprocess.PIPE, stderr=self._log)

    def write(self, frame) -> None:
        import numpy as np
        array = np.asarray(frame)
        if array.ndim != 3 or array.shape[2] < 3 or (array.shape[1], array.shape[0]) != self.size:
            raise ValueError(f"Frame {array.shape} does not match the {self.size[0]}x{self.size[1]} recording")
        if self._process.poll() is not None:
            raise RuntimeError(f"ffmpeg stopped with code {self._process.returncode}; see {self.log_path.name}")
        # A full pipe blocks here, which is the backpressure FrameRecorder's queue is sized to absorb.
        self._process.stdin.write(np.ascontiguousarray(array[:, :, :3], dtype=np.uint8).tobytes())

    def release(self) -> None:
        try:
            if self._process.stdin and not self._process.stdin.closed:
                self._process.stdin.close()
            code = self._process.wait(timeout=120)
        finally:
            self._log.close()
        if code == 0 and self.log_path.stat().st_size == 0:
            self.log_path.unlink()
        elif code != 0:
            raise RuntimeError(f"ffmpeg exited with code {code}; see {self.log_path.name}")


class Y16Writer:
    """Lossless 16-bit thermal frames: little-endian uint16 concatenated, described by a JSON sidecar."""

    def __init__(self, path: str, fps: float, size: tuple[int, int], units: str):
        self.path = Path(path)
        self.size = size
        self.handle = self.path.open("wb")
        meta = {"format": "uint16le frames, row-major", "width": size[0], "height": size[1], "nominalFps": fps, "units": units,
                "celsius": "value / 100 - 273.15" if units == "centikelvin" else "camera specific",
                "frameTimestamps": self.path.with_name(f"{self.path.stem}_frames.csv").name}
        self.path.with_suffix(".json").write_text(json.dumps(meta, indent=2), encoding="utf-8")

    def write(self, frame) -> None:
        import numpy as np
        self.handle.write(np.ascontiguousarray(frame, dtype="<u2").tobytes())

    def release(self) -> None:
        self.handle.close()


def to_y16(frame, width: int, height: int):
    """Normalize what OpenCV returns for Y16 capture (2-D uint16, or a flat byte buffer) to a height x width uint16 array."""
    import numpy as np
    array = np.asarray(frame)
    if array.dtype == np.uint16 and array.ndim == 2:
        return array
    flat = array.reshape(-1)
    if flat.dtype == np.uint8 and flat.size >= width * height * 2:
        return flat[: width * height * 2].view("<u2").reshape(height, width)
    raise ValueError(f"Unexpected Y16 frame {array.dtype} {array.shape}")


V4L2_LOCK_CONTROLS = {"exposure": "auto_exposure=1", "wbTemperature": "white_balance_automatic=0"}


def lock_camera_settings_v4l2(device: str) -> dict | None:
    """Freeze auto exposure and white balance through v4l2-ctl, for cameras OpenCV cannot drive.

    Session 0101JUMR's Sony ILCE-6700 returned -1.0 from every CAP_PROP_* getter and setter, so the OpenCV path
    reported locked=false and auto exposure ran free for 32 minutes on the primary rPPG camera - the one confound
    rPPG cannot tolerate, since the AE loop responds to the same clip brightness the protocol is manipulating.
    """
    if not isinstance(device, str) or not device.startswith("/dev/"):
        return None
    import subprocess
    applied, failed = [], []
    for name, control in V4L2_LOCK_CONTROLS.items():
        try:
            result = subprocess.run(["v4l2-ctl", "-d", device, "--set-ctrl", control],
                                    capture_output=True, text=True, timeout=5)
        except (OSError, subprocess.SubprocessError):
            return None
        (applied if result.returncode == 0 else failed).append(name)
    if not applied:
        return None
    return {"locked": not failed, "backend": "v4l2-ctl", "applied": applied, "failed": failed}


POWER_LINE_MENU = {50: 1, 60: 2}


def set_power_line_v4l2(device: object, hz: int) -> bool | None:
    """Set the camera's anti-flicker filter to the mains frequency. None when there is no V4L2 device or control."""
    if hz not in POWER_LINE_MENU or not isinstance(device, str) or not device.startswith("/dev/"):
        return None
    import subprocess
    try:
        result = subprocess.run(["v4l2-ctl", "-d", device, "--set-ctrl", f"power_line_frequency={POWER_LINE_MENU[hz]}"],
                                capture_output=True, text=True, timeout=5)
    except (OSError, subprocess.SubprocessError):
        return None
    return result.returncode == 0


def flicker_safe_exposure(value_100us: float, hz: int, fps: float) -> int:
    """Snap an exposure (V4L2 units of 100 us) to a whole number of lamp flicker periods.

    Lamps flicker at twice the mains frequency, so an exposure of 10 ms (50 Hz) or 8.33 ms (60 Hz) integrates a full
    cycle and every frame collects the same light. Anything in between ripples frame to frame, which rPPG reads as
    signal. Kept to at least one period and at most the frame period, rounded down to whole periods there.
    """
    period = 10000 / (2 * hz)
    periods = max(1, round(value_100us / period))
    if fps > 0:
        periods = max(1, min(periods, int((10000 / fps) // period)))
    return int(round(periods * period))


def apply_flicker_safe_exposure(device: object, hz: int, fps: float) -> dict:
    """Re-set a locked manual exposure to a flicker-safe value through v4l2-ctl, and report what changed."""
    result: dict = {"powerLineHz": hz, "applied": False}
    if hz not in POWER_LINE_MENU or not isinstance(device, str) or not device.startswith("/dev/"):
        return result
    import subprocess

    def read() -> int | None:
        try:
            out = subprocess.run(["v4l2-ctl", "-d", device, "--get-ctrl", "exposure_time_absolute"], capture_output=True, text=True, timeout=5)
        except (OSError, subprocess.SubprocessError):
            return None
        try:
            return int(out.stdout.split(":")[-1]) if out.returncode == 0 else None
        except ValueError:
            return None

    before = read()
    if before is None:
        return result
    target = flicker_safe_exposure(before, hz, fps)
    try:
        subprocess.run(["v4l2-ctl", "-d", device, "--set-ctrl", f"exposure_time_absolute={target}"], capture_output=True, text=True, timeout=5)
    except (OSError, subprocess.SubprocessError):
        pass
    after = read()
    result.update({"exposureBefore": before, "exposureTarget": target, "exposureAfter": after, "applied": after == target})
    return result


BODY_LOCK_CHECK_SEC = 10.0
BODY_LOCK_MAX_RANGE = 3.0


def background_luma(frame) -> float:
    """Mean grey level of the top-left 10% x 10% of the frame: background, away from a centred face."""
    height, width = frame.shape[:2]
    patch = frame[: max(1, height // 10), : max(1, width // 10)]
    return float(patch.mean())


def luma_steadiness(values: list[float], max_range: float = BODY_LOCK_MAX_RANGE) -> dict:
    """Whether background brightness held still: auto exposure re-meters when the subject moves, and the background moves with it."""
    import numpy as np
    if len(values) < 2:
        return {"verified": None, "detail": "too few frames to check"}
    arr = np.asarray(values, dtype=np.float64)
    spread = float(arr.max() - arr.min())
    verified = spread <= max_range
    return {"verified": verified, "backgroundLumaStd": round(float(arr.std()), 3), "backgroundLumaRange": round(spread, 3), "frames": int(arr.size),
            "detail": "background brightness steady" if verified else "brightness is still changing: check M mode, ISO and WB"}


def lock_camera_settings(capture, cv2, system: str, device: object = None) -> dict:
    """Freeze auto exposure, white balance, and gain at their settled values so brightness does not drift under rPPG."""
    props = {"exposure": cv2.CAP_PROP_EXPOSURE, "gain": cv2.CAP_PROP_GAIN, "wbTemperature": cv2.CAP_PROP_WB_TEMPERATURE}
    settled = {name: capture.get(prop) for name, prop in props.items()}
    manual_exposure = 0.25 if system == "Windows" else 1.0
    capture.set(cv2.CAP_PROP_AUTO_EXPOSURE, manual_exposure)
    capture.set(cv2.CAP_PROP_AUTO_WB, 0)
    for name, prop in props.items():
        if settled[name] not in (None, -1, 0) or name == "gain":
            capture.set(prop, settled[name])
    readback = {name: capture.get(prop) for name, prop in props.items()}
    auto_exposure = capture.get(cv2.CAP_PROP_AUTO_EXPOSURE)
    auto_wb = capture.get(cv2.CAP_PROP_AUTO_WB)
    locked = abs(auto_exposure - manual_exposure) < 1e-6 and auto_wb == 0
    result = {"locked": bool(locked), "settled": settled, "readback": readback, "autoExposure": auto_exposure, "autoWhiteBalance": auto_wb}
    if not locked and system == "Linux":
        fallback = lock_camera_settings_v4l2(device)
        if fallback:
            result.update({key: value for key, value in fallback.items() if key != "locked"})
            result["locked"] = fallback["locked"]
            result["openCvLocked"] = bool(locked)
    return result


class FrameRecorder:
    """Writes video frames on a background thread and logs one timestamp row per frame actually written.

    The video container only stores a nominal frame rate, so `<sensor>_frames.csv` is the source of truth for
    aligning video with the other streams.
    """

    def __init__(self, video_path: Path, fps: float, origin_mono: float, open_writer: Callable, max_queue: int = 60):
        self.video_path = video_path
        self.timestamps_path = video_path.with_name(f"{video_path.stem}_frames.csv")
        self.fps = fps
        self.origin_mono = origin_mono
        self.open_writer = open_writer
        self.frames: queue.Queue = queue.Queue(maxsize=max_queue)
        self.written = 0
        self.dropped = 0
        self.error = ""
        self.started_mono = time.monotonic()
        self._thread = threading.Thread(target=self._run, name=f"meridian-writer-{video_path.stem}", daemon=True)
        self._thread.start()

    def submit(self, frame, host_epoch_ns: int, monotonic: float) -> bool:
        try:
            self.frames.put_nowait((frame, host_epoch_ns, monotonic))
            return True
        except queue.Full:
            self.dropped += 1
            return False

    def close(self, timeout: float = 10.0) -> None:
        self.frames.put(None)
        self._thread.join(timeout=timeout)

    def _run(self) -> None:
        writer = None
        try:
            with self.timestamps_path.open("a", newline="", buffering=1) as handle:
                stamps = csv.writer(handle)
                if self.timestamps_path.stat().st_size == 0:
                    stamps.writerow(["frame_index","host_epoch_ns","monotonic_s","repeated"])
                previous = None
                while True:
                    item = self.frames.get()
                    if item is None:
                        break
                    frame, host_epoch_ns, monotonic = item
                    if writer is None:
                        height, width = frame.shape[:2]
                        writer = self.open_writer(str(self.video_path), self.fps, (width, height))
                        if writer is None:
                            raise RuntimeError("Cannot create camera recording")
                    writer.write(frame)
                    # Identical consecutive frames mark a frozen stream, e.g. a thermal camera's flat-field correction.
                    repeated = previous is not None and getattr(frame, "shape", None) == getattr(previous, "shape", None) and _frames_equal(frame, previous)
                    stamps.writerow([self.written, host_epoch_ns, f"{monotonic-self.origin_mono:.6f}", int(repeated)])
                    previous = frame
                    self.written += 1
        except Exception as exc:
            self.error = f"{type(exc).__name__}: {str(exc)[:120]}"
        finally:
            if writer is not None:
                # Closing an encoder can fail on its own (ffmpeg exits non-zero); keep the first error, never raise
                # out of the writer thread, where nobody would see it.
                try:
                    writer.release()
                except Exception as exc:
                    self.error = self.error or f"{type(exc).__name__}: {str(exc)[:120]}"


class CameraSensor(Sensor):
    WARMUP_SEC = 2.0

    def __init__(self, sensor_id: str, source: str, session_dir: Path, origin_mono: float, options: CameraOptions | None = None):
        super().__init__(sensor_id, source, session_dir, origin_mono)
        self.source = int(source) if source.isdigit() else source
        self.options = options or CameraOptions()
        self.radiometric = sensor_id == "thermal" and self.options.thermal_format == "y16"
        codec = VIDEO_CODECS.get(self.options.codec, VIDEO_CODECS["ffv1"])
        self.path = session_dir / sensor_id / (f"{sensor_id}_y16.raw" if self.radiometric else f"{sensor_id}{codec[1]}")
        self.estimated_gb_per_hour = 18.0
        self.writer_backend = "y16-raw" if self.radiometric else ("ffmpeg-ffv1-sliced" if self.options.codec == "ffv1" and ffmpeg_available() else f"opencv-{self.options.codec}")
        self._preview_lock = threading.Lock()
        self._preview_frame: bytes | None = None

    def preview_frame(self) -> bytes | None:
        with self._preview_lock:
            return self._preview_frame

    def run(self) -> None:
        try:
            import cv2
            import numpy as np
        except Exception as exc:
            self.set_state("error",f"Camera support unavailable: {type(exc).__name__}")
            return

        fourcc, _, share = VIDEO_CODECS.get(self.options.codec, VIDEO_CODECS["ffv1"])
        options = self.options

        def open_writer(path: str, fps: float, size: tuple[int,int]):
            if self.radiometric:
                return Y16Writer(path, fps, size, options.thermal_units)
            if options.codec == "ffv1" and ffmpeg_available():
                self.writer_backend = "ffmpeg-ffv1-sliced"
                return FfmpegWriter(path, fps, size)
            self.writer_backend = f"opencv-{options.codec}"
            writer = cv2.VideoWriter(path,cv2.VideoWriter_fourcc(*fourcc),fps,size)
            return writer if writer.isOpened() else None

        self.path.parent.mkdir(parents=True, exist_ok=True)
        capture = None
        recorder: FrameRecorder | None = None
        system = platform.system()
        # A video file can stand in for a camera when testing without hardware; it is replayed in real time and looped.
        file_source = isinstance(self.source, str) and Path(self.source).is_file()
        try:
            backend = cv2.CAP_ANY if file_source else cv2.CAP_DSHOW if system == "Windows" else cv2.CAP_V4L2 if system == "Linux" else cv2.CAP_ANY
            capture = cv2.VideoCapture(self.source,backend)
            if not capture.isOpened():
                raise RuntimeError(f"Cannot open camera {self.source}")
            if self.radiometric:
                capture.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter_fourcc(*"Y16 "))
                capture.set(cv2.CAP_PROP_CONVERT_RGB, 0)
            elif options.input_format == "mjpg" and not file_source:
                # Before the size, or V4L2 negotiates the size against the default format first.
                capture.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter_fourcc(*"MJPG"))
            if options.width and options.height:
                capture.set(cv2.CAP_PROP_FRAME_WIDTH, options.width)
                capture.set(cv2.CAP_PROP_FRAME_HEIGHT, options.height)
            if options.fps:
                capture.set(cv2.CAP_PROP_FPS, options.fps)
            # Before the warm-up, so auto exposure settles with the anti-flicker filter already on.
            power_line_set = None if file_source or self.radiometric else set_power_line_v4l2(self.source, options.power_line_hz)
            width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH)) or 1280
            height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT)) or 720
            requested_fps = capture.get(cv2.CAP_PROP_FPS)
            fps = requested_fps if 1 <= requested_fps <= 240 else 30.0
            self.estimated_gb_per_hour = gb_per_hour(width, height, fps, 2 if self.radiometric else 3, 1.0 if self.radiometric else share)
            self.set_state("connected",f"{width}x{height} at {fps:.1f} fps, {'Y16 raw' if self.radiometric else options.codec}")
            settings: dict = {"sensor": self.sensor_id, "codec": "y16-raw" if self.radiometric else options.codec, "writer": self.writer_backend, "width": width, "height": height,
                              "fps": fps, "requested": {"width": options.width, "height": options.height, "fps": options.fps, "inputFormat": options.input_format},
                              "inputFormat": fourcc_text(capture.get(cv2.CAP_PROP_FOURCC)), "lock": None}
            started = time.monotonic()
            lock_pending = options.lock_settings and not self.radiometric and not file_source
            if file_source:
                settings["lock"] = {"locked": False, "reason": "video file source"}
            file_frames = 0
            body_lumas: list[float] = []
            body_check_until: float | None = None
            rppg = LiveRppg() if self.sensor_id in ("face","face2") and not self.radiometric else None
            frame_times: deque[float] = deque(maxlen=90)
            last_preview = 0.0
            dropped = 0
            while not self._stop.is_set():
                ok, frame = capture.read()
                if file_source:
                    if not ok:
                        capture.set(cv2.CAP_PROP_POS_FRAMES, 0)
                        continue
                    file_frames += 1
                    self._stop.wait(max(0.0, started + file_frames / fps - time.monotonic()))
                if not ok:
                    dropped += 1
                    self.set_state("delayed","Camera frame unavailable")
                    self._stop.wait(0.05)
                    continue
                if self.radiometric:
                    frame = to_y16(frame, width, height)
                host_epoch_ns = time.time_ns()
                current = time.monotonic(); frame_times.append(current)
                measured = (len(frame_times)-1)/max(0.001,frame_times[-1]-frame_times[0]) if len(frame_times)>1 else fps
                if lock_pending and current - started >= self.WARMUP_SEC:
                    lock_pending = False
                    settings["lock"] = lock_camera_settings(capture, cv2, system, self.source)
                    if not settings["lock"].get("locked") and options.exposure_on_body:
                        # Nothing to lock from here; the camera body holds the settings. Trust it only as far as the
                        # background brightness check below confirms it.
                        settings["lock"] = {"locked": True, "backend": "camera body (operator-set)", "verified": None, "hostAttempt": settings["lock"]}
                        body_check_until = current + BODY_LOCK_CHECK_SEC
                    if options.gain >= 0 and not options.exposure_on_body:
                        settings["gainSet"] = set_gain(capture, cv2, self.source, options.gain)
                    if settings["lock"].get("locked") and system == "Linux":
                        settings["flicker"] = {**apply_flicker_safe_exposure(self.source, options.power_line_hz, fps), "powerLineSet": power_line_set}
                if (settings["lock"] is not None or not lock_pending) and not settings.get("written"):
                    settings["source"] = "file" if file_source else "camera"
                    settings["written"] = True
                    (self.path.parent / "camera_settings.json").write_text(json.dumps({k: v for k, v in settings.items() if k != "written"}, indent=2), encoding="utf-8")
                if body_check_until is not None:
                    body_lumas.append(background_luma(frame))
                    if current >= body_check_until:
                        body_check_until = None
                        settings["lock"].update(luma_steadiness(body_lumas))
                        (self.path.parent / "camera_settings.json").write_text(json.dumps({k: v for k, v in settings.items() if k != "written"}, indent=2), encoding="utf-8")
                if current-last_preview >= 0.2:
                    preview = frame
                    if self.radiometric:
                        low, high = float(frame.min()), float(frame.max())
                        scaled = ((frame.astype(np.float32) - low) * (255.0 / max(1.0, high - low))).astype(np.uint8)
                        preview = cv2.applyColorMap(scaled, cv2.COLORMAP_INFERNO)
                    if preview.shape[1] > 640:
                        preview = cv2.resize(preview,(640,max(1,round(preview.shape[0]*640/preview.shape[1]))))
                    encoded,jpeg = cv2.imencode(".jpg",preview,[cv2.IMWRITE_JPEG_QUALITY,65])
                    if encoded:
                        with self._preview_lock:
                            self._preview_frame = jpeg.tobytes()
                    last_preview=current
                if self._recording.is_set() and recorder is None:
                    recorder = FrameRecorder(self.path,fps,self.origin_mono,open_writer)
                if not self._recording.is_set() and recorder is not None:
                    recorder.close(); recorder=None
                queued = False
                if recorder is not None:
                    if recorder.error:
                        raise RuntimeError(recorder.error)
                    queued = recorder.submit(frame,host_epoch_ns,current)
                    if not queued:
                        self.record_dropped(1)
                    # What landed in the file, which is what the manifest and the quality gate must score.
                    self._persisted_samples = recorder.written
                locked = (settings["lock"] or {}).get("locked")
                encoder_dropped = recorder.dropped if recorder else 0
                written_fps = recorder.written / max(0.001, current - recorder.started_mono) if recorder and recorder.written else None
                metrics = {"width":width,"height":height,"fps":round(measured,2),"droppedFrames":dropped+encoder_dropped,"codec":settings["codec"]}
                validation = ["Hardware detected","Frames arriving","Preview available","Frame rate measured"]
                if recorder is not None:
                    metrics["writtenFps"] = round(written_fps,2) if written_fps else 0.0
                    metrics["encoderDropped"] = encoder_dropped
                    # The camera keeping up says nothing about the encoder keeping up - that is what went unnoticed
                    # for a whole session, so it gets its own line rather than living inside a metrics dict.
                    validation.append("Encoder keeping up with the camera" if not encoder_dropped
                                      else f"Encoder dropping frames: {encoder_dropped} discarded, {round(written_fps or 0,1)} fps reaching the file")
                if settings["lock"] is not None:
                    # A body-held exposure whose brightness check failed is not locked, whatever the camera claims.
                    locked = bool(locked) and settings["lock"].get("verified") is not False
                    metrics["settingsLocked"] = locked
                    validation.append("Exposure and white balance locked" if locked else "Exposure or white balance could not be locked")
                if rppg is not None:
                    metrics.update(rppg.update(frame, current, cv2))
                    metrics["clippedPct"] = clipped_pct(frame, rppg.roi)
                if self.radiometric and options.thermal_units == "centikelvin":
                    metrics["minTempC"] = round(float(frame.min()) / 100 - 273.15, 2)
                    metrics["maxTempC"] = round(float(frame.max()) / 100 - 273.15, 2)
                self.sample(f"{width}x{height}",int(frame.nbytes) if queued else 0,rate_hz=round(measured,2),point=float(measured),metrics=metrics,validation=validation)
        except Exception as exc:
            self.set_state("error",f"{type(exc).__name__}: {str(exc)[:120]}")
        finally:
            if recorder is not None:
                recorder.close()
            if capture is not None:
                capture.release()


class AudioSensor(Sensor):
    def __init__(self, device: str, session_dir: Path, origin_mono: float, sample_rate: int = 48000, write_channels: int = 1):
        super().__init__("audio", device, session_dir, origin_mono)
        self.audio_device = int(device) if device.isdigit() else (None if device == "auto" else device)
        self.sample_rate = sample_rate
        # Channels to keep in the recording. 1 averages the input to mono; 2 keeps a two-mic
        # receiver's channels apart, which mono averaging destroys irreversibly.
        self.write_channels = max(1, min(2, write_channels))
        self.path = session_dir / "audio" / "audio.wav"

    def run(self) -> None:
        try:
            import sounddevice as sd
        except Exception as exc:
            self.set_state("error",f"Audio support unavailable: {type(exc).__name__}")
            return

        self.path.parent.mkdir(parents=True, exist_ok=True)
        chunks: queue.Queue[tuple[bytes,int]] = queue.Queue(maxsize=256)
        missed = {"frames":0}

        def callback(indata, frames, timing, status):
            del timing
            if status:
                self.set_state("delayed",str(status))
            try:
                chunks.put_nowait((bytes(indata),missed["frames"]))
                missed["frames"] = 0
            except queue.Full:
                missed["frames"] += frames
                self.record_dropped(frames)
                self.set_state("delayed","Audio writer queue full")

        target = None
        try:
            # Stereo inputs are averaged to mono: a mic on one side of a camera's jack would be lost if only the first channel were read.
            channels = max(1, min(2, int(sd.query_devices(self.audio_device, "input")["max_input_channels"])))
            # Keep only as many channels as the device actually offers, however many were asked for.
            written = min(self.write_channels, channels)
            with sd.RawInputStream(samplerate=self.sample_rate,channels=channels,dtype="int16",device=self.audio_device,callback=callback):
                self.set_state("connected",(f"Stereo {self.sample_rate} Hz (2 channels kept)" if written == 2
                                            else f"Mono {self.sample_rate} Hz" + (" (stereo input averaged)" if channels == 2 else "")))
                while not self._stop.is_set():
                    try:
                        chunk, silence_frames = chunks.get(timeout=0.25)
                    except queue.Empty:
                        continue
                    if written == 1:
                        chunk = downmix_int16(chunk, channels)
                    if self._recording.is_set() and target is None:
                        self.path.parent.mkdir(parents=True,exist_ok=True)
                        target = wave.open(str(self.path),"wb")
                        target.setnchannels(written); target.setsampwidth(2); target.setframerate(self.sample_rate)
                    if not self._recording.is_set() and target is not None:
                        target.close(); target=None
                    if target is not None:
                        if silence_frames:
                            target.writeframesraw(silence_bytes(silence_frames, written))
                        target.writeframesraw(chunk)
                    frames = len(chunk) // (2 * written)
                    # Meter the mono average in both modes so the console number stays comparable.
                    level = audio_level_pct(downmix_int16(chunk, written) if written > 1 else chunk)
                    self.sample("Audio signal detected" if level>1 else "Audio connected",len(chunk) if target is not None else 0,frames,float(self.sample_rate),point=level,metrics={"levelPct":level,"sampleRate":self.sample_rate,"channels":written},validation=["Hardware detected","Audio stream open",("Signal detected" if level>1 else "Waiting for sound")])
        except Exception as exc:
            self.set_state("error",f"{type(exc).__name__}: {str(exc)[:120]}")
        finally:
            if target is not None:
                target.close()


def silence_bytes(frames: int, channels: int) -> bytes:
    """Silent padding for a dropout, as 16-bit frames of `channels` samples each.

    Gaps are filled so the WAV stays aligned to wall-clock time. At the wrong width the padding is
    short by a factor of the channel count, so every dropout slides the audio against every other
    stream — a drift no check of the file's existence or format would catch.
    """
    return bytes(max(0, frames) * 2 * max(1, channels))


def downmix_int16(chunk: bytes, channels: int) -> bytes:
    """Average interleaved int16 PCM channels into mono."""
    if channels <= 1:
        return chunk
    import numpy as np
    usable = len(chunk) // (2 * channels) * (2 * channels)
    frames = np.frombuffer(chunk[:usable], dtype=np.int16).reshape(-1, channels).astype(np.int32)
    return (frames.sum(axis=1) // channels).astype(np.int16).tobytes()


def audio_level_pct(chunk: bytes) -> float:
    """RMS level of mono int16 PCM, scaled to 0-100 for the operator meter."""
    import numpy as np
    samples = np.frombuffer(chunk[:len(chunk)//2*2], dtype=np.int16)
    if samples.size == 0:
        return 0.0
    rms = float(np.sqrt(np.mean(np.square(samples, dtype=np.float64))))
    return min(100.0, round(rms/32768*240, 1))


def auto_oximeter_port() -> str:
    try:
        from serial.tools import list_ports
        for port in list_ports.comports():
            if port.vid == 0x10C4 and port.pid == 0xEA60:
                return port.device
    except Exception:
        pass
    return ""


def stable_links(directory: Path, suffix: str = "") -> dict[str,str]:
    """Map resolved device nodes to their stable /dev/.../by-id links, which survive replugging."""
    links: dict[str,str] = {}
    try:
        for link in sorted(directory.iterdir()):
            if suffix and not link.name.endswith(suffix):
                continue
            links.setdefault(os.path.realpath(link), str(link))
    except OSError:
        pass
    return links


def serial_inventory(ports, by_id: dict[str,str]) -> list[dict]:
    """USB serial adapters only: legacy on-board ttyS ports have no USB vendor id and would crowd out the real devices."""
    items = []
    for port in ports:
        if getattr(port, "vid", None) is None:
            continue
        device = by_id.get(os.path.realpath(port.device), port.device)
        description = port.description or "Serial device"
        items.append({"id":device,"label":f"{port.device} | {description}","kind":"serial","description":description})
    return items


def audio_inventory(devices) -> list[dict]:
    """Audio inputs by name without the ALSA card number, which changes when USB devices are replugged."""
    inputs = [(index, str(item.get("name", f"Input {index}")), item) for index, item in enumerate(devices) if int(item.get("max_input_channels", 0)) >= 1]
    stems = [name.split(" (hw:")[0] for _, name, _ in inputs]
    items = []
    for (index, name, item), stem in zip(inputs, stems):
        unique = stems.count(stem) == 1
        description = f"{name} | {int(item.get('max_input_channels', 0))} channel | {round(float(item.get('default_samplerate', 0)))} Hz"
        items.append({"id":stem if unique else str(index),"label":description,"kind":"audio","description":description})
    return items


def discover_device_inventory() -> dict[str,list[dict]]:
    inventory: dict[str,list[dict]] = {"video":[],"audio":[],"serial":[]}
    try:
        from serial.tools import list_ports
        inventory["serial"] = serial_inventory(list_ports.comports(), stable_links(Path("/dev/serial/by-id")))
    except Exception:
        pass
    cameras = stable_links(Path("/dev/v4l/by-id"), "-video-index0") if platform.system() == "Linux" else {}
    if cameras:
        for link in sorted(cameras.values()):
            name = Path(link).name.removeprefix("usb-").removesuffix("-video-index0").replace("_", " ")
            inventory["video"].append({"id":link,"label":f"{name} ({os.path.basename(os.path.realpath(link))})","kind":"video","description":name})
    else:
        try:
            import cv2
            backend = cv2.CAP_DSHOW if platform.system() == "Windows" else cv2.CAP_V4L2 if platform.system() == "Linux" else cv2.CAP_ANY
            for index in range(5):
                capture = cv2.VideoCapture(index,backend)
                if not capture.isOpened():
                    capture.release()
                    continue
                width=int(capture.get(cv2.CAP_PROP_FRAME_WIDTH)) or 0
                height=int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT)) or 0
                fps=capture.get(cv2.CAP_PROP_FPS) or 0
                capture.release()
                description=f"Camera {index} | {width}x{height} at {fps:.0f} fps"
                inventory["video"].append({"id":str(index),"label":description,"kind":"video","description":description})
        except Exception:
            pass
    try:
        import sounddevice as sd
        inventory["audio"] = audio_inventory(sd.query_devices())
    except Exception:
        pass
    return inventory


def discover_serial_assignments(requested: dict[str,str], bauds: dict[str,int]) -> tuple[dict[str,str],list[dict]]:
    """Identify supplied ESP32 streams by samples, not by USB presence alone."""
    try:
        import serial
        from serial.tools import list_ports
    except Exception:
        return requested,[]
    try:
        ports = list(list_ports.comports())
    except Exception:
        ports = []
    inventory = [{"device":port.device,"description":port.description,"vid":port.vid,"pid":port.pid,"serialNumber":port.serial_number} for port in ports]
    result = dict(requested)
    claimed = {value for value in result.values() if value not in ("","auto","none","simulate")}
    # USB bridge VID/PID values identify the serial adapter, not the sensor.
    # Assign every automatic serial modality only after its wire protocol has
    # been observed, and never let two modalities claim the same COM port.
    for sensor_id in ("oximeter","emg","gsr","csi"):
        if result.get(sensor_id) != "auto":
            continue
        result[sensor_id] = ""
        for item in inventory:
            port = item["device"]
            if port in claimed:
                continue
            if _probe_serial_protocol(serial,port,bauds.get(sensor_id,115200),sensor_id):
                result[sensor_id] = port
                claimed.add(port)
                break
    return result,inventory


def _probe_serial_protocol(serial_module, port: str, baud: int, sensor_id: str) -> bool:
    handle = None
    try:
        handle = serial_module.Serial(port,baud,timeout=0.15,write_timeout=0.5)
        handle.reset_input_buffer()
        if sensor_id == "oximeter":
            handle.write(OximeterSensor.START)
            handle.flush()
        if sensor_id == "emg":
            handle.write(b"?")
            handle.flush()
        deadline = time.monotonic()+1.4
        binary = bytearray()
        valid_frames = 0
        previous_emg_sequence: int | None = None
        while time.monotonic()<deadline:
            if sensor_id == "oximeter":
                chunk = handle.read(256)
                if not chunk:
                    continue
                binary.extend(chunk)
                while len(binary) >= 9:
                    start = binary.find(0x01)
                    if start < 0:
                        binary.clear()
                        break
                    if start:
                        del binary[:start]
                    if len(binary) < 9:
                        break
                    packet = bytes(binary[:9])
                    parsed = OximeterSensor.parse_packet(packet)
                    if parsed is not None:
                        valid_frames += 1
                        del binary[:9]
                        if valid_frames >= 2:
                            return True
                        continue
                    del binary[0]
                continue
            line = handle.readline().decode("utf-8","replace").strip()
            if not line:
                continue
            if sensor_id == "emg":
                if line.startswith("# emg1"):
                    return True
                parts=line.split(",")
                if len(parts)==3:
                    try:
                        _,sequence,raw = [int(value) for value in parts]
                        if 0 <= raw <= 65535 and (previous_emg_sequence is None or sequence >= previous_emg_sequence):
                            valid_frames += 1
                            previous_emg_sequence = sequence
                            if valid_frames >= 2:
                                return True
                    except ValueError:
                        pass
            if sensor_id == "gsr":
                try:
                    payload=json.loads(line)
                    if "uS" in payload and "raw" in payload:
                        float(payload["uS"]); int(payload["raw"])
                        valid_frames += 1
                        if valid_frames >= 2:
                            return True
                except (json.JSONDecodeError,TypeError):
                    pass
                except (ValueError,OverflowError):
                    pass
            if sensor_id == "csi":
                raw_line=line[9:] if line.startswith("CSI_DATA,") else line
                parts=raw_line.split(",")
                if len(parts)>=8:
                    try:
                        rssi=float(parts[2])
                        if -140<=rssi<=20:
                            valid_frames += 1
                            if valid_frames >= 2:
                                return True
                    except ValueError:
                        pass
    except Exception:
        return False
    finally:
        if handle is not None:
            try:
                if sensor_id == "oximeter":
                    handle.write(OximeterSensor.STOP)
                handle.close()
            except Exception:
                pass
    return False


def make_sensor(sensor_id: str, value: str, baud: int, session_dir: Path, origin_mono: float, camera_options: CameraOptions | None = None, audio_channels: int = 1) -> Sensor:
    if value == "simulate":
        return SimulatedSensor(sensor_id,session_dir,origin_mono)
    if value in ("", "none"):
        return UnavailableSensor(sensor_id,"Not configured",session_dir,origin_mono)
    if sensor_id in ("face","face2","thermal"):
        return CameraSensor(sensor_id,"0" if value == "auto" else value,session_dir,origin_mono,camera_options)
    if sensor_id == "audio":
        return AudioSensor(value,session_dir,origin_mono,write_channels=audio_channels)
    if sensor_id == "oximeter":
        port = auto_oximeter_port() if value == "auto" else value
        return OximeterSensor(port,session_dir,origin_mono) if port else UnavailableSensor(sensor_id,"CMS50E not detected",session_dir,origin_mono)
    if sensor_id == "csi":
        return CsiSensor(sensor_id,value,baud,session_dir,origin_mono)
    if sensor_id == "emg":
        return EmgSensor(sensor_id,value,baud,session_dir,origin_mono)
    if sensor_id == "gsr":
        return GsrSensor(sensor_id,value,baud,session_dir,origin_mono)
    if sensor_id in ("resp", "environment", "csi2") and value == "auto":
        return UnavailableSensor(sensor_id,"Select the serial port in Recording setup",session_dir,origin_mono)
    if sensor_id == "resp":
        return RespirationSensor(sensor_id,value,baud,session_dir,origin_mono)
    if sensor_id == "environment":
        return EnvironmentSensor(sensor_id,value,baud,session_dir,origin_mono)
    if sensor_id == "csi2":
        return CsiSensor(sensor_id,value,baud,session_dir,origin_mono)
    if sensor_id == "photodiode":
        if value == "auto":
            return UnavailableSensor(sensor_id,"Select the photodiode serial port in Recording setup",session_dir,origin_mono)
        return PhotodiodeSensor(sensor_id,value,baud,session_dir,origin_mono)
    if sensor_id == "ecg":
        if value == "auto":
            return UnavailableSensor(sensor_id,"Paste a Frontier X live ECG link in Recording setup",session_dir,origin_mono)
        if is_frontierx_source(value):
            try:
                return FrontierXEcgSensor(value,session_dir,origin_mono)
            except ValueError as exc:
                return UnavailableSensor(sensor_id,str(exc),session_dir,origin_mono)
        return GenericSerialSensor(sensor_id,value,baud,session_dir,origin_mono)
    return GenericSerialSensor(sensor_id,value,baud,session_dir,origin_mono)
