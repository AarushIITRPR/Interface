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
from typing import Callable
from urllib.parse import urlparse

from .models import RecordingArtifact, SensorReport
from .rppg import LiveRppg


TARGET_RATES = {"face":30.0,"audio":48000.0,"oximeter":60.0,"csi":100.0,"emg":1000.0,"gsr":20.0,"ecg":125.0,"thermal":9.0,"photodiode":1000.0,"csi2":100.0,"resp":50.0,"environment":1.0}

FRONTIERX_SCALE_PER_COUNT = 0.0000038146972
FRONTIERX_SAMPLE_RATE_HZ = 125.0
FRONTIERX_SERVER_COUNTS = {"frontierxapp.com":5,"frontierxs.com":5,"frontierxd.in":1}


def iso_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


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
        self._gap_count = 0
        self._total_gap_s = 0.0
        self._longest_gap_s = 0.0
        self._previous_sample_mono = 0.0
        self._side_capture: tuple | None = None
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
            if self._previous_sample_mono and target:
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
            elif result.status == "delayed" or (result.targetRateHz and result.rateHz is not None and result.rateHz < result.targetRateHz * 0.8):
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

    def artifact(self) -> RecordingArtifact | None:
        if not self.path or not self.path.exists():
            return None
        report = self.report()
        duration = max(0.0,(self._recording_ended_mono or time.monotonic()) - self._recording_started_mono) if self._recording_started_mono else 0.0
        average_rate = self._recorded_samples / duration if duration else 0.0
        quality = "pass" if self._recorded_samples > 0 and report.status not in ("error", "missing") else "fail"
        if quality == "pass" and report.targetRateHz and average_rate < report.targetRateHz * 0.8:
            quality = "warning"
        return RecordingArtifact(
            sensorId=self.sensor_id,
            relativePath=str(self.path.relative_to(self.session_dir)).replace("\\", "/"),
            format=self.path.suffix.lstrip(".") or "binary",
            sampleCount=self._recorded_samples,
            bytes=self.path.stat().st_size,
            sha256=sha256_file(self.path),
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
            availabilityPct=round(100 * self._recorded_samples / max(1,self._recorded_samples+self._dropped_samples),3),
        )


class UnavailableSensor(Sensor):
    def __init__(self, sensor_id: str, detail: str, session_dir: Path, origin_mono: float):
        super().__init__(sensor_id, "", session_dir, origin_mono)
        self.reason = detail

    def run(self) -> None:
        self.set_state("missing", self.reason)
        self._stop.wait()


class SimulatedSensor(Sensor):
    RATES = {"face":30.0,"audio":48000.0,"oximeter":60.0,"csi":100.0,"emg":1000.0,"gsr":50.0,"ecg":500.0,"thermal":9.0,"photodiode":1000.0,"csi2":100.0,"resp":50.0,"environment":1.0}

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
                elif self.sensor_id in ("face","thermal"):
                    metrics = {"width":1280 if self.sensor_id == "face" else 640,"height":720 if self.sensor_id == "face" else 480,"fps":rate,"droppedFrames":0}
                    if self.sensor_id == "face":
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


