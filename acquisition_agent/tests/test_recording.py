import csv
import tempfile
import time
import unittest
from pathlib import Path

import numpy as np

from meridian_agent.agent import ClockEstimator, clock_offset_ms, unique_session_dir
from meridian_agent.sensors import FrameRecorder, SimulatedSensor, audio_level_pct


class FakeVideoWriter:
    def __init__(self, path, fps, size):
        self.path = path
        self.fps = fps
        self.size = size
        self.frames = []
        self.released = False

    def write(self, frame):
        self.frames.append(frame)

    def release(self):
        self.released = True


class RecordingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def test_frame_recorder_writes_one_timestamp_per_frame(self):
        writers = []
        def open_writer(path, fps, size):
            writers.append(FakeVideoWriter(path, fps, size))
            return writers[-1]
        (self.root / "face").mkdir()
        origin = time.monotonic()
        recorder = FrameRecorder(self.root / "face" / "face.avi", 30.0, origin, open_writer)
        frame = np.zeros((480, 640, 3), dtype=np.uint8)
        for index in range(5):
            self.assertTrue(recorder.submit(frame, 1_000 + index, origin + index / 30))
        recorder.close()

        self.assertEqual(recorder.error, "")
        self.assertEqual(len(writers), 1)
        self.assertEqual(writers[0].size, (640, 480))
        self.assertEqual(len(writers[0].frames), 5)
        self.assertTrue(writers[0].released)
        with (self.root / "face" / "face_frames.csv").open(newline="") as handle:
            rows = list(csv.reader(handle))
        self.assertEqual(rows[0], ["frame_index", "host_epoch_ns", "monotonic_s", "repeated"])
        self.assertEqual([row[3] for row in rows[1:]], ["0", "1", "1", "1", "1"])
        self.assertEqual([row[0] for row in rows[1:]], ["0", "1", "2", "3", "4"])
        self.assertEqual(rows[-1][1], "1004")

    def test_frame_recorder_counts_frames_it_cannot_queue(self):
        (self.root / "face").mkdir()
        recorder = FrameRecorder(self.root / "face" / "face.avi", 30.0, time.monotonic(), lambda *args: None, max_queue=1)
        recorder.frames.put(("blocked", 0, 0.0))
        self.assertFalse(recorder.submit(object(), 0, 0.0))
        self.assertEqual(recorder.dropped, 1)

    def test_dropped_samples_only_count_while_recording(self):
        sensor = SimulatedSensor("audio", self.root, time.monotonic())
        sensor.record_dropped(480)
        self.assertEqual(sensor.report().droppedSamples, 0)
        sensor.start_recording()
        sensor.record_dropped(480)
        artifact_report = sensor.report()
        self.assertEqual(artifact_report.droppedSamples, 480)
        self.assertEqual(sensor._gap_count, 1)

    def test_artifact_quality_is_judged_when_recording_stops(self):
        sensor = SimulatedSensor("gsr", self.root, time.monotonic())
        sensor.path.parent.mkdir(parents=True, exist_ok=True)
        sensor.path.write_text("host_epoch_ns\n")
        sensor.start_recording()
        sensor.sample("3.1 uS", 10, 1, 20.0, 3.1)
        sensor.stop_recording()
        sensor._last_sample_mono -= 30  # finalization took long after the stream stopped
        self.assertEqual(sensor.artifact().quality, "pass")  # before the fix, the 30 s gap made this "fail"

    def test_audio_level(self):
        self.assertEqual(audio_level_pct(b""), 0.0)
        self.assertEqual(audio_level_pct(np.zeros(480, dtype=np.int16).tobytes()), 0.0)
        loud = np.full(480, 16384, dtype=np.int16).tobytes()
        self.assertEqual(audio_level_pct(loud), 100.0)
        quiet = np.full(480, 1365, dtype=np.int16).tobytes()
        self.assertAlmostEqual(audio_level_pct(quiet), 10.0, delta=0.1)

    def test_unique_session_dir_never_reuses_a_directory(self):
        first = unique_session_dir(self.root, "session_0001ABCD_20260101_000000")
        second = unique_session_dir(self.root, "session_0001ABCD_20260101_000000")
        self.assertNotEqual(first, second)
        self.assertTrue(first.is_dir() and second.is_dir())
        self.assertEqual(second.name, "session_0001ABCD_20260101_000000_2")

    def test_clock_offset_excludes_server_processing_time(self):
        command = {"serverReceivedAt": "2026-01-01T00:00:00.050Z", "serverTime": "2026-01-01T00:00:00.450Z"}
        sent = _epoch("2026-01-01T00:00:00.000Z")
        received = _epoch("2026-01-01T00:00:00.500Z")
        self.assertAlmostEqual(clock_offset_ms(command, sent, received, 0.0), 0.0, delta=0.5)
        skewed = clock_offset_ms(command, sent - 2.0, received - 2.0, 0.0)
        self.assertAlmostEqual(skewed, 2000.0, delta=0.5)
        self.assertEqual(clock_offset_ms({"serverTime": "not a time"}, sent, received, 12.5), 12.5)

    def test_clock_estimator_prefers_fastest_exchange(self):
        estimator = ClockEstimator()
        stamps = {"serverReceivedAt": "2026-01-01T00:00:00.050Z", "serverTime": "2026-01-01T00:00:00.060Z"}
        sent = _epoch("2026-01-01T00:00:00.040Z")
        self.assertAlmostEqual(estimator.add(stamps, sent, _epoch("2026-01-01T00:00:00.070Z")), 0.0, delta=0.5)
        # A delayed reply (host busy for 400 ms before reading it) would alone suggest a -200 ms offset.
        delayed = estimator.add(stamps, sent, _epoch("2026-01-01T00:00:00.470Z"))
        self.assertAlmostEqual(delayed, 0.0, delta=0.5)
        self.assertAlmostEqual(clock_offset_ms(stamps, sent, _epoch("2026-01-01T00:00:00.470Z"), 0.0), -200.0, delta=0.5)


def _epoch(value):
    from datetime import datetime
    return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()


if __name__ == "__main__":
    unittest.main()
