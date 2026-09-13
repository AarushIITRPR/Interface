"""Analysis-ready session bundle: protocol events on the acquisition computer's clock plus a per-step QA report.

Sensor files stamp every row with the host clock (``host_epoch_ns``). Meridian records protocol events on the server
clock, and stimulus events additionally carry the subject display's server-corrected browser time. The agent measures
the server-minus-host offset continuously, so every event can be placed on the same clock as the raw samples.
"""
from __future__ import annotations

import csv
import hashlib
import json
import math
import time
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

PAUSE_START_EVENTS = {"session_paused", "operator_lost", "sensor_lost"}
MIN_STEP_COVERAGE_PCT = 95.0


@dataclass(frozen=True)
class HostClock:
    """Maps server timestamps onto the host clock and the agent's monotonic session clock."""

    offset_ms: float
    origin_mono: float
    anchor_epoch_ns: int
    anchor_mono: float

    @classmethod
    def now(cls, offset_ms: float, origin_mono: float) -> "HostClock":
        return cls(offset_ms, origin_mono, time.time_ns(), time.monotonic())

    def server_to_host_ns(self, iso: str | None) -> int | None:
        if not iso:
            return None
        try:
            parsed = datetime.fromisoformat(str(iso).replace("Z", "+00:00"))
        except ValueError:
            return None
        return round(parsed.timestamp() * 1_000_000) * 1000 - round(self.offset_ms * 1_000_000)

    def host_to_monotonic_s(self, host_ns: int) -> float:
        return (host_ns - self.anchor_epoch_ns) / 1e9 + self.anchor_mono - self.origin_mono


def event_time(event: dict) -> str | None:
    """The best available time for an event: the display's playback time for stimuli, otherwise server receipt."""
    return event.get("clientTime") or event.get("serverTime")


def event_marker(event: dict, clock: HostClock) -> dict:
    host_ns = clock.server_to_host_ns(event_time(event))
    return {
        "sequence": event.get("sequence"),
        "eventType": event.get("eventType"),
        "stepId": event.get("stepId"),
        "stepIndex": event.get("stepIndex"),
        "attempt": event.get("attempt"),
        "source": event.get("source"),
        "hostEpochNs": host_ns,
        "monotonicS": None if host_ns is None else round(clock.host_to_monotonic_s(host_ns), 6),
        "timeSource": "display" if event.get("clientTime") else "server",
        "serverTime": event.get("serverTime"),
        "clientTime": event.get("clientTime"),
        "label": event.get("label"),
        "detail": event.get("detail"),
        "metadata": event.get("metadata") or {},
    }


def open_window(step: dict, event: dict, start_ns: int | None, attempt) -> dict:
    return {
        "step_index": event.get("stepIndex"), "step_id": event.get("stepId"), "attempt": attempt,
        "type": step.get("type", ""), "label": step.get("label", ""), "phase": step.get("phase", ""),
        "emotion": step.get("emotion") or "", "planned_duration_s": step.get("durationSec"), "advance": step.get("advance", ""),
        "start_ns": start_ns, "pause_ns": 0, "pauses": 0, "stimulus_onset_ns": None, "stimulus_load_delay_ms": None,
        "media_interruptions": 0, "stimulus_starts": 0,
    }