class CsiSensor(SerialLineSensor):
    header = ["host_epoch_ns", "monotonic_s", "device_timestamp", "packet_id", "rssi", "raw_line"]

    def parse(self, line: str) -> tuple[list[object], str] | None:
        if line.startswith("#"):
            return None
        raw_line = line[9:] if line.startswith("CSI_DATA,") else line
        parts = raw_line.split(",")
        if len(parts) < 8:
            return None
        try:
            timestamp = parts[0]
            packet_id = parts[1]
            rssi = float(parts[2])
        except (ValueError, IndexError):
            return None
        return [timestamp, packet_id, rssi, line], f"RSSI {rssi:g} dBm"

    def telemetry(self, values: list[object]) -> tuple[float | None,dict,list[str]]:
        rssi = float(values[2]); raw_line = str(values[3]); parts = raw_line[9:].split(",") if raw_line.startswith("CSI_DATA,") else raw_line.split(",")
        amplitudes: list[float] = []
        for value in parts[6:58]:
            try:
                amplitudes.append(abs(float(value)))
            except ValueError:
                continue
        if amplitudes:
            self._series.clear(); self._series.extend(amplitudes[:52])
        return rssi,{"rssi":rssi,"subcarriers":len(amplitudes) or 52},["Hardware detected","CSI packet format valid","Samples arriving"]


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
                writer.writerow(["host_epoch_ns","monotonic_s","packet_no","session_start_ms","sample_time_ms","sample_index","raw_count","scaled_value","heart_rate"])
            while not self._stop.is_set():
                socket_client = None
                server_number = random.randint(1,FRONTIERX_SERVER_COUNTS[self.domain])
                try:
                    self.set_state("unknown",f"Connecting to Frontier X server {server_number}")
                    socket_url = f"wss://liveecgwsapi.{self.domain}/server{server_number}?Authorization=token"
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
                            host_epoch_ns = time.time_ns()
                            monotonic_s = time.monotonic() - self.origin_mono
                            base_ms = accepted["timestamp"] + accepted["packetNo"] * 1000
                            if self._recording.is_set():
                                raw_handle.write(json.dumps(packet,separators=(",",":")) + "\n")
                                for index,(count,value) in enumerate(zip(counts,scaled)):
                                    writer.writerow([host_epoch_ns,f"{monotonic_s + index / FRONTIERX_SAMPLE_RATE_HZ:.6f}",accepted["packetNo"],accepted["timestamp"],round(base_ms + index * 1000 / FRONTIERX_SAMPLE_RATE_HZ),index,count,value,accepted["heartRate"] if accepted["heartRate"] is not None else ""])
                            with self._lock:
                                self._series.extend(round(value,6) for value in scaled)
                            latest = f"HR {accepted['heartRate']} bpm" if accepted["heartRate"] is not None else "ECG samples arriving"
                            packet_total = self.accepted_packets + self.missed_packets
                            packet_loss = round(100 * self.missed_packets / packet_total,3) if packet_total else 0.0
                            metrics = {"heartRate":accepted["heartRate"] if accepted["heartRate"] is not None else "Unavailable","packetNo":accepted["packetNo"],"acceptedPackets":self.accepted_packets,"duplicatePackets":self.duplicate_packets,"missedPackets":self.missed_packets,"packetLossPct":packet_loss,"source":"Frontier X live API"}
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


def gb_per_hour(width: int, height: int, fps: float, bytes_per_pixel: float, share: float) -> float:
    return width * height * bytes_per_pixel * fps * share * 3600 / 1e9


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


