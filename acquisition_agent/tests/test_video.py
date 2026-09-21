import json
import tempfile
import time
import unittest
from pathlib import Path

import cv2
import numpy as np

from meridian_agent.rppg import LiveRppg, pos_heart_rate
from meridian_agent.sensors import FfmpegWriter, FrameRecorder, VIDEO_CODECS, Y16Writer, background_luma, ffmpeg_available, flicker_safe_exposure, luma_steadiness, gb_per_hour, lock_camera_settings, to_y16


class FakeCapture:
    """Mimics a V4L2 camera where auto settings can (or cannot) be switched off."""

    def __init__(self, obeys: bool):
        self.obeys = obeys
        self.values = {cv2.CAP_PROP_EXPOSURE: 156.0, cv2.CAP_PROP_GAIN: 12.0, cv2.CAP_PROP_WB_TEMPERATURE: 4600.0, cv2.CAP_PROP_AUTO_EXPOSURE: 3.0, cv2.CAP_PROP_AUTO_WB: 1.0}
        self.calls = []

    def get(self, prop):
        return self.values.get(prop, 0.0)

    def set(self, prop, value):
        self.calls.append((prop, value))
        if self.obeys:
            self.values[prop] = value
        return self.obeys


class VideoTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def test_ffv1_recording_is_lossless(self):
        fourcc, extension, _ = VIDEO_CODECS["ffv1"]
        path = self.root / f"face{extension}"
        def open_writer(p, fps, size):
            writer = cv2.VideoWriter(p, cv2.VideoWriter_fourcc(*fourcc), fps, size)
            return writer if writer.isOpened() else None
        rng = np.random.default_rng(1)
        frames = [rng.integers(0, 256, (120, 160, 3), dtype=np.uint8) for _ in range(12)]
        recorder = FrameRecorder(path, 30.0, time.monotonic(), open_writer)
        for index, frame in enumerate(frames):
            recorder.submit(frame, index, time.monotonic())
        recorder.close()
        self.assertEqual(recorder.error, "")
        capture = cv2.VideoCapture(str(path))
        decoded = []
        while True:
            ok, frame = capture.read()
            if not ok:
                break
            decoded.append(frame)
        self.assertEqual(len(decoded), len(frames))
        for original, frame in zip(frames, decoded):
            self.assertTrue(np.array_equal(original, frame))

    def test_camera_lock_reports_success_and_failure(self):
        good = FakeCapture(obeys=True)
        result = lock_camera_settings(good, cv2, "Linux")
        self.assertTrue(result["locked"])
        self.assertEqual(good.values[cv2.CAP_PROP_AUTO_EXPOSURE], 1.0)
        self.assertEqual(good.values[cv2.CAP_PROP_EXPOSURE], 156.0)
        self.assertEqual(result["settled"]["wbTemperature"], 4600.0)
        windows = lock_camera_settings(FakeCapture(obeys=True), cv2, "Windows")
        self.assertEqual(windows["autoExposure"], 0.25)
        stubborn = lock_camera_settings(FakeCapture(obeys=False), cv2, "Linux")
        self.assertFalse(stubborn["locked"])

    def test_y16_frames_round_trip_with_metadata(self):
        width, height = 160, 120
        frames = [np.full((height, width), 30715 + i, dtype=np.uint16) for i in range(3)]  # about 34 C in centikelvin
        writer = Y16Writer(str(self.root / "thermal_y16.raw"), 9.0, (width, height), "centikelvin")
        for frame in frames:
            writer.write(frame)
        writer.release()
        meta = json.loads((self.root / "thermal_y16.json").read_text())
        self.assertEqual((meta["width"], meta["height"], meta["units"]), (160, 120, "centikelvin"))
        data = np.fromfile(self.root / "thermal_y16.raw", dtype="<u2").reshape(-1, height, width)
        self.assertEqual(data.shape[0], 3)
        self.assertTrue(np.array_equal(data[2], frames[2]))
        self.assertAlmostEqual(float(data[0, 0, 0]) / 100 - 273.15, 34.0, places=2)

    def test_to_y16_accepts_opencv_buffers(self):
        frame = np.arange(4 * 3, dtype=np.uint16).reshape(3, 4)
        self.assertIs(to_y16(frame, 4, 3), frame)
        flat = frame.astype("<u2").tobytes()
        converted = to_y16(np.frombuffer(flat, dtype=np.uint8).reshape(1, -1), 4, 3)
        self.assertTrue(np.array_equal(converted, frame))
        with self.assertRaises(ValueError):
            to_y16(np.zeros((2, 2, 3), dtype=np.uint8), 4, 3)

    def test_disk_estimate(self):
        self.assertAlmostEqual(gb_per_hour(1280, 720, 30, 3, 0.5), 149.3, delta=0.1)
        self.assertAlmostEqual(gb_per_hour(160, 120, 9, 2, 1.0), 1.24, delta=0.01)

    def test_pos_heart_rate_recovers_pulse_frequency(self):
        rng = np.random.default_rng(3)
        times = [i / 30 for i in range(12 * 30)]
        for bpm in (50, 75, 120, 165):
            f = bpm / 60
            trace = [(100 + 0.3 * np.sin(2 * np.pi * f * t) + rng.normal(0, 0.1), 120 + 0.8 * np.sin(2 * np.pi * f * t) + 0.5 * np.sin(2 * np.pi * 0.2 * t) + rng.normal(0, 0.1), 160 + 0.2 * np.sin(2 * np.pi * f * t) + rng.normal(0, 0.1)) for t in times]
            estimate, quality, _, _ = pos_heart_rate(times, trace)
            self.assertAlmostEqual(estimate, bpm, delta=2)
            self.assertGreater(quality, 0.3)
        _, noise_quality, _, _ = pos_heart_rate(times, [(100 + rng.normal(0, 0.3), 120 + rng.normal(0, 0.3), 160 + rng.normal(0, 0.3)) for _ in times])
        self.assertLess(noise_quality, 0.3)
        self.assertIsNone(pos_heart_rate(times[:60], [(1.0, 1.0, 1.0)] * 60))

    def test_pos_heart_rate_reports_the_half_rate_candidate(self):
        """A trace with power at both f and 2f must expose f as a candidate, not silently pick the harmonic."""
        rng = np.random.default_rng(7)
        times = [i / 30 for i in range(12 * 30)]
        f = 55 / 60
        trace = [(100 + 0.1 * np.sin(2 * np.pi * f * t) + 0.3 * np.sin(2 * np.pi * 2 * f * t) + rng.normal(0, 0.05),
                  120 + 0.3 * np.sin(2 * np.pi * f * t) + 0.8 * np.sin(2 * np.pi * 2 * f * t) + rng.normal(0, 0.05),
                  160 + 0.05 * np.sin(2 * np.pi * f * t) + 0.2 * np.sin(2 * np.pi * 2 * f * t) + rng.normal(0, 0.05)) for t in times]
        estimate, _, half, half_quality = pos_heart_rate(times, trace)
        self.assertAlmostEqual(estimate, 110, delta=3)
        self.assertAlmostEqual(half, 55, delta=3)
        self.assertGreater(half_quality, 0.0)

    def test_live_rppg_reports_no_face_on_blank_frames(self):
        live = LiveRppg()
        metrics = live.update(np.zeros((240, 320, 3), dtype=np.uint8), 0.0, cv2)
        self.assertEqual(metrics, {"faceDetected": False})