def step_windows(export: dict, clock: HostClock) -> list[dict]:
    """One row per step attempt, bounded by its step_start and the next step start or session end."""
    plan = {step["index"]: step for step in export.get("plan", [])}
    events = sorted(export.get("events", []), key=lambda item: item.get("sequence", 0))
    windows: list[dict] = []
    current: dict | None = None
    pause_started: int | None = None

    def close(end_ns: int | None, reason: str) -> None:
        nonlocal current, pause_started
        if current is None:
            return
        if pause_started is not None and end_ns is not None:
            current["pause_ns"] += max(0, end_ns - pause_started)
        current["end_ns"] = end_ns
        current["end"] = reason
        windows.append(current)
        current = None
        pause_started = None

    for event in events:
        host_ns = clock.server_to_host_ns(event_time(event))
        kind = event.get("eventType")
        if kind == "step_start":
            close(host_ns, "next_step")
            current = open_window(plan.get(event.get("stepIndex"), {}), event, host_ns, event.get("attempt"))
        elif current is None:
            continue
        elif kind == "step_repeated":
            previous = current
            close(host_ns, "repeated")
            attempt = (event.get("metadata") or {}).get("attempt") or (previous["attempt"] or 1) + 1
            current = open_window(plan.get(previous["step_index"], {}), event, host_ns, attempt)
        elif kind in PAUSE_START_EVENTS and pause_started is None:
            pause_started = host_ns
            current["pauses"] += 1
        elif kind == "session_resumed" and pause_started is not None and host_ns is not None:
            current["pause_ns"] += max(0, host_ns - pause_started)
            pause_started = None
        elif kind == "media_onset":
            current["stimulus_starts"] += 1
            if current["stimulus_onset_ns"] is None:
                current["stimulus_onset_ns"] = host_ns
                current["stimulus_load_delay_ms"] = (event.get("metadata") or {}).get("loadDelayMs")
        elif kind == "media_paused":
            current["media_interruptions"] += 1
        elif kind in ("session_complete", "session_aborted"):
            close(host_ns, kind.replace("session_", ""))
    close(None, "open")
    return windows


def read_host_times(path: Path) -> list[int]:
    """host_epoch_ns column of a Meridian CSV, skipping malformed rows."""
    values: list[int] = []
    with path.open(newline="", encoding="utf-8", errors="replace") as handle:
        reader = csv.reader(handle)
        header = next(reader, [])
        if "host_epoch_ns" not in header:
            return values
        column = header.index("host_epoch_ns")
        for row in reader:
            try:
                values.append(int(row[column]))
            except (IndexError, ValueError):
                continue
    values.sort()
    return values


