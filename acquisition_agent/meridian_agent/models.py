from __future__ import annotations

from dataclasses import asdict, dataclass


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

    def payload(self) -> dict:
        return asdict(self)

