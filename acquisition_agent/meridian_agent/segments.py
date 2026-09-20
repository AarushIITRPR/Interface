"""Per-task folders, cut from the finished recording.

One folder per step attempt, holding that step's slice of every modality: a small compressed video proxy, the frame
timestamps, the physio rows, and the step's own metadata. The lossless masters are never touched - they stay the
archive, and these are the working copies analysis reads instead.

Cutting live, during the session, would not help: FFV1 is written with every frame a keyframe, so seeking into a
master is already exact and nearly free (1.4 s to seek fifteen minutes in), and per-step reads are bound by disk
throughput, not by the search. What a proxy buys is the *repeat* read - seconds instead of gigabytes, every time an
analysis is re-run.

The one thing this must not get wrong: **video time is not wall-clock time**. Dropped frames are simply absent from
the container while it keeps claiming a constant frame rate - session 0101JUMR's face video is 18:09 long for a
32-minute session. So every video cut is mapped through `<sensor>_frames.csv`, which stamps each frame that was
actually written, and never through the step's wall-clock offset.
"""
from __future__ import annotations

import bisect
import csv
import json
import shutil
import subprocess
import wave
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

# Lossy encoding destroys the sub-1% colour modulation that rPPG measures, so the proxy is for viewing, behavioural
# coding and models that tolerate compression. Per-task rPPG reads face_colour_trace.tsv instead, which is exact.
PROXY_WARNING = "Lossy proxy: do not use for rPPG. Use face_colour_trace.tsv, or the lossless master."

README = """Per-task folders
================

One folder per step attempt, named `<step_id>` (with `-aN` when a step was repeated). Each holds that step's slice
of every modality that recorded during it.

  step.json             the step's window, in both host-epoch nanoseconds and seconds from the session origin,
                        plus type, phase, emotion, attempt, pause count and stimulus onset
  *_proxy.mp4           compressed, downscaled video for viewing and behavioural coding
  *_frames.csv          the frame timestamps inside this window, copied from the master's sidecar
  face_colour_trace.tsv the per-frame face colour signal, when the export derived one
  audio.wav             lossless PCM slice
  *.csv                 the physio rows inside this window, columns unchanged

{warning}

The lossless masters in face/, face2/, thermal/, audio/ and the physio folders are unchanged. Nothing here is a
substitute for them; `index.tsv` lists what was written and what was missing.
"""


@dataclass(frozen=True)
class ProxyOptions:
    """How the video proxies are encoded. Height 0 keeps the master's own size."""

    height: int = 480
    crf: int = 20


def base_name(window: dict) -> str:
    """`s12-clip-fear`, or `s12-clip-fear-a2` for the second attempt of a repeated step."""
    step_id = str(window.get("step_id") or f"step{window.get('step_index')}")
    attempt = window.get("attempt") or 1
    return step_id if int(attempt) <= 1 else f"{step_id}-a{int(attempt)}"


def assign_names(windows: list[dict]) -> None:
    """Give every window a folder name of its own, in chronological order.

    A step id can come round again at the same attempt number: in session 0101JUMR ten of them did, because the
    operator navigated back through the console after the session and each visit opened a fresh window. Sharing a
    name would mean the second visit quietly overwriting the first, so the first keeps the plain name and later ones
    get `-v2`, `-v3`.
    """
    seen: dict[str, int] = {}
    for window in windows:
        base = base_name(window)
        seen[base] = seen.get(base, 0) + 1
        window["_name"] = base if seen[base] == 1 else f"{base}-v{seen[base]}"


def folder_name(window: dict) -> str:
    return str(window.get("_name") or base_name(window))


def video_fps(path: Path) -> float | None:
    """The container's nominal frame rate, which is what frame indices are expressed against."""
    probe = shutil.which("ffprobe")
    if not probe:
        return None
    result = subprocess.run([probe, "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=r_frame_rate",
                             "-of", "default=nw=1:nk=1", str(path)], capture_output=True, text=True)
    text = result.stdout.strip()
    if not text:
        return None
    try:
        numerator, _, denominator = text.partition("/")
        value = float(numerator) / float(denominator or 1)
    except (ValueError, ZeroDivisionError):
        return None
    return value if value > 0 else None


