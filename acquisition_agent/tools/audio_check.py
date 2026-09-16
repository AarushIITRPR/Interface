"""Show which microphone is actually carrying sound, as a live level meter per input device.

Meridian records one audio device, and when it is left on Auto-detect the agent hands PortAudio
`device=None` — the system default, which on a PipeWire box is rarely the microphone you meant. The
console then reports the device as "auto" and a hardcoded 48000 Hz, so a session can record the
laptop's built-in microphone while looking perfectly healthy. This tool answers the question the
console cannot: speak, and see which device moves.

    python tools/audio_check.py                     # meter every input until Ctrl-C
    python tools/audio_check.py --list              # list inputs and exit
    python tools/audio_check.py --device ILCE       # only devices whose name contains this
    python tools/audio_check.py --seconds 15        # stop after 15 seconds

Levels use the same formula as the operator console's "Input level %" (audio_level_pct in
meridian_agent/sensors.py), so a reading here matches what the console shows for the same source.

Reading is passive: the tool opens inputs for capture only and writes nothing.

Running it beside a live session is limited, and the limit was measured rather than assumed: while
another program holds an ALSA `hw:` device, that device is not merely locked but **absent from
PortAudio's device list**, so the tool cannot see or meter it at all. In practice this means running
the check *before* starting the agent. Mid-session, `--include-virtual` can still meter the
`pipewire` alias, which the sound server does mix, though it reports whatever is routed rather than
naming a physical input.

Stereo inputs also show per-channel levels, which is how you tell that a mic wired into one side of
a camera jack — a DJI receiver in a Sony's 3.5 mm socket, say — is landing on L or R only.
"""
from __future__ import annotations

import argparse
import signal
import sys
import threading
import time

BAR_WIDTH = 24
REFRESH_S = 0.2
PEAK_HOLD_S = 1.5
#: Level above which the agent calls a stream "Signal detected" rather than "Waiting for sound".
SIGNAL_THRESHOLD = 1.0


def level_pct(samples) -> float:
    """RMS scaled to 0-100, identical to audio_level_pct so readings match the console."""
    import numpy as np

    if samples.size == 0:
        return 0.0
    rms = float(np.sqrt(np.mean(np.square(samples, dtype=np.float64))))
    return min(100.0, round(rms / 32768 * 240, 1))


class Meter:
    """One input device, its live level, and why it could not be opened if it could not."""

    def __init__(self, index: int, name: str, channels: int, samplerate: int):
        self.index = index
        self.name = name
        self.channels = channels
        self.samplerate = samplerate
        self.level = 0.0
        self.channel_levels: list[float] = []
        self.peak = 0.0
        self.peak_at = 0.0
        self.error: str | None = None
        self.stream = None
        self._lock = threading.Lock()

    def _callback(self, indata, frames, timing, status) -> None:
        del frames, timing, status  # xruns are expected when several readers share a device
        import numpy as np

        block = np.frombuffer(indata, dtype=np.int16)
        if self.channels > 1:
            block = block.reshape(-1, self.channels)
            channel_levels = [level_pct(block[:, c]) for c in range(self.channels)]
            # The agent averages stereo to mono before recording, so meter the same signal it keeps.
            mono = block.mean(axis=1).astype(np.int16)
        else:
            channel_levels = []
            mono = block
        value = level_pct(mono)
        now = time.monotonic()
        with self._lock:
            self.level = value
            self.channel_levels = channel_levels
            if value >= self.peak or now - self.peak_at > PEAK_HOLD_S:
                self.peak = value
                self.peak_at = now

    def open(self, sd) -> None:
        try:
            self.stream = sd.RawInputStream(samplerate=self.samplerate, channels=self.channels,
                                            dtype="int16", device=self.index, callback=self._callback)
            self.stream.start()
        except Exception as exc:
            # Nearly always another program holding the device exclusively. Say so and keep going;
            # one busy device must not stop the operator seeing the rest.
            self.error = f"{type(exc).__name__}: {str(exc).splitlines()[0][:70]}"
            self.stream = None

    def close(self) -> None:
        if self.stream is not None:
            try:
                self.stream.stop()
                self.stream.close()
            except Exception:
                pass
            self.stream = None

    def snapshot(self) -> tuple[float, float, list[float]]:
        with self._lock:
            return self.level, self.peak, list(self.channel_levels)


#: Virtual endpoints that alias whatever the sound server currently routes, rather than being a
#: microphone of their own. They are skipped by default for two reasons: their level tells you
#: nothing about *which* physical input is live, which is the only question this tool exists to
#: answer; and opening one alongside the hardware device it aliases wedges PortAudio on PipeWire —
#: metering all four inputs on this machine hangs, while the two hardware inputs together do not.
VIRTUAL_DEVICES = {"default", "pipewire", "pulse", "sysdefault", "jack", "spdif"}


def is_virtual(name: str) -> bool:
    return name.split(" (hw:")[0].strip().lower() in VIRTUAL_DEVICES


