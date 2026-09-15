"""Post-session derived signals: benchmark-ready labels computed from the raw recordings.

Everything here is numpy-only and conservative: simple, documented algorithms that make the dataset immediately
usable and give reviewers a sanity check. Researchers should still run their preferred pipelines (e.g. NeuroKit2) on
the raw files for publication analyses.
"""
from __future__ import annotations

import csv
import gzip
import math
import wave
from pathlib import Path

import numpy as np


def csi_amplitudes(line: str) -> list[float]:
    """Subcarrier amplitudes from one ESP32 CSI line.

    Two layouts are accepted. Raw I/Q firmware prints `timestamp,packet,rssi,noise,count` followed by `count` I/Q
    pairs, so amplitudes are sqrt(I^2 + Q^2). Amplitude firmware (and the emulator) prints
    `timestamp,packet,rssi,rate,noise,channel` followed by ready-made amplitudes.
    """
    parts = (line[9:] if line.startswith("CSI_DATA,") else line).split(",")
    try:
        count = int(parts[4]) if len(parts) > 4 else -1
        if count > 0 and len(parts) == 5 + 2 * count:
            values = [float(value) for value in parts[5:]]
            return [math.hypot(values[2 * index], values[2 * index + 1]) for index in range(count)]
        return [abs(float(value)) for value in parts[6:]]
    except ValueError:
        return []


def read_numeric_columns(path: Path, names: list[str]) -> dict[str, np.ndarray] | None:
    """host_epoch_ns plus the requested numeric columns; rows with any unparsable value are dropped."""
    with path.open(newline="", encoding="utf-8", errors="replace") as handle:
        reader = csv.reader(handle)
        header = next(reader, [])
        if "host_epoch_ns" not in header or any(name not in header for name in names):
            return None
        indices = [header.index("host_epoch_ns")] + [header.index(name) for name in names]
        rows = []
        for row in reader:
            try:
                rows.append([float(row[index]) for index in indices])
            except (IndexError, ValueError):
                continue
    if not rows:
        return None
    array = np.asarray(rows, dtype=float)
    order = np.argsort(array[:, 0], kind="stable")
    array = array[order]
    result = {"host_epoch_ns": array[:, 0]}
    for position, name in enumerate(names, start=1):
        result[name] = array[:, position]
    return result


def header_of(path: Path) -> list[str]:
    with path.open(newline="", encoding="utf-8", errors="replace") as handle:
        return next(csv.reader(handle), [])


def moving_average(values: np.ndarray, width: int) -> np.ndarray:
    width = max(1, int(width))
    kernel = np.ones(width) / width
    return np.convolve(values, kernel, mode="same")


def detect_r_peaks(signal: np.ndarray, fs: float) -> np.ndarray:
    """Pan-Tompkins-style detection: baseline removal, derivative, squaring, 150 ms integration, adaptive threshold."""
    if signal.size < fs * 2:
        return np.array([], dtype=int)
    filtered = signal - moving_average(signal, int(0.2 * fs))
    filtered = moving_average(filtered, max(1, int(0.02 * fs)))
    energy = moving_average(np.square(np.gradient(filtered)), int(0.15 * fs))
    peaks: list[int] = []
    refractory = int(0.25 * fs)
    search = int(0.1 * fs)
    segment = int(10 * fs)
    for start in range(0, energy.size, segment):
        chunk = energy[start:start + segment]
        if chunk.size < fs:
            continue
        threshold = 0.3 * np.percentile(chunk, 98)
        above = np.flatnonzero(chunk > threshold) + start
        index = 0
        while index < above.size:
            end = index
            while end + 1 < above.size and above[end + 1] == above[end] + 1:
                end += 1
            region = slice(max(0, above[index] - search), min(filtered.size, above[end] + 1))
            peak = region.start + int(np.argmax(np.abs(filtered[region])))
            if not peaks or peak - peaks[-1] >= refractory:
                peaks.append(peak)
            elif abs(filtered[peak]) > abs(filtered[peaks[-1]]):
                peaks[-1] = peak
            index = end + 1
    return np.asarray(peaks, dtype=int)


def ecg_times_and_signal(columns: dict[str, np.ndarray]) -> tuple[np.ndarray, np.ndarray, float] | None:
    """Frontier X rows share a host receipt time per packet, so sample times come from the device clock fitted to host time."""
    host = columns["host_epoch_ns"]
    signal = columns["scaled_value"]
    if "sample_time_ms" in columns and np.ptp(columns["sample_time_ms"]) > 0:
        device = columns["sample_time_ms"]
        slope, intercept = np.polyfit(device, host, 1)
        times = slope * device + intercept
        order = np.argsort(device, kind="stable")
        times, signal = times[order], signal[order]
    else:
        times = host
    duration = (times[-1] - times[0]) / 1e9
    if duration <= 2:
        return None
    return times, signal, (times.size - 1) / duration


