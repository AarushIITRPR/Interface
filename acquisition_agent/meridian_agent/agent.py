from __future__ import annotations

import argparse
import json
import os
import platform
import shutil
import signal
import socket
import sys
import time
import uuid
from collections import deque
from dataclasses import replace
from pathlib import Path
from datetime import datetime, timezone
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from . import __version__
from .export import HostClock, auxiliary_files, build_bundle, event_marker
from .preview import PreviewServer
from .segments import ProxyOptions
from .sensors import CHECKSUM_PENDING, MAX_CLIPPED_PCT, CameraOptions, CameraSensor, FrontierXEcgSensor, Sensor, SimulatedSensor, UnavailableSensor, discover_device_inventory, discover_serial_assignments, iso_now, make_sensor, restamp_frontierx_csv, sha256_file


DEFAULT_SERVER = "https://meridian-multimodal-lab.aditya11-gupta16709.chatgpt.site"
SENSOR_IDS = ("face","audio","oximeter","csi","emg","gsr","ecg","thermal","photodiode","csi2","resp","environment","face2")
CSI_SENSOR_IDS = ("csi","csi2")
# Free space at which the operator is warned during a recording. It only warns: stopping a running protocol would
# cost the participant's whole session, and the writers fail loudly on their own if the disk actually fills.
LOW_DISK_WARNING_GB = 30.0

# Cameras whose frames feed rPPG, where a drifting exposure is a confound rather than a cosmetic issue.
RPPG_SENSOR_IDS = ("face","face2")


class AgentAlreadyRunning(RuntimeError):
    pass


def acquire_session_lock(root: Path, code: str):
    """Hold an exclusive lock for this session code for the life of the process.

    Twice on 22 September a second agent was started for a session that already had one; the two fought over every
    camera and serial port and both recordings were damaged. The lock is released by the kernel when the process
    exits, however it exits, so a crashed agent never leaves a stale lock behind.
    """
    try:
        import fcntl
    except ImportError:  # Windows: no advisory locks here; the operator console warning has to do
        return None
    root.mkdir(parents=True, exist_ok=True)
    handle = open(root / f".agent_{code}.lock", "a+", encoding="utf-8")
    try:
        fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        handle.seek(0)
        holder = handle.read().strip() or "unknown"
        handle.close()
        raise AgentAlreadyRunning(f"Another acquisition agent is already running for session {code} (PID {holder}). "
                                  "Stop it first; two agents fight over the same cameras and serial ports.")
    handle.seek(0); handle.truncate(); handle.write(str(os.getpid())); handle.flush()
    return handle


def unique_session_dir(root: Path, name: str) -> Path:
    """Create a new, never-reused recording directory, even if the agent restarts within the same second."""
    root.mkdir(parents=True,exist_ok=True)
    for suffix in range(1000):
        candidate = root / (name if suffix == 0 else f"{name}_{suffix+1}")
        try:
            candidate.mkdir(exist_ok=False)
            return candidate
        except FileExistsError:
            continue
    raise RuntimeError(f"Could not create a unique recording directory for {name}")