def coverage(times: list[int], start_ns: int, end_ns: int) -> dict:
    """Share of one-second bins inside the window that contain at least one sample."""
    import bisect
    duration_s = max(0.0, (end_ns - start_ns) / 1e9)
    lo = bisect.bisect_left(times, start_ns)
    hi = bisect.bisect_left(times, end_ns)
    bins = max(1, math.ceil(duration_s))
    filled = {min(bins - 1, int((stamp - start_ns) // 1_000_000_000)) for stamp in times[lo:hi]}
    return {"rows": hi - lo, "coveragePct": round(100 * len(filled) / bins, 1) if duration_s else 0.0}


def stream_files(session_dir: Path, artifacts: list[dict]) -> dict[str, Path]:
    """Timestamped file per stream: the CSV itself, or the frame timestamp sidecar for video."""
    files: dict[str, Path] = {}
    for artifact in artifacts:
        path = session_dir / artifact["relativePath"]
        if path.suffix == ".csv":
            files[artifact["sensorId"]] = path
        elif path.with_name(f"{path.stem}_frames.csv").exists():
            files[artifact["sensorId"]] = path.with_name(f"{path.stem}_frames.csv")
    return files


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def auxiliary_files(session_dir: Path) -> list[dict]:
    """Timing files that are not streams themselves but are needed to align them."""
    candidates = sorted(session_dir.glob("*/*_frames.csv")) + [session_dir / "session_markers.jsonl", session_dir / "session_events.jsonl"]
    return [{"relativePath": str(path.relative_to(session_dir)).replace("\\", "/"), "bytes": path.stat().st_size, "sha256": sha256(path)} for path in candidates if path.exists()]


def _seconds(value_ns: int | None, origin_ns: int | None) -> str:
    return "" if value_ns is None or origin_ns is None else f"{(value_ns - origin_ns) / 1e9:.3f}"


def _cell(value) -> str:
    if value is None:
        return ""
    if isinstance(value, (dict, list)):
        value = json.dumps(value, separators=(",", ":"))
    return str(value).replace("\t", " ").replace("\r", " ").replace("\n", " ")


def _write_tsv(path: Path, header: list[str], rows: list[list]) -> None:
    with path.open("w", encoding="utf-8", newline="") as handle:
        handle.write("\t".join(header) + "\n")
        for row in rows:
            handle.write("\t".join(_cell(value) for value in row) + "\n")


def build_bundle(export: dict, session_dir: Path, clock: HostClock, artifacts: list[dict]) -> dict:
    """Write export/ (events, steps, ratings, tasks, session.json, QA report) and return the QA report."""
    out = session_dir / "export"
    out.mkdir(exist_ok=True)
    events = sorted(export.get("events", []), key=lambda item: item.get("sequence", 0))
    origin_ns = clock.server_to_host_ns(export.get("recordingStartedAt")) or (clock.server_to_host_ns(event_time(events[0])) if events else None)

    markers = [event_marker(event, clock) for event in events]
    _write_tsv(out / "events.tsv",
        ["onset_s", "host_epoch_ns", "time_source", "event_type", "source", "step_index", "step_id", "attempt", "label", "detail", "server_time", "client_time", "metadata"],
        [[_seconds(m["hostEpochNs"], origin_ns), m["hostEpochNs"], m["timeSource"], m["eventType"], m["source"], m["stepIndex"], m["stepId"], m["attempt"], m["label"], m["detail"], m["serverTime"], m["clientTime"], m["metadata"]] for m in markers])

    windows = step_windows(export, clock)
    step_rows = []
    for window in windows:
        start, end = window["start_ns"], window["end_ns"]
        duration = None if start is None or end is None else (end - start) / 1e9
        active = None if duration is None else duration - window["pause_ns"] / 1e9
        window["duration_s"] = duration
        window["active_duration_s"] = active
        step_rows.append([window["step_index"], window["step_id"], window["attempt"], window["type"], window["label"], window["phase"], window["emotion"],
            _seconds(start, origin_ns), _seconds(end, origin_ns), "" if duration is None else f"{duration:.3f}", "" if active is None else f"{active:.3f}",
            window["planned_duration_s"], _seconds(window["stimulus_onset_ns"], origin_ns), window["stimulus_load_delay_ms"], window["pauses"], window["end"]])
    _write_tsv(out / "steps.tsv",
        ["step_index", "step_id", "attempt", "type", "label", "phase", "emotion", "onset_s", "offset_s", "duration_s", "active_duration_s", "planned_duration_s", "stimulus_onset_s", "stimulus_load_delay_ms", "pauses", "end"],
        step_rows)

    _write_tsv(out / "ratings.tsv", ["onset_s", "clip_emotion", "valence", "arousal", "dominance", "scale_points", "felt_emotion", "intensity", "familiarity"],
        [[_seconds(clock.server_to_host_ns(r.get("createdAt")), origin_ns), r.get("emotion"), r.get("valence"), r.get("arousal"), r.get("dominance"),
          r.get("scalePoints", 10), r.get("discreteEmotion"), r.get("intensity"), r.get("familiarity")] for r in export.get("ratings", [])])
    task_events = [m for m in markers if m["eventType"] in ("stroop_complete", "nback_complete", "breath_hold_complete")]
    _write_tsv(out / "tasks.tsv", ["onset_s", "event_type", "step_id", "summary"],
        [[_seconds(m["hostEpochNs"], origin_ns), m["eventType"], m["stepId"], {key: value for key, value in m["metadata"].items() if key not in ("trialData", "clientTime")}] for m in task_events])
    write_trial_tables(out, task_events)

    report = qa_report(export, session_dir, windows, artifacts)
    session = {key: export.get(key) for key in ("sessionCode", "participantId", "operator", "protocolVersion", "status", "assignment", "createdAt", "recordingStartedAt", "requiredSensors", "deviceConfig", "media", "hardwareGateOverride", "exportedAt")}
    session["clock"] = {
        "description": "onset_s is seconds since recording start on the acquisition host clock; host_epoch_ns matches the host_epoch_ns column in every sensor CSV",
        "serverMinusHostMs": clock.offset_ms, "recordingStartHostEpochNs": origin_ns,
    }
    session["streams"] = artifacts
    session["auxiliaryFiles"] = auxiliary_files(session_dir)
    session["bpReadings"] = export.get("bpReadings", [])
    session["notes"] = export.get("notes", [])
    (out / "session.json").write_text(json.dumps(session, indent=2), encoding="utf-8")
    (out / "qa_report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    (out / "qa_report.md").write_text(qa_markdown(report), encoding="utf-8")
    return report


TRIAL_TABLES = {
    "stroop_complete": ("stroop_trials.tsv", ["i", "word", "ink", "congruent", "response", "rtMs", "correct", "timedOut"]),
    "nback_complete": ("nback_trials.tsv", ["index", "position", "target", "responded", "rtMs", "outcome"]),
}


def write_trial_tables(out: Path, task_events: list[dict]) -> None:
    """One row per task trial, with the step and generator seed so sequences can be regenerated."""
    for event_type, (name, columns) in TRIAL_TABLES.items():
        rows = []
        for marker in task_events:
            if marker["eventType"] != event_type:
                continue
            metadata = marker["metadata"]
            for trial in metadata.get("trialData") or []:
                rows.append([marker["stepId"], metadata.get("seed"), metadata.get("level")] + [trial.get(column) for column in columns])
        if rows:
            _write_tsv(out / name, ["step_id", "seed", "level"] + columns, rows)


def qa_report(export: dict, session_dir: Path, windows: list[dict], artifacts: list[dict]) -> dict:
    required = set(export.get("requiredSensors") or [])
    files = stream_files(session_dir, artifacts)
    times = {sensor: read_host_times(path) for sensor, path in files.items()}
    # Streams without per-sample timestamps (audio WAV) are continuous files spanning the recording.
    continuous = {artifact["sensorId"] for artifact in artifacts} - set(times)
    steps = []
    flagged = 0
    for window in windows:
        start, end = window["start_ns"], window["end_ns"]
        streams = {}
        issues = []
        if start is not None and end is not None and end > start:
            for sensor, stamps in times.items():
                streams[sensor] = coverage(stamps, start, end)
                if sensor in required and streams[sensor]["coveragePct"] < MIN_STEP_COVERAGE_PCT:
                    issues.append(f"{sensor} coverage {streams[sensor]['coveragePct']}%")
            for sensor in continuous:
                streams[sensor] = {"rows": None, "coveragePct": None, "note": "continuous file without per-sample timestamps"}
            for sensor in required - set(times) - continuous:
                issues.append(f"{sensor} has no recording")
        else:
            issues.append("step window incomplete")
        if window["pauses"]:
            issues.append(f"paused {window['pauses']}x")
        if window["media_interruptions"]:
            issues.append("stimulus playback interrupted")
        if window["stimulus_starts"] > 1:
            issues.append(f"stimulus started {window['stimulus_starts']}x (display reloaded or restarted)")
        if window["end"] == "repeated":
            issues.append("attempt repeated")
        planned, active = window["planned_duration_s"], window.get("active_duration_s")
        if window["advance"] == "timer" and planned and active is not None and abs(active - planned) > 2:
            issues.append(f"active duration {active:.1f}s vs planned {planned}s")
        if window["type"] == "clip" and window["stimulus_onset_ns"] is None and window["end"] != "repeated":
            issues.append("no stimulus onset recorded")
        flagged += bool(issues)
        steps.append({"stepIndex": window["step_index"], "stepId": window["step_id"], "attempt": window["attempt"], "label": window["label"],
            "durationSec": None if window.get("duration_s") is None else round(window["duration_s"], 3),
            "activeDurationSec": None if active is None else round(active, 3), "plannedDurationSec": planned,
            "stimulusLoadDelayMs": window["stimulus_load_delay_ms"], "streams": streams, "issues": issues})
    return {"sessionCode": export.get("sessionCode"), "participantId": export.get("participantId"), "status": export.get("status"),
        "requiredSensors": sorted(required), "minCoveragePct": MIN_STEP_COVERAGE_PCT, "stepsFlagged": flagged, "stepCount": len(steps), "steps": steps}


def qa_markdown(report: dict) -> str:
    lines = [f"# Session QA: {report['sessionCode']} (participant {report['participantId']})", "",
        f"Status: {report['status']}. {report['stepsFlagged']} of {report['stepCount']} step attempts flagged. "
        f"Required streams: {', '.join(report['requiredSensors']) or 'none'} (minimum {report['minCoveragePct']}% coverage per step).", "",
        "| # | Step | Attempt | Active s | Planned s | Issues |", "|---|---|---|---|---|---|"]
    for step in report["steps"]:
        issues = "; ".join(step["issues"]) or "OK"
        lines.append(f"| {step['stepIndex']} | {step['label']} | {step['attempt']} | {step['activeDurationSec'] if step['activeDurationSec'] is not None else ''} | {step['plannedDurationSec'] or ''} | {issues} |")
    return "\n".join(lines) + "\n"
