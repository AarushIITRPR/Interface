from __future__ import annotations

import csv
import hashlib
import json
import os
import platform
import queue
import threading
import time
import wave
from collections import deque
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

from .models import RecordingArtifact, SensorReport


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

    def set_state(self, status: str, detail: str) -> None:
        with self._lock:
            self._report.status = status
            self._report.detail = detail[:160]

    def sample(self, latest: str, byte_count: int = 0, sample_count: int = 1, rate_hz: float | None = None) -> None:
        current = time.monotonic()
        with self._lock:
            self._sample_times.append(current)
            self._last_sample_mono = current
            self._report.sampleCount += max(1,sample_count)
            self._report.latestValue = latest[:160]
            self._report.bytesWritten += max(0, byte_count)
            if rate_hz is not None:
                self._report.rateHz = rate_hz
            self._report.status = "recording"
            self._report.detail = "Samples arriving"

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
        quality = "pass" if report.sampleCount > 0 and report.status not in ("error", "missing") else "fail"
        return RecordingArtifact(
            sensorId=self.sensor_id,
            relativePath=str(self.path.relative_to(self.session_dir)).replace("\\", "/"),
            format=self.path.suffix.lstrip(".") or "binary",
            sampleCount=report.sampleCount,
            bytes=self.path.stat().st_size,
            sha256=sha256_file(self.path),
            startedAt=self.started_at,
            endedAt=self.ended_at or iso_now(),
            quality=quality,
        )


class UnavailableSensor(Sensor):
    def __init__(self, sensor_id: str, detail: str, session_dir: Path, origin_mono: float):
        super().__init__(sensor_id, "", session_dir, origin_mono)
        self.reason = detail

    def run(self) -> None:
        self.set_state("missing", self.reason)
        self._stop.wait()


class SimulatedSensor(Sensor):
    RATES = {"face":30.0,"audio":48000.0,"oximeter":60.0,"csi":100.0,"emg":1000.0,"gsr":50.0,"ecg":500.0,"thermal":9.0}

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
            while not self._stop.wait(interval):
                latest = "HR 72, SpO2 98%" if self.sensor_id == "oximeter" else "Simulated samples"
                writer.writerow([time.time_ns(),f"{time.monotonic()-self.origin_mono:.6f}",batch,latest])
                self.sample(latest,32,batch,rate)


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

    def run(self) -> None:
        import serial

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
                        writer.writerow(row)
                        self.sample(latest, len(raw))
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


class GenericSerialSensor(SerialLineSensor):
    header = ["host_epoch_ns", "monotonic_s", "raw_line"]


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
        import serial

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
                            writer.writerow([time.time_ns(),f"{time.monotonic()-self.origin_mono:.6f}",parsed["spo2"],parsed["heart_rate"],parsed["signal"],parsed["ppg"]])
                            latest = "Searching for finger" if parsed["searching"] else f"HR {parsed['heart_rate']}, SpO2 {parsed['spo2']}%"
                            self.sample(latest,9)
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


class CameraSensor(Sensor):
    def __init__(self, sensor_id: str, source: str, session_dir: Path, origin_mono: float):
        super().__init__(sensor_id, source, session_dir, origin_mono)
        self.source = int(source) if source.isdigit() else source
        self.path = session_dir / sensor_id / f"{sensor_id}.avi"

    def run(self) -> None:
        import cv2

        self.path.parent.mkdir(parents=True, exist_ok=True)
        capture = None
        writer = None
        try:
            backend = cv2.CAP_DSHOW if platform.system() == "Windows" else cv2.CAP_V4L2 if platform.system() == "Linux" else cv2.CAP_ANY
            capture = cv2.VideoCapture(self.source,backend)
            if not capture.isOpened():
                raise RuntimeError(f"Cannot open camera {self.source}")
            width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH)) or 1280
            height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT)) or 720
            requested_fps = capture.get(cv2.CAP_PROP_FPS)
            fps = requested_fps if 1 <= requested_fps <= 120 else 30.0
            writer = cv2.VideoWriter(str(self.path),cv2.VideoWriter_fourcc(*"MJPG"),fps,(width,height))
            if not writer.isOpened():
                raise RuntimeError("Cannot create camera recording")
            self.set_state("connected",f"{width}x{height} at {fps:.1f} fps")
            while not self._stop.is_set():
                ok, frame = capture.read()
                if not ok:
                    self.set_state("delayed","Camera frame unavailable")
                    self._stop.wait(0.05)
                    continue
                writer.write(frame)
                self.sample(f"{width}x{height}",int(frame.nbytes))
        except Exception as exc:
            self.set_state("error",f"{type(exc).__name__}: {str(exc)[:120]}")
        finally:
            if writer is not None:
                writer.release()
            if capture is not None:
                capture.release()


