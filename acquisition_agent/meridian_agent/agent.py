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
from pathlib import Path
from datetime import datetime, timezone
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from . import __version__
from .preview import PreviewServer
from .sensors import CameraSensor, Sensor, discover_device_inventory, discover_serial_assignments, iso_now, make_sensor


DEFAULT_SERVER = "https://meridian-multimodal-lab.aditya11-gupta16709.chatgpt.site"
SENSOR_IDS = ("face","audio","oximeter","csi","emg","gsr","ecg","thermal")


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
        self.session_dir = Path(args.output).expanduser().resolve() / f"session_{self.code}_{stamp}"
        self.session_dir.mkdir(parents=True,exist_ok=False)
        self.marker_path = self.session_dir / "session_markers.jsonl"
        self.sensors: list[Sensor] = []
        self.stop_requested = False
        self.last_marker: tuple | None = None
        self.last_command: dict | None = None
        self.inventory: dict[str,list[dict]] = {"video":[],"audio":[],"serial":[]}
        self.device_config: dict[str,str] = {}
        self.config_revision = -1
        self.clock_offset_ms = 0.0
        self.recording_started = False
        self.preview: PreviewServer | None = None
        self.preflight_started_mono = 0.0
        self.preflight_result: dict = {"status":"idle","detail":"Not run","completedAt":None}

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
        try:
            server_time = datetime.fromisoformat(str(command.get("serverTime","")).replace("Z","+00:00")).timestamp()
            self.clock_offset_ms = round((server_time - ((sent_at + time.time()) / 2)) * 1000,2)
        except (ValueError,TypeError):
            pass
        return command

    def agent_payload(self) -> dict:
        usage = shutil.disk_usage(self.session_dir)
        free_gb = usage.free / (1024 ** 3)
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
            "estimatedHours":round(free_gb/18.0,1),
            "clockOffsetMs":self.clock_offset_ms,
            "openFileCount":len(recorded) if self.recording_started else 0,
            "droppedPct":round(100*dropped/max(1,samples+dropped),3),
            "previewUrls":self.preview.urls() if self.preview else {},
            "configRevision":self.config_revision,
            "preflightTest":self.preflight_result,
        }

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
        }
        values = {sensor_id:("simulate" if self.args.simulate_all else str((requested or {}).get(sensor_id,defaults[sensor_id]))) for sensor_id in SENSOR_IDS}
        bauds = {"csi":self.args.csi_baud,"emg":self.args.emg_baud,"gsr":self.args.gsr_baud,"ecg":self.args.ecg_baud}
        values,inventory = discover_serial_assignments(values,bauds)
        self.sensors = [make_sensor(sensor_id,values[sensor_id],bauds.get(sensor_id,115200),self.session_dir,self.origin_mono) for sensor_id in SENSOR_IDS]
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
        if command.get("command") == "test" and self.preflight_result.get("status") != "running":
            self.preflight_started_mono = time.monotonic()
            self.preflight_result = {"status":"running","detail":"Validating streams and local storage","completedAt":None}
        if self.preflight_result.get("status") == "running" and time.monotonic()-self.preflight_started_mono >= 10:
            current_reports = reports or [sensor.report().payload() for sensor in self.sensors]
            required = set(map(str,command.get("requiredSensors") or []))
            failed = [item["id"] for item in current_reports if item["id"] in required and item.get("quality") != "good"]
            probe = self.session_dir / "preflight_test.json"
            payload = {"completedAt":iso_now(),"required":sorted(required),"failed":failed,"diskFreeGb":round(shutil.disk_usage(self.session_dir).free/(1024**3),2)}
            probe.write_text(json.dumps(payload,indent=2),encoding="utf-8")
            verified = json.loads(probe.read_text(encoding="utf-8")) == payload
            sync_ok = abs(self.clock_offset_ms) < 100
            passed = not failed and verified and payload["diskFreeGb"] >= 10 and sync_ok
            problem = ", ".join(failed) if failed else "clock synchronization" if not sync_ok else "local storage"
            self.preflight_result = {"status":"pass" if passed else "fail","detail":"All required streams, synchronization, and local storage passed" if passed else "Check: "+problem,"completedAt":payload["completedAt"]}

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
            artifacts = [artifact.payload() for sensor in self.sensors if (artifact := sensor.artifact())]
            manifest = {"sessionCode":self.code,"finalizedAt":iso_now(),"recordings":artifacts}
            (self.session_dir / "manifest.json").write_text(json.dumps(manifest,indent=2),encoding="utf-8")
            try:
                self.request("finalize",recordings=artifacts)
                print("Recording manifest synchronized with Meridian")
            except Exception as exc:
                (self.session_dir / "pending_upload.json").write_text(json.dumps({"endpoint":self.endpoint,"payload":{"code":self.code,"action":"finalize","recordings":artifacts}},indent=2),encoding="utf-8")
                print(f"Manifest could not be synchronized: {type(exc).__name__}. Raw files are safe locally.",file=sys.stderr)
        return 0


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description="Record synchronized multimodal sensor data for a Meridian session")
    result.add_argument("--server",default=os.environ.get("MERIDIAN_URL",DEFAULT_SERVER))
    result.add_argument("--code",default=os.environ.get("MERIDIAN_SESSION",""),required="MERIDIAN_SESSION" not in os.environ)
    result.add_argument("--token",default=os.environ.get("MERIDIAN_ACQUISITION_TOKEN",""),required="MERIDIAN_ACQUISITION_TOKEN" not in os.environ)
    result.add_argument("--output",default="recordings")
    result.add_argument("--interval",type=float,default=2.0)
    result.add_argument("--timeout",type=float,default=10.0)
    result.add_argument("--camera",default="auto",help="Camera index/path, none, or simulate")
    result.add_argument("--audio",default="auto",help="Audio input index/name, none, or simulate")
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
    result.add_argument("--preview-port",type=int,default=8765,help="Loopback-only camera preview port")
    result.add_argument("--simulate-all",action="store_true",help="Use deterministic simulated streams for integration testing")
    return result


def main() -> int:
    args = parser().parse_args()
    if args.simulate_all:
        for name in ("camera","audio","oximeter","csi","emg","gsr","ecg","thermal"):
            setattr(args,name,"simulate")
    if not args.code or not args.token:
        print("Session code and acquisition token are required",file=sys.stderr)
        return 2
    agent = MeridianAgent(args)
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