def input_devices(sd, needle: str | None, include_virtual: bool) -> list[tuple[int, dict]]:
    found = []
    for index, device in enumerate(sd.query_devices()):
        name = str(device.get("name", ""))
        if int(device.get("max_input_channels", 0)) < 1:
            continue
        if needle and needle.lower() not in name.lower():
            continue
        # A name given explicitly with --device is an explicit request, so honour it either way.
        if is_virtual(name) and not include_virtual and not needle:
            continue
        found.append((index, device))
    return found


def bar(value: float) -> str:
    filled = int(round(min(100.0, value) / 100 * BAR_WIDTH))
    return "#" * filled + "." * (BAR_WIDTH - filled)


def render(meters: list[Meter], elapsed: float) -> str:
    lines = [f"  {'idx':>3}  {'device':<38} {'level':>6} {'peak':>6}  meter"]
    for meter in meters:
        if meter.error:
            lines.append(f"  {meter.index:>3}  {meter.name[:38]:<38} {'--':>6} {'--':>6}  unavailable: {meter.error}")
            continue
        level, peak, channels = meter.snapshot()
        mark = " <= SIGNAL" if level > SIGNAL_THRESHOLD else ""
        lines.append(f"  {meter.index:>3}  {meter.name[:38]:<38} {level:>6.1f} {peak:>6.1f}  {bar(level)}{mark}")
        if channels:
            detail = "  ".join(f"ch{c}: {value:5.1f}" for c, value in enumerate(channels))
            lines.append(f"       {'':<38} {'':>6} {'':>6}  {detail}")
    lines.append("")
    lines.append(f"  speak into the microphone you expect to record; {elapsed:5.1f}s elapsed, Ctrl-C to stop")
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description="Live level meter for every audio input, to identify which microphone is recording.")
    parser.add_argument("--list", action="store_true", help="list input devices and exit")
    parser.add_argument("--device", help="only meter devices whose name contains this text")
    parser.add_argument("--seconds", type=float, default=0.0, help="stop after this many seconds (default: run until Ctrl-C)")
    parser.add_argument("--include-virtual", action="store_true", help="also meter default/pipewire aliases (can wedge PortAudio alongside the hardware they alias)")
    args = parser.parse_args()

    try:
        import sounddevice as sd
    except Exception as exc:
        print(f"sounddevice is required: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 2
    try:
        import numpy  # noqa: F401  # imported for the level maths, fail early with a clear message
    except Exception as exc:
        print(f"numpy is required: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 2

    devices = input_devices(sd, args.device, args.include_virtual)
    if not devices:
        print("No matching input devices." if args.device else "No audio input devices found.", file=sys.stderr)
        # A device another program holds is dropped from PortAudio's list entirely, so "not found"
        # and "in use by the agent" look identical from here. Say so rather than leave it a mystery.
        print("A device already held by another program (the acquisition agent, usually) does not appear\n"
              "in this list at all. Stop the agent and try again, or use --include-virtual to meter the\n"
              "pipewire alias instead.", file=sys.stderr)
        return 1

    if args.list:
        print(f"  {'idx':>3}  {'device':<44} {'ch':>3} {'default rate':>13}")
        for index, device in devices:
            print(f"  {index:>3}  {str(device['name'])[:44]:<44} {int(device['max_input_channels']):>3} {round(float(device['default_samplerate'])):>13}")
        return 0

    meters = []
    for index, device in devices:
        channels = max(1, min(2, int(device["max_input_channels"])))
        samplerate = int(round(float(device.get("default_samplerate") or 48000))) or 48000
        meters.append(Meter(index, str(device["name"]), channels, samplerate))
    for meter in meters:
        meter.open(sd)

    live = [meter for meter in meters if meter.error is None]
    if not live:
        print("Every input device is unavailable:", file=sys.stderr)
        for meter in meters:
            print(f"  {meter.name}: {meter.error}", file=sys.stderr)
        return 1

    stop = threading.Event()
    signal.signal(signal.SIGINT, lambda *_: stop.set())
    signal.signal(signal.SIGTERM, lambda *_: stop.set())

    started = time.monotonic()
    printed = 0
    try:
        while not stop.is_set():
            elapsed = time.monotonic() - started
            if args.seconds and elapsed >= args.seconds:
                break
            frame = render(meters, elapsed)
            if printed:
                sys.stdout.write(f"\033[{printed}A")
            sys.stdout.write("\033[J" + frame + "\n")
            sys.stdout.flush()
            printed = frame.count("\n") + 1
            stop.wait(REFRESH_S)
    finally:
        for meter in meters:
            meter.close()

    loudest = max((meter for meter in meters if meter.error is None), key=lambda meter: meter.peak, default=None)
    if loudest is not None and loudest.peak > SIGNAL_THRESHOLD:
        print(f"\n  loudest input was [{loudest.index}] {loudest.name} at peak {loudest.peak:.1f}%")
        print("  assign that device in Recording setup rather than leaving Room audio on Auto-detect.")
    else:
        print("\n  no input rose above the signal threshold; nothing was speaking into any device.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