def lock_camera_settings(capture, cv2, system: str) -> dict:
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
    return {"locked": bool(locked), "settled": settled, "readback": readback, "autoExposure": auto_exposure, "autoWhiteBalance": auto_wb}


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
                writer.release()


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
            writer = cv2.VideoWriter(path,cv2.VideoWriter_fourcc(*fourcc),fps,size)
            return writer if writer.isOpened() else None

        self.path.parent.mkdir(parents=True, exist_ok=True)
        capture = None
        recorder: FrameRecorder | None = None
        system = platform.system()
        try:
            backend = cv2.CAP_DSHOW if system == "Windows" else cv2.CAP_V4L2 if system == "Linux" else cv2.CAP_ANY
            capture = cv2.VideoCapture(self.source,backend)
            if not capture.isOpened():
                raise RuntimeError(f"Cannot open camera {self.source}")
            if self.radiometric:
                capture.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter_fourcc(*"Y16 "))
                capture.set(cv2.CAP_PROP_CONVERT_RGB, 0)
            if options.width and options.height:
                capture.set(cv2.CAP_PROP_FRAME_WIDTH, options.width)
                capture.set(cv2.CAP_PROP_FRAME_HEIGHT, options.height)
            if options.fps:
                capture.set(cv2.CAP_PROP_FPS, options.fps)
            width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH)) or 1280
            height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT)) or 720
            requested_fps = capture.get(cv2.CAP_PROP_FPS)
            fps = requested_fps if 1 <= requested_fps <= 240 else 30.0
            self.estimated_gb_per_hour = gb_per_hour(width, height, fps, 2 if self.radiometric else 3, 1.0 if self.radiometric else share)
            self.set_state("connected",f"{width}x{height} at {fps:.1f} fps, {'Y16 raw' if self.radiometric else options.codec}")
            settings: dict = {"sensor": self.sensor_id, "codec": "y16-raw" if self.radiometric else options.codec, "width": width, "height": height,
                              "fps": fps, "requested": {"width": options.width, "height": options.height, "fps": options.fps}, "lock": None}
            started = time.monotonic()
            lock_pending = options.lock_settings and not self.radiometric
            rppg = LiveRppg() if self.sensor_id == "face" and not self.radiometric else None
            frame_times: deque[float] = deque(maxlen=90)
            last_preview = 0.0
            dropped = 0
            while not self._stop.is_set():
                ok, frame = capture.read()
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
                    settings["lock"] = lock_camera_settings(capture, cv2, system)
                if (settings["lock"] is not None or not lock_pending) and not settings.get("written"):
                    settings["written"] = True
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
                locked = (settings["lock"] or {}).get("locked")
                metrics = {"width":width,"height":height,"fps":round(measured,2),"droppedFrames":dropped+(recorder.dropped if recorder else 0),"codec":settings["codec"]}
                validation = ["Hardware detected","Frames arriving","Preview available","Frame rate measured"]
                if settings["lock"] is not None:
                    metrics["settingsLocked"] = bool(locked)
                    validation.append("Exposure and white balance locked" if locked else "Exposure or white balance could not be locked")
                if rppg is not None:
                    metrics.update(rppg.update(frame, current, cv2))
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
    def __init__(self, device: str, session_dir: Path, origin_mono: float, sample_rate: int = 48000):
        super().__init__("audio", device, session_dir, origin_mono)
        self.audio_device = int(device) if device.isdigit() else (None if device == "auto" else device)
        self.sample_rate = sample_rate
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
            with sd.RawInputStream(samplerate=self.sample_rate,channels=1,dtype="int16",device=self.audio_device,callback=callback):
                self.set_state("connected",f"Mono {self.sample_rate} Hz")
                while not self._stop.is_set():
                    try:
                        chunk, silence_frames = chunks.get(timeout=0.25)
                    except queue.Empty:
                        continue
                    if self._recording.is_set() and target is None:
                        self.path.parent.mkdir(parents=True,exist_ok=True)
                        target = wave.open(str(self.path),"wb")
                        target.setnchannels(1); target.setsampwidth(2); target.setframerate(self.sample_rate)
                    if not self._recording.is_set() and target is not None:
                        target.close(); target=None
                    if target is not None:
                        if silence_frames:
                            target.writeframesraw(bytes(silence_frames*2))
                        target.writeframesraw(chunk)
                    frames = len(chunk) // 2
                    level = audio_level_pct(chunk)
                    self.sample("Audio signal detected" if level>1 else "Audio connected",len(chunk) if target is not None else 0,frames,float(self.sample_rate),point=level,metrics={"levelPct":level,"sampleRate":self.sample_rate},validation=["Hardware detected","Audio stream open",("Signal detected" if level>1 else "Waiting for sound")])
        except Exception as exc:
            self.set_state("error",f"{type(exc).__name__}: {str(exc)[:120]}")
        finally:
            if target is not None:
                target.close()


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


def discover_device_inventory() -> dict[str,list[dict]]:
    inventory: dict[str,list[dict]] = {"video":[],"audio":[],"serial":[]}
    try:
        from serial.tools import list_ports
        for port in list_ports.comports():
            description = port.description or "Serial device"
            inventory["serial"].append({"id":port.device,"label":f"{port.device} | {description}","kind":"serial","description":description})
    except Exception:
        pass
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
        for index,item in enumerate(sd.query_devices()):
            channels=int(item.get("max_input_channels",0))
            if channels < 1:
                continue
            name=str(item.get("name",f"Input {index}"))
            rate=round(float(item.get("default_samplerate",0)))
            description=f"{name} | {channels} channel | {rate} Hz"
            inventory["audio"].append({"id":str(index),"label":description,"kind":"audio","description":description})
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


def make_sensor(sensor_id: str, value: str, baud: int, session_dir: Path, origin_mono: float, camera_options: CameraOptions | None = None) -> Sensor:
    if value == "simulate":
        return SimulatedSensor(sensor_id,session_dir,origin_mono)
    if value in ("", "none"):
        return UnavailableSensor(sensor_id,"Not configured",session_dir,origin_mono)
    if sensor_id == "face" or sensor_id == "thermal":
        return CameraSensor(sensor_id,"0" if value == "auto" else value,session_dir,origin_mono,camera_options)
    if sensor_id == "audio":
        return AudioSensor(value,session_dir,origin_mono)
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
