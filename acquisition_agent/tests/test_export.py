import csv
import numpy as np
import json
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

from meridian_agent.export import HostClock, build_bundle, coverage, event_marker, photodiode_edges, step_windows, sync_check

BASE = datetime(2026, 1, 1, tzinfo=timezone.utc).timestamp()


def iso(seconds: float) -> str:
    return datetime.fromtimestamp(BASE + seconds, tz=timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def ns(seconds: float) -> int:
    return int(BASE) * 1_000_000_000 + round(seconds * 1e9)


def event(sequence, kind, seconds, step_index=0, step_id="s00-setup", attempt=1, client=None, metadata=None):
    return {"sequence": sequence, "eventType": kind, "serverTime": iso(seconds), "clientTime": client, "stepIndex": step_index,
            "stepId": step_id, "attempt": attempt, "source": "system", "label": kind, "detail": "", "metadata": metadata or {}}


PLAN = [
    {"index": 0, "id": "s00-setup", "type": "setup", "label": "Sensor check", "phase": "Getting settled", "emotion": None, "durationSec": None, "advance": "operator"},
    {"index": 1, "id": "s01-washout", "type": "washout", "label": "Neutral washout", "phase": "Part 1", "emotion": None, "durationSec": 20, "advance": "timer"},
    {"index": 2, "id": "s02-clip-happy", "type": "clip", "label": "Clip: happy", "phase": "Part 1", "emotion": "happy", "durationSec": None, "advance": "media"},
]


def export_fixture():
    return {
        "sessionCode": "0001TEST", "participantId": 1, "status": "complete", "recordingStartedAt": iso(0),
        "requiredSensors": ["face", "oximeter"], "plan": PLAN, "ratings": [], "notes": [], "bpReadings": [],
        "events": [
            event(1, "step_start", 0),
            event(2, "step_start", 10, 1, "s01-washout"),
            event(3, "session_paused", 15, 1, "s01-washout"),
            event(4, "session_resumed", 20, 1, "s01-washout"),
            event(5, "step_start", 35, 2, "s02-clip-happy"),
            event(6, "media_onset", 36, 2, "s02-clip-happy", client=iso(36.25), metadata={"loadDelayMs": 180}),
            event(7, "step_repeated", 40, 2, "s02-clip-happy", metadata={"attempt": 2}),
            event(8, "media_onset", 41, 2, "s02-clip-happy", attempt=2, client=iso(41.5)),
            event(9, "stroop_complete", 59, 2, "s02-clip-happy", attempt=2, metadata={"seed": 7, "accuracyPct": 50, "trialData": [
                {"i": 0, "word": "Red", "ink": "Red", "congruent": True, "response": "Red", "rtMs": 500, "correct": True, "timedOut": False},
                {"i": 1, "word": "Blue", "ink": "Green", "congruent": False, "response": None, "rtMs": None, "correct": False, "timedOut": True}]}),
            event(10, "session_complete", 60, 2, "s02-clip-happy", attempt=2),
        ],
    }


class ExportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def test_server_time_maps_to_host_clock_using_offset(self):
        clock = HostClock(offset_ms=250.0, origin_mono=0.0, anchor_epoch_ns=ns(0), anchor_mono=100.0)
        self.assertEqual(clock.server_to_host_ns(iso(10)), ns(10) - 250_000_000)
        self.assertAlmostEqual(clock.host_to_monotonic_s(ns(10)), 110.0, places=6)
        self.assertIsNone(clock.server_to_host_ns("not a time"))

    def test_marker_prefers_display_time_for_stimuli(self):
        clock = HostClock(0.0, 0.0, ns(0), 0.0)
        marker = event_marker(event(6, "media_onset", 36, client=iso(36.25)), clock)
        self.assertEqual(marker["timeSource"], "display")
        self.assertEqual(marker["hostEpochNs"], ns(36.25))

    def test_step_windows_track_pauses_repeats_and_onsets(self):
        windows = step_windows(export_fixture(), HostClock(0.0, 0.0, ns(0), 0.0))
        self.assertEqual([(w["step_id"], w["attempt"], w["end"]) for w in windows],
                         [("s00-setup", 1, "next_step"), ("s01-washout", 1, "next_step"), ("s02-clip-happy", 1, "repeated"), ("s02-clip-happy", 2, "complete")])
        washout = windows[1]
        self.assertEqual(washout["pauses"], 1)
        self.assertEqual((washout["end_ns"] - washout["start_ns"] - washout["pause_ns"]) / 1e9, 20.0)
        self.assertEqual(windows[2]["stimulus_onset_ns"], ns(36.25))
        self.assertEqual(windows[2]["stimulus_load_delay_ms"], 180)
        self.assertEqual(windows[3]["stimulus_onset_ns"], ns(41.5))
        self.assertEqual(windows[2]["stimulus_starts"], 1)

    def test_coverage_counts_filled_seconds(self):
        stamps = [ns(0.1), ns(1.5), ns(3.2)]
        self.assertEqual(coverage(stamps, ns(0), ns(4)), {"rows": 3, "coveragePct": 75.0})

    def test_bundle_writes_aligned_tables_and_flags_gaps(self):
        (self.root / "oximeter").mkdir()
        with (self.root / "oximeter" / "oximeter.csv").open("w", newline="") as handle:
            writer = csv.writer(handle)
            writer.writerow(["host_epoch_ns", "monotonic_s", "spo2", "heart_rate", "signal_strength", "pleth"])
            for tenth in range(0, 600):
                seconds = tenth / 10
                if 45 <= seconds < 55:
                    continue  # ten-second dropout during the repeated clip
                writer.writerow([ns(seconds), seconds, 98, 72, 80, 50])
        (self.root / "face").mkdir()
        (self.root / "face" / "face.avi").write_bytes(b"")
        with (self.root / "face" / "face_frames.csv").open("w", newline="") as handle:
            writer = csv.writer(handle)
            writer.writerow(["frame_index", "host_epoch_ns", "monotonic_s"])
            for frame in range(0, 60 * 30):
                writer.writerow([frame, ns(frame / 30), frame / 30])
        artifacts = [{"sensorId": "oximeter", "relativePath": "oximeter/oximeter.csv"}, {"sensorId": "face", "relativePath": "face/face.avi"},
                     {"sensorId": "audio", "relativePath": "audio/audio.wav"}]

        report = build_bundle(export_fixture(), self.root, HostClock(0.0, 0.0, ns(0), 0.0), artifacts)

        out = self.root / "export"
        for name in ("events.tsv", "steps.tsv", "ratings.tsv", "tasks.tsv", "session.json", "qa_report.json", "qa_report.md"):
            self.assertTrue((out / name).exists(), name)
        steps = list(csv.DictReader((out / "steps.tsv").open(), delimiter="\t"))
        self.assertEqual(steps[1]["active_duration_s"], "20.000")
        self.assertEqual(steps[2]["stimulus_onset_s"], "36.250")
        events = list(csv.DictReader((out / "events.tsv").open(), delimiter="\t"))
        self.assertEqual(events[5]["time_source"], "display")
        self.assertEqual(int(events[5]["host_epoch_ns"]), ns(36.25))

        by_attempt = {(step["stepId"], step["attempt"]): step for step in report["steps"]}
        repeated = by_attempt[("s02-clip-happy", 2)]
        self.assertTrue(any("oximeter coverage" in issue for issue in repeated["issues"]))
        self.assertEqual(repeated["streams"]["face"]["coveragePct"], 100.0)
        self.assertIsNone(repeated["streams"]["audio"]["coveragePct"])
        self.assertIn("attempt repeated", by_attempt[("s02-clip-happy", 1)]["issues"])
        self.assertIn("paused 1x", by_attempt[("s01-washout", 1)]["issues"])
        self.assertEqual(by_attempt[("s00-setup", 1)]["issues"], [])
        trials = list(csv.DictReader((out / "stroop_trials.tsv").open(), delimiter="\t"))
        self.assertEqual([(t["seed"], t["i"], t["congruent"], t["timedOut"]) for t in trials], [("7", "0", "True", "False"), ("7", "1", "False", "True")])
        self.assertNotIn("trialData", (out / "tasks.tsv").read_text())
        session = json.loads((out / "session.json").read_text())
        self.assertEqual(session["clock"]["recordingStartHostEpochNs"], ns(0))

    def test_word_list_recognition_gets_its_own_tables_and_consent(self):
        fixture = export_fixture()
        trials = [
            {"i": 0, "word": "bicycle", "type": "old", "answer": "yes", "correct": True, "rtMs": 850},
            {"i": 1, "word": "cycle", "type": "lure", "answer": "yes", "correct": False, "rtMs": 1200},
            {"i": 2, "word": "river", "type": "old", "answer": "no", "correct": False, "rtMs": 990},
        ]
        recognition = {"listIndex": 0, "seed": 1234, "hits": 1, "misses": 1, "falseAlarms": 1, "correctRejections": 0,
                       "answered": 3, "total": 20, "hitRate": 0.5, "falseAlarmRate": 1.0, "dPrime": -0.43, "criterion": -0.22,
                       "meanRtMs": 1013, "studyMs": 20000, "words": ["bicycle", "river"], "lures": ["cycle", "stream"],
                       "trialData": trials}
        fixture["events"].insert(-1, event(11, "wordlist_recognition", 58, 2, "s02-clip-happy", attempt=2, metadata=recognition))
        fixture["consent"] = {"values": {"participation": "Yes", "shareResponses": "No"}}

        build_bundle(fixture, self.root, HostClock(0.0, 0.0, ns(0), 0.0), [])

        out = self.root / "export"
        rows = list(csv.DictReader((out / "wordlist.tsv").open(), delimiter="\t"))
        self.assertEqual(len(rows), 1)
        row = rows[0]
        self.assertEqual((row["list"], row["seed"], row["hits"], row["false_alarms"], row["d_prime"], row["study_ms"]),
                         ("1", "1234", "1", "1", "-0.43", "20000"))
        self.assertEqual(row["lures"], "cycle;stream")
        per_word = list(csv.DictReader((out / "wordlist_trials.tsv").open(), delimiter="\t"))
        self.assertEqual([(t["word"], t["type"], t["answer"], t["correct"]) for t in per_word],
                         [("bicycle", "old", "yes", "True"), ("cycle", "lure", "yes", "False"), ("river", "old", "no", "False")])
        self.assertEqual(per_word[0]["seed"], "1234")
        # The summary stays readable: per-word detail lives in the two word list tables only.
        summary = (out / "tasks.tsv").read_text()
        self.assertIn("wordlist_recognition", summary)
        self.assertNotIn("trialData", summary)
        # Recognition answers are responses, so both tables follow the participant's response-sharing consent.
        manifest = json.loads((out / "share_manifest.json").read_text())
        for name in ("wordlist.tsv", "wordlist_trials.tsv"):
            entry = next(item for item in manifest["files"] if item["path"].endswith(name))
            self.assertEqual(entry["consentField"], "shareResponses")
            self.assertFalse(entry["share"])

    def test_photodiode_edges_and_sync_latency(self):
        path = self.root / "photodiode.csv"
        with path.open("w", newline="") as handle:
            writer = csv.writer(handle)
            writer.writerow(["host_epoch_ns", "monotonic_s", "device_t_us", "raw"])
            flashes = [10.030, 20.018]
            for ms in range(0, 30_000, 2):
                seconds = ms / 1000
                lit = any(start <= seconds < start + 0.2 for start in flashes)
                writer.writerow([ns(seconds), seconds, ms * 1000, 3900 if lit else 120 + ms % 7])
        edges = photodiode_edges(path)
        self.assertEqual(len(edges), 2)
        self.assertAlmostEqual((edges[0] - ns(10.030)) / 1e6, 0, delta=2)
        clock = HostClock(0.0, 0.0, ns(0), 0.0)
        markers = [event_marker(event(1, "media_onset", 10.2, client=iso(10.0)), clock), event_marker(event(2, "media_offset", 20.1, client=iso(20.0)), clock),
                   event_marker(event(3, "step_start", 5), clock)]
        result = sync_check(markers, edges)
        self.assertEqual(result["summary"]["events"], 2)
        self.assertEqual(result["summary"]["matched"], 2)
        self.assertAlmostEqual(result["rows"][0]["latencyMs"], 30, delta=2)
        self.assertAlmostEqual(result["summary"]["maxAbsLatencyMs"], 30, delta=2)

    def test_photodiode_edges_with_rare_flashes(self):
        path = self.root / "rare.csv"
        rng = np.random.default_rng(1)
        with path.open("w", newline="") as handle:
            writer = csv.writer(handle)
            writer.writerow(["host_epoch_ns", "monotonic_s", "device_t_us", "raw"])
            flashes = [100.0, 400.0, 650.0]
            for ms in range(0, 700_000, 1):
                seconds = ms / 1000
                lit = any(start <= seconds < start + 0.2 for start in flashes)
                writer.writerow([ns(seconds), seconds, ms * 1000, int((3900 if lit else 140) + rng.normal(0, 6))])
        self.assertEqual(len(photodiode_edges(path)), 3)


if __name__ == "__main__":
    unittest.main()
