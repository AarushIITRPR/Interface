import csv
import gzip
import json
import math
import sys
import tempfile
import time
import types
import unittest
import wave
from pathlib import Path

import numpy as np

from meridian_agent.derivatives import audio_envelope, detect_r_peaks, eda_decompose, physio_summary, rmssd, rr_intervals
from meridian_agent.export import HostClock, build_bundle
from meridian_agent.lsl import LslBridge

from test_export import export_fixture, iso, ns


def synthetic_ecg(fs: float, rr_ms: list[float], noise: float = 0.02, seed: int = 0):
    rng = np.random.default_rng(seed)
    duration = sum(rr_ms) / 1000 + 1
    t = np.arange(0, duration, 1 / fs)
    signal = 0.05 * np.sin(2 * np.pi * 0.25 * t) + rng.normal(0, noise, t.size)
    beats = np.cumsum([500.0] + rr_ms[:-1]) / 1000
    for beat in beats:
        signal += 1.0 * np.exp(-((t - beat) ** 2) / (2 * 0.012 ** 2)) - 0.15 * np.exp(-((t - beat - 0.2) ** 2) / (2 * 0.04 ** 2))
    return t, signal, beats


class DerivativeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def test_r_peak_detection_and_rmssd(self):
        rr = [800 + 40 * math.sin(i / 3) for i in range(60)]
        t, signal, beats = synthetic_ecg(125.0, rr)
        peaks = detect_r_peaks(signal, 125.0)
        self.assertEqual(len(peaks), len(beats))
        self.assertLess(np.max(np.abs(t[peaks] - beats)), 0.02)
        intervals = rr_intervals(t[peaks] * 1e9)
        expected = float(np.sqrt(np.mean(np.square(np.diff(rr[:-1])))))
        self.assertAlmostEqual(rmssd(intervals), expected, delta=8)

    def test_eda_scr_detection(self):
        fs = 20.0
        t = np.arange(0, 120, 1 / fs)
        values = 3 + 0.002 * t
        for onset in (20, 50, 90):
            rise = (t >= onset) * 0.4 * (1 - np.exp(-(t - onset) / 1.0)) * np.exp(-np.clip(t - onset, 0, None) / 6)
            values = values + rise
        tonic, phasic, peaks = eda_decompose(values, fs)
        self.assertEqual(len(peaks), 3)
        self.assertTrue(all(abs(t[p] - onset) < 4 for p, onset in zip(peaks, (20, 50, 90))))
        self.assertLess(abs(float(np.median(tonic)) - 3.12), 0.1)

    def test_audio_envelope(self):
        path = self.root / "audio.wav"
        rate = 16000
        samples = np.concatenate([np.zeros(rate), (0.5 * 32767 * np.sin(2 * np.pi * 220 * np.arange(rate) / rate)).astype(np.int16)])
        with wave.open(str(path), "wb") as handle:
            handle.setnchannels(1); handle.setsampwidth(2); handle.setframerate(rate)
            handle.writeframes(samples.astype("<i2").tobytes())
        envelope = audio_envelope(path)
        self.assertEqual(len(envelope), 20)
        self.assertEqual(envelope[0], (0.0, 0.0))
        self.assertAlmostEqual(envelope[-1][1], 0.5 / math.sqrt(2), delta=0.01)

    def write_csv(self, relative: str, header: list[str], rows):
        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("w", newline="") as handle:
            writer = csv.writer(handle)
            writer.writerow(header)
            writer.writerows(rows)
        return path

    def test_physio_summary_bids_and_share_manifest(self):
        rr = [750.0] * 80
        t, signal, _ = synthetic_ecg(125.0, rr)
        self.write_csv("ecg/ecg.csv", ["host_epoch_ns", "monotonic_s", "packet_no", "session_start_ms", "sample_time_ms", "sample_index", "raw_count", "scaled_value", "heart_rate"],
                       [[ns(x), x, 0, 0, round(x * 1000, 3), i, 0, value, 80] for i, (x, value) in enumerate(zip(t, signal))])
        self.write_csv("oximeter/oximeter.csv", ["host_epoch_ns", "monotonic_s", "spo2", "heart_rate", "signal_strength", "pleth"], [[ns(i / 10), i / 10, 97, 79 if i % 2 else 81, 80, 50] for i in range(600)])
        resp_t = np.arange(0, 60, 1 / 50)
        self.write_csv("resp/resp.csv", ["host_epoch_ns", "monotonic_s", "device_t_us", "raw"], [[ns(x), x, int(x * 1e6), 2048 + 500 * math.sin(2 * math.pi * 0.25 * x)] for x in resp_t])
        export = export_fixture()
        export["consent"] = {"values": {"participation": "Yes", "shareFaceVideo": "No", "shareThermalVideo": "No", "shareAudio": "No", "sharePhysiology": "Yes", "shareWifi": "Yes", "shareResponses": "Yes", "shareDerived": "Yes", "futureResearch": "Yes"}}
        artifacts = [{"sensorId": "ecg", "relativePath": "ecg/ecg.csv", "startedAt": iso(0)}, {"sensorId": "oximeter", "relativePath": "oximeter/oximeter.csv", "startedAt": iso(0)},
                     {"sensorId": "resp", "relativePath": "resp/resp.csv", "startedAt": iso(0)}, {"sensorId": "face", "relativePath": "face/face.mkv", "startedAt": iso(0)}]
        build_bundle(export, self.root, HostClock(0.0, 0.0, ns(0), 0.0), artifacts)
        out = self.root / "export"

        summary = {row["step_id"]: row for row in csv.DictReader((out / "derivatives" / "physio_summary.tsv").open(), delimiter="\t")}
        washout = summary["s01-washout"]
        self.assertAlmostEqual(float(washout["ecg_heart_rate"]), 80.0, delta=1.0)
        self.assertLess(float(washout["rmssd_ms"]), 10)
        self.assertAlmostEqual(float(washout["oximeter_heart_rate"]), 80.0, delta=0.5)
        self.assertEqual(float(washout["spo2"]), 97.0)
        self.assertAlmostEqual(float(washout["breathing_rate"]), 15.0, delta=1.0)
        with gzip.open(out / "derivatives" / "ecg_rpeaks.tsv.gz", "rt") as handle:
            self.assertGreater(len(handle.readlines()), 60)

        bids = out / "bids"
        self.assertEqual(json.loads((bids / "dataset_description.json").read_text())["BIDSVersion"], "1.9.0")
        physio = bids / "sub-001" / "ses-0001test" / "physio"
        sidecar = json.loads((physio / "sub-001_ses-0001test_task-meridian_recording-oximeter_physio.json").read_text())
        self.assertEqual((sidecar["SamplingFrequency"], sidecar["Columns"]), (60.0, ["spo2", "heart_rate", "signal_strength", "pleth"]))
        with gzip.open(physio / "sub-001_ses-0001test_task-meridian_recording-oximeter_physio.tsv.gz", "rt") as handle:
            rows = handle.readlines()
        self.assertAlmostEqual(len(rows), 59.9 * 60, delta=2)
        events = list(csv.DictReader((bids / "sub-001" / "ses-0001test" / "beh" / "sub-001_ses-0001test_task-meridian_events.tsv").open(), delimiter="\t"))
        self.assertIn("washout", {row["trial_type"] for row in events})

        manifest = json.loads((out / "share_manifest.json").read_text())
        by_path = {item["path"]: item["share"] for item in manifest["files"]}
        self.assertFalse(by_path["face/face.mkv"])
        self.assertTrue(by_path["ecg/ecg.csv"])
        self.assertTrue(by_path["export/ratings.tsv"])

    def test_nothing_shareable_without_consent(self):
        build_bundle(export_fixture(), self.root, HostClock(0.0, 0.0, ns(0), 0.0), [], bids=False)
        manifest = json.loads((self.root / "export" / "share_manifest.json").read_text())
        self.assertFalse(manifest["consentRecorded"])
        self.assertFalse(any(item["share"] for item in manifest["files"]))


