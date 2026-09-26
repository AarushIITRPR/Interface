"""Record a long empty-room CSI baseline outside any session, in the format preflight accepts as today's baseline.

    .venv/bin/python tools/record_empty_room.py                      # 180 s to leave the room, then 30 min
    .venv/bin/python tools/record_empty_room.py --minutes 1 --grace 5 --out /tmp/check

Writes empty_room_<stamp>.csv, .json and .log to recordings/empty_room_baselines. The agent's find_rig_baseline adopts
a file from the same day on the same receiver, but only if no minute stalled or dropped below good quality, so a run
anyone walked through, or one stopped early with Ctrl-C, is recorded as such rather than silently accepted. The
2026-09-22 baseline was made by a one-off script that was never committed; this is that script, kept.

Stop the acquisition agent first: it holds the receiver's serial port.
"""
from __future__ import annotations

import argparse
import json
import sys
import tempfile
import time
from pathlib import Path

AGENT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(AGENT))

from meridian_agent.sensors import CsiSensor  # noqa: E402

DEFAULT_PORT = "/dev/serial/by-id/usb-Espressif_USB_JTAG_serial_debug_unit_D0:CF:13:E2:92:F8-if00"
GEOMETRY_NOTE = "fill in: TX/RX positions, distance, heights, channel, bandwidth — must match sessions"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--port", default=DEFAULT_PORT)
    parser.add_argument("--baud", type=int, default=921600)
    parser.add_argument("--minutes", type=float, default=30.0)
    parser.add_argument("--grace", type=float, default=180.0, help="seconds to leave the room before recording starts")
    parser.add_argument("--out", type=Path, default=AGENT / "recordings" / "empty_room_baselines")
    args = parser.parse_args()

    args.out.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y%m%d_%H%M%S")
    base = args.out / f"empty_room_{stamp}"
    log_lines: list[str] = []

    def log(message: str) -> None:
        line = f"{time.strftime('%H:%M:%S')} {message}"
        print(line, flush=True)
        log_lines.append(line)

    def status(report) -> str:
        return (f"status={report.status} quality={report.quality} rate={report.rateHz} Hz "
                f"rssi={report.metrics.get('rssi')} latency={report.latencyMs} ms detail='{report.detail}'")

    # The sensor also keeps its own csi/csi.csv, which only fills during a session recording; keep it out of the way.
    work = tempfile.TemporaryDirectory(prefix="empty-room-")
    sensor = CsiSensor("csi", args.port, args.baud, Path(work.name), time.monotonic())
    sensor.start()
    info: dict = {"kind": "empty_room_csi_baseline", "sensorId": "csi", "port": args.port, "baud": args.baud}
    rows = 0
    minute_rates: list[float] = []
    stalled: list[int] = []
    non_good: list[int] = []
    aborted = False
    try:
        log(f"Opened {args.port}; grace period {args.grace:.0f} s — leave the room now")
        grace_end = time.monotonic() + args.grace
        while (left := grace_end - time.monotonic()) > 0:
            time.sleep(min(15.0, left))
            log(f"[grace {args.grace - max(0.0, grace_end - time.monotonic()):5.0f}s] {status(sensor.report())}")
        report = sensor.report()
        if not report.dataDetected:
            log(f"No CSI frames arrived during the grace period; not recording. {status(report)}")
            return 1
        sensor.start_side_capture(str(base.with_suffix(".csv")), CsiSensor.header)
        info["startedAt"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
        started = time.monotonic()
        log(f"RECORDING {args.minutes:g} min -> {base.with_suffix('.csv')}")
        minute = 0
        previous = 0
        while minute < args.minutes:
            time.sleep(max(0.0, started + 60.0 * (minute + 1) - time.monotonic()) if minute + 1 <= args.minutes
                       else max(0.0, started + 60.0 * args.minutes - time.monotonic()))
            minute += 1
            with sensor._lock:
                current = sensor._side_rows
            report = sensor.report()
            gained = current - previous
            previous = current
            minute_rates.append(gained / 60.0)
            if gained == 0:
                stalled.append(minute)
            if report.quality != "good":
                non_good.append(minute)
            log(f"[rec {minute:4.1f} min rows={current}] {status(report)}")
    except KeyboardInterrupt:
        aborted = True
        log("Stopped early with Ctrl-C; this baseline is marked aborted and preflight will not use it")
    finally:
        final = sensor.report()
        rows = sensor.stop_side_capture()
        sensor.stop()
        work.cleanup()

    if "startedAt" not in info:
        return 1
    duration = time.monotonic() - started
    info.update({
        "endedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "durationS": round(duration, 1), "graceS": args.grace,
        "rows": rows, "meanRateHz": round(rows / duration, 2) if duration else 0.0,
        "worstMinuteRateHz": round(min(minute_rates), 2) if minute_rates else 0.0,
        "stalledMinutes": len(stalled), "nonGoodMinutes": non_good,
        "finalReport": {"status": final.status, "quality": final.quality, "detail": final.detail, "rateHz": final.rateHz},
        "finalMetrics": final.metrics, "csvHeader": CsiSensor.header, "geometry": {"note": GEOMETRY_NOTE},
    })
    if aborted:
        info["aborted"] = True
    base.with_suffix(".json").write_text(json.dumps(info, indent=2), encoding="utf-8")
    log(f"Done: {rows} rows, {info['meanRateHz']} Hz mean, {len(stalled)} stalled and {len(non_good)} degraded minutes")
    base.with_suffix(".log").write_text("\n".join(log_lines) + "\n", encoding="utf-8")
    return 0 if not aborted and not stalled and not non_good else 2


if __name__ == "__main__":
    sys.exit(main())