def read_frame_stamps(path: Path) -> list[tuple[int, int]]:
    """(frame_index, host_epoch_ns) for every frame actually written, in index order."""
    rows: list[tuple[int, int]] = []
    with path.open(newline="", encoding="utf-8", errors="replace") as handle:
        reader = csv.reader(handle)
        header = next(reader, [])
        if "frame_index" not in header or "host_epoch_ns" not in header:
            return []
        index_at, stamp_at = header.index("frame_index"), header.index("host_epoch_ns")
        for row in reader:
            try:
                rows.append((int(row[index_at]), int(row[stamp_at])))
            except (IndexError, ValueError):
                continue
    rows.sort(key=lambda item: item[0])
    return rows


def frame_span(stamps: list[tuple[int, int]], start_ns: int, end_ns: int) -> tuple[int, int] | None:
    """The first frame index at or after `start_ns` and the number of frames before `end_ns`."""
    times = [stamp for _, stamp in stamps]
    first = bisect.bisect_left(times, start_ns)
    last = bisect.bisect_left(times, end_ns)
    if last <= first:
        return None
    return stamps[first][0], last - first


def write_rows(path: Path, header: list[str], rows: list[list[str]], delimiter: str = ",") -> None:
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle, delimiter=delimiter)
        writer.writerow(header)
        writer.writerows(rows)


def slice_csv_by_window(source: Path, windows: list[dict], name: str,
                        stamp_column: str = "host_epoch_ns") -> dict[str, int]:
    """Split one timestamped CSV across every window in a single pass.

    Windows tile the session without overlapping, so one cursor walking them in start order is enough; a file is
    opened only for windows that actually receive a row. One pass matters: csi.csv is 87 MB, and reopening it per
    step would read it fifty times.
    """
    ordered = sorted((w for w in windows if w.get("start_ns") is not None and w.get("end_ns") is not None),
                     key=lambda w: w["start_ns"])
    if not ordered:
        return {}
    with source.open(newline="", encoding="utf-8", errors="replace") as handle:
        reader = csv.reader(handle)
        header = next(reader, [])
        if stamp_column not in header:
            return {}
        stamp_at = header.index(stamp_column)
        buckets: dict[int, list[list[str]]] = {}
        cursor = 0
        for row in reader:
            try:
                stamp = int(float(row[stamp_at]))
            except (IndexError, ValueError):
                continue
            while cursor < len(ordered) and stamp >= ordered[cursor]["end_ns"]:
                cursor += 1
            if cursor >= len(ordered):
                break
            if stamp >= ordered[cursor]["start_ns"]:
                buckets.setdefault(cursor, []).append(row)
    written: dict[str, int] = {}
    for position, rows in buckets.items():
        window = ordered[position]
        destination = window["_dir"] / name
        write_rows(destination, header, rows)
        written[folder_name(window)] = len(rows)
    return written


def slice_wav(source: Path, destination: Path, started_ns: int, start_ns: int, end_ns: int) -> int:
    """Copy the PCM frames inside the window. Lossless, and small enough not to need a proxy."""
    with wave.open(str(source), "rb") as reader:
        rate = reader.getframerate()
        total = reader.getnframes()
        first = max(0, round((start_ns - started_ns) / 1e9 * rate))
        last = min(total, round((end_ns - started_ns) / 1e9 * rate))
        if last <= first:
            return 0
        reader.setpos(first)
        payload = reader.readframes(last - first)
        with wave.open(str(destination), "wb") as writer:
            writer.setnchannels(reader.getnchannels())
            writer.setsampwidth(reader.getsampwidth())
            writer.setframerate(rate)
            writer.writeframes(payload)
    return last - first


