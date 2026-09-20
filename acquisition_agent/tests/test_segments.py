import csv
import json
import tempfile
import unittest
import wave
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

from meridian_agent.segments import (ProxyOptions, assign_names, folder_name, frame_span, read_frame_stamps, slice_csv_by_window,
                                     slice_wav, task_folders, video_fps)
from meridian_agent.sensors import ffmpeg_available

BASE = datetime(2026, 1, 1, tzinfo=timezone.utc).timestamp()


def ns(seconds: float) -> int:
    return int(BASE) * 1_000_000_000 + round(seconds * 1e9)


def iso(seconds: float) -> str:
    return datetime.fromtimestamp(BASE + seconds, tz=timezone.utc).isoformat(timespec="microseconds").replace("+00:00", "Z")


def window(step_id, start, end, index=0, attempt=1, kind="clip"):
    return {"step_index": index, "step_id": step_id, "attempt": attempt, "type": kind, "label": step_id,
            "phase": "Part 1", "emotion": "", "start_ns": ns(start), "end_ns": ns(end), "pause_ns": 0, "pauses": 0,
            "stimulus_onset_ns": None, "stimulus_load_delay_ms": None, "planned_duration_s": end - start,
            "duration_s": float(end - start), "active_duration_s": float(end - start), "end": "next_step"}


def write_csv(path: Path, header, rows):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(header)
        writer.writerows(rows)


class SliceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def prepare(self, windows):
        for item in windows:
            item["_dir"] = self.root / folder_name(item)
            item["_dir"].mkdir(parents=True, exist_ok=True)
            item["_files"] = []
        return windows

    def test_rows_land_in_the_right_step_and_boundaries_are_half_open(self):
        source = self.root / "ecg.csv"
        write_csv(source, ["host_epoch_ns", "scaled_value"], [[ns(t / 10), t] for t in range(0, 300)])
        windows = self.prepare([window("s00-a", 0, 10), window("s01-b", 10, 20, index=1)])
        counts = slice_csv_by_window(source, windows, "ecg.csv")
        self.assertEqual(counts, {"s00-a": 100, "s01-b": 100})
        first = list(csv.reader((windows[0]["_dir"] / "ecg.csv").open()))
        second = list(csv.reader((windows[1]["_dir"] / "ecg.csv").open()))
        # The sample exactly on the boundary belongs to the later step only, so no sample is counted twice.
        self.assertEqual(first[-1][0], str(ns(9.9)))
        self.assertEqual(second[1][0], str(ns(10.0)))
        self.assertEqual(first[0], ["host_epoch_ns", "scaled_value"])

    def test_columns_are_copied_unchanged(self):
        source = self.root / "csi.csv"
        write_csv(source, ["host_epoch_ns", "rssi", "amplitudes"], [[ns(1), -40, "1.5|2.5"], [ns(2), -41, "3.5|4.5"]])
        windows = self.prepare([window("s00-a", 0, 10)])
        slice_csv_by_window(source, windows, "csi.csv")
        rows = list(csv.reader((windows[0]["_dir"] / "csi.csv").open()))
        self.assertEqual(rows[0], ["host_epoch_ns", "rssi", "amplitudes"])
        self.assertEqual(rows[1][2], "1.5|2.5")

    def test_a_step_with_no_samples_gets_no_file(self):
        source = self.root / "gsr.csv"
        write_csv(source, ["host_epoch_ns", "conductance_us"], [[ns(1), 2.0]])
        windows = self.prepare([window("s00-a", 0, 5), window("s01-quiet", 5, 10, index=1)])
        counts = slice_csv_by_window(source, windows, "gsr.csv")
        self.assertEqual(list(counts), ["s00-a"])
        self.assertFalse((windows[1]["_dir"] / "gsr.csv").exists())

    def test_frame_span_follows_the_timestamps_not_the_clock(self):
        # 25 fps nominal, but every other frame was dropped between 2 s and 4 s: written frame indices skip.
        stamps = [(index, ns(index / 25)) for index in range(0, 50)]
        stamps += [(index, ns(2 + (index - 50) * 2 / 25)) for index in range(50, 75)]
        span = frame_span(stamps, ns(2), ns(4))
        self.assertEqual(span, (50, 25))
        self.assertIsNone(frame_span(stamps, ns(100), ns(101)))

    def test_frame_stamps_are_read_in_index_order(self):
        path = self.root / "face_frames.csv"
        write_csv(path, ["frame_index", "host_epoch_ns", "monotonic_s", "repeated"],
                  [[2, ns(2), 0.2, 0], [0, ns(0), 0.0, 0], [1, ns(1), 0.1, 0], ["x", "y", 0, 0]])
        self.assertEqual(read_frame_stamps(path), [(0, ns(0)), (1, ns(1)), (2, ns(2))])

    def test_audio_slice_keeps_the_window_and_the_format(self):
        source = self.root / "audio.wav"
        rate = 8000
        tone = (np.sin(np.arange(rate * 10) * 0.05) * 16000).astype("<i2")
        with wave.open(str(source), "wb") as handle:
            handle.setnchannels(1)
            handle.setsampwidth(2)
            handle.setframerate(rate)
            handle.writeframes(tone.tobytes())
        target = self.root / "slice.wav"
        written = slice_wav(source, target, ns(0), ns(2), ns(4))
        self.assertEqual(written, 2 * rate)
        with wave.open(str(target), "rb") as handle:
            self.assertEqual(handle.getframerate(), rate)
            self.assertEqual(handle.getnframes(), 2 * rate)
            payload = np.frombuffer(handle.readframes(2 * rate), dtype="<i2")
        np.testing.assert_array_equal(payload, tone[2 * rate:4 * rate])

    def test_a_repeated_step_gets_its_own_folder(self):
        self.assertEqual(folder_name(window("s02-clip-happy", 0, 1)), "s02-clip-happy")
        self.assertEqual(folder_name(window("s02-clip-happy", 0, 1, attempt=2)), "s02-clip-happy-a2")

    def test_a_step_visited_twice_does_not_overwrite_itself(self):
        # What session 0101JUMR does: the operator navigates back afterwards and the same step id opens a second
        # window at the same attempt number. Ten of its steps did this; sharing a folder would lose the first visit.
        windows = [window("s32-sweep", 1493, 1506), window("s33-sweep", 1506, 1525, index=1),
                   window("s32-sweep", 2271, 2292, index=2)]
        assign_names(windows)
        self.assertEqual([folder_name(w) for w in windows], ["s32-sweep", "s33-sweep", "s32-sweep-v2"])
        self.assertEqual(len({folder_name(w) for w in windows}), 3)

    def test_every_window_keeps_its_own_rows_when_a_step_repeats(self):
        source = self.root / "ecg.csv"
        write_csv(source, ["host_epoch_ns", "scaled_value"], [[ns(t / 10), t] for t in range(0, 400)])
        windows = [window("s32-sweep", 0, 10), window("s33-sweep", 10, 20, index=1),
                   window("s32-sweep", 30, 40, index=2)]
        assign_names(windows)
        self.prepare(windows)
        counts = slice_csv_by_window(source, windows, "ecg.csv")
        self.assertEqual(counts, {"s32-sweep": 100, "s33-sweep": 100, "s32-sweep-v2": 100})


