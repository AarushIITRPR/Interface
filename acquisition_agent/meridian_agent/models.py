from __future__ import annotations

from dataclasses import asdict, dataclass, field


@dataclass
class SensorReport:
    id: str
    status: str = "unknown"
    detail: str = "Waiting for device"
    rateHz: float | None = None
    sampleCount: int = 0
    latestValue: str = ""
    device: str = ""
    recordingFile: str = ""
    bytesWritten: int = 0
    latencyMs: float | None = None
    targetRateHz: float | None = None
    hardwareDetected: bool = False
    dataDetected: bool = False
    quality: str = "waiting"
    droppedSamples: int = 0
    dropoutPct: float = 0.0
    metrics: dict = field(default_factory=dict)
    series: list[float] = field(default_factory=list)
    validation: list[str] = field(default_factory=list)

    def payload(self) -> dict:
        return asdict(self)


@dataclass
class RecordingArtifact:
    sensorId: str
    relativePath: str
    format: str
    sampleCount: int
    bytes: int
    sha256: str
    startedAt: str
    endedAt: str
    quality: str
    durationSec: float = 0.0
    averageRateHz: float = 0.0
    droppedSamples: int = 0
    dropoutPct: float = 0.0
    gapCount: int = 0
    totalGapSec: float = 0.0
    longestGapSec: float = 0.0
    availabilityPct: float = 0.0

    def payload(self) -> dict:
        return asdict(self)
