"""Lightweight live rPPG heart-rate estimate for operator feedback (not a reference measurement).

Uses the Plane-Orthogonal-to-Skin method (Wang et al., 2017) on the mean skin colour of a face region, then the
spectral peak between 42 and 180 bpm. It exists so the operator can see, during setup, whether the face video, the
oximeter, and the ECG broadly agree.
"""
from __future__ import annotations

from collections import deque

MIN_BPM = 42.0
MAX_BPM = 180.0
FS = 30.0


def pos_heart_rate(times_s: list[float], bgr_means: list[tuple[float, float, float]], window_s: float = 1.6) -> tuple[float, float] | None:
    """Return (bpm, quality) where quality is the share of in-band spectral power at the peak, or None if too short."""
    import numpy as np

    if len(times_s) < 2 or times_s[-1] - times_s[0] < 6:
        return None
    t = np.asarray(times_s, dtype=float)
    grid = np.arange(t[0], t[-1], 1 / FS)
    if grid.size < int(6 * FS):
        return None
    rgb = np.stack([np.interp(grid, t, [value[2 - channel] for value in bgr_means]) for channel in range(3)])
    length = int(window_s * FS)
    signal = np.zeros(grid.size)
    projection = np.array([[0.0, 1.0, -1.0], [-2.0, 1.0, 1.0]])
    for start in range(0, grid.size - length + 1):
        block = rgb[:, start:start + length]
        mean = block.mean(axis=1, keepdims=True)
        if np.any(mean <= 0):
            continue
        s = projection @ (block / mean)
        std1 = s[1].std()
        h = s[0] + (s[0].std() / std1 if std1 > 0 else 0.0) * s[1]
        signal[start:start + length] += h - h.mean()
    signal -= signal.mean()
    # Zero padding interpolates the spectrum so a 12 s window resolves better than its 5 bpm bin width.
    points = max(8192, signal.size)
    spectrum = np.abs(np.fft.rfft(signal * np.hanning(signal.size), n=points)) ** 2
    freqs = np.fft.rfftfreq(points, 1 / FS)
    band = (freqs >= MIN_BPM / 60) & (freqs <= MAX_BPM / 60)
    if not band.any() or spectrum[band].sum() <= 0:
        return None
    peak = int(np.argmax(np.where(band, spectrum, 0)))
    spread = max(1, int(round((2 / 60) / (freqs[1] - freqs[0]))))  # +-2 bpm around the peak
    neighbourhood = spectrum[max(0, peak - spread):peak + spread + 1].sum()
    return round(float(freqs[peak] * 60), 1), round(float(neighbourhood / spectrum[band].sum()), 3)


class LiveRppg:
    """Tracks a face region and keeps a rolling colour trace; call `update` per frame."""

    def __init__(self, seconds: float = 12.0, detect_every_s: float = 1.0, estimate_every_s: float = 2.0):
        self.samples: deque[tuple[float, tuple[float, float, float]]] = deque()
        self.seconds = seconds
        self.detect_every_s = detect_every_s
        self.estimate_every_s = estimate_every_s
        self.roi: tuple[int, int, int, int] | None = None
        self.last_detect = -1e9
        self.last_estimate = -1e9
        self.last_face = -1e9
        self.estimate: tuple[float, float] | None = None
        self._cascade = None

    def _detect(self, frame, cv2) -> None:
        if self._cascade is None:
            self._cascade = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")
        scale = 320 / max(1, frame.shape[1])
        small = cv2.resize(frame, (320, max(1, round(frame.shape[0] * scale))))
        faces = self._cascade.detectMultiScale(cv2.cvtColor(small, cv2.COLOR_BGR2GRAY), 1.1, 5, minSize=(40, 40))
        if len(faces):
            x, y, w, h = max(faces, key=lambda item: item[2] * item[3])
            # Central face region: skips hair and background, keeps forehead and cheeks.
            self.roi = (int((x + 0.2 * w) / scale), int((y + 0.1 * h) / scale), int((x + 0.8 * w) / scale), int((y + 0.9 * h) / scale))
        else:
            self.roi = None

    def update(self, frame, now: float, cv2) -> dict:
        if now - self.last_detect >= self.detect_every_s:
            self.last_detect = now
            self._detect(frame, cv2)
        if self.roi is not None:
            x0, y0, x1, y1 = self.roi
            patch = frame[y0:y1, x0:x1]
            if patch.size:
                self.last_face = now
                mean = patch.reshape(-1, 3).mean(axis=0)
                self.samples.append((now, (float(mean[0]), float(mean[1]), float(mean[2]))))
        while self.samples and now - self.samples[0][0] > self.seconds:
            self.samples.popleft()
        if now - self.last_estimate >= self.estimate_every_s:
            self.last_estimate = now
            self.estimate = pos_heart_rate([t for t, _ in self.samples], [v for _, v in self.samples]) if now - self.last_face < 2 else None
        metrics: dict = {"faceDetected": now - self.last_face < 2}
        if self.estimate:
            metrics["rppgHeartRate"], metrics["rppgQuality"] = self.estimate
        return metrics
