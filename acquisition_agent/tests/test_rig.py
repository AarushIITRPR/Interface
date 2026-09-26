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

from test_export import event, export_fixture, iso, ns


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

    def test_bundle_writes_questionnaires_and_annotations(self):
        export = export_fixture()
        export["plan"] = export["plan"] + [{"index": 3, "id": "s03-annotation-happy", "type": "annotation", "label": "Replay rating: happy", "phase": "Continuous rating", "emotion": "happy", "durationSec": None, "advance": "media"}]
        export["questionnaireItems"] = {"nasa_tlx": {"items": [{"id": "mental", "text": "How mentally demanding was the task?"}, {"id": "effort", "text": "How hard?"}]}}
        export["questionnaires"] = [{"questionnaireId": "nasa_tlx", "stepId": "s11-questionnaire-nasa_tlx", "answers": {"mental": 80, "effort": 60}, "scores": {"rawTlx": 70.0}, "createdAt": iso(30)}]
        base_ms = int(ns(40) // 1_000_000)
        export["annotations"] = [
            {"stepId": "s03-annotation-happy", "chunk": 1, "attempt": 1, "samples": [[base_ms + 2000, 0.5, 0.25]]},
            {"stepId": "s03-annotation-happy", "chunk": 0, "attempt": 1, "samples": [[base_ms, 0.0, 0.0], [base_ms + 50, 0.1, -0.2]]},
        ]
        build_bundle(export, self.root, HostClock(250.0, 0.0, ns(0), 0.0), [])
        out = self.root / "export"
        items = list(csv.DictReader((out / "questionnaire_items.tsv").open(), delimiter="\t"))
        self.assertEqual([(row["item"], row["response"]) for row in items], [("mental", "80"), ("effort", "60")])
        scores = list(csv.DictReader((out / "questionnaire_scores.tsv").open(), delimiter="\t"))
        self.assertEqual((scores[0]["questionnaire"], scores[0]["rawTlx"]), ("nasa_tlx", "70.0"))
        annotations = list(csv.DictReader((out / "annotations.tsv").open(), delimiter="\t"))
        self.assertEqual([row["valence"] for row in annotations], ["0.0", "0.1", "0.5"])
        # Server-clock sample times are shifted onto the host clock by the measured offset (250 ms).
        self.assertEqual(int(annotations[0]["host_epoch_ns"]), ns(40) - 250_000_000)
        self.assertEqual(annotations[0]["clip"], "Replay rating: happy")


if __name__ == "__main__":
    unittest.main()


class RigBaselineTest(unittest.TestCase):
    def write(self, root: Path, day: str, port: str, csv: bool = True, **extra) -> None:
        folder = root / "empty_room_baselines"
        folder.mkdir(parents=True, exist_ok=True)
        info = {"kind": "empty_room_csi_baseline", "port": port, "startedAt": f"{day}T07:55", "durationS": 1800.0, "rows": 1000,
                "stalledMinutes": 0, "nonGoodMinutes": [], "finalReport": {"quality": "good"}, **extra}
        (folder / f"empty_room_{day}_075251.json").write_text(json.dumps(info))
        if csv:
            (folder / f"empty_room_{day}_075251.csv").write_text("host_epoch_ns\n1\n")

    def test_same_day_same_port_is_accepted_and_adopted(self):
        from meridian_agent.agent import adopt_rig_baseline, find_rig_baseline
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self.write(root, "20260922", "/dev/ttyACM0")
            found = find_rig_baseline(root, "/dev/ttyACM0", "20260922")
            self.assertEqual(found["file"], "empty_room_20260922_075251.json")
            session = root / "session_X"
            adopt_rig_baseline(session, found)
            self.assertTrue((session / "csi" / "empty_room_20260922_075251.csv").is_file())
            self.assertTrue((session / "csi" / "empty_room_rig_baseline.json").is_file())

    def test_other_day_port_stall_or_missing_csv_is_refused(self):
        from meridian_agent.agent import find_rig_baseline
        cases = [("20260921", "/dev/ttyACM0", True, {}), ("20260922", "/dev/ttyUSB0", True, {}),
                 ("20260922", "/dev/ttyACM0", True, {"stalledMinutes": 2}), ("20260922", "/dev/ttyACM0", False, {})]
        for day, port, csv_present, extra in cases:
            with self.subTest(day=day, port=port, csv=csv_present, extra=extra), tempfile.TemporaryDirectory() as tmp:
                self.write(Path(tmp), day, port, csv_present, **extra)
                self.assertIsNone(find_rig_baseline(Path(tmp), "/dev/ttyACM0", "20260922"))


class ReconnectAndLockTest(unittest.TestCase):
    def test_serial_nodes_resolve_to_their_physical_port_link(self):
        from meridian_agent.sensors import stable_serial_path
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            node = root / "ttyUSB1"; node.write_text("")
            by_path = root / "by-path"; by_path.mkdir()
            (by_path / "pci-0-usbv2-0:8:1.0-port0").symlink_to(node)
            (by_path / "pci-0-usb-0:8:1.0-port0").symlink_to(node)
            # The by-path lookup only applies to /dev/tty* names, so exercise the matching directly.
            import meridian_agent.sensors as sensors
            original = sensors.os.path.realpath
            try:
                sensors.os.path.realpath = lambda p: original(str(node) if p == "/dev/ttyUSB1" else p)
                self.assertEqual(stable_serial_path("/dev/ttyUSB1", by_path), str(by_path / "pci-0-usb-0:8:1.0-port0"))
                self.assertEqual(stable_serial_path("/dev/ttyUSB9", by_path), "/dev/ttyUSB9")
            finally:
                sensors.os.path.realpath = original
            self.assertEqual(stable_serial_path("auto", by_path), "auto")
            self.assertEqual(stable_serial_path("/dev/v4l/by-id/cam", by_path), "/dev/v4l/by-id/cam")

    def test_a_second_agent_for_the_same_session_is_refused(self):
        from meridian_agent.agent import AgentAlreadyRunning, acquire_session_lock
        with tempfile.TemporaryDirectory() as tmp:
            first = acquire_session_lock(Path(tmp), "0132ABCD")
            self.assertIsNotNone(first)
            import subprocess, sys
            # flock is per open file description, so a second process is the honest test.
            code = ("import sys; from pathlib import Path; from meridian_agent.agent import acquire_session_lock, AgentAlreadyRunning\n"
                    f"try:\n    acquire_session_lock(Path({tmp!r}), '0132ABCD')\nexcept AgentAlreadyRunning as e:\n    print(e); sys.exit(3)\n")
            result = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, cwd=Path(__file__).resolve().parents[1])
            self.assertEqual(result.returncode, 3, result.stderr)
            self.assertIn("already running for session 0132ABCD", result.stdout)
            other = subprocess.run([sys.executable, "-c", code.replace("0132ABCD", "0133WXYZ")], capture_output=True, text=True, cwd=Path(__file__).resolve().parents[1])
            self.assertEqual(other.returncode, 0, other.stderr)
            first.close()
            again = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, cwd=Path(__file__).resolve().parents[1])
            self.assertEqual(again.returncode, 0, "the lock must go away with the process that held it")
            del AgentAlreadyRunning