def encode_proxy(source: Path, destination: Path, first_index: int, count: int, fps: float,
                 options: ProxyOptions) -> bool:
    """Cut `count` frames starting at `first_index` and re-encode them small.

    The seek is in seconds because that is ffmpeg's interface, but the number comes from the frame index and the
    container's own rate, never from the step's wall-clock offset - the two differ by every dropped frame.
    """
    executable = shutil.which("ffmpeg")
    if not executable:
        return False
    command = [executable, "-y", "-hide_banner", "-loglevel", "error",
               "-ss", f"{first_index / fps:.6f}", "-i", str(source), "-frames:v", str(count)]
    if options.height:
        command += ["-vf", f"scale=-2:{options.height}"]
    command += ["-c:v", "libx264", "-crf", str(options.crf), "-preset", "veryfast", "-pix_fmt", "yuv420p", "-an",
                str(destination)]
    return subprocess.run(command, capture_output=True, text=True).returncode == 0 and destination.exists()


def step_metadata(window: dict, origin_ns: int | None) -> dict:
    def seconds(value: int | None) -> float | None:
        return None if value is None or origin_ns is None else round((value - origin_ns) / 1e9, 3)

    return {
        "stepIndex": window.get("step_index"), "stepId": window.get("step_id"), "attempt": window.get("attempt"),
        "type": window.get("type"), "label": window.get("label"), "phase": window.get("phase"),
        "emotion": window.get("emotion") or None,
        "startNs": window.get("start_ns"), "endNs": window.get("end_ns"),
        "onsetS": seconds(window.get("start_ns")), "offsetS": seconds(window.get("end_ns")),
        "durationS": window.get("duration_s"), "activeDurationS": window.get("active_duration_s"),
        "plannedDurationS": window.get("planned_duration_s"),
        "pauses": window.get("pauses"), "pausedS": round(window.get("pause_ns", 0) / 1e9, 3),
        "stimulusOnsetS": seconds(window.get("stimulus_onset_ns")), "end": window.get("end"),
        "note": PROXY_WARNING,
    }


def task_folders(session_dir: Path, windows: list[dict], artifacts: list[dict], origin_ns: int | None,
                 options: ProxyOptions = ProxyOptions()) -> dict:
    """Write `tasks/`, one folder per step attempt. Returns a summary for the caller to print."""
    usable = [w for w in windows if w.get("start_ns") is not None and w.get("end_ns") is not None
              and w["end_ns"] > w["start_ns"]]
    root = session_dir / "tasks"
    root.mkdir(exist_ok=True)
    assign_names(usable)
    for window in usable:
        window["_dir"] = root / folder_name(window)
        window["_dir"].mkdir(exist_ok=True)
        window["_files"] = []

    by_sensor = {artifact["sensorId"]: artifact for artifact in artifacts}
    missing: list[str] = []

    for sensor, artifact in sorted(by_sensor.items()):
        source = session_dir / artifact["relativePath"]
        if not source.exists():
            missing.append(f"{sensor}: file missing")
            continue
        if source.suffix == ".csv":
            counts = slice_csv_by_window(source, usable, f"{sensor}.csv")
            for window in usable:
                if counts.get(folder_name(window)):
                    window["_files"].append(f"{sensor}.csv")
            if not counts:
                missing.append(f"{sensor}: no rows in any step")
        elif source.suffix == ".wav":
            started_ns = _started_ns(artifact)
            if started_ns is None:
                missing.append(f"{sensor}: no start time in the manifest")
                continue
            for window in usable:
                target = window["_dir"] / f"{sensor}.wav"
                if slice_wav(source, target, started_ns, window["start_ns"], window["end_ns"]):
                    window["_files"].append(target.name)
                elif target.exists():
                    target.unlink()
        elif source.suffix in (".mkv", ".avi"):
            _slice_video(sensor, source, usable, options, missing)
        else:
            missing.append(f"{sensor}: {source.suffix or 'no'} files are not cut")

    _slice_colour_trace(session_dir, usable)

    index_rows = []
    for window in usable:
        metadata = step_metadata(window, origin_ns)
        (window["_dir"] / "step.json").write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
        size = sum(path.stat().st_size for path in window["_dir"].iterdir() if path.is_file())
        index_rows.append([window["step_index"], folder_name(window), window["type"], window["label"],
                           "" if metadata["onsetS"] is None else f"{metadata['onsetS']:.3f}",
                           "" if window.get("duration_s") is None else f"{window['duration_s']:.3f}",
                           len(window["_files"]), " ".join(sorted(window["_files"])), size])
    # Tab separated, like every other table in the export, because labels contain commas.
    write_rows(root / "index.tsv",
               ["step_index", "folder", "type", "label", "onset_s", "duration_s", "file_count", "files", "bytes"],
               [[str(value) for value in row] for row in index_rows], delimiter="\t")
    (root / "README").write_text(README.format(warning=PROXY_WARNING), encoding="utf-8")
    for window in usable:
        window.pop("_dir", None)
        window.pop("_files", None)
        window.pop("_name", None)
    return {"folders": len(usable), "skipped": len(windows) - len(usable), "missing": missing,
            "bytes": sum(row[8] for row in index_rows)}