if __name__ == "__main__":
    unittest.main()


@unittest.skipUnless(ffmpeg_available(), "ffmpeg is not installed")
class FfmpegWriterTests(unittest.TestCase):
    def test_frames_come_back_bit_for_bit_and_the_log_is_cleaned_up(self):
        rng = np.random.default_rng(1)
        frames = [rng.integers(0, 256, (48, 64, 3), dtype=np.uint8) for _ in range(5)]
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "face.mkv"
            writer = FfmpegWriter(str(path), 25.0, (64, 48))
            for frame in frames:
                writer.write(frame)
            writer.release()
            self.assertFalse((Path(tmp) / "face.ffmpeg.log").exists(), "a clean run leaves no log behind")
            capture = cv2.VideoCapture(str(path))
            decoded = []
            while True:
                ok, frame = capture.read()
                if not ok:
                    break
                decoded.append(frame)
            self.assertEqual(len(decoded), 5)
            for original, back in zip(frames, decoded):
                np.testing.assert_array_equal(original, back)

    def test_a_frame_of_the_wrong_size_is_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            writer = FfmpegWriter(str(Path(tmp) / "face.mkv"), 25.0, (64, 48))
            with self.assertRaises(ValueError):
                writer.write(np.zeros((48, 32, 3), dtype=np.uint8))
            writer.release()

    def test_a_recorder_keeps_the_writer_error_instead_of_raising(self):
        class Broken:
            def write(self, frame):
                raise BrokenPipeError("encoder went away")
            def release(self):
                raise RuntimeError("ffmpeg exited with code 1")
        with tempfile.TemporaryDirectory() as tmp:
            recorder = FrameRecorder(Path(tmp) / "face.mkv", 25.0, time.monotonic(), lambda *args: Broken())
            recorder.submit(np.zeros((4, 4, 3), dtype=np.uint8), time.time_ns(), time.monotonic())
            recorder.close()
            self.assertIn("encoder went away", recorder.error)


class FlickerSafeExposureTest(unittest.TestCase):
    def test_snaps_to_whole_flicker_periods_at_50_hz(self):
        self.assertEqual(flicker_safe_exposure(136, 50, 20), 100)
        self.assertEqual(flicker_safe_exposure(160, 50, 20), 200)

    def test_never_shorter_than_one_period(self):
        self.assertEqual(flicker_safe_exposure(30, 50, 20), 100)

    def test_never_longer_than_the_frame_period(self):
        self.assertEqual(flicker_safe_exposure(1500, 50, 20), 500)
        self.assertEqual(flicker_safe_exposure(1500, 50, 30), 300)

    def test_60_hz_uses_8_33_ms_periods(self):
        self.assertEqual(flicker_safe_exposure(136, 60, 30), 167)
        self.assertEqual(flicker_safe_exposure(70, 60, 30), 83)


class BodyExposureCheckTest(unittest.TestCase):
    def test_background_patch_ignores_the_centre(self):
        frame = np.full((480, 640, 3), 40, np.uint8)
        frame[200:300, 250:400] = 250  # a bright face in the middle
        self.assertEqual(background_luma(frame), 40.0)

    def test_steady_background_verifies(self):
        rng = np.random.default_rng(0)
        self.assertTrue(luma_steadiness(list(80 + rng.normal(0, 0.3, 250)))["verified"])

    def test_auto_exposure_step_fails(self):
        result = luma_steadiness([80.0] * 120 + [92.0] * 130)
        self.assertFalse(result["verified"])
        self.assertEqual(result["backgroundLumaRange"], 12.0)
