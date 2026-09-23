import importlib.util
import json
from pathlib import Path
import threading
import unittest
import urllib.request
import urllib.error

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('telemetry', ROOT / 'packages/orbit-live-telemetry/backend/main.py')
telemetry = importlib.util.module_from_spec(spec)
spec.loader.exec_module(telemetry)

class TelemetryTests(unittest.TestCase):
    def test_real_host_sampling(self):
        data, previous = telemetry.sample()
        self.assertGreater(data['memoryTotal'], 0)
        self.assertIsNone(data['cpuPercent'])
        self.assertEqual(len(data['load']), 3)
        self.assertNotIn('processes', data)
        self.assertEqual(set(data), {'sampledAt','cpuPercent','memoryUsed','memoryTotal','load','logicalCpus'})

    def test_config(self):
        base = {'host':'machine.example.ts.net:8443','owner':'owner@example.com','orbitOrigin':'https://orbit.example.com'}
        self.assertEqual(telemetry.validate_config(base), base)
        for patch in [{'orbitOrigin':'https://example.com;evil'}, {'host':'a/evil'}, {'owner':'a\r\nb'}, {'orbitOrigin':'http://example.com'}]:
            with self.subTest(patch=patch):
                with self.assertRaises(ValueError): telemetry.validate_config(dict(base, **patch))

    def test_real_http_authentication_and_no_cors(self):
        config={'host':'machine.example.ts.net:8443','owner':'owner@example.com','orbitOrigin':'https://orbit.example.com'}
        server=telemetry.ThreadingHTTPServer(('127.0.0.1',0),telemetry.handler(config))
        server.metrics_lock=threading.Lock()
        server.metrics,_=telemetry.sample()
        worker=threading.Thread(target=server.serve_forever,daemon=True);worker.start()
        url=f'http://127.0.0.1:{server.server_port}'
        def request(path,headers):
            return urllib.request.urlopen(urllib.request.Request(url+path,headers=headers))
        try:
            for headers in [{},{'Host':config['host']},{'Host':config['host'],'Tailscale-User-Login':'other'},{'Host':config['host'],'Tailscale-User-Login':config['owner'],'Origin':'https://evil.example'}]:
                with self.assertRaises(urllib.error.HTTPError) as error:request('/api/metrics',headers)
                self.assertEqual(error.exception.code,403)
            headers={'Host':config['host'],'Tailscale-User-Login':config['owner']}
            with request('/api/metrics',headers) as response:
                data=json.load(response);self.assertGreater(data['memoryTotal'],0)
                self.assertIsNone(response.headers.get('Access-Control-Allow-Origin'))
                self.assertIn(config['orbitOrigin'],response.headers['Content-Security-Policy'])
            with request('/',headers) as response:self.assertIn(b'Your machine',response.read())
            with request('/health',{}) as response:self.assertTrue(json.load(response)['ok'])
        finally:
            server.shutdown();server.server_close();worker.join()

if __name__=='__main__': unittest.main(verbosity=2)