def rr_intervals(peak_times_ns: np.ndarray) -> np.ndarray:
    rr = np.diff(peak_times_ns) / 1e6
    return rr[(rr >= 300) & (rr <= 2000)]


def rmssd(rr_ms: np.ndarray) -> float | None:
    if rr_ms.size < 3:
        return None
    return float(np.sqrt(np.mean(np.square(np.diff(rr_ms)))))


def eda_decompose(values: np.ndarray, fs: float, tonic_window_s: float = 8.0) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Tonic level as a moving median, phasic as the remainder, and SCR peaks above 0.05 uS at least 1 s apart."""
    width = max(3, int(tonic_window_s * fs) | 1)
    padded = np.pad(values, width // 2, mode="edge")
    tonic = np.median(np.lib.stride_tricks.sliding_window_view(padded, width), axis=1)[: values.size]
    phasic = values - tonic
    candidates = np.flatnonzero((phasic[1:-1] > phasic[:-2]) & (phasic[1:-1] >= phasic[2:]) & (phasic[1:-1] > 0.05)) + 1
    peaks: list[int] = []
    for index in candidates:
        if not peaks or index - peaks[-1] >= fs:
            peaks.append(int(index))
        elif phasic[index] > phasic[peaks[-1]]:
            peaks[-1] = int(index)
    return tonic, phasic, np.asarray(peaks, dtype=int)


def audio_envelope(path: Path, window_ms: int = 100) -> list[tuple[float, float]]:
    """RMS level per window from a mono 16-bit WAV: a speech-activity feature without recoverable speech."""
    with wave.open(str(path), "rb") as handle:
        rate = handle.getframerate()
        width = handle.getsampwidth()
        channels = handle.getnchannels()
        frames = handle.readframes(handle.getnframes())
    if width != 2:
        return []
    samples = np.frombuffer(frames, dtype="<i2").astype(np.float64)
    if channels > 1:
        samples = samples.reshape(-1, channels).mean(axis=1)
    step = max(1, rate * window_ms // 1000)
    usable = samples[: samples.size // step * step].reshape(-1, step)
    rms = np.sqrt(np.mean(np.square(usable), axis=1)) / 32768.0
    return [(round(index * step / rate, 3), round(float(value), 5)) for index, value in enumerate(rms)]


def face_colour_trace(video: Path, frames_csv: Path) -> list[tuple[int, float, float, float, int]]:
    """Mean BGR of the tracked face region per frame, aligned to frame host timestamps (for offline rPPG)."""
    import cv2
    from .rppg import LiveRppg

    stamps = read_numeric_columns(frames_csv, ["frame_index"])
    if stamps is None:
        return []
    ordered = sorted(zip(stamps["frame_index"].astype(int), stamps["host_epoch_ns"].astype(np.int64)))
    capture = cv2.VideoCapture(str(video))
    tracker = LiveRppg(estimate_every_s=1e9)
    rows: list[tuple[int, float, float, float, int]] = []
    for _, host_ns in ordered:
        ok, frame = capture.read()
        if not ok:
            break
        tracker.update(frame, host_ns / 1e9, cv2)
        sample = tracker.samples[-1] if tracker.samples and tracker.samples[-1][0] == host_ns / 1e9 else None
        if sample is None:
            rows.append((int(host_ns), math.nan, math.nan, math.nan, 0))
        else:
            rows.append((int(host_ns), *sample[1], 1))
    capture.release()
    return rows


def write_gzip_tsv(path: Path, header: list[str], rows) -> None:
    with gzip.open(path, "wt", encoding="utf-8", newline="") as handle:
        handle.write("\t".join(header) + "\n")
        for row in rows:
            handle.write("\t".join("n/a" if isinstance(value, float) and math.isnan(value) else str(value) for value in row) + "\n")


def window_mask(times_ns: np.ndarray, start_ns: int, end_ns: int) -> np.ndarray:
    return (times_ns >= start_ns) & (times_ns < end_ns)


def physio_summary(windows: list[dict], session_dir: Path, artifacts: list[dict], derivatives_dir: Path, derive_video: bool = False) -> list[dict]:
    """Per step attempt: ECG heart rate and RMSSD, oximeter HR and SpO2, skin conductance level and SCR count,
    breathing rate from the belt, and (optionally) face-video rPPG heart rate."""
    from .rppg import pos_heart_rate
    from .sensors import breathing_rate_bpm

    paths = {artifact["sensorId"]: session_dir / artifact["relativePath"] for artifact in artifacts}
    summaries = [{"stepId": w["step_id"], "attempt": w["attempt"], "start_ns": w["start_ns"], "end_ns": w["end_ns"]} for w in windows]
    valid = [s for s in summaries if s["start_ns"] is not None and s["end_ns"] is not None and s["end_ns"] > s["start_ns"]]

    ecg_path = paths.get("ecg")
    ecg = read_numeric_columns(ecg_path, ["scaled_value"] + (["sample_time_ms"] if "sample_time_ms" in header_of(ecg_path) else [])) if ecg_path and ecg_path.suffix == ".csv" and ecg_path.exists() else None
    if ecg:
        prepared = ecg_times_and_signal(ecg)
        if prepared:
            times, signal, fs = prepared
            peaks = detect_r_peaks(signal, fs)
            peak_times = times[peaks]
            write_gzip_tsv(derivatives_dir / "ecg_rpeaks.tsv.gz", ["host_epoch_ns", "rr_ms"], [(int(t), "n/a" if i == 0 else round((t - peak_times[i - 1]) / 1e6, 1)) for i, t in enumerate(peak_times)])
            for summary in valid:
                rr = rr_intervals(peak_times[window_mask(peak_times, summary["start_ns"], summary["end_ns"])])
                if rr.size:
                    summary["ecgHeartRate"] = round(60000 / float(np.mean(rr)), 1)
                    value = rmssd(rr)
                    summary["rmssdMs"] = None if value is None else round(value, 1)

    oximeter_path = paths.get("oximeter")
    oximeter = read_numeric_columns(oximeter_path, ["spo2", "heart_rate"]) if oximeter_path and oximeter_path.suffix == ".csv" and oximeter_path.exists() else None
    if oximeter:
        for summary in valid:
            mask = window_mask(oximeter["host_epoch_ns"], summary["start_ns"], summary["end_ns"])
            hr = oximeter["heart_rate"][mask]
            spo2 = oximeter["spo2"][mask]
            hr = hr[(hr >= 30) & (hr <= 220)]
            spo2 = spo2[(spo2 >= 50) & (spo2 <= 100)]
            if hr.size:
                summary["oximeterHeartRate"] = round(float(np.mean(hr)), 1)
            if spo2.size:
                summary["spo2"] = round(float(np.mean(spo2)), 1)

    gsr_path = paths.get("gsr")
    gsr = read_numeric_columns(gsr_path, ["conductance_us"]) if gsr_path and gsr_path.suffix == ".csv" and gsr_path.exists() else None
    if gsr and gsr["host_epoch_ns"].size > 10:
        times = gsr["host_epoch_ns"]
        fs = (times.size - 1) / max(1e-9, (times[-1] - times[0]) / 1e9)
        tonic, _, scr = eda_decompose(gsr["conductance_us"], fs)
        scr_times = times[scr]
        for summary in valid:
            mask = window_mask(times, summary["start_ns"], summary["end_ns"])
            if mask.any():
                summary["sclUs"] = round(float(np.mean(tonic[mask])), 3)
                summary["scrCount"] = int(window_mask(scr_times, summary["start_ns"], summary["end_ns"]).sum())

    resp_path = paths.get("resp")
    resp = read_numeric_columns(resp_path, ["raw"]) if resp_path and resp_path.suffix == ".csv" and resp_path.exists() else None
    if resp:
        for summary in valid:
            mask = window_mask(resp["host_epoch_ns"], summary["start_ns"], summary["end_ns"])
            rate = breathing_rate_bpm(list(resp["host_epoch_ns"][mask] / 1e9), list(resp["raw"][mask])) if mask.sum() > 20 else None
            if rate is not None:
                summary["breathingRate"] = rate

    face_video = paths.get("face")
    if derive_video and face_video and face_video.exists() and face_video.suffix in (".mkv", ".avi"):
        frames_csv = face_video.with_name(f"{face_video.stem}_frames.csv")
        if frames_csv.exists():
            trace = face_colour_trace(face_video, frames_csv)
            write_gzip_tsv(derivatives_dir / "face_colour_trace.tsv.gz", ["host_epoch_ns", "blue", "green", "red", "face_detected"], trace)
            stamps = np.asarray([row[0] for row in trace], dtype=np.int64)
            for summary in valid:
                estimates = []
                for window_start in range(summary["start_ns"], summary["end_ns"] - 10_000_000_000 + 1, 2_000_000_000):
                    mask = window_mask(stamps, window_start, window_start + 10_000_000_000)
                    points = [(row[0] / 1e9, row[1:4]) for row, keep in zip(trace, mask) if keep and row[4]]
                    result = pos_heart_rate([p[0] for p in points], [p[1] for p in points]) if len(points) > 60 else None
                    if result and result[1] >= 0.3:
                        estimates.append(result[0])
                if estimates:
                    summary["rppgHeartRate"] = round(float(np.median(estimates)), 1)

    for summary in summaries:
        summary.pop("start_ns", None)
        summary.pop("end_ns", None)
    return summaries
