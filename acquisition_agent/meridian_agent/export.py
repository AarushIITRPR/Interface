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
# Matches POINT_ARTIFACT_WINDOW in lib/rig.ts: the operator presses after noticing the event.
POINT_ARTIFACT_BEFORE_S = 3.0
POINT_ARTIFACT_AFTER_S = 1.0
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


SYNC_EVENTS = {"media_onset", "media_offset", "step_displayed"}
SYNC_MATCH_WINDOW_NS = 500_000_000
SYNC_REFRACTORY_NS = 100_000_000


def photodiode_edges(path: Path) -> list[int]:
    """Host times where the sync patch turned bright: rising crossings of the midpoint between dark and bright levels."""
    rows: list[tuple[int, int]] = []
    with path.open(newline="", encoding="utf-8", errors="replace") as handle:
        reader = csv.DictReader(handle)
        for row in reader:
            try:
                rows.append((int(row["host_epoch_ns"]), int(row["raw"])))
            except (KeyError, TypeError, ValueError):
                continue
    if len(rows) < 10:
        return []
    import numpy as np
    levels = np.asarray([level for _, level in rows], dtype=float)
    # Flashes may occupy well under 1% of samples, so the bright level is the top of the distribution, and a flash
    # must stand far above the dark level's own noise.
    dark = float(np.median(levels))
    noise = float(np.median(np.abs(levels - dark))) * 1.4826
    bright = float(np.percentile(levels, 99.99))
    if bright - dark < max(20.0, 10 * noise):
        return []
    high = dark + 0.6 * (bright - dark)
    low = dark + 0.4 * (bright - dark)
    edges: list[int] = []
    lit = False
    for stamp, level in sorted(rows):
        if not lit and level >= high:
            lit = True
            if not edges or stamp - edges[-1] >= SYNC_REFRACTORY_NS:
                edges.append(stamp)
        elif lit and level <= low:
            lit = False
    return edges


