import json
import sys
import tempfile
import time
import types
import unittest
from pathlib import Path
from unittest.mock import patch

from meridian_agent.sensors import (
    CsiSensor,
    EmgSensor,
    FrontierXEcgSensor,
    GsrSensor,
    OximeterSensor,
    SimulatedSensor,
    _probe_serial_protocol,
    discover_serial_assignments,
    frontierx_subscribe_payload,
    parse_frontierx_source,
)


class ParserTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def test_cms50e_v7_packet(self):
        packet = bytes([0x01,0x82,0x85,0xA1,0x83,72,98,0x80,0x80])
        parsed = OximeterSensor.parse_packet(packet)
        self.assertIsNotNone(parsed)
        self.assertEqual(parsed["heart_rate"],72)
        self.assertEqual(parsed["spo2"],98)
        self.assertEqual(parsed["ppg"],33)

    def test_emg_line(self):
        sensor = EmgSensor("emg","COM6",921600,self.root,0)
        self.assertEqual(sensor.parse("123456,77,2048"),([123456,77,2048],"Raw 2048"))
        self.assertIsNone(sensor.parse("# emg1 v=1 fs=1000"))

    def test_csi_line(self):
        sensor = CsiSensor("csi","COM5",921600,self.root,0)
        parsed = sensor.parse("1000,42,-47,0,0,0,12,13,14,15")
        self.assertIsNotNone(parsed)
        self.assertEqual(parsed[0][2],-47.0)
        self.assertEqual(parsed[1],"RSSI -47 dBm")

    def test_csi_amplitudes_from_iq_and_amplitude_lines(self):
        from meridian_agent.derivatives import csi_amplitudes
        self.assertEqual(csi_amplitudes("218034440,29793,-38,-94,3,3,4,0,0,-6,8"),[5.0,0.0,10.0])
        self.assertEqual(csi_amplitudes("CSI_DATA,1000,42,-47,11,-92,6,1.5,-2.5,3"),[1.5,2.5,3.0])

    def test_second_face_camera_uses_lossless_recorder(self):
        from meridian_agent.sensors import CameraSensor, make_sensor
        sensor = make_sensor("face2","/dev/v4l/by-id/usb-Sony_ILCE-6700-video-index0",115200,self.root,0)
        self.assertIsInstance(sensor,CameraSensor)
        self.assertEqual(sensor.path.relative_to(self.root).as_posix(),"face2/face2.mkv")

    def test_stereo_downmix_keeps_one_sided_microphone(self):
        import numpy as np
        from meridian_agent.sensors import downmix_int16
        stereo = np.array([[0,1000],[0,-2000],[10,32767],[-32768,-32768]],dtype=np.int16).tobytes()
        mono = np.frombuffer(downmix_int16(stereo,2),dtype=np.int16).tolist()
        self.assertEqual(mono,[500,-1000,16388,-32768])
        self.assertEqual(downmix_int16(b"\x01\x02",1),b"\x01\x02")

    def test_gsr_json(self):
        sensor = GsrSensor("gsr","COM7",115200,self.root,0)
        parsed = sensor.parse('{"uS":2.34,"raw":1856,"stress":42,"zScore":0.87}')
        self.assertEqual(parsed,([2.34,1856,42.0,0.87],"2.34 uS"))

    def test_auto_detect_assigns_serial_ports_by_protocol(self):
        requested = {"oximeter":"auto","emg":"none","gsr":"auto","csi":"none"}
        original_ports = [
            types.SimpleNamespace(device="COM3",description="CP210x",vid=0x10C4,pid=0xEA60,serial_number="OXI"),
            types.SimpleNamespace(device="COM6",description="CP210x",vid=0x10C4,pid=0xEA60,serial_number="GSR"),
        ]
        detected = {("COM3","oximeter"), ("COM6","gsr")}
        for ports in (original_ports,list(reversed(original_ports))):
            with self.subTest(order=[port.device for port in ports]), patch(
                "serial.tools.list_ports.comports",return_value=ports
            ), patch(
                "meridian_agent.sensors._probe_serial_protocol",
                side_effect=lambda serial_module,port,baud,sensor_id: (port,sensor_id) in detected,
            ):
                assigned,_ = discover_serial_assignments(
                    requested,{"emg":921600,"gsr":115200,"csi":921600}
                )
            self.assertEqual(assigned["oximeter"],"COM3")
            self.assertEqual(assigned["gsr"],"COM6")
            self.assertEqual(len({assigned["oximeter"],assigned["gsr"]}),2)

    def test_auto_detect_never_steals_an_explicit_port(self):
        requested = {"oximeter":"auto","emg":"none","gsr":"COM6","csi":"none"}
        ports = [types.SimpleNamespace(device="COM6",description="CP210x",vid=0x10C4,pid=0xEA60,serial_number="GSR")]
        with patch("serial.tools.list_ports.comports",return_value=ports), patch(
            "meridian_agent.sensors._probe_serial_protocol",return_value=True
        ) as probe:
            assigned,_ = discover_serial_assignments(requested,{"gsr":115200})
        self.assertEqual(assigned["gsr"],"COM6")
        self.assertEqual(assigned["oximeter"],"")
        probe.assert_not_called()

    def test_missing_or_failed_port_enumeration_leaves_auto_unassigned(self):
        requested = {"oximeter":"auto","emg":"auto","gsr":"auto","csi":"auto"}
        with patch("serial.tools.list_ports.comports",side_effect=OSError("device manager unavailable")):
            assigned,inventory = discover_serial_assignments(requested,{})
        self.assertEqual(inventory,[])
        self.assertTrue(all(assigned[sensor_id] == "" for sensor_id in requested))

    def test_oximeter_probe_requires_a_valid_packet(self):
        class FakePort:
            def __init__(self, chunks):
                self.chunks = list(chunks)
                self.writes = []

            def reset_input_buffer(self):
                pass

            def write(self, value):
                self.writes.append(value)

            def flush(self):
                pass

            def read(self, size):
                return self.chunks.pop(0) if self.chunks else b""

            def readline(self):
                return b""

            def close(self):
                pass

        packet = bytes([0x01,0x82,0x85,0xA1,0x83,72,98,0x80,0x80])
        port = FakePort([packet,packet])
        serial_module = types.SimpleNamespace(Serial=lambda *args,**kwargs: port)
        self.assertTrue(_probe_serial_protocol(serial_module,"COM3",115200,"oximeter"))
        self.assertEqual(port.writes[0],OximeterSensor.START)
        self.assertEqual(port.writes[-1],OximeterSensor.STOP)

    def test_one_accidental_oximeter_like_packet_is_not_enough(self):
        packet = bytes([0x01,0x82,0x85,0xA1,0x83,72,98,0x80,0x80])

        class OnePacketPort:
            def __init__(self):
                self.reads = 0
            def reset_input_buffer(self): pass
            def write(self,value): pass
            def flush(self): pass
            def close(self): pass
            def read(self,size):
                self.reads += 1
                if self.reads == 1:
                    return packet
                raise OSError("stream ended")

        serial_module = types.SimpleNamespace(Serial=lambda *args,**kwargs: OnePacketPort())
        self.assertFalse(_probe_serial_protocol(serial_module,"COM8",115200,"oximeter"))

    def test_busy_serial_port_is_not_auto_assigned(self):
        serial_module = types.SimpleNamespace(Serial=lambda *args,**kwargs: (_ for _ in ()).throw(PermissionError("busy")))
        self.assertFalse(_probe_serial_protocol(serial_module,"COM9",115200,"gsr"))

    def test_frontierx_source_and_subscription(self):
        self.assertEqual(
            parse_frontierx_source("https://liveecg.frontierxapp.com/6005748/Hans"),
            ("6005748","frontierxapp.com"),
        )
        self.assertEqual(parse_frontierx_source("6005748"),("6005748","frontierxapp.com"))
        payload = frontierx_subscribe_payload("6005748",3)
        self.assertIn('"userid":"6005748"',payload)
        self.assertIn('"server":"server3"',payload)
        with self.assertRaises(ValueError):
            parse_frontierx_source("https://example.com/6005748")

    def test_frontierx_packet_deduplication_and_gap_counting(self):
        sensor = FrontierXEcgSensor("6005748",self.root,time.monotonic())
        sensor.start_recording()
        packet = {"packetNo":10,"Timestamp":1_700_000_000_000,"data":[100] * 125,"heartrate":72}
        accepted = sensor.accept_packet(packet)
        self.assertIsNotNone(accepted)
        self.assertEqual(accepted["heartRate"],72)
        self.assertIsNone(sensor.accept_packet(packet))
        self.assertEqual(sensor.duplicate_packets,1)
        next_packet = {**packet,"packetNo":12}
        self.assertIsNotNone(sensor.accept_packet(next_packet))
        self.assertEqual(sensor.missed_packets,1)
        self.assertEqual(sensor._dropped_samples,125)

    def test_frontierx_stream_writes_recording_and_live_telemetry(self):
        class SocketTimeout(Exception):
            pass

        class FakeSocket:
            def __init__(self):
                self.messages = [json.dumps({"packetNo":0,"Timestamp":1_700_000_000_000,"data":list(range(125)),"heartrate":71})]
                self.subscription = ""

            def settimeout(self, timeout):
                self.timeout = timeout

            def send(self, payload):
                self.subscription = payload

            def recv(self):
                if self.messages:
                    return self.messages.pop(0)
                raise SocketTimeout()

            def close(self):
                pass

        fake_socket = FakeSocket()
        websocket_module = types.SimpleNamespace(
            WebSocketTimeoutException=SocketTimeout,
            create_connection=lambda *args,**kwargs: fake_socket,
        )
        sensor = FrontierXEcgSensor("6005748",self.root,time.monotonic())
        sensor.start_recording()
        with patch.dict(sys.modules,{"websocket":websocket_module}):
            sensor.start()
            deadline = time.monotonic() + 1
            while sensor.report().sampleCount < 125 and time.monotonic() < deadline:
                time.sleep(0.01)
            sensor.stop_recording()
            sensor.stop()
        report = sensor.report()
        self.assertEqual(report.sampleCount,125)
        self.assertEqual(report.rateHz,125.0)
        self.assertEqual(report.metrics["heartRate"],71)
        self.assertEqual(len(report.series),125)
        self.assertEqual(len(sensor.path.read_text(encoding="utf-8").splitlines()),126)
        self.assertEqual(len(sensor.raw_path.read_text(encoding="utf-8").splitlines()),1)
        self.assertIn('"userid":"6005748"',fake_socket.subscription)

    def test_probe_and_recording_states_are_distinct(self):
        sensor = SimulatedSensor("oximeter",self.root,time.monotonic())
        sensor.start()
        time.sleep(0.2)
        probe = sensor.report()
        self.assertEqual(probe.status,"connected")
        self.assertTrue(probe.dataDetected)
        sensor.start_recording()
        time.sleep(0.2)
        recording = sensor.report()
        self.assertEqual(recording.status,"recording")
        sensor.stop_recording()
        sensor.stop()
        artifact = sensor.artifact()
        self.assertIsNotNone(artifact)
        self.assertGreater(artifact.sampleCount,0)


if __name__ == "__main__":
    unittest.main()