class LslTests(unittest.TestCase):
    def test_bridge_publishes_markers_and_values(self):
        pushed = []

        class Outlet:
            def __init__(self, info):
                self.info = info
            def push_sample(self, sample, timestamp=None):
                pushed.append((self.info.name, sample, timestamp))

        class Info:
            def __init__(self, name, kind, channels, rate, fmt, source):
                self.name, self.rate = name, rate

        fake = types.SimpleNamespace(StreamInfo=Info, StreamOutlet=Outlet, IRREGULAR_RATE=0.0)
        bridge = LslBridge("0001TEST", module=fake)
        bridge.push_event({"eventType": "media_onset", "stepId": "s03-clip-happy", "sequence": 7}, 123.5)
        bridge.push_value("oximeter", 60.0, 72.0, 124.0)
        bridge.push_value("oximeter", 60.0, 73.0, 124.1)
        self.assertEqual(pushed[0][0], "Meridian-0001TEST-markers")
        self.assertEqual(json.loads(pushed[0][1][0])["eventType"], "media_onset")
        self.assertEqual(pushed[0][2], 123.5)
        self.assertEqual([p[1] for p in pushed[1:]], [[72.0], [73.0]])
        self.assertEqual(len(bridge.outlets), 1)


if __name__ == "__main__":
    unittest.main()