def _started_ns(artifact: dict) -> int | None:
    """When this stream's first sample was written. The manifest stamps it on the host clock already."""
    started = artifact.get("startedAt")
    if not started:
        return None
    try:
        moment = datetime.fromisoformat(str(started).replace("Z", "+00:00"))
    except ValueError:
        return None
    return round(moment.timestamp() * 1_000_000) * 1000


def _slice_video(sensor: str, source: Path, windows: list[dict], options: ProxyOptions, missing: list[str]) -> None:
    stamps_path = source.with_name(f"{source.stem}_frames.csv")
    if not stamps_path.exists():
        missing.append(f"{sensor}: no frame timestamps, so it cannot be cut safely")
        return
    stamps = read_frame_stamps(stamps_path)
    fps = video_fps(source)
    if not stamps or not fps:
        missing.append(f"{sensor}: unreadable frame timestamps or frame rate")
        return
    header = ["frame_index", "host_epoch_ns"]
    for window in windows:
        span = frame_span(stamps, window["start_ns"], window["end_ns"])
        if span is None:
            continue
        first_index, count = span
        rows = [[str(index), str(stamp)] for index, stamp in stamps
                if window["start_ns"] <= stamp < window["end_ns"]]
        write_rows(window["_dir"] / f"{sensor}_frames.csv", header, rows)
        window["_files"].append(f"{sensor}_frames.csv")
        target = window["_dir"] / f"{sensor}_proxy.mp4"
        if encode_proxy(source, target, first_index, count, fps, options):
            window["_files"].append(target.name)
        elif target.exists():
            target.unlink()


def _slice_colour_trace(session_dir: Path, windows: list[dict]) -> None:
    """The exact per-frame face signal, when the export derived one. This, not the proxy, is the rPPG input."""
    import gzip
    source = session_dir / "export" / "derivatives" / "face_colour_trace.tsv.gz"
    if not source.exists():
        return
    with gzip.open(source, "rt", encoding="utf-8", newline="") as handle:
        reader = csv.reader(handle, delimiter="\t")
        header = next(reader, [])
        if "host_epoch_ns" not in header:
            return
        stamp_at = header.index("host_epoch_ns")
        ordered = sorted(windows, key=lambda w: w["start_ns"])
        buckets: dict[int, list[list[str]]] = {}
        cursor = 0
        for row in reader:
            try:
                stamp = int(float(row[stamp_at]))
            except (IndexError, ValueError):
                continue
            while cursor < len(ordered) and stamp >= ordered[cursor]["end_ns"]:
                cursor += 1
            if cursor >= len(ordered):
                break
            if stamp >= ordered[cursor]["start_ns"]:
                buckets.setdefault(cursor, []).append(row)
    for position, rows in buckets.items():
        window = ordered[position]
        destination = window["_dir"] / "face_colour_trace.tsv"
        with destination.open("w", newline="", encoding="utf-8") as handle:
            writer = csv.writer(handle, delimiter="\t")
            writer.writerow(header)
            writer.writerows(rows)
        window["_files"].append(destination.name)
