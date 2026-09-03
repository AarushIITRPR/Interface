import itertools
import types
import unittest
from unittest.mock import patch

from meridian_agent.sensors import _probe_serial_protocol, discover_serial_assignments


class LinePort:
    def __init__(self, lines):
        self.lines = [line.encode("utf-8") for line in lines]

    def reset_input_buffer(self): pass
    def write(self, value): pass
    def flush(self): pass
    def close(self): pass
    def read(self, size): return b""

    def readline(self):
        if self.lines:
            return self.lines.pop(0)
        raise OSError("test stream complete")


class BinaryPort:
    def __init__(self, chunks):
        self.chunks = list(chunks)

    def reset_input_buffer(self): pass
    def write(self, value): pass
    def flush(self): pass
    def close(self): pass
    def readline(self): return b""

    def read(self, size):
        if self.chunks:
            return self.chunks.pop(0)
        raise OSError("test stream complete")


def serial_module(port):
    return types.SimpleNamespace(Serial=lambda *args,**kwargs: port)


class SerialProtocolProbeTests(unittest.TestCase):
    def test_gsr_requires_two_structurally_valid_samples(self):
        valid = LinePort([
            '{"uS":12.4,"raw":1820,"stress":10,"zScore":0.1}\n',
            '{"uS":12.5,"raw":1822,"stress":11,"zScore":0.2}\n',
        ])
        self.assertTrue(_probe_serial_protocol(serial_module(valid),"COM1",115200,"gsr"))

        malformed = LinePort([
            '{"uS":"not-a-number","raw":1820}\n',
            '{"raw":1822}\n',
        ])
        self.assertFalse(_probe_serial_protocol(serial_module(malformed),"COM1",115200,"gsr"))

    def test_emg_requires_repeated_monotonic_packets(self):
        valid = LinePort(["1000,7,2048\n","2000,8,2050\n"])
        self.assertTrue(_probe_serial_protocol(serial_module(valid),"COM2",921600,"emg"))

        decreasing = LinePort(["1000,8,2048\n","2000,7,2050\n"])
        self.assertFalse(_probe_serial_protocol(serial_module(decreasing),"COM2",921600,"emg"))

    def test_emg_identity_header_is_sufficient(self):
        header = LinePort(["# emg1 v=1 fs=1000\n"])
        self.assertTrue(_probe_serial_protocol(serial_module(header),"COM2",921600,"emg"))

    def test_csi_requires_repeated_packets_with_plausible_rssi(self):
        valid = LinePort([
            "1000,1,-47,0,0,0,12,13\n",
            "1010,2,-48,0,0,0,14,15\n",
        ])
        self.assertTrue(_probe_serial_protocol(serial_module(valid),"COM3",921600,"csi"))

        invalid = LinePort([
            "1000,1,500,0,0,0,12,13\n",
            "1010,2,500,0,0,0,14,15\n",
        ])
        self.assertFalse(_probe_serial_protocol(serial_module(invalid),"COM3",921600,"csi"))

    def test_oximeter_probe_resynchronizes_after_noise(self):
        packet = bytes([0x01,0x82,0x85,0xA1,0x83,72,98,0x80,0x80])
        port = BinaryPort([b"noise",packet[:4],packet[4:]+packet])
        self.assertTrue(_probe_serial_protocol(serial_module(port),"COM4",115200,"oximeter"))


class SerialAssignmentTests(unittest.TestCase):
    def test_all_modalities_are_stable_for_every_port_order(self):
        protocol_port = {
            "oximeter":"COM3",
            "gsr":"COM4",
            "emg":"COM5",
            "csi":"COM6",
        }
        ports = [
            types.SimpleNamespace(device=port,description="Identical USB bridge",vid=0x10C4,pid=0xEA60,serial_number=sensor)
            for sensor,port in protocol_port.items()
        ]
        requested = {sensor:"auto" for sensor in protocol_port}
        bauds = {"oximeter":115200,"gsr":115200,"emg":921600,"csi":921600}

        for order in itertools.permutations(ports):
            with patch("serial.tools.list_ports.comports",return_value=order), patch(
                "meridian_agent.sensors._probe_serial_protocol",
                side_effect=lambda module,port,baud,sensor: protocol_port[sensor] == port,
            ):
                assigned,_ = discover_serial_assignments(requested,bauds)
            self.assertEqual({sensor:assigned[sensor] for sensor in protocol_port},protocol_port)

    def test_a_port_can_never_be_claimed_twice(self):
        ports = [
            types.SimpleNamespace(device="COM3",description="Ambiguous",vid=None,pid=None,serial_number=None),
            types.SimpleNamespace(device="COM4",description="Ambiguous",vid=None,pid=None,serial_number=None),
        ]
        requested = {sensor:"auto" for sensor in ("oximeter","gsr","emg","csi")}
        with patch("serial.tools.list_ports.comports",return_value=ports), patch(
            "meridian_agent.sensors._probe_serial_protocol",return_value=True
        ):
            assigned,_ = discover_serial_assignments(requested,{})
        claimed = [value for value in assigned.values() if value]
        self.assertEqual(len(claimed),len(set(claimed)))
        self.assertEqual(set(claimed),{"COM3","COM4"})


if __name__ == "__main__":
    unittest.main()
