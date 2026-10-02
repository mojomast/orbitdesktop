"""Cache-only transport tests: real shipped handlers, Unix HTTP and HMAC sequence.

Identity/pin validation has separate actual-pinned-gateway acceptance tests. Here a
test-local ContextVar and clock isolate cache lifecycle, without a provider/runtime.
"""
import contextvars
import hashlib
import hmac
import importlib.util
import json
from pathlib import Path
import socket
import socketserver
import sys
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from http.server import BaseHTTPRequestHandler

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('retention_plugin', ROOT / 'hermes-plugin/__init__.py', submodule_search_locations=[str(ROOT / 'hermes-plugin')])
package = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = package
spec.loader.exec_module(package)
module = importlib.import_module('retention_plugin.normal_resources')


class CacheRetention(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='resource-cache-', dir='/tmp/opencode')
        self.root = Path(self.temp.name)
        self.clock = 10000.0
        self.identity = contextvars.ContextVar('fixture_identity')
        self.sequences = {}
        self.keys = {}
        self.effects = 0
        self.started = threading.Event()
        self.release = threading.Event()
        self.original = (module.verify_runtime, module.trusted_context, module.time)
        module.verify_runtime = lambda: None
        module.trusted_context = self.identity.get
        module.time = SimpleNamespace(time=lambda:self.clock, sleep=time.sleep)
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                raw = self.rfile.read(int(self.headers['Content-Length']))
                recipient = self.headers['X-Orbit-Recipient']
                seq = int(self.headers['X-Orbit-Sequence'])
                mac = hmac.new(outer.keys[recipient].encode(), str(seq).encode()+b'\n'+raw, hashlib.sha256).hexdigest()
                if mac != self.headers['X-Orbit-Mac'] or seq <= outer.sequences.get(recipient, 0):
                    self.send_response(403);self.end_headers();self.wfile.write(b'{"ok":false,"code":"sequence_reused"}');return
                outer.sequences[recipient] = seq
                body = json.loads(raw)
                if body['action'] == 'create_document':
                    outer.effects += 1
                    outer.started.set()
                    outer.release.wait(10)
                    # Commit happened; response is deliberately lost. Cache cleanup
                    # must not cause automatic mutation replay.
                    self.connection.shutdown(socket.SHUT_RDWR)
                    self.connection.close()
                    return
                self.send_response(200);self.end_headers();self.wfile.write(json.dumps({'ok':True,'sequence':seq}).encode())
            def log_message(self, *args):
                pass

        class Server(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
            daemon_threads = True
        self.server = Server(str(self.root/'tool.sock'), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True);self.thread.start()

        class Context:
            def get_config(self, key, default=None):
                return str(outer.root) if key == 'normal_resource_directory' else default
            def register_tool(self, **kwargs):
                outer.handle = kwargs['handler']
        module.register(Context())

    def tearDown(self):
        self.release.set();self.server.shutdown();self.server.server_close();self.thread.join()
        module.verify_runtime, module.trusted_context, module.time = self.original
        self.temp.cleanup()

    def channel(self, number, ttl=3600):
        run = f'run_retention_{number:04d}'
        identity = (run, f'orbit-session-{number}', '')
        secret = f'fixture-private-channel-{number}'
        self.keys[run] = secret
        file = self.root/(run+'.json')
        file.write_text(json.dumps({'version':1,'run_id':run,'session_id':identity[1],'hermes_profile':'',
            'recipient_id':run,'secret':secret,'socket':str(self.root/'tool.sock'),'expires_at':(self.clock+ttl)*1000}))
        file.chmod(0o600)
        return identity, file

    def call(self, identity, body=None):
        token = self.identity.set(identity)
        try:
            return json.loads(self.handle(body or {'action':'describe'}))
        finally:
            self.identity.reset(token)

    def test_over_64_retired_channels_preserve_valid_active_sequence(self):
        keeper, _ = self.channel(0)
        self.assertEqual(self.call(keeper)['sequence'], 1)
        expired = []
        for i in range(1, 90):
            identity, file = self.channel(i, ttl=.5 if i%2 else 3600)
            self.assertTrue(self.call(identity)['ok'])
            if i%2:
                self.clock += 1
                expired.append(identity)
            else:
                file.unlink()  # Server revoked/completed this idle channel.
        self.assertEqual(self.call(keeper)['sequence'], 2)
        self.assertEqual(self.call(expired[0])['code'], 'normal_grant_unavailable')
        self.assertEqual(self.sequences[expired[0][0]], 1)  # No reinitialization/replay.

    def test_full_cache_does_not_evict_live_channels_or_reset_sequence(self):
        channels = [self.channel(i) for i in range(65)]
        for identity, _ in channels[:64]:
            self.assertTrue(self.call(identity)['ok'])
        self.assertEqual(self.call(channels[64][0])['code'], 'normal_channel_capacity')
        self.assertEqual(self.call(channels[0][0])['sequence'], 2)
        channels[1][1].unlink()
        self.assertTrue(self.call(channels[64][0])['ok'])
        self.assertEqual(self.call(channels[0][0])['sequence'], 3)
        data=json.loads(channels[0][1].read_text());data['secret']='replacement-secret'
        channels[0][1].write_text(json.dumps(data))
        self.assertEqual(self.call(channels[0][0])['code'],'normal_grant_unavailable')
        self.assertEqual(self.sequences[channels[0][0][0]],3)

    def test_in_flight_unknown_effect_retains_slot_until_return_and_is_not_retried(self):
        channels = [self.channel(i) for i in range(65)]
        for identity, _ in channels[:64]:
            self.assertTrue(self.call(identity)['ok'])
        result = []
        worker=threading.Thread(target=lambda:result.append(self.call(channels[0][0],{'action':'create_document','op_id':'12345678-1234-1234-1234-123456789abc'})))
        worker.start();self.assertTrue(self.started.wait(5));channels[0][1].unlink()
        self.assertEqual(self.call(channels[64][0])['code'], 'normal_channel_capacity')
        self.assertEqual(self.call(channels[1][0])['sequence'], 2)
        self.release.set();worker.join(5);self.assertFalse(worker.is_alive())
        self.assertEqual(result[0]['outcome'],'unknown');self.assertEqual(self.effects,1)
        self.assertTrue(self.call(channels[64][0])['ok']);self.assertEqual(self.effects,1)
        self.assertEqual(self.sequences[channels[0][0][0]],2)

if __name__ == '__main__':
    unittest.main()
