"""Optional Lab Streaming Layer output (`--lsl`, requires `pip install pylsl`).

Publishes one irregular string marker stream with every protocol event and one numeric stream per sensor with its
live telemetry value, so LabRecorder or other LSL tools can capture Meridian alongside their own devices. Timestamps
are the agent's monotonic clock, which is the same steady clock liblsl uses for `local_clock()`.
"""
from __future__ import annotations

import json
import threading


class LslBridge:
    def __init__(self, session_code: str, module=None):
        if module is None:
            import pylsl as module  # noqa: N813 - optional dependency
        self.lsl = module
        self.session_code = session_code
        self._lock = threading.Lock()
        info = module.StreamInfo(f"Meridian-{session_code}-markers", "Markers", 1, module.IRREGULAR_RATE, "string", f"meridian-{session_code}-markers")
        self.markers = module.StreamOutlet(info)
        self.outlets: dict[str, object] = {}

    def push_event(self, marker: dict, monotonic_s: float | None) -> None:
        payload = json.dumps({key: marker.get(key) for key in ("eventType", "stepId", "stepIndex", "attempt", "source", "label", "sequence")}, separators=(",", ":"))
        with self._lock:
            if monotonic_s is None:
                self.markers.push_sample([payload])
            else:
                self.markers.push_sample([payload], monotonic_s)

    def push_value(self, sensor_id: str, rate_hz: float | None, value: float, monotonic_s: float) -> None:
        with self._lock:
            outlet = self.outlets.get(sensor_id)
            if outlet is None:
                info = self.lsl.StreamInfo(f"Meridian-{self.session_code}-{sensor_id}", "Telemetry", 1, float(rate_hz or self.lsl.IRREGULAR_RATE), "float32", f"meridian-{self.session_code}-{sensor_id}")
                outlet = self.lsl.StreamOutlet(info)
                self.outlets[sensor_id] = outlet
            outlet.push_sample([float(value)], monotonic_s)
