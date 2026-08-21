import tempfile
import unittest
from pathlib import Path

from meridian_agent.sensors import CsiSensor, EmgSensor, GsrSensor, OximeterSensor


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

    def test_gsr_json(self):
        sensor = GsrSensor("gsr","COM7",115200,self.root,0)
        parsed = sensor.parse('{"uS":2.34,"raw":1856,"stress":42,"zScore":0.87}')
        self.assertEqual(parsed,([2.34,1856,42.0,0.87],"2.34 uS"))


if __name__ == "__main__":
    unittest.main()
