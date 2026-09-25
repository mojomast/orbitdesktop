import importlib.util
import sys
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'extensions/orbit-telemetry'))
from metrics import cpu_percent, process_stat, HostSampler, TokenRates, gateway


class MetricsTests(unittest.TestCase):
    def test_cpu_deltas(self):
        self.assertIsNone(cpu_percent((100, 20), None))
        self.assertEqual(cpu_percent((200, 60), (100, 20)), 60)
        self.assertIsNone(cpu_percent((100, 20), (100, 20)))
        self.assertIsNone(cpu_percent((5, 1), (100, 20)))

    def test_process_name_parentheses(self):
        fields = ['S'] + ['0'] * 21
        fields[11], fields[12], fields[19], fields[21] = '12', '8', '999', '5'
        result = process_stat('42 (test (worker)) ' + ' '.join(fields), 4096)
        self.assertEqual(result, dict(name='test (worker)', ticks=20, start=999, rss=20480))

    def test_rates_warmup_duplicate_and_reset(self):
        rates = TokenRates()
        a = {'updated_at': 100, 'profile': {'input': 100, 'output': 20, 'calls': 1}}
        self.assertIsNone(rates.sample(a)['scopes']['profile']['output_per_second'])
        rates.sample(a)
        self.assertEqual(len(rates.samples), 1)
        b = {'updated_at': 115, 'profile': {'input': 250, 'output': 50, 'calls': 2}}
        self.assertEqual(rates.sample(b)['scopes']['profile']['output_per_second'], 2)
        reset = {'updated_at': 130, 'profile': {'input': 0, 'output': 0, 'calls': 0}}
        self.assertIsNone(rates.sample(reset)['scopes']['profile']['output_per_second'])

    def test_live_host(self):
        sampler = HostSampler()
        first = sampler.sample()
        self.assertIsNone(first['cpu_percent'])
        time.sleep(.2)
        current = sampler.sample()
        self.assertGreater(len(current['cores']), 0)
        self.assertGreaterEqual(current['cpu_percent'], 0)
        self.assertLessEqual(current['cpu_percent'], 100)
        self.assertLessEqual(current['memory_used'], current['memory_total'])
        self.assertGreater(len(current['top_memory']), 0)
        for row in current['top_memory']:
            self.assertEqual(set(row), {'name', 'pid', 'rss', 'cpu_percent'})

    def test_live_gateway(self):
        result = gateway()
        self.assertTrue(result['available'])
        self.assertIsInstance(result['in_flight'], int)
        self.assertGreaterEqual(result['in_flight'], 0)
        self.assertNotIn('pid', result)


if __name__ == '__main__':
    unittest.main()