def find_rig_baseline(root: Path, port: str | None, day: str) -> dict | None:
    """A same-day empty-room CSI baseline recorded outside any session, on the receiver now assigned to CSI.

    A long rig baseline taken in the morning is a better null than the 60 s in-session one, as long as it is from the
    same day and the same radio; anything stalled or degraded is not accepted.
    """
    if not port:
        return None
    for meta in sorted((root / "empty_room_baselines").glob(f"empty_room_{day}_*.json"), reverse=True):
        try:
            info = json.loads(meta.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        csv = meta.with_suffix(".csv")
        if (info.get("kind") == "empty_room_csi_baseline" and int(info.get("rows") or 0) > 0 and not info.get("stalledMinutes")
                and not info.get("nonGoodMinutes") and (info.get("finalReport") or {}).get("quality") == "good" and csv.is_file()
                and info.get("port") and os.path.realpath(str(info["port"])) == os.path.realpath(str(port))):
            return {"file": meta.name, "csv": str(csv), "startedAt": info.get("startedAt"), "durationS": info.get("durationS"),
                    "rows": info.get("rows"), "port": info.get("port")}
    return None


def adopt_rig_baseline(session_dir: Path, baseline: dict) -> None:
    """Put the rig baseline into the session folder once, so the export checksums and ships it like an in-session one."""
    target_dir = session_dir / "csi"
    record = target_dir / "empty_room_rig_baseline.json"
    if record.exists():
        return
    target_dir.mkdir(parents=True, exist_ok=True)
    source = Path(baseline["csv"])
    target = target_dir / source.name
    if not target.exists():
        try:
            os.link(source, target)
        except OSError:
            shutil.copy2(source, target)
    record.write_text(json.dumps({**baseline, "sessionCopy": target.name}, indent=2), encoding="utf-8")


def _parse_server_time(value) -> float:
    return datetime.fromisoformat(str(value).replace("Z","+00:00")).timestamp()


def clock_offset_ms(command: dict, sent_at: float, received_at: float, previous: float) -> float:
    """NTP-style offset: server processing time between receive and reply is excluded from the estimate."""
    try:
        replied = _parse_server_time(command.get("serverTime",""))
        received = _parse_server_time(command["serverReceivedAt"]) if command.get("serverReceivedAt") else replied
    except (ValueError,TypeError):
        return previous
    return round((((received - sent_at) + (replied - received_at)) / 2) * 1000,2)


class ClockEstimator:
    """Server-minus-host offset from the recent exchange with the shortest round trip.

    A single exchange can be delayed on either side (for example while sensor threads hold the interpreter), which
    skews that one estimate; the fastest recent exchange bounds the error most tightly.
    """

    def __init__(self, keep: int = 16):
        self.samples: deque[tuple[float, float]] = deque(maxlen=keep)
        self.offset_ms = 0.0

    def add(self, command: dict, sent_at: float, received_at: float) -> float:
        try:
            replied = _parse_server_time(command.get("serverTime",""))
            received = _parse_server_time(command["serverReceivedAt"]) if command.get("serverReceivedAt") else replied
        except (ValueError,TypeError,KeyError):
            return self.offset_ms
        round_trip = (received_at - sent_at) - (replied - received)
        self.samples.append((round_trip, clock_offset_ms(command,sent_at,received_at,self.offset_ms)))
        self.offset_ms = min(self.samples)[1]
        return self.offset_ms


def write_manifest(session_dir: Path, code: str, recordings: list[dict], checksums: str) -> None:
    """Write manifest.json atomically, so an interrupted write never leaves a truncated file."""
    manifest = {"sessionCode":code,"finalizedAt":iso_now(),"checksums":checksums,"recordings":recordings,"auxiliaryFiles":auxiliary_files(session_dir)}
    path = session_dir / "manifest.json"
    temporary = path.with_name("manifest.json.tmp")
    temporary.write_text(json.dumps(manifest,indent=2),encoding="utf-8")
    os.replace(temporary, path)


def finalize_manifest(session_dir: Path, code: str, recordings: list[dict], hasher=sha256_file) -> list[dict]:
    """Record what was captured first, then spend the minutes checksumming it.

    Hashing a session's video is slow - about 5 minutes for 57 GB on the lab disk - and used to happen before the
    manifest existed, so closing the agent in that window left a session with no manifest at all. Now the manifest is
    on disk, marked pending, before the first byte is hashed.
    """
    write_manifest(session_dir, code, recordings, CHECKSUM_PENDING)
    completed = [
        {**item, "sha256": hasher(session_dir / item["relativePath"])} if item.get("sha256") == CHECKSUM_PENDING else item
        for item in recordings
    ]
    write_manifest(session_dir, code, completed, "complete")
    return completed


class MeridianHttpError(RuntimeError):
    pass


class MeridianAgent:
    def __init__(self, args: argparse.Namespace):
        self.args = args
        self.server = args.server.rstrip("/")
        self.endpoint = f"{self.server}/api/acquisition"
        self.code = args.code.strip().upper()
        self.token = args.token.strip()
        self.host = socket.gethostname()
        self.agent_id = str(uuid.uuid5(uuid.NAMESPACE_DNS,f"meridian:{self.host}:{uuid.getnode()}"))
        self.origin_mono = time.monotonic()
        stamp = time.strftime("%Y%m%d_%H%M%S")
        if getattr(args,"export_to",None):
            self.session_dir = Path(args.export_to).expanduser().resolve()
            if not (self.session_dir / "manifest.json").exists():
                raise RuntimeError(f"No manifest.json in {self.session_dir}")
        else:
            self.session_dir = unique_session_dir(Path(args.output).expanduser().resolve(),f"session_{self.code}_{stamp}")
        self.marker_path = self.session_dir / "session_markers.jsonl"
        self.events_path = self.session_dir / "session_events.jsonl"
        self.last_event_sequence = 0
        self.sensors: list[Sensor] = []
        self.stop_requested = False
        self.last_marker: tuple | None = None
        self.last_low_disk_warning = -1e9
        self.last_command: dict | None = None
        self.inventory: dict[str,list[dict]] = {"video":[],"audio":[],"serial":[]}
        self.device_config: dict[str,str] = {}
        self.config_revision = -1
        self.clock_offset_ms = 0.0
        self.clock = ClockEstimator()
        self.recording_started = False
        self.preview: PreviewServer | None = None
        self.preflight_started_mono = 0.0
        self.preflight_result: dict = {"status":"idle","detail":"Not run","completedAt":None}
        self.calibration: dict | None = None
        self.lsl = None
        if getattr(args,"lsl",False) and not getattr(args,"export_to",None):
            from .lsl import LslBridge
            self.lsl = LslBridge(self.code)

    def request(self, action: str, **content) -> dict:
        payload = {"code":self.code,"token":self.token,"action":action,**content}
        body = json.dumps(payload,separators=(",",":")).encode("utf-8")
        request = Request(self.endpoint,data=body,method="POST",headers={"content-type":"application/json","user-agent":f"meridian-agent/{__version__}"})
        try:
            sent_at = time.time()
            with urlopen(request,timeout=self.args.timeout) as response:
                data = json.loads(response.read().decode("utf-8"))
        except HTTPError as exc:
            try:
                message = json.loads(exc.read().decode("utf-8")).get("error",str(exc))
            except Exception:
                message = str(exc)
            raise MeridianHttpError(message) from exc
        if "command" not in data:
            raise RuntimeError(data.get("error","Meridian returned no command"))
        command = data["command"]
        self.clock_offset_ms = self.clock.add(command,sent_at,time.time())
        return command

    def agent_payload(self) -> dict:
        usage = shutil.disk_usage(self.session_dir)
        free_gb = usage.free / (1024 ** 3)
        self.warn_if_disk_low(free_gb)
        reports = [sensor.report() for sensor in self.sensors]
        recorded = [report for report in reports if report.status == "recording"]
        dropped = sum(report.droppedSamples for report in reports)
        samples = sum(report.sampleCount for report in reports)
        return {
            "id":self.agent_id,
            "host":self.host,
            "platform":f"{platform.system()} {platform.release()}",
            "version":__version__,
            "recordingRoot":str(self.session_dir),
            "inventory":self.inventory,
            "diskFreeGb":round(free_gb,2),
            "lowDisk":free_gb < LOW_DISK_WARNING_GB,
            "estimatedHours":round(free_gb/self.recording_gb_per_hour(),1),
            "clockOffsetMs":self.clock_offset_ms,
            "openFileCount":len(recorded) if self.recording_started else 0,
            "droppedPct":round(100*dropped/max(1,samples+dropped),3),
            "previewUrls":self.preview.urls() if self.preview else {},
            "configRevision":self.config_revision,
            "preflightTest":self.preflight_result,
            "csiCalibration":{key:value for key,value in (self.calibration or {}).items() if key in ("status","rows","detail")} or None,
        }

    def warn_if_disk_low(self, free_gb: float) -> None:
        """Say so in the terminal, at most once a minute, while a recording is running out of disk."""
        if free_gb >= LOW_DISK_WARNING_GB or not self.recording_started:
            return
        now = time.monotonic()
        if now - getattr(self, "last_low_disk_warning", -1e9) < 60:
            return
        self.last_low_disk_warning = now
        minutes = free_gb / max(1.0, self.recording_gb_per_hour()) * 60
        print(f"WARNING: only {free_gb:.1f} GB free on the recording disk, about {minutes:.0f} min of recording left",
              file=sys.stderr, flush=True)

    def recording_gb_per_hour(self) -> float:
        """Disk use of the current configuration: cameras from resolution and codec, plus about 1 GB/h for everything else."""
        cameras = sum(sensor.estimated_gb_per_hour for sensor in self.sensors if isinstance(sensor, CameraSensor))
        return max(1.0, cameras + 1.0)

    def configure(self, requested: dict | None = None, revision: int = 0) -> None:
        defaults = {
            "face":self.args.camera,
            "audio":self.args.audio,
            "oximeter":self.args.oximeter,
            "csi":self.args.csi,
            "emg":self.args.emg,
            "gsr":self.args.gsr,
            "ecg":self.args.ecg,
            "thermal":self.args.thermal,
            "photodiode":self.args.photodiode,
            "csi2":self.args.csi2,
            "resp":self.args.resp,
            "environment":self.args.environment,
            "face2":self.args.camera2,
        }
        values = {sensor_id:("simulate" if self.args.simulate_all else str((requested or {}).get(sensor_id,defaults[sensor_id]))) for sensor_id in SENSOR_IDS}
        bauds = {"csi":self.args.csi_baud,"emg":self.args.emg_baud,"gsr":self.args.gsr_baud,"ecg":self.args.ecg_baud,"photodiode":self.args.photodiode_baud,"csi2":self.args.csi_baud,"resp":self.args.resp_baud,"environment":self.args.environment_baud}
        values,inventory = discover_serial_assignments(values,bauds)
        camera_options = CameraOptions(codec=self.args.video_codec,width=self.args.camera_width,height=self.args.camera_height,fps=self.args.camera_fps,
                                       lock_settings=not self.args.no_camera_lock,thermal_format=self.args.thermal_format,thermal_units=self.args.thermal_units,power_line_hz=self.args.power_line_hz)
        # The face camera can run its own size and rate, e.g. a BCC950 at 640x480/20 fps for flicker-safe raw capture,
        # without dragging the other cameras down with it.
        face_options = replace(camera_options,width=self.args.face_width or camera_options.width,height=self.args.face_height or camera_options.height,fps=self.args.face_fps or camera_options.fps,
                              input_format=self.args.face_input_format,gain=self.args.face_gain,exposure_on_body=self.args.face_exposure_on_body)
        face2_options = replace(camera_options,width=self.args.face2_width or camera_options.width,height=self.args.face2_height or camera_options.height,fps=self.args.face2_fps or camera_options.fps,
                               input_format=self.args.face2_input_format,gain=self.args.face2_gain,exposure_on_body=self.args.face2_exposure_on_body)
        options_for = {"face":face_options,"face2":face2_options}
        self.sensors = [make_sensor(sensor_id,values[sensor_id],bauds.get(sensor_id,115200),self.session_dir,self.origin_mono,options_for.get(sensor_id,camera_options),2 if self.args.audio_channels == "stereo" else 1) for sensor_id in SENSOR_IDS]
        if self.lsl is not None:
            for sensor in self.sensors:
                sensor.sample_listener = self.lsl.push_value
        self.device_config = values
        self.config_revision = revision
        metadata = {
            "sessionCode":self.code,"agentId":self.agent_id,"host":self.host,
            "platform":platform.platform(),"agentVersion":__version__,"startedAt":iso_now(),
            "clock":{"hostEpochNs":time.time_ns(),"monotonicOrigin":self.origin_mono},
            "devices":values,"serialInventory":inventory,"deviceInventory":self.inventory,"bauds":bauds,
        }
        (self.session_dir / "acquisition.json").write_text(json.dumps(metadata,indent=2),encoding="utf-8")

    def start_sensors(self) -> None:
        for sensor in self.sensors:
            sensor.start()

    def reconfigure(self, requested: dict, revision: int) -> None:
        if self.recording_started:
            return
        self.inventory = discover_device_inventory()
        if self.calibration and self.calibration["status"] == "running":
            for sensor in self.calibration["receivers"]:
                sensor.stop_side_capture()
            self.calibration.update(status="failed",detail="Hardware changed during the baseline")
        for sensor in self.sensors:
            sensor.stop()
        self.configure(requested,revision)
        self.preflight_result = {"status":"idle","detail":"Run preflight after changing hardware","completedAt":None}
        self.start_sensors()

    def preview_frame(self, sensor_id: str) -> bytes | None:
        sensor = next((item for item in self.sensors if item.sensor_id == sensor_id),None)
        return sensor.preview_frame() if isinstance(sensor,CameraSensor) else None

    def apply_command(self, command: dict, reports: list[dict] | None = None) -> None:
        requested = command.get("deviceConfig") if isinstance(command.get("deviceConfig"),dict) else {}
        revision = int(command.get("configRevision",0))
        if revision != self.config_revision and command.get("command") != "record":
            self.reconfigure(requested,revision)
        if command.get("command") == "record" and not self.recording_started:
            for sensor in self.sensors:
                sensor.start_recording()
            self.recording_started = True
        self.run_calibration(command)
        if command.get("command") == "test" and self.preflight_result.get("status") != "running":
            self.preflight_started_mono = time.monotonic()
            self.preflight_result = {"status":"running","detail":"Validating streams and local storage","completedAt":None}
        if self.preflight_result.get("status") == "running" and time.monotonic()-self.preflight_started_mono >= 10:
            current_reports = reports or [sensor.report().payload() for sensor in self.sensors]
            required = set(map(str,command.get("requiredSensors") or []))
            failed = [item["id"] for item in current_reports if item["id"] in required and item.get("quality") != "good"]
            # An rPPG camera whose auto exposure is still running is not ready, however cleanly its frames arrive.
            unlocked = [item["id"] for item in current_reports
                        if item["id"] in required and item["id"] in RPPG_SENSOR_IDS
                        and item.get("metrics", {}).get("settingsLocked") is False]
            # A blown-out face has no colour variation left to measure, however steady its exposure.
            overexposed = [f"{item['id']} ({item['metrics']['clippedPct']:.0f}% clipped)" for item in current_reports
                           if item["id"] in required and item["id"] in RPPG_SENSOR_IDS
                           and (item.get("metrics", {}).get("clippedPct") or 0) > MAX_CLIPPED_PCT]
            # Without the empty-room baseline there is no null for any CSI claim, so the session cannot be scored.
            baseline_missing = bool(required & set(CSI_SENSOR_IDS)) and (self.calibration or {}).get("status") != "done"
            rig_baseline = None
            if baseline_missing:
                csi_port = next((getattr(sensor, "port", None) for sensor in self.sensors if sensor.sensor_id == "csi"), None)
                rig_baseline = find_rig_baseline(self.session_dir.parent, csi_port, time.strftime("%Y%m%d"))
                if rig_baseline:
                    adopt_rig_baseline(self.session_dir, rig_baseline)
                    baseline_missing = False
            probe = self.session_dir / "preflight_test.json"
            payload = {"completedAt":iso_now(),"required":sorted(required),"failed":failed,"exposureUnlocked":unlocked,"overexposed":overexposed,
                       "csiEmptyRoomBaseline":f"rig baseline {rig_baseline['file']}" if rig_baseline else (self.calibration or {}).get("status","not recorded"),
                       "csiRigBaseline":rig_baseline,
                       "diskFreeGb":round(shutil.disk_usage(self.session_dir).free/(1024**3),2)}
            probe.write_text(json.dumps(payload,indent=2),encoding="utf-8")
            verified = json.loads(probe.read_text(encoding="utf-8")) == payload
            sync_ok = abs(self.clock_offset_ms) < 100
            # Enough disk for a full session (about 45 minutes) with 50% margin.
            # An operator floor replaces the estimate outright: the estimate is a planning figure, and the operator
            # knows what today's protocol actually costs.
            floor_gb = float(getattr(self.args,"min_free_gb",0) or 0)
            needed_gb = floor_gb if floor_gb > 0 else max(10.0, self.recording_gb_per_hour() * 0.75 * 1.5)
            payload["diskNeededGb"] = round(needed_gb,1)
            if floor_gb > 0:
                payload["diskFloorGb"] = floor_gb
                payload["diskEstimateGb"] = round(max(10.0, self.recording_gb_per_hour() * 0.75 * 1.5),1)
            # The operator can downgrade the exposure gate to a warning when the session must start; it is still
            # recorded here and in the QA report, because a drifting exposure is a confound in the rPPG data.
            if getattr(self.args,"allow_unlocked_exposure",False) and unlocked:
                payload["exposureUnlockedAccepted"] = unlocked
                unlocked = []
            passed = not failed and not unlocked and not overexposed and not baseline_missing and verified and payload["diskFreeGb"] >= needed_gb and sync_ok
            problem = (", ".join(failed) if failed
                       else f"auto exposure still running on {', '.join(unlocked)} (camera body: M mode, fixed ISO and WB, DRO off)" if unlocked
                       else f"overexposed: {', '.join(overexposed)}; lower gain or light" if overexposed
                       else "empty-room CSI baseline not recorded" if baseline_missing
                       else "clock synchronization" if not sync_ok
                       else f"disk space ({payload['diskFreeGb']} GB free, {payload['diskNeededGb']} GB needed)" if payload["diskFreeGb"] < needed_gb
                       else "local storage")
            self.preflight_result = {"status":"pass" if passed else "fail","detail":"All required streams, synchronization, and local storage passed" if passed else "Check: "+problem,"completedAt":payload["completedAt"]}

    def run_calibration(self, command: dict) -> None:
        """Empty-room CSI baseline: while the server asks for it, CSI receivers also write to csi*/empty_room_*.csv."""
        started_at = command.get("calibrationStartedAt")
        if command.get("command") == "calibrate" and started_at and (self.calibration is None or self.calibration["startedAt"] != started_at):
            receivers = [sensor for sensor in self.sensors if sensor.sensor_id in CSI_SENSOR_IDS and not isinstance(sensor, UnavailableSensor)]
            stamp = time.strftime("%Y%m%d_%H%M%S")
            self.calibration = {"startedAt":started_at,"started":time.monotonic(),"seconds":float(command.get("calibrationSec") or 60),"receivers":receivers,"status":"running","rows":0,"detail":"Recording the empty room"}
            if not receivers:
                self.calibration.update(status="failed",detail="No CSI receiver is connected")
                return
            for sensor in receivers:
                header = getattr(sensor,"header",["host_epoch_ns","monotonic_s","sample_count","value"]) if not isinstance(sensor, SimulatedSensor) else ["host_epoch_ns","monotonic_s","sample_count","value"]
                sensor.start_side_capture(f"{sensor.sensor_id}/empty_room_{stamp}.csv",header)
        calibration = self.calibration
        if calibration and calibration["status"] == "running" and time.monotonic() - calibration["started"] >= calibration["seconds"]:
            counts = {sensor.sensor_id: sensor.stop_side_capture() for sensor in calibration["receivers"]}
            rows = sum(counts.values())
            silent = [sensor_id for sensor_id, count in counts.items() if count == 0]
            calibration["rows"] = rows
            calibration["status"] = "done" if rows else "failed"
            calibration["detail"] = (", ".join(f"{sensor_id} {count} packets" for sensor_id, count in counts.items()) + (f"; no packets from {', '.join(silent)}" if silent else "")) if rows else "No CSI packets arrived during the baseline"

    def write_marker(self, command: dict) -> None:
        step = command.get("step") or {}
        marker = (command.get("sessionStatus"),command.get("stepIndex"),step.get("id"),step.get("attempt"),command.get("command"))
        if marker == self.last_marker:
            return
        record = {
            "hostEpochNs":time.time_ns(),"monotonicS":round(time.monotonic()-self.origin_mono,6),
            "receivedAt":iso_now(),"serverTime":command.get("serverTime"),"revision":command.get("revision"),
            "sessionStatus":command.get("sessionStatus"),"command":command.get("command"),
            "stepIndex":command.get("stepIndex"),"step":step,
        }
        with self.marker_path.open("a",encoding="utf-8") as handle:
            handle.write(json.dumps(record,separators=(",",":"))+"\n")
        self.last_marker = marker

    def write_events(self, command: dict) -> None:
        """Append protocol events stamped with when they happened, converted to this computer's clock."""
        fresh = [event for event in command.get("recentEvents") or [] if int(event.get("sequence") or 0) > self.last_event_sequence]
        if not fresh:
            return
        clock = HostClock.now(self.clock_offset_ms,self.origin_mono)
        with self.events_path.open("a",encoding="utf-8") as handle:
            for event in sorted(fresh,key=lambda item: int(item.get("sequence") or 0)):
                marker = event_marker(event,clock)
                handle.write(json.dumps(marker,separators=(",",":"))+"\n")
                if self.lsl is not None:
                    self.lsl.push_event(marker,None if marker["monotonicS"] is None else marker["monotonicS"] + self.origin_mono)
                self.last_event_sequence = int(event.get("sequence") or 0)

    def export_bundle(self, artifacts: list[dict]) -> None:
        data = self.request_export()
        tasks = ProxyOptions(height=max(0,getattr(self.args,"task_proxy_height",480)),crf=getattr(self.args,"task_proxy_crf",20)) \
            if getattr(self.args,"extract_tasks",False) else None
        report = build_bundle(data,self.session_dir,HostClock.now(self.clock_offset_ms,self.origin_mono),artifacts,
                              derive_video=getattr(self.args,"derive_video",False),bids=not getattr(self.args,"no_bids",False),tasks=tasks)
        print(f"Analysis bundle written to {self.session_dir / 'export'} ({report['stepsFlagged']} of {report['stepCount']} step attempts flagged)")
        folders = report.get("taskFolders")
        if folders:
            print(f"Task folders written to {self.session_dir / 'tasks'} ({folders['folders']} steps, {folders['bytes'] / 1e9:.2f} GB)")
            for note in folders["missing"]:
                print(f"  not cut - {note}")

    def request_export(self) -> dict:
        payload = json.dumps({"code":self.code,"token":self.token,"action":"export"},separators=(",",":")).encode("utf-8")
        request = Request(self.endpoint,data=payload,method="POST",headers={"content-type":"application/json","user-agent":f"meridian-agent/{__version__}"})
        sent_at = time.time()
        with urlopen(request,timeout=max(self.args.timeout,30)) as response:
            data = json.loads(response.read().decode("utf-8"))
        if "export" not in data:
            raise RuntimeError(data.get("error","Meridian returned no export"))
        self.clock_offset_ms = self.clock.add(data.get("command") or {},sent_at,time.time())
        return data["export"]

    def export_only(self) -> int:
        manifest = json.loads((self.session_dir / "manifest.json").read_text(encoding="utf-8"))
        recordings = manifest.get("recordings",[])
        if manifest.get("checksums") == CHECKSUM_PENDING:
            # The recording agent was stopped while checksumming; finish the job before exporting.
            print("Manifest checksums were never completed; computing them now")
            recordings = finalize_manifest(self.session_dir, manifest.get("sessionCode", self.code), recordings)
        self.export_bundle(recordings)
        return 0

    def start(self) -> None:
        print(f"Connecting acquisition computer to Meridian session {self.code}")
        command = self.request("poll")
        self.write_marker(command)
        if command.get("command") == "finalize":
            raise RuntimeError("This Meridian session has already ended")
        self.inventory = discover_device_inventory()
        self.configure(command.get("deviceConfig"),int(command.get("configRevision",0)))
        self.start_sensors()
        self.preview = PreviewServer(self.preview_frame,self.token[-16:],self.args.preview_port)
        self.preview.start()
        self.apply_command(command)
        print(f"Monitoring locally in {self.session_dir}")

    def run(self) -> int:
        self.start()
        network_errors = 0
        try:
            while not self.stop_requested:
                reports = [sensor.report().payload() for sensor in self.sensors]
                try:
                    command = self.request("heartbeat",agent=self.agent_payload(),sensors=reports)
                    self.last_command = command
                    self.write_marker(command)
                    self.write_events(command)
                    self.apply_command(command,reports)
                    network_errors = 0
                    healthy = sum(report["status"] == "recording" for report in reports)
                    print(f"\r{healthy}/{len(reports)} sensors recording | step {int(command.get('stepIndex',0))+1} | revision {command.get('revision')}",end="",flush=True)
                    if command.get("command") == "finalize":
                        break
                except (URLError,OSError,ValueError,RuntimeError) as exc:
                    network_errors += 1
                    print(f"\nMeridian heartbeat unavailable ({type(exc).__name__}). Local recording continues.",file=sys.stderr)
                time.sleep(min(self.args.interval,max(1.0,network_errors)))
        except KeyboardInterrupt:
            self.stop_requested = True
        finally:
            print("\nFinalizing local recordings")
            for sensor in self.sensors:
                sensor.stop_recording()
                sensor.stop()
            if self.preview:
                self.preview.stop()
            # Re-stamp ECG against the whole capture's arrival floor before the manifest hashes the file.
            for sensor in self.sensors:
                if isinstance(sensor, FrontierXEcgSensor):
                    restamped = restamp_frontierx_csv(sensor.path)
                    if restamped:
                        print(f"ECG re-stamped from the device clock: transport delay {restamped['offsetSec']}s, arrival jitter {restamped['jitterSec']}s removed")
            pending = [artifact.payload() for sensor in self.sensors if (artifact := sensor.artifact(hash_file=False))]
            artifacts = finalize_manifest(self.session_dir, self.code, pending)
            try:
                command = self.request("finalize",recordings=artifacts)
                self.write_events(command)
                print("Recording manifest synchronized with Meridian")
            except Exception as exc:
                (self.session_dir / "pending_upload.json").write_text(json.dumps({"endpoint":self.endpoint,"payload":{"code":self.code,"action":"finalize","recordings":artifacts}},indent=2),encoding="utf-8")
                print(f"Manifest could not be synchronized: {type(exc).__name__}. Raw files are safe locally.",file=sys.stderr)
            try:
                self.export_bundle(artifacts)
            except Exception as exc:
                print(f"Analysis bundle not written ({type(exc).__name__}: {exc}). Rerun later with --export-to {self.session_dir}",file=sys.stderr)
        return 0


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description="Record synchronized multimodal sensor data for a Meridian session")
    result.add_argument("--server",default=os.environ.get("MERIDIAN_URL",DEFAULT_SERVER))
    result.add_argument("--code",default=os.environ.get("MERIDIAN_SESSION",""),required="MERIDIAN_SESSION" not in os.environ)
    result.add_argument("--token",default=os.environ.get("MERIDIAN_ACQUISITION_TOKEN",""),required="MERIDIAN_ACQUISITION_TOKEN" not in os.environ)
    result.add_argument("--output",default="recordings")
    result.add_argument("--interval",type=float,default=1.0,help="Seconds between heartbeats; also bounds how quickly recording starts after the protocol starts")
    result.add_argument("--timeout",type=float,default=10.0)
    result.add_argument("--camera",default="auto",help="Camera index/path, none, or simulate")
    result.add_argument("--camera2",default="none",help="Second face camera index/path (e.g. a mirrorless camera over USB streaming), or none")
    result.add_argument("--audio",default="auto",help="Audio input index/name, none, or simulate")
    result.add_argument("--audio-channels",choices=("mono","stereo"),default="mono",help="mono averages the input; stereo keeps a two-mic receiver's channels apart")
    result.add_argument("--oximeter",default="auto",help="CMS50E serial port, auto, none, or simulate")
    result.add_argument("--csi",default="auto",help="ESP32 CSI receiver serial port, auto, or none")
    result.add_argument("--csi-baud",type=int,default=921600)
    result.add_argument("--emg",default="auto",help="ESP32 EMG serial port, auto, or none")
    result.add_argument("--emg-baud",type=int,default=921600)
    result.add_argument("--gsr",default="auto",help="ESP32 GSR serial port, auto, or none")
    result.add_argument("--gsr-baud",type=int,default=115200)
    result.add_argument("--ecg",default="none",help="Frontier X live ECG share link/user ID, or a legacy newline serial port")
    result.add_argument("--ecg-baud",type=int,default=115200)
    result.add_argument("--thermal",default="none",help="Thermal camera index/path")
    result.add_argument("--photodiode",default="none",help="Photodiode (screen sync patch) serial port, or none")
    result.add_argument("--photodiode-baud",type=int,default=921600)
    result.add_argument("--video-codec",choices=("ffv1","mjpg"),default="ffv1",help="ffv1 is lossless (recommended for rPPG); mjpg is small but lossy")
    # 720p, not the camera default. Session 0101JUMR left these at 0, negotiated 1920x1080, and lossless FFV1 on
    # 1080p could not keep up: 42.6% of face frames were dropped at the writer queue, leaving 14.34 Hz on disk.
    result.add_argument("--camera-width",type=int,default=1280,help="Requested capture width (0 keeps the camera default)")
    result.add_argument("--camera-height",type=int,default=720,help="Requested capture height (0 keeps the camera default)")
    result.add_argument("--camera-fps",type=float,default=0.0,help="Requested frame rate (0 keeps the camera default)")
    result.add_argument("--face-width",type=int,default=0,help="Face camera capture width only (0 uses --camera-width)")
    result.add_argument("--face-height",type=int,default=0,help="Face camera capture height only (0 uses --camera-height)")
    result.add_argument("--face-fps",type=float,default=0.0,help="Face camera frame rate only (0 uses --camera-fps)")
    result.add_argument("--face-input-format",choices=("","mjpg"),default="",help="Pixel format asked of the face camera; mjpg reaches 720p30 on USB 2 webcams such as the C270 (the file stays lossless)")
    result.add_argument("--face-gain",type=int,default=-1,help="Face camera sensor gain after the exposure lock (-1 leaves the device value)")
    result.add_argument("--face-exposure-on-body",action="store_true",help="Face camera has manual exposure, fixed ISO and fixed WB set on the camera body (e.g. a Sony over USB); verified by a background brightness check")
    result.add_argument("--face2-width",type=int,default=0,help="Face camera 2 capture width only (0 uses --camera-width)")
    result.add_argument("--face2-height",type=int,default=0,help="Face camera 2 capture height only (0 uses --camera-height)")
    result.add_argument("--face2-fps",type=float,default=0.0,help="Face camera 2 frame rate only (0 uses --camera-fps)")
    result.add_argument("--face2-input-format",choices=("","mjpg"),default="",help="Pixel format asked of face camera 2")
    result.add_argument("--face2-gain",type=int,default=-1,help="Face camera 2 sensor gain after the exposure lock (-1 leaves the device value)")
    result.add_argument("--face2-exposure-on-body",action="store_true",help="Face camera 2 has manual exposure, fixed ISO and fixed WB set on the camera body (it exposes no controls over USB); verified by a background brightness check")
    result.add_argument("--power-line-hz",type=int,choices=(0,50,60),default=50,help="Mains frequency of the room lights: sets anti-flicker and snaps locked exposure to whole flicker periods (0 = leave alone)")
    result.add_argument("--no-camera-lock",action="store_true",help="Leave auto exposure and white balance on")
    result.add_argument("--thermal-format",choices=("rgb","y16"),default="rgb",help="y16 records radiometric 16-bit frames (e.g. FLIR Lepton on PureThermal)")
    result.add_argument("--thermal-units",choices=("centikelvin","raw"),default="centikelvin")
    result.add_argument("--csi2",default="none",help="Second ESP32 CSI receiver serial port, or none")
    result.add_argument("--resp",default="none",help="Respiration belt serial port, or none")
    result.add_argument("--resp-baud",type=int,default=115200)
    result.add_argument("--environment",default="none",help="Room environment sensor serial port, or none")
    result.add_argument("--environment-baud",type=int,default=115200)
    result.add_argument("--preview-port",type=int,default=8765,help="Loopback-only camera preview port")
    result.add_argument("--simulate-all",action="store_true",help="Use deterministic simulated streams for integration testing")
    result.add_argument("--export-to",default="",help="Write the analysis bundle for an existing recording directory without recording")
    result.add_argument("--derive-video",action="store_true",help="Also decode face video for a colour trace and offline rPPG heart rate (slow)")
    # On request, not automatically: three cameras over a 32-minute session measured 7.4 minutes, which does not
    # belong at the end of a session with a participant still in the chair.
    result.add_argument("--extract-tasks",action="store_true",help="Also write tasks/: one folder per step with a video proxy and that step's physio rows (slow)")
    result.add_argument("--task-proxy-height",type=int,default=480,help="Proxy video height; 0 keeps the recorded size")
    result.add_argument("--task-proxy-crf",type=int,default=20,help="Proxy video quality, lower is better and larger")
    result.add_argument("--allow-unlocked-exposure",action="store_true",help="Preflight warns instead of failing when a face camera's exposure is not verifiably locked; the session records the exception")
    result.add_argument("--min-free-gb",type=float,default=0.0,help="Free disk preflight requires, in GB; 0 uses the estimate from the camera configuration")
    result.add_argument("--no-bids",action="store_true",help="Skip the BIDS-style copy of the export")
    result.add_argument("--lsl",action="store_true",help="Publish events and live telemetry as Lab Streaming Layer streams (requires pylsl)")
    return result