class AudioSensor(Sensor):
    def __init__(self, device: str, session_dir: Path, origin_mono: float, sample_rate: int = 48000):
        super().__init__("audio", device, session_dir, origin_mono)
        self.audio_device = int(device) if device.isdigit() else (None if device == "auto" else device)
        self.sample_rate = sample_rate
        self.path = session_dir / "audio" / "audio.wav"

    def run(self) -> None:
        import sounddevice as sd

        self.path.parent.mkdir(parents=True, exist_ok=True)
        chunks: queue.Queue[bytes] = queue.Queue(maxsize=256)

        def callback(indata, frames, timing, status):
            del timing
            if status:
                self.set_state("delayed",str(status))
            try:
                chunks.put_nowait(bytes(indata))
            except queue.Full:
                self.set_state("delayed","Audio writer queue full")

        try:
            with wave.open(str(self.path),"wb") as target:
                target.setnchannels(1)
                target.setsampwidth(2)
                target.setframerate(self.sample_rate)
                with sd.RawInputStream(samplerate=self.sample_rate,channels=1,dtype="int16",device=self.audio_device,callback=callback):
                    self.set_state("connected",f"Mono {self.sample_rate} Hz")
                    while not self._stop.is_set():
                        try:
                            chunk = chunks.get(timeout=0.25)
                        except queue.Empty:
                            continue
                        target.writeframesraw(chunk)
                        frames = len(chunk) // 2
                        self.sample("Audio samples arriving",len(chunk),frames,float(self.sample_rate))
        except Exception as exc:
            self.set_state("error",f"{type(exc).__name__}: {str(exc)[:120]}")


def auto_oximeter_port() -> str:
    try:
        from serial.tools import list_ports
        for port in list_ports.comports():
            if port.vid == 0x10C4 and port.pid == 0xEA60:
                return port.device
    except Exception:
        pass
    return ""


def discover_serial_assignments(requested: dict[str,str], bauds: dict[str,int]) -> tuple[dict[str,str],list[dict]]:
    """Identify supplied ESP32 streams by samples, not by USB presence alone."""
    try:
        import serial
        from serial.tools import list_ports
    except Exception:
        return requested,[]
    inventory = [{"device":port.device,"description":port.description,"vid":port.vid,"pid":port.pid,"serialNumber":port.serial_number} for port in list_ports.comports()]
    result = dict(requested)
    claimed = {value for value in result.values() if value not in ("","auto","none","simulate")}
    if result.get("oximeter") == "auto":
        result["oximeter"] = auto_oximeter_port()
        if result["oximeter"]:
            claimed.add(result["oximeter"])
    for sensor_id in ("emg","gsr","csi"):
        if result.get(sensor_id) != "auto":
            continue
        result[sensor_id] = ""
        for item in inventory:
            port = item["device"]
            if port in claimed:
                continue
            if _probe_serial_protocol(serial,port,bauds[sensor_id],sensor_id):
                result[sensor_id] = port
                claimed.add(port)
                break
    return result,inventory


def _probe_serial_protocol(serial_module, port: str, baud: int, sensor_id: str) -> bool:
    handle = None
    try:
        handle = serial_module.Serial(port,baud,timeout=0.15,write_timeout=0.5)
        handle.reset_input_buffer()
        if sensor_id == "emg":
            handle.write(b"?")
            handle.flush()
        deadline = time.monotonic()+1.4
        while time.monotonic()<deadline:
            line = handle.readline().decode("utf-8","replace").strip()
            if not line:
                continue
            if sensor_id == "emg":
                if line.startswith("# emg1"):
                    return True
                parts=line.split(",")
                if len(parts)==3:
                    try:
                        [int(value) for value in parts]
                        return True
                    except ValueError:
                        pass
            if sensor_id == "gsr":
                try:
                    payload=json.loads(line)
                    if "uS" in payload and "raw" in payload:
                        return True
                except (json.JSONDecodeError,TypeError):
                    pass
            if sensor_id == "csi":
                raw_line=line[9:] if line.startswith("CSI_DATA,") else line
                parts=raw_line.split(",")
                if len(parts)>=8:
                    try:
                        rssi=float(parts[2])
                        if -140<=rssi<=20:
                            return True
                    except ValueError:
                        pass
    except Exception:
        return False
    finally:
        if handle is not None:
            try:
                handle.close()
            except Exception:
                pass
    return False


def make_sensor(sensor_id: str, value: str, baud: int, session_dir: Path, origin_mono: float) -> Sensor:
    if value == "simulate":
        return SimulatedSensor(sensor_id,session_dir,origin_mono)
    if value in ("", "none"):
        return UnavailableSensor(sensor_id,"Not configured",session_dir,origin_mono)
    if sensor_id == "face" or sensor_id == "thermal":
        return CameraSensor(sensor_id,"0" if value == "auto" else value,session_dir,origin_mono)
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
    return GenericSerialSensor(sensor_id,value,baud,session_dir,origin_mono)
