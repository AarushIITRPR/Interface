"""BIDS-style export of one session (https://bids.neuroimaging.io).

Physiological CSVs are resampled onto a uniform grid at their nominal rate, because BIDS physio files require a
constant sampling frequency; the original timestamped files stay in the recording folder and are listed in
scans.tsv. Video and audio are referenced, not copied.
"""
from __future__ import annotations

import json
import shutil
from pathlib import Path

import numpy as np

from .derivatives import header_of, read_numeric_columns

NOMINAL_RATES = {"oximeter": 60.0, "csi": 100.0, "csi2": 100.0, "emg": 1000.0, "gsr": 20.0, "ecg": 125.0, "photodiode": 1000.0, "resp": 50.0, "environment": 1.0}
SKIP_COLUMNS = {"host_epoch_ns", "monotonic_s", "device_t_us", "device_t_ms", "device_timestamp", "packet_id", "sequence", "packet_no", "session_start_ms", "sample_time_ms", "sample_index", "sample_count"}


def numeric_columns(path: Path, probe_rows: int = 50) -> list[str]:
    """Signal columns whose first rows are all numeric (text columns such as raw lines are left out)."""
    import csv
    header = header_of(path)
    candidates = [name for name in header if name not in SKIP_COLUMNS]
    with path.open(newline="", encoding="utf-8", errors="replace") as handle:
        reader = csv.reader(handle)
        next(reader, None)
        sample = [row for _, row in zip(range(probe_rows), reader)]
    usable = []
    for name in candidates:
        index = header.index(name)
        try:
            if sample and all(row[index] != "" and float(row[index]) == float(row[index]) for row in sample):
                usable.append(name)
        except (IndexError, ValueError):
            continue
    return usable


def csi_amplitude_columns(path: Path, names: list[str], columns: dict | None):
    """ESP32 CSI rows keep subcarrier amplitudes inside raw_line; expand them into amp_0..amp_N columns."""
    import csv
    times: list[int] = []
    rssi: list[float] = []
    amplitudes: list[list[float]] = []
    with path.open(newline="", encoding="utf-8", errors="replace") as handle:
        reader = csv.DictReader(handle)
        for row in reader:
            line = row.get("raw_line") or ""
            parts = (line[9:] if line.startswith("CSI_DATA,") else line).split(",")
            try:
                values = [abs(float(value)) for value in parts[6:]]
                times.append(int(row["host_epoch_ns"]))
                rssi.append(float(row["rssi"]))
            except (KeyError, ValueError):
                continue
            amplitudes.append(values)
    if not amplitudes:
        return columns, names
    width = min(len(values) for values in amplitudes)
    order = np.argsort(np.asarray(times), kind="stable")
    result = {"host_epoch_ns": np.asarray(times, dtype=float)[order], "rssi": np.asarray(rssi)[order]}
    matrix = np.asarray([values[:width] for values in amplitudes])[order]
    for index in range(width):
        result[f"amp_{index}"] = matrix[:, index]
    return result, ["rssi"] + [f"amp_{index}" for index in range(width)]


def write_bids(out: Path, export: dict, session_dir: Path, artifacts: list[dict], origin_ns: int | None, events: list[list], participants_dir: Path) -> Path:
    subject = f"sub-{int(export.get('participantId') or 0):03d}"
    session = f"ses-{str(export.get('sessionCode') or 'unknown').lower()}"
    prefix = f"{subject}_{session}_task-meridian"
    root = out / "bids"
    beh = root / subject / session / "beh"
    physio = root / subject / session / "physio"
    beh.mkdir(parents=True, exist_ok=True)
    physio.mkdir(parents=True, exist_ok=True)

    (root / "dataset_description.json").write_text(json.dumps({
        "Name": "Meridian multimodal emotion and contactless physiology recordings",
        "BIDSVersion": "1.9.0",
        "DatasetType": "raw",
        "GeneratedBy": [{"Name": "Meridian acquisition agent"}],
    }, indent=2), encoding="utf-8")
    (root / "README").write_text(
        "Session exported by Meridian. events.tsv onsets are seconds from recording start on the acquisition host clock.\n"
        "Physio files are resampled to a uniform rate; the original timestamped CSVs, video, and audio are listed in scans.tsv.\n",
        encoding="utf-8")
    for name in ("participants.tsv", "participants.json"):
        if (participants_dir / name).exists():
            shutil.copyfile(participants_dir / name, root / name)

    event_path = beh / f"{prefix}_events.tsv"
    with event_path.open("w", encoding="utf-8") as handle:
        handle.write("onset\tduration\ttrial_type\tstep_id\tsource\tvalue\n")
        for row in events:
            handle.write("\t".join("n/a" if value in (None, "") else str(value) for value in row) + "\n")
    (beh / f"{prefix}_events.json").write_text(json.dumps({
        "onset": {"Description": "Seconds from recording start (acquisition host clock)", "Units": "s"},
        "duration": {"Description": "Step duration for step rows, artifact window length for artifacts, 0 for instantaneous events", "Units": "s"},
        "trial_type": {"Description": "Meridian event or step type"},
        "step_id": {"Description": "Protocol step identifier"},
        "source": {"Description": "system, operator, subject, or sensor"},
        "value": {"Description": "Step label, artifact type, or event label"},
    }, indent=2), encoding="utf-8")

    scans = []
    for artifact in artifacts:
        path = session_dir / artifact["relativePath"]
        if not path.exists():
            continue
        scans.append((str(Path("..") / ".." / ".." / ".." / path.relative_to(session_dir.parent)).replace("\\", "/"), artifact.get("startedAt", "n/a")))
        sensor = artifact["sensorId"]
        rate = NOMINAL_RATES.get(sensor)
        if path.suffix != ".csv" or rate is None:
            continue
        names = numeric_columns(path)
        columns = read_numeric_columns(path, names) if names else None
        if sensor in ("csi", "csi2"):
            columns, names = csi_amplitude_columns(path, names, columns)
        if not columns or columns["host_epoch_ns"].size < 2:
            continue
        times = columns["host_epoch_ns"]
        grid = np.arange(times[0], times[-1], 1e9 / rate)
        if grid.size < 2:
            continue
        resampled = [np.interp(grid, times, columns[name]) for name in names]
        stem = f"{prefix}_recording-{sensor}_physio"
        import gzip
        with gzip.open(physio / f"{stem}.tsv.gz", "wt", encoding="utf-8") as handle:
            for row in np.column_stack(resampled):
                handle.write("\t".join(f"{value:.6g}" for value in row) + "\n")
        (physio / f"{stem}.json").write_text(json.dumps({
            "SamplingFrequency": rate,
            "StartTime": round((times[0] - origin_ns) / 1e9, 6) if origin_ns is not None else 0,
            "Columns": names,
            "Manufacturer": "See session.json streams",
            "ResampledFrom": artifact["relativePath"],
        }, indent=2), encoding="utf-8")
    with (root / subject / session / f"{subject}_{session}_scans.tsv").open("w", encoding="utf-8") as handle:
        handle.write("filename\tacq_time\n")
        for filename, acquired in scans:
            handle.write(f"{filename}\t{acquired}\n")
    return root
