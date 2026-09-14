import argparse
import csv
import json
import math
import tempfile
import time
import unittest
from pathlib import Path

from meridian_agent.export import HostClock, artifact_windows, build_bundle, environment_summary, event_marker
from meridian_agent.sensors import EnvironmentSensor, RespirationSensor, SimulatedSensor, breathing_rate_bpm

from test_export import event, export_fixture, ns


class RigSensorTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def test_breathing_rate_from_belt_trace(self):
        times = [i / 50 for i in range(30 * 50)]
        for bpm in (6, 12, 20):
            values = [2048 + 500 * math.sin(2 * math.pi * (bpm / 60) * t) + (7 if i % 3 else -7) for i, t in enumerate(times)]
            self.assertAlmostEqual(breathing_rate_bpm(times, values), bpm, delta=1.0)
        self.assertIsNone(breathing_rate_bpm(times[:100], [0.0] * 100))

    def test_respiration_and_environment_parsers(self):
        belt = RespirationSensor("resp", "COM1", 115200, self.root, 0.0)
        self.assertEqual(belt.parse("1000,2100")[0], [1000, 2100])
        self.assertEqual(belt.parse("1000,5,2100")[0], [1000, 2100])
        self.assertIsNone(belt.parse("hello"))
        room = EnvironmentSensor("environment", "COM2", 115200, self.root, 0.0)
        self.assertEqual(room.parse("5000,23.5,48.2,310")[0], ["5000", 23.5, 48.2, 310.0, ""])
        parsed = room.parse(json.dumps({"t_ms": 6000, "temp_c": 24.0, "rh": 50, "lux": 280, "pressure_hpa": 1008.5}))
        self.assertEqual(parsed[0], [6000, 24.0, 50.0, 280.0, 1008.5])
        self.assertIsNone(room.parse("5000,warm,48,310"))
        _, metrics, _ = room.telemetry(parsed[0])
        self.assertEqual(metrics, {"tempC": 24.0, "humidityPct": 50.0, "lux": 280.0, "pressureHpa": 1008.5})

    def test_side_capture_writes_only_while_active(self):
        sensor = SimulatedSensor("csi", self.root, time.monotonic())
        sensor._side_write([1, 2])
        path = sensor.start_side_capture("csi/empty_room_test.csv", ["host_epoch_ns", "monotonic_s"])
        sensor._side_write([3, 4])
        sensor._side_write([5, 6])
        self.assertEqual(sensor.stop_side_capture(), 2)
        sensor._side_write([7, 8])
        with path.open() as handle:
            self.assertEqual(list(csv.reader(handle)), [["host_epoch_ns", "monotonic_s"], ["3", "4"], ["5", "6"]])

    def test_agent_calibration_flow(self):
        from meridian_agent.agent import MeridianAgent
        args = argparse.Namespace(server="http://localhost", code="0001TEST", token="t", output=str(self.root), export_to="", timeout=1.0)
        agent = MeridianAgent(args)
        receiver = SimulatedSensor("csi", agent.session_dir, time.monotonic())
        agent.sensors = [receiver, SimulatedSensor("face", agent.session_dir, time.monotonic())]
        agent.run_calibration({"command": "calibrate", "calibrationStartedAt": "2026-01-01T00:00:00Z", "calibrationSec": 0.05})
        self.assertEqual(agent.calibration["status"], "running")
        receiver._side_write([1, 2, 3, 4])
        time.sleep(0.06)
        agent.run_calibration({"command": "calibrate", "calibrationStartedAt": "2026-01-01T00:00:00Z", "calibrationSec": 0.05})
        self.assertEqual(agent.calibration["status"], "done")
        self.assertEqual(agent.calibration["rows"], 1)
        self.assertEqual(len(list((agent.session_dir / "csi").glob("empty_room_*.csv"))), 1)

        agent.sensors = []
        agent.run_calibration({"command": "calibrate", "calibrationStartedAt": "2026-01-01T00:05:00Z", "calibrationSec": 60})
        self.assertEqual(agent.calibration["status"], "failed")


class RigExportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def test_artifact_windows(self):
        clock = HostClock(0.0, 0.0, ns(0), 0.0)
        markers = [event_marker(event(i, "artifact", t, metadata=meta), clock) for i, (t, meta) in enumerate([
            (10, {"type": "cough", "kind": "point"}),
            (20, {"type": "talking", "kind": "start"}),
            (32, {"type": "talking", "kind": "end"}),
            (40, {"type": "left_seat", "kind": "start"}),
        ], start=1)] + [event_marker(event(9, "session_complete", 50), clock)]
        windows = artifact_windows(markers)
        self.assertEqual([(w["type"], (w["start_ns"] - ns(0)) / 1e9, (w["end_ns"] - w["start_ns"]) / 1e9) for w in windows],
                         [("cough", 7.0, 4.0), ("talking", 20.0, 12.0), ("left_seat", 40.0, 10.0)])
        self.assertTrue(windows[-1]["unclosed"])

    def test_environment_summary_flags_lighting_change(self):
        path = self.root / "environment.csv"
        with path.open("w", newline="") as handle:
            writer = csv.writer(handle)
            writer.writerow(["host_epoch_ns", "monotonic_s", "device_t_ms", "temp_c", "humidity_pct", "lux", "pressure_hpa"])
            for i in range(60):
                writer.writerow([ns(i), i, i * 1000, 23 + i * 0.01, 48, 300 if i < 40 else 450, ""])
        summary = environment_summary(path)
        self.assertEqual(summary["lux"], {"min": 300.0, "median": 300.0, "max": 450.0})
        self.assertTrue(summary["lightingChanged"])

    def test_bundle_includes_participants_artifacts_and_qa(self):
        export = export_fixture()
        export["participantFields"] = [
            {"id": "fitzpatrick", "label": "Skin type", "kind": "choice", "options": ["I", "II", "III", "IV", "V", "VI"], "required": True},
            {"id": "eyewear", "label": "Eyewear", "kind": "choice", "options": ["None", "Glasses"], "required": True},
            {"id": "cameraDistanceCm", "label": "Face camera to face", "kind": "number", "unit": "cm", "min": 20, "max": 400},
        ]
        export["participantMetadata"] = {"fitzpatrick": "IV", "cameraDistanceCm": 80}
        export["events"].insert(3, event(30, "artifact", 12, 1, "s01-washout", metadata={"type": "cough", "kind": "point"}))
        export["events"].sort(key=lambda item: item["serverTime"])
        for index, item in enumerate(export["events"], start=1):
            item["sequence"] = index
        report = build_bundle(export, self.root, HostClock(0.0, 0.0, ns(0), 0.0), [])
        out = self.root / "export"
        rows = list(csv.DictReader((out / "participants.tsv").open(), delimiter="\t"))
        self.assertEqual(rows[0]["participant_id"], "sub-001")
        self.assertEqual((rows[0]["fitzpatrick"], rows[0]["eyewear"], rows[0]["cameraDistanceCm"]), ("IV", "n/a", "80"))
        dictionary = json.loads((out / "participants.json").read_text())
        self.assertEqual(dictionary["cameraDistanceCm"]["Units"], "cm")
        artifacts = list(csv.DictReader((out / "artifacts.tsv").open(), delimiter="\t"))
        self.assertEqual((artifacts[0]["type"], artifacts[0]["onset_s"], artifacts[0]["duration_s"]), ("cough", "9.000", "4.000"))
        washout = next(step for step in report["steps"] if step["stepId"] == "s01-washout")
        self.assertEqual(washout["artifactSeconds"], {"cough": 3.0})  # window 9-13 s, washout starts at 10 s
        self.assertIn("artifacts: cough 3s", washout["issues"])
        self.assertEqual(report["missingParticipantFields"], ["eyewear"])
        self.assertIn("Participant details missing: eyewear", (out / "qa_report.md").read_text())


if __name__ == "__main__":
    unittest.main()