def main() -> int:
    args = parser().parse_args()
    if args.simulate_all:
        for name in ("camera","audio","oximeter","csi","emg","gsr","ecg","thermal","photodiode","csi2","resp","environment","camera2"):
            setattr(args,name,"simulate")
    if not args.code or not args.token:
        print("Session code and acquisition token are required",file=sys.stderr)
        return 2
    if args.export_to:
        try:
            return MeridianAgent(args).export_only()
        except Exception as exc:
            print(str(exc),file=sys.stderr)
            return 1
    try:
        # One place per machine, not the recording folder: an agent started from another directory must still see it.
        # A fixed path, not gettempdir(): a shell with its own TMPDIR would otherwise look in a different place.
        lock = acquire_session_lock(Path("/tmp/meridian-agent-locks"), args.code.strip().upper())
    except AgentAlreadyRunning as exc:
        print(str(exc),file=sys.stderr)
        return 3
    agent = MeridianAgent(args)
    agent.session_lock = lock
    def request_stop(signum, frame):
        del signum,frame
        agent.stop_requested = True
    signal.signal(signal.SIGTERM,request_stop)
    try:
        return agent.run()
    except MeridianHttpError as exc:
        print(str(exc),file=sys.stderr)
        return 1
    except Exception as exc:
        print(str(exc),file=sys.stderr)
        return 1