class TaskFolderTests(unittest.TestCase):
    """End to end over a small synthetic recording, including a real video cut when ffmpeg is present."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.session = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def build_recording(self, drop_every: int = 0) -> list[dict]:
        write_csv(self.session / "ecg" / "ecg.csv", ["host_epoch_ns", "scaled_value"],
                  [[ns(t / 100), t] for t in range(0, 1000)])
        artifacts = [{"sensorId": "ecg", "relativePath": "ecg/ecg.csv"}]
        if ffmpeg_available():
            import cv2
            from meridian_agent.sensors import FfmpegWriter
            path = self.session / "face" / "face.mkv"
            path.parent.mkdir(parents=True, exist_ok=True)
            writer = FfmpegWriter(str(path), 25.0, (64, 48))
            stamps = []
            written = 0
            for index in range(250):
                if drop_every and index % drop_every == 0:
                    continue
                frame = np.full((48, 64, 3), index % 256, dtype=np.uint8)
                writer.write(frame)
                stamps.append([written, ns(index / 25), index / 25, 0])
                written += 1
            writer.release()
            write_csv(self.session / "face" / "face_frames.csv",
                      ["frame_index", "host_epoch_ns", "monotonic_s", "repeated"], stamps)
            artifacts.append({"sensorId": "face", "relativePath": "face/face.mkv"})
            del cv2
        return artifacts

    def test_every_step_gets_a_folder_with_its_own_rows(self):
        artifacts = self.build_recording()
        windows = [window("s00-rest", 0, 4), window("s01-clip", 4, 8, index=1), window("s02-quiet", 8, 10, index=2)]
        summary = task_folders(self.session, windows, artifacts, ns(0), ProxyOptions(height=0, crf=30))
        self.assertEqual(summary["folders"], 3)
        root = self.session / "tasks"
        self.assertEqual(sorted(p.name for p in root.iterdir() if p.is_dir()), ["s00-rest", "s01-clip", "s02-quiet"])
        rows = list(csv.reader((root / "index.tsv").open(), delimiter="\t"))
        self.assertEqual(rows[0][:3], ["step_index", "folder", "type"])
        self.assertEqual(len(rows), 4)
        for folder, expected in (("s00-rest", 400), ("s01-clip", 400), ("s02-quiet", 200)):
            body = list(csv.reader((root / folder / "ecg.csv").open()))
            self.assertEqual(len(body) - 1, expected, folder)
        metadata = json.loads((root / "s01-clip" / "step.json").read_text())
        self.assertEqual((metadata["stepId"], metadata["onsetS"], metadata["offsetS"]), ("s01-clip", 4.0, 8.0))
        self.assertIn("rPPG", metadata["note"])
        self.assertTrue((root / "README").exists())

    def test_masters_are_left_alone(self):
        artifacts = self.build_recording()
        source = self.session / "ecg" / "ecg.csv"
        before = source.read_bytes()
        task_folders(self.session, [window("s00-rest", 0, 4)], artifacts, ns(0), ProxyOptions(height=0, crf=30))
        self.assertEqual(source.read_bytes(), before)

    @unittest.skipUnless(ffmpeg_available(), "ffmpeg is required to cut video")
    def test_video_is_cut_by_frame_and_survives_dropped_frames(self):
        # Two frames in three were dropped, so wall-clock 4-8 s is NOT video 4-8 s. Cutting by timestamp would be wrong.
        artifacts = self.build_recording(drop_every=3)
        master = self.session / "face" / "face.mkv"
        stamps = read_frame_stamps(master.with_name("face_frames.csv"))
        self.assertLess(len(stamps), 250)
        windows = [window("s00-rest", 0, 4), window("s01-clip", 4, 8, index=1)]
        task_folders(self.session, windows, artifacts, ns(0), ProxyOptions(height=0, crf=30))
        clip = self.session / "tasks" / "s01-clip"
        expected = [row for row in stamps if ns(4) <= row[1] < ns(8)]
        written = list(csv.reader((clip / "face_frames.csv").open()))
        self.assertEqual(len(written) - 1, len(expected))
        self.assertEqual(written[1][1], str(expected[0][1]))
        proxy = clip / "face_proxy.mp4"
        self.assertTrue(proxy.exists())
        import cv2
        capture = cv2.VideoCapture(str(proxy))
        count = int(capture.get(cv2.CAP_PROP_FRAME_COUNT))
        capture.release()
        self.assertEqual(count, len(expected))
        self.assertIsNotNone(video_fps(master))


if __name__ == "__main__":
    unittest.main()