def sync_check(markers: list[dict], edges: list[int]) -> dict:
    """Match display-timed events to photodiode flashes; latency is flash minus logged event time."""
    import bisect
    rows = []
    for marker in markers:
        if marker["eventType"] not in SYNC_EVENTS or marker["timeSource"] != "display" or marker["hostEpochNs"] is None:
            continue
        stamp = marker["hostEpochNs"]
        index = bisect.bisect_left(edges, stamp - SYNC_MATCH_WINDOW_NS)
        candidates = [edge for edge in edges[index:index + 3] if abs(edge - stamp) <= SYNC_MATCH_WINDOW_NS]
        edge = min(candidates, key=lambda value: abs(value - stamp)) if candidates else None
        rows.append({"sequence": marker["sequence"], "eventType": marker["eventType"], "stepId": marker["stepId"], "eventHostEpochNs": stamp,
                     "flashHostEpochNs": edge, "latencyMs": None if edge is None else round((edge - stamp) / 1e6, 1)})
    latencies = sorted(abs(row["latencyMs"]) for row in rows if row["latencyMs"] is not None)
    summary = {"events": len(rows), "matched": len(latencies), "flashes": len(edges)}
    if latencies:
        summary.update({"medianAbsLatencyMs": latencies[len(latencies) // 2], "p95AbsLatencyMs": latencies[min(len(latencies) - 1, (len(latencies) * 95) // 100)], "maxAbsLatencyMs": latencies[-1]})
    return {"summary": summary, "rows": rows}


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def auxiliary_files(session_dir: Path) -> list[dict]:
    """Timing files that are not streams themselves but are needed to align them."""
    candidates = (sorted(session_dir.glob("*/*_frames.csv")) + sorted(session_dir.glob("*/empty_room_*.csv")) + sorted(session_dir.glob("*/camera_settings.json"))
                  + sorted(session_dir.glob("*/*_y16.json")) + [session_dir / "session_markers.jsonl", session_dir / "session_events.jsonl"])
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


CONSENT_BY_SENSOR = {"face": "shareFaceVideo", "face2": "shareFaceVideo", "thermal": "shareThermalVideo", "audio": "shareAudio", "oximeter": "sharePhysiology", "ecg": "sharePhysiology",
                     "emg": "sharePhysiology", "gsr": "sharePhysiology", "resp": "sharePhysiology", "csi": "shareWifi", "csi2": "shareWifi"}
RESPONSE_FILES = {"ratings.tsv", "tasks.tsv", "stroop_trials.tsv", "nback_trials.tsv", "questionnaire_items.tsv", "questionnaire_scores.tsv", "annotations.tsv"}


def consent_allows(consent: dict, key: str | None) -> bool:
    return key is None or consent.get(key) == "Yes"


def write_share_manifest(out: Path, export: dict, session_dir: Path, artifacts: list[dict]) -> dict:
    """What may leave the lab under this participant's consent, and which de-identified substitutes replace withheld data."""
    consent = ((export.get("consent") or {}).get("values")) or {}
    files = []
    for artifact in artifacts:
        key = CONSENT_BY_SENSOR.get(artifact["sensorId"])
        files.append({"path": artifact["relativePath"], "category": artifact["sensorId"], "consentField": key, "share": bool(consent) and consent_allows(consent, key)})
    for path in sorted(out.rglob("*")):
        if path.is_file() and path.name not in ("share_manifest.json",):
            relative = str(path.relative_to(session_dir)).replace("\\", "/")
            key = "shareResponses" if path.name in RESPONSE_FILES else None
            files.append({"path": relative, "category": "export", "consentField": key, "share": bool(consent) and consent_allows(consent, key)})
    manifest = {"consentRecorded": bool(consent), "futureResearch": consent.get("futureResearch"), "consent": consent,
                "note": "Without recorded consent nothing is marked shareable.", "files": files}
    (out / "share_manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    (out / "consent.json").write_text(json.dumps(export.get("consent"), indent=2), encoding="utf-8")
    return manifest


def build_bundle(export: dict, session_dir: Path, clock: HostClock, artifacts: list[dict], derive_video: bool = False, bids: bool = True) -> dict:
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

    artifact_list = artifact_windows(markers)
    _write_tsv(out / "artifacts.tsv", ["onset_s", "duration_s", "type", "kind", "step_id", "unclosed"],
        [[_seconds(a["start_ns"], origin_ns), f"{(a['end_ns'] - a['start_ns']) / 1e9:.3f}", a["type"], a["kind"], a["stepId"], a.get("unclosed", False)] for a in artifact_list])
    write_participants(out, export)
    write_questionnaires(out, export, clock, origin_ns)
    write_annotations(out, export, clock, origin_ns)
    report = qa_report(export, session_dir, windows, artifacts, artifact_list)
    derivatives_dir = out / "derivatives"
    derivatives_dir.mkdir(exist_ok=True)
    consent = ((export.get("consent") or {}).get("values")) or {}
    derived_allowed = consent.get("shareDerived") == "Yes"
    # A face colour trace substitutes for withheld face video; it is also computed on request for offline rPPG.
    need_face_trace = derive_video or (bool(consent) and consent.get("shareFaceVideo") != "Yes" and derived_allowed)
    from .derivatives import audio_envelope, physio_summary
    summaries = physio_summary(windows, session_dir, artifacts, derivatives_dir, derive_video=need_face_trace)
    summary_columns = ["ecgHeartRate", "rmssdMs", "oximeterHeartRate", "spo2", "sclUs", "scrCount", "breathingRate", "rppgHeartRate"]
    _write_tsv(derivatives_dir / "physio_summary.tsv", ["step_id", "attempt"] + [_snake(name) for name in summary_columns],
        [[row["stepId"], row["attempt"]] + [row.get(name, "n/a") for name in summary_columns] for row in summaries])
    audio = next((session_dir / a["relativePath"] for a in artifacts if a["sensorId"] == "audio" and a["relativePath"].endswith(".wav")), None)
    if audio and audio.exists() and bool(consent) and consent.get("shareAudio") != "Yes" and derived_allowed:
        _write_tsv(derivatives_dir / "audio_envelope.tsv", ["offset_s", "rms"], [[offset, value] for offset, value in audio_envelope(audio)])
    environment = next((session_dir / artifact["relativePath"] for artifact in artifacts if artifact["sensorId"] == "environment" and artifact["relativePath"].endswith(".csv")), None)
    if environment and environment.exists():
        report["environment"] = environment_summary(environment)
    photodiode = next((session_dir / artifact["relativePath"] for artifact in artifacts if artifact["sensorId"] == "photodiode" and artifact["relativePath"].endswith(".csv")), None)
    if photodiode and photodiode.exists():
        sync = sync_check(markers, photodiode_edges(photodiode))
        report["syncCheck"] = sync["summary"]
        _write_tsv(out / "sync_check.tsv", ["sequence", "event_type", "step_id", "event_host_epoch_ns", "flash_host_epoch_ns", "latency_ms"],
            [[row["sequence"], row["eventType"], row["stepId"], row["eventHostEpochNs"], row["flashHostEpochNs"], row["latencyMs"]] for row in sync["rows"]])
    session = {key: export.get(key) for key in ("sessionCode", "participantId", "operator", "protocolVersion", "status", "assignment", "createdAt", "recordingStartedAt", "requiredSensors", "deviceConfig", "media", "hardwareGateOverride", "exportedAt")}
    session["clock"] = {
        "description": "onset_s is seconds since recording start on the acquisition host clock; host_epoch_ns matches the host_epoch_ns column in every sensor CSV",
        "serverMinusHostMs": clock.offset_ms, "recordingStartHostEpochNs": origin_ns,
    }
    session["streams"] = artifacts
    session["auxiliaryFiles"] = auxiliary_files(session_dir)
    session["bpReadings"] = export.get("bpReadings", [])
    session["participant"] = export.get("participantMetadata", {})
    session["protocolOptions"] = export.get("protocolOptions")
    session["stimuli"] = export.get("stimuli", {})
    session["csiSetup"] = export.get("csiSetup", {})
    session["csiCalibration"] = export.get("csiCalibration")
    session["notes"] = export.get("notes", [])
    (out / "session.json").write_text(json.dumps(session, indent=2), encoding="utf-8")
    (out / "qa_report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    (out / "qa_report.md").write_text(qa_markdown(report), encoding="utf-8")
    if bids:
        from .bids import write_bids
        bids_events = [[_seconds(w["start_ns"], origin_ns), "n/a" if w.get("duration_s") is None else f"{w['duration_s']:.3f}", w["type"], w["step_id"], "protocol", w["label"]] for w in windows if w["start_ns"] is not None]
        bids_events += [[_seconds(m["hostEpochNs"], origin_ns), 0, m["eventType"], m["stepId"], m["source"], m["label"]] for m in markers if m["hostEpochNs"] is not None and m["eventType"] not in ("step_start", "step_end", "artifact")]
        bids_events += [[_seconds(a["start_ns"], origin_ns), f"{(a['end_ns'] - a['start_ns']) / 1e9:.3f}", "artifact", a["stepId"], "operator", a["type"]] for a in artifact_list]
        bids_events.sort(key=lambda row: float(row[0]) if row[0] not in ("", None) else float("inf"))
        write_bids(out, export, session_dir, artifacts, origin_ns, bids_events, out)
    write_share_manifest(out, export, session_dir, artifacts)
    return report


def _snake(name: str) -> str:
    return "".join(f"_{char.lower()}" if char.isupper() else char for char in name)


def artifact_windows(markers: list[dict]) -> list[dict]:
    """Operator artifact labels as host-clock windows: points cover the reaction lag, spans run from start to end."""
    windows: list[dict] = []
    open_spans: dict[str, dict] = {}
    last_ns = max((m["hostEpochNs"] for m in markers if m["hostEpochNs"] is not None), default=None)
    for marker in markers:
        if marker["eventType"] != "artifact" or marker["hostEpochNs"] is None:
            continue
        meta = marker["metadata"]
        kind, kind_type, stamp = meta.get("kind"), str(meta.get("type")), marker["hostEpochNs"]
        if kind == "point":
            windows.append({"type": kind_type, "kind": "point", "stepId": marker["stepId"], "start_ns": stamp - int(POINT_ARTIFACT_BEFORE_S * 1e9), "end_ns": stamp + int(POINT_ARTIFACT_AFTER_S * 1e9)})
        elif kind == "start":
            open_spans[kind_type] = {"type": kind_type, "kind": "span", "stepId": marker["stepId"], "start_ns": stamp}
        elif kind == "end" and kind_type in open_spans:
            window = open_spans.pop(kind_type)
            window["end_ns"] = stamp
            windows.append(window)
    for window in open_spans.values():
        window["end_ns"] = last_ns if last_ns is not None else window["start_ns"]
        window["unclosed"] = True
        windows.append(window)
    return sorted(windows, key=lambda item: item["start_ns"])


def overlap_seconds(start_ns: int, end_ns: int, other_start: int, other_end: int) -> float:
    return max(0, min(end_ns, other_end) - max(start_ns, other_start)) / 1e9


def environment_summary(path: Path) -> dict | None:
    """Session ranges for room temperature, humidity, and light; a large light change is flagged for rPPG."""
    columns: dict[str, list[float]] = {"temp_c": [], "humidity_pct": [], "lux": []}
    with path.open(newline="", encoding="utf-8", errors="replace") as handle:
        for row in csv.DictReader(handle):
            for key in columns:
                try:
                    columns[key].append(float(row[key]))
                except (KeyError, TypeError, ValueError):
                    pass
    if not any(columns.values()):
        return None
    summary: dict = {}
    for key, values in columns.items():
        if values:
            ordered = sorted(values)
            summary[key] = {"min": round(ordered[0], 2), "median": round(ordered[len(ordered) // 2], 2), "max": round(ordered[-1], 2)}
    lux = summary.get("lux")
    summary["lightingChanged"] = bool(lux and lux["median"] > 0 and (lux["max"] - lux["min"]) / lux["median"] > 0.3)
    return summary


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


def write_questionnaires(out: Path, export: dict, clock: HostClock, origin_ns: int | None) -> None:
    """Item responses (long format) and scale scores (one row per administration)."""
    responses = export.get("questionnaires") or []
    if not responses:
        return
    items = {qid: {item["id"]: item["text"] for item in definition.get("items", [])} for qid, definition in (export.get("questionnaireItems") or {}).items()}
    _write_tsv(out / "questionnaire_items.tsv", ["questionnaire", "step_id", "item", "text", "response"],
        [[entry["questionnaireId"], entry["stepId"], item, items.get(entry["questionnaireId"], {}).get(item, ""), value] for entry in responses for item, value in entry["answers"].items()])
    score_names = sorted({name for entry in responses for name in entry.get("scores", {})})
    _write_tsv(out / "questionnaire_scores.tsv", ["onset_s", "questionnaire", "step_id"] + score_names,
        [[_seconds(clock.server_to_host_ns(entry.get("createdAt")), origin_ns), entry["questionnaireId"], entry["stepId"]] + [entry.get("scores", {}).get(name, "n/a") for name in score_names] for entry in responses])


def write_annotations(out: Path, export: dict, clock: HostClock, origin_ns: int | None) -> None:
    """Continuous valence and arousal (each -1 to 1) on the host clock, one row per 50 ms sample."""
    chunks = sorted(export.get("annotations") or [], key=lambda item: (item.get("stepId"), item.get("attempt", 1), item.get("chunk", 0)))
    if not chunks:
        return
    plan = {step["id"]: step for step in export.get("plan", [])}
    offset_ns = round(clock.offset_ms * 1_000_000)
    rows = []
    for chunk in chunks:
        clip = plan.get(chunk.get("stepId"), {}).get("label", "")
        for server_ms, valence, arousal in chunk.get("samples", []):
            host_ns = int(server_ms) * 1_000_000 - offset_ns
            rows.append([_seconds(host_ns, origin_ns), host_ns, chunk.get("stepId"), clip, chunk.get("attempt", 1), valence, arousal])
    rows.sort(key=lambda row: row[1])
    _write_tsv(out / "annotations.tsv", ["onset_s", "host_epoch_ns", "step_id", "clip", "attempt", "valence", "arousal"], rows)


def write_participants(out: Path, export: dict) -> None:
    """BIDS-style participants.tsv (one row) with a participants.json data dictionary."""
    fields = export.get("participantFields") or []
    values = export.get("participantMetadata") or {}
    columns = ["participant_id", "session_code"] + [field["id"] for field in fields]
    row = [f"sub-{int(export.get('participantId') or 0):03d}", export.get("sessionCode")] + [values.get(field["id"], "n/a") for field in fields]
    _write_tsv(out / "participants.tsv", columns, [row])
    dictionary = {"participant_id": {"Description": "Participant number, zero padded"}, "session_code": {"Description": "Meridian session code"}}
    for field in fields:
        entry = {"LongName": field["label"]}
        if field.get("options"):
            entry["Levels"] = {option: option for option in field["options"]}
        if field.get("unit"):
            entry["Units"] = field["unit"]
        dictionary[field["id"]] = entry
    (out / "participants.json").write_text(json.dumps(dictionary, indent=2), encoding="utf-8")


def qa_report(export: dict, session_dir: Path, windows: list[dict], artifacts: list[dict], artifact_list: list[dict] | None = None) -> dict:
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
        artifact_seconds: dict[str, float] = {}
        if start is not None and end is not None:
            for item in artifact_list or []:
                seconds = overlap_seconds(start, end, item["start_ns"], item["end_ns"])
                if seconds > 0:
                    artifact_seconds[item["type"]] = artifact_seconds.get(item["type"], 0.0) + seconds
        noticeable = {name: seconds for name, seconds in artifact_seconds.items() if seconds >= 0.5}
        if noticeable:
            issues.append("artifacts: " + ", ".join(f"{name} {seconds:.0f}s" for name, seconds in sorted(noticeable.items())))
        flagged += bool(issues)
        steps.append({"stepIndex": window["step_index"], "stepId": window["step_id"], "attempt": window["attempt"], "label": window["label"],
            "durationSec": None if window.get("duration_s") is None else round(window["duration_s"], 3),
            "activeDurationSec": None if active is None else round(active, 3), "plannedDurationSec": planned,
            "stimulusLoadDelayMs": window["stimulus_load_delay_ms"], "artifactSeconds": {k: round(v, 1) for k, v in artifact_seconds.items()}, "streams": streams, "issues": issues})
    events = export.get("events", [])
    skipped = [{"stepId": e.get("stepId"), "detail": e.get("detail")} for e in events if e.get("eventType") == "step_skipped"]
    gates = [{"stepId": e.get("stepId"), "outcome": e.get("eventType"), "reason": e.get("detail")} for e in events if e.get("eventType") in ("gate_verified", "gate_override", "gate_unverified")]
    missing_metadata = [field["id"] for field in export.get("participantFields") or [] if field.get("required") and not (export.get("participantMetadata") or {}).get(field["id"])]
    calibration = export.get("csiCalibration") or {}
    return {"sessionCode": export.get("sessionCode"), "participantId": export.get("participantId"), "status": export.get("status"),
        "missingParticipantFields": missing_metadata, "csiEmptyRoomBaseline": calibration.get("status", "not recorded"),
        "requiredSensors": sorted(required), "minCoveragePct": MIN_STEP_COVERAGE_PCT, "stepsFlagged": flagged, "stepCount": len(steps),
        "skippedSteps": skipped, "gates": gates, "steps": steps}


def environment_line(environment: dict | None) -> str:
    if not environment:
        return "Room environment: not recorded."
    parts = [f"{label} {environment[key]['min']}-{environment[key]['max']}{unit}" for key, label, unit in (("temp_c", "temperature", " C"), ("humidity_pct", "humidity", "%"), ("lux", "light", " lux")) if key in environment]
    return "Room environment: " + ", ".join(parts) + (". Lighting changed by more than 30% during the session." if environment.get("lightingChanged") else ".")


def sync_line(sync: dict | None) -> str:
    if not sync:
        return "Photodiode sync check: no photodiode recording."
    if not sync.get("matched"):
        return f"Photodiode sync check: {sync['events']} display events, {sync['flashes']} flashes, none matched."
    return (f"Photodiode sync check: {sync['matched']} of {sync['events']} display events matched; |flash - event| median "
            f"{sync['medianAbsLatencyMs']} ms, p95 {sync['p95AbsLatencyMs']} ms, max {sync['maxAbsLatencyMs']} ms.")


def qa_markdown(report: dict) -> str:
    lines = [f"# Session QA: {report['sessionCode']} (participant {report['participantId']})", "",
        f"Status: {report['status']}. {report['stepsFlagged']} of {report['stepCount']} step attempts flagged. "
        f"Required streams: {', '.join(report['requiredSensors']) or 'none'} (minimum {report['minCoveragePct']}% coverage per step).", "",
        f"Skipped by screening: {', '.join(item['detail'] for item in report.get('skippedSteps', [])) or 'none'}.",
        f"Return-to-baseline gates: {', '.join(item['outcome'].replace('gate_', '') for item in report.get('gates', [])) or 'none'}.",
        sync_line(report.get("syncCheck")),
        f"Participant details missing: {', '.join(report.get('missingParticipantFields') or []) or 'none'}. CSI empty-room baseline: {report.get('csiEmptyRoomBaseline', 'not recorded')}.",
        environment_line(report.get("environment")), "",
        "| # | Step | Attempt | Active s | Planned s | Issues |", "|---|---|---|---|---|---|"]
    for step in report["steps"]:
        issues = "; ".join(step["issues"]) or "OK"
        lines.append(f"| {step['stepIndex']} | {step['label']} | {step['attempt']} | {step['activeDurationSec'] if step['activeDurationSec'] is not None else ''} | {step['plannedDurationSec'] or ''} | {issues} |")
    return "\n".join(lines) + "\n"
