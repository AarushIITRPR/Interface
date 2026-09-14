"""Hardware emulators for testing Meridian without the sensors attached.

Each emulated device speaks the same wire format as the real one, over a virtual serial port (Linux/macOS pty) or,
for Frontier X ECG, a local WebSocket. The agent therefore exercises its real parsers, recording, derived signals,
and export. A shared physiology model follows the live protocol step (read from the Meridian server), so derived
values can be checked against what was generated: heart rate rises during exertion, breathing follows the paced
breathing rate, skin conductance responds to clip onsets, and the photodiode flashes when the subject display logs
a stimulus or step event.

    python tools/emulate_devices.py --server http://localhost:3000 --code SESSION_CODE --links ../.local-run/devices

Port links are created in --links (oximeter, csi, csi2, emg, gsr, resp, environment, photodiode). Start the agent
with MERIDIAN_FRONTIERX_WS_URL=ws://127.0.0.1:8766 and use a numeric Frontier X user id for ECG.

The photodiode emulator learns about display events by polling the server, so its flashes lag the real display by
the polling interval; a real photodiode measures the screen directly.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import math
import os
import random
import select
import signal
import socket
import threading
import time
import tty
import urllib.request
from pathlib import Path

FRONTIERX_SCALE_PER_COUNT = 0.0000038146972


class ProtocolState:
    """Polls the session so emulated physiology can follow the protocol."""

    def __init__(self, server: str, code: str):
        self.url = f"{server.rstrip('/')}/api/sessions?code={code}"
        self.lock = threading.Lock()
        self.status = "setup"
        self.step_type = "setup"
        self.step_title = ""
        self.breaths_per_min: float | None = None
        self.calibrating = False
        self.last_sequence = 0
        self.display_events: list[float] = []
        self.clip_onsets: list[float] = []

    def run(self, stop: threading.Event) -> None:
        plan_cache: dict[int, dict] = {}
        while not stop.is_set():
            try:
                with urllib.request.urlopen(self.url, timeout=5) as response:
                    session = json.load(response)["session"]
                events = [event for event in session["events"] if event["sequence"] > self.last_sequence]
                step_index = session["stepIndex"]
                step_event = next((event for event in reversed(session["events"]) if event["eventType"] == "step_start"), None)
                with self.lock:
                    self.status = session["status"]
                    self.calibrating = (session.get("csiCalibration") or {}).get("status") == "running"
                    if step_event:
                        self.step_title = step_event.get("detail", "")
                    for event in events:
                        if event["eventType"] in ("step_displayed", "media_onset", "media_offset"):
                            self.display_events.append(time.monotonic())
                        if event["eventType"] == "media_onset":
                            self.clip_onsets.append(time.monotonic())
                    if events:
                        self.last_sequence = events[-1]["sequence"]
                if step_index not in plan_cache:
                    plan_cache[step_index] = {}
                title = self.step_title.lower()
                with self.lock:
                    self.step_type = ("exertion" if "exertion" in title else "standing" if "standing" in title else "breath_hold" if "breath hold" in title
                                      else "paced" if "paced breathing" in title else "movement" if "head movement" in title else "clip" if title.startswith("clip") else "rest")
                    rate = None
                    if "paced breathing" in title:
                        try:
                            rate = float(title.split(":")[1].split("per")[0])
                        except (IndexError, ValueError):
                            rate = None
                    self.breaths_per_min = rate
            except Exception:
                pass
            stop.wait(0.1)

    def snapshot(self) -> dict:
        with self.lock:
            return {"status": self.status, "stepType": self.step_type, "breathsPerMin": self.breaths_per_min, "calibrating": self.calibrating}

    def take_display_events(self) -> list[float]:
        with self.lock:
            events, self.display_events = self.display_events, []
            return events

    def take_clip_onsets(self) -> list[float]:
        with self.lock:
            onsets, self.clip_onsets = self.clip_onsets, []
            return onsets


class Physiology:
    """Heart and breathing phases integrated over time, with targets set by the protocol step."""

    TARGET_HR = {"rest": 72.0, "clip": 76.0, "exertion": 112.0, "standing": 86.0, "breath_hold": 64.0, "movement": 78.0, "paced": 70.0}

    def __init__(self, protocol: ProtocolState):
        self.protocol = protocol
        self.lock = threading.Lock()
        self.hr = 72.0
        self.breathing = 15.0
        self.heart_phase = 0.0
        self.breath_phase = 0.0
        self.last = time.monotonic()
        self.beats: list[float] = []

    def advance(self) -> None:
        now = time.monotonic()
        with self.lock:
            dt = now - self.last
            self.last = now
            state = self.protocol.snapshot()
            target_hr = self.TARGET_HR.get(state["stepType"], 72.0)
            self.hr += (target_hr - self.hr) * min(1.0, dt / 8.0)
            target_breathing = state["breathsPerMin"] or (0.0 if state["stepType"] == "breath_hold" else 15.0)
            self.breathing += (target_breathing - self.breathing) * min(1.0, dt / 2.0)
            previous = self.heart_phase
            self.heart_phase += dt * self.hr / 60.0
            if int(self.heart_phase) > int(previous):
                self.beats.append(now)
                self.beats = self.beats[-8:]
            self.breath_phase += dt * self.breathing / 60.0

    def values(self) -> dict:
        with self.lock:
            return {"hr": self.hr, "breathing": self.breathing, "heartPhase": self.heart_phase % 1.0, "breathPhase": self.breath_phase % 1.0, "beats": list(self.beats)}


class VirtualPort:
    """A pty pair; the agent opens the slave through a symlink, the emulator reads and writes the master."""

    def __init__(self, name: str, links: Path):
        self.master, self.slave = os.openpty()
        tty.setraw(self.slave)
        tty.setraw(self.master)
        self.path = os.ttyname(self.slave)
        link = links / name
        if link.is_symlink() or link.exists():
            link.unlink()
        link.symlink_to(self.path)
        self.link = link

    def write(self, data: bytes) -> None:
        try:
            view = memoryview(data)
            while view:
                _, writable, _ = select.select([], [self.master], [], 0.05)
                if not writable:
                    return  # nobody is reading: drop, like a real UART without a listener
                written = os.write(self.master, view)
                view = view[written:]
        except OSError:
            pass

    def read_available(self) -> bytes:
        readable, _, _ = select.select([self.master], [], [], 0)
        if not readable:
            return b""
        try:
            return os.read(self.master, 1024)
        except OSError:
            return b""


def paced_loop(stop: threading.Event, rate_hz: float, emit) -> None:
    period = 1.0 / rate_hz
    next_time = time.monotonic()
    while not stop.is_set():
        now = time.monotonic()
        if now < next_time:
            time.sleep(min(period, next_time - now))
            continue
        batches = min(50, int((now - next_time) / period) + 1)
        emit(batches)
        next_time += batches * period


def pleth(phase: float) -> float:
    return math.exp(-((phase - 0.18) ** 2) / 0.006) + 0.35 * math.exp(-((phase - 0.45) ** 2) / 0.01)


def ecg_wave(phase: float) -> float:
    return -0.12 * math.exp(-((phase - 0.02) ** 2) / 0.0004) + 1.1 * math.exp(-((phase - 0.05) ** 2) / 0.00008) - 0.2 * math.exp(-((phase - 0.08) ** 2) / 0.0003) + 0.3 * math.exp(-((phase - 0.35) ** 2) / 0.004)


def oximeter(port: VirtualPort, body: Physiology, stop: threading.Event) -> None:
    """CMS50E: streams 9-byte packets at 60 Hz after receiving the start command."""
    streaming = False

    def emit(count: int) -> None:
        nonlocal streaming
        incoming = port.read_available()
        if b"\x7d\x81\xa1" in incoming:
            streaming = True
        if b"\x7d\x81\xa2" in incoming:
            streaming = False
        if not streaming:
            return
        body.advance()
        values = body.values()
        packets = bytearray()
        for _ in range(count):
            ppg = int(max(0, min(100, 10 + 80 * pleth(values["heartPhase"]))))
            hr = int(round(values["hr"]))
            spo2 = 97 + (1 if random.random() < 0.3 else 0)
            packets.extend(bytes([0x01, 0x80, 0x80 | 0x60, 0x80 | ppg, 0x80, hr & 0x7F, spo2 & 0x7F, 0x80, 0x80]))
        port.write(bytes(packets))

    paced_loop(stop, 60.0, emit)


def esp32_csi(port: VirtualPort, body: Physiology, protocol: ProtocolState, stop: threading.Event, seed: int) -> None:
    """ESP32 CSI receiver: CSI_DATA lines with 52 subcarrier amplitudes modulated by breathing and heartbeat."""
    rng = random.Random(seed)
    base = [12 + 8 * math.sin(i / 5 + seed) for i in range(52)]
    packet = 0

    def emit(count: int) -> None:
        nonlocal packet
        body.advance()
        values = body.values()
        empty = protocol.snapshot()["calibrating"] or protocol.snapshot()["stepType"] == "left_seat"
        lines = []
        for _ in range(count):
            packet += 1
            breath = 0.0 if empty else 1.6 * math.sin(2 * math.pi * values["breathPhase"])
            heart = 0.0 if empty else 0.15 * pleth(values["heartPhase"])
            amplitudes = ",".join(f"{max(0.0, b + breath * (0.5 + 0.5 * math.sin(i)) + heart + rng.gauss(0, 0.4)):.2f}" for i, b in enumerate(base))
            rssi = -48 + (0 if empty else -2) + rng.randint(-1, 1)
            lines.append(f"CSI_DATA,{int(time.time() * 1000)},{packet},{rssi},11,-92,6,{amplitudes}\n")
        port.write("".join(lines).encode())

    paced_loop(stop, 100.0, emit)


def emg(port: VirtualPort, body: Physiology, protocol: ProtocolState, stop: threading.Event) -> None:
    """ESP32 EMG: replies to '?' with a header, then t_us,seq,raw at 1 kHz with bursts during movement and exertion."""
    rng = random.Random(3)
    sequence = 0
    started = time.monotonic()
    header_sent = False

    def emit(count: int) -> None:
        nonlocal sequence, header_sent
        if b"?" in port.read_available() or not header_sent:
            port.write(b"# emg1 t_us,seq,raw\n")
            header_sent = True
        active = protocol.snapshot()["stepType"] in ("exertion", "movement", "standing")
        lines = []
        for _ in range(count):
            sequence += 1
            amplitude = 380 if active else 25
            raw = int(max(0, min(4095, 2048 + rng.gauss(0, amplitude))))
            lines.append(f"{int((time.monotonic() - started) * 1e6)},{sequence},{raw}\n")
        port.write("".join(lines).encode())

    paced_loop(stop, 1000.0, emit)


def gsr(port: VirtualPort, protocol: ProtocolState, stop: threading.Event) -> None:
    """ESP32 GSR JSON lines at 20 Hz: tonic level with skin conductance responses after clip onsets and artifacts."""
    rng = random.Random(4)
    responses: list[float] = []
    started = time.monotonic()
    next_spontaneous = started + 25

    def emit(count: int) -> None:
        nonlocal next_spontaneous
        now = time.monotonic()
        responses.extend(onset + 1.5 for onset in protocol.take_clip_onsets())
        if now > next_spontaneous:
            responses.append(now)
            next_spontaneous = now + rng.uniform(30, 50)
        del responses[:-10]
        lines = []
        for index in range(count):
            t = now - (count - 1 - index) / 20
            tonic = 3.0 + 0.003 * (t - started)
            phasic = sum(0.35 * (1 - math.exp(-(t - r) / 1.0)) * math.exp(-(t - r) / 5.0) for r in responses if t > r)
            value = tonic + phasic + rng.gauss(0, 0.004)
            lines.append(json.dumps({"uS": round(value, 4), "raw": int(value * 300), "stress": round(phasic, 3), "zScore": round(phasic / 0.2, 3)}) + "\n")
        port.write("".join(lines).encode())

    paced_loop(stop, 20.0, emit)


def respiration(port: VirtualPort, body: Physiology, stop: threading.Event) -> None:
    """Respiration belt on an ESP32 ADC: t_us,raw at 50 Hz."""
    rng = random.Random(5)
    started = time.monotonic()

    def emit(count: int) -> None:
        body.advance()
        values = body.values()
        lines = [f"{int((time.monotonic() - started) * 1e6)},{int(2048 + 600 * math.sin(2 * math.pi * values['breathPhase']) + rng.gauss(0, 8))}\n" for _ in range(count)]
        port.write("".join(lines).encode())

    paced_loop(stop, 50.0, emit)


def environment(port: VirtualPort, stop: threading.Event) -> None:
    """Room sensor: t_ms,temp_c,humidity_pct,lux,pressure_hpa at 1 Hz."""
    rng = random.Random(6)
    started = time.monotonic()

    def emit(count: int) -> None:
        elapsed = time.monotonic() - started
        port.write(f"{int(elapsed * 1000)},{23.2 + 0.0004 * elapsed + rng.gauss(0, 0.02):.2f},{47.5 + rng.gauss(0, 0.1):.1f},{312 + rng.gauss(0, 3):.0f},{1008.4 + rng.gauss(0, 0.05):.2f}\n".encode())

    paced_loop(stop, 1.0, emit)


def photodiode(port: VirtualPort, protocol: ProtocolState, stop: threading.Event) -> None:
    """Photodiode on the sync patch: t_us,raw at 1 kHz; bright for 200 ms after each display event the server reports."""
    rng = random.Random(7)
    started = time.monotonic()
    bright_until = 0.0

    def emit(count: int) -> None:
        nonlocal bright_until
        now = time.monotonic()
        if protocol.take_display_events():
            bright_until = now + 0.2
        level = 3900 if now < bright_until else 140
        lines = [f"{int((now - started) * 1e6)},{int(level + rng.gauss(0, 6))}\n" for _ in range(count)]
        port.write("".join(lines).encode())

    paced_loop(stop, 1000.0, emit)


def frontierx_server(port_number: int, body: Physiology, stop: threading.Event) -> None:
    """Minimal WebSocket server emulating the Frontier X live-share stream: one packet per second of 125 Hz ECG."""
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    listener.bind(("127.0.0.1", port_number))
    listener.listen(4)
    listener.settimeout(0.5)

    def frame(text: str) -> bytes:
        payload = text.encode()
        header = bytearray([0x81])
        if len(payload) < 126:
            header.append(len(payload))
        elif len(payload) < 65536:
            header.append(126)
            header.extend(len(payload).to_bytes(2, "big"))
        else:
            header.append(127)
            header.extend(len(payload).to_bytes(8, "big"))
        return bytes(header) + payload

    def serve(client: socket.socket) -> None:
        try:
            request = client.recv(4096).decode("latin-1")
            key = next(line.split(":", 1)[1].strip() for line in request.split("\r\n") if line.lower().startswith("sec-websocket-key"))
            accept = base64.b64encode(hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()).decode()
            client.sendall(f"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {accept}\r\n\r\n".encode())
            client.settimeout(0.05)
            session_ms = int(time.time() * 1000)
            client.sendall(frame(json.dumps({"type": "livecg-begin"})))
            packet_no = 0
            rng = random.Random(8)
            phase_time = time.monotonic()
            heart_phase = 0.0
            while not stop.is_set():
                started = time.monotonic()
                counts = []
                for _ in range(125):
                    body.advance()
                    hr = body.values()["hr"]
                    heart_phase += hr / 60.0 / 125.0
                    millivolts = ecg_wave(heart_phase % 1.0) + 0.05 * math.sin(2 * math.pi * 0.25 * (time.monotonic() - phase_time)) + rng.gauss(0, 0.02)
                    counts.append(round(millivolts / FRONTIERX_SCALE_PER_COUNT))
                client.sendall(frame(json.dumps({"type": "livecg", "packetNo": packet_no, "Timestamp": session_ms, "heartrate": round(body.values()["hr"]), "data": counts})))
                packet_no += 1
                try:
                    client.recv(4096)
                except (socket.timeout, BlockingIOError):
                    pass
                time.sleep(max(0.0, 1.0 - (time.monotonic() - started)))
        except Exception:
            pass
        finally:
            client.close()

    while not stop.is_set():
        try:
            client, _ = listener.accept()
        except socket.timeout:
            continue
        threading.Thread(target=serve, args=(client,), daemon=True).start()
    listener.close()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--server", default="http://localhost:3000")
    parser.add_argument("--code", required=True)
    parser.add_argument("--links", default="devices")
    parser.add_argument("--frontierx-port", type=int, default=8766)
    args = parser.parse_args()
    links = Path(args.links).resolve()
    links.mkdir(parents=True, exist_ok=True)
    stop = threading.Event()
    protocol = ProtocolState(args.server, args.code)
    body = Physiology(protocol)
    ports = {name: VirtualPort(name, links) for name in ("oximeter", "csi", "csi2", "emg", "gsr", "resp", "environment", "photodiode")}
    workers = [
        (protocol.run, (stop,)),
        (oximeter, (ports["oximeter"], body, stop)),
        (esp32_csi, (ports["csi"], body, protocol, stop, 1)),
        (esp32_csi, (ports["csi2"], body, protocol, stop, 2)),
        (emg, (ports["emg"], body, protocol, stop)),
        (gsr, (ports["gsr"], protocol, stop)),
        (respiration, (ports["resp"], body, stop)),
        (environment, (ports["environment"], stop)),
        (photodiode, (ports["photodiode"], protocol, stop)),
        (frontierx_server, (args.frontierx_port, body, stop)),
    ]
    for target, arguments in workers:
        threading.Thread(target=target, args=arguments, daemon=True).start()
    for name, port in ports.items():
        print(f"{name:12s} {port.link} -> {port.path}", flush=True)
    print(f"frontierx    ws://127.0.0.1:{args.frontierx_port}", flush=True)
    signal.signal(signal.SIGTERM, lambda *_: stop.set())
    try:
        while not stop.is_set():
            stop.wait(1)
    except KeyboardInterrupt:
        stop.set()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