class BackupTest(unittest.TestCase):
    def test_backup_copies_verifies_and_snapshots_the_database(self):
        import hashlib, sqlite3, subprocess, sys
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            session = root / "session_X_1"; (session / "face").mkdir(parents=True)
            data = b"frames" * 1000
            (session / "face" / "face.mkv").write_bytes(data)
            (session / "manifest.json").write_text(json.dumps({"recordings": [{"relativePath": "face/face.mkv", "bytes": len(data),
                                                                               "sha256": hashlib.sha256(data).hexdigest()}], "auxiliaryFiles": []}))
            db = root / "db"; db.mkdir()
            with sqlite3.connect(db / "state.sqlite") as con:
                con.execute("create table sessions(code text)"); con.execute("insert into sessions values ('X')")
            archive = root / "archive"; archive.mkdir()
            tool = Path(__file__).resolve().parents[1] / "tools" / "backup_session.py"
            result = subprocess.run([sys.executable, str(tool), str(session), str(archive), "--db-dir", str(db)], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual((archive / session.name / "face" / "face.mkv").read_bytes(), data)
            snapshot = next(archive.glob("database_*")) / "state.sqlite"
            with sqlite3.connect(snapshot) as con:
                self.assertEqual(con.execute("select code from sessions").fetchall(), [("X",)])
            (archive / session.name / "face" / "face.mkv").write_bytes(b"x" * len(data))
            from importlib.util import module_from_spec, spec_from_file_location
            spec = spec_from_file_location("backup_session", tool); module = module_from_spec(spec); spec.loader.exec_module(module)
            self.assertEqual(module.verify(session, archive / session.name, quick=False), ["checksum differs: face/face.mkv"])

    def test_verify_only_checks_a_copy_without_copying_anything(self):
        import hashlib, subprocess, sys
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            session = root / "session_Z"; (session / "face").mkdir(parents=True)
            data = b"frames" * 500
            (session / "face" / "face.mkv").write_bytes(data)
            (session / "manifest.json").write_text(json.dumps({"recordings": [{"relativePath": "face/face.mkv", "bytes": len(data),
                                                                               "sha256": hashlib.sha256(data).hexdigest()}]}))
            copy = root / "drive"; (copy / "face").mkdir(parents=True)
            (copy / "face" / "face.mkv").write_bytes(data)
            tool = Path(__file__).resolve().parents[1] / "tools" / "backup_session.py"
            run = lambda: subprocess.run([sys.executable, str(tool), str(session), str(root / "unused"), "--verify-only", str(copy)],
                                         capture_output=True, text=True)
            good = run()
            self.assertEqual(good.returncode, 0, good.stderr)
            self.assertIn("matches the manifest", good.stdout)
            self.assertFalse((root / "unused").exists(), "--verify-only must not copy anything")
            (copy / "face" / "face.mkv").write_bytes(b"y" * len(data))
            bad = run()
            self.assertEqual(bad.returncode, 1)
            self.assertIn("checksum differs", bad.stderr)

    def test_backup_refuses_an_unfinished_session_or_a_missing_drive(self):
        import subprocess, sys
        with tempfile.TemporaryDirectory() as tmp:
            tool = Path(__file__).resolve().parents[1] / "tools" / "backup_session.py"
            session = Path(tmp) / "session_Y"; session.mkdir()
            result = subprocess.run([sys.executable, str(tool), str(session), str(Path(tmp) / "nope")], capture_output=True, text=True)
            self.assertEqual(result.returncode, 2)
            self.assertIn("manifest.json", result.stderr)
