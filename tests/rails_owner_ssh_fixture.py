"""Test-only SSH peer for the optional signed browser path (Paramiko)."""
import base64
import json
import os
from pathlib import Path
import socketserver
import subprocess
import sys
import threading

import paramiko


class Peer(paramiko.ServerInterface):
    def __init__(self, relay): self.relay=relay;self.requested=threading.Event()
    def get_allowed_auths(self, username):return 'publickey'
    def check_auth_publickey(self, username, key):
        return paramiko.AUTH_SUCCESSFUL if username=='fixture-relay' and key.asbytes()==self.relay else paramiko.AUTH_FAILED
    def check_channel_request(self, kind, chanid):return paramiko.OPEN_SUCCEEDED if kind=='session' else paramiko.OPEN_FAILED_ADMINISTRATIVELY_PROHIBITED
    def check_channel_exec_request(self, channel, command):
        if command!=b'rails-feedback-v1':return False
        self.requested.set();return True


class Fixture:
    def __init__(self,root,ledger,workspace,cleanup):
        self.root=root;self.blackhole=True
        self.bb=Path(__file__).resolve().parents[2]/'bundlebees'
        self.owner=root/'owner-signing';relay=root/'relay'
        for key in (self.owner,relay):subprocess.run(['ssh-keygen','-q','-t','ed25519','-N','','-f',str(key)],check=True)
        host=paramiko.RSAKey.generate(2048);pub=base64.b64decode(relay.with_suffix('.pub').read_text().split()[1]);pins=root/'host-keys'
        pins.write_text('rails-feedback-coordinator '+host.get_name()+' '+host.get_base64()+'\n')
        allowed=root/'allowed-signers';allowed.write_text(workspace+':alice namespaces="rizzstack-rails-feedback-v1" '+' '.join(self.owner.with_suffix('.pub').read_text().split()[:2])+'\n');allowed.chmod(0o600)
        state=root/'coordinator';state.mkdir();profile=root/'writer-profile'
        # Invoke the real coordinator authorizer under a disposable PTY; this
        # role's key is generated in the fixture only, never imported from Orbit.
        import pty
        master,slave=pty.openpty()
        try:
            code='from bundlebees_plugin import job;from pathlib import Path;import sys;job.record_authorization(Path(sys.argv[1]),job_id="job-fixture",by="alice",statement="Run only the isolated browser fixture",repo="public/fixture",base_rev="a"*40,scope=["tests/*"],bees=1,wall_clock_s=60)'
            subprocess.run([sys.executable,'-c',code,str(state)],stdin=slave,cwd=self.bb,env={'PATH':os.environ['PATH'],'HOME':str(root/'home')},check=True)
        finally:os.close(master);os.close(slave)
        profile.write_text(json.dumps(dict(ledger=str(ledger.path),ledger_uuid=ledger.ledger_uuid,state_dir=str(state),owner='alice',workspace_id=workspace,signers=str(allowed))));profile.chmod(0o600)
        outer=self
        class Handler(socketserver.BaseRequestHandler):
            def handle(self):
                with paramiko.Transport(self.request) as t:
                    t.add_server_key(host);peer=Peer(pub);t.start_server(server=peer);ch=t.accept(5)
                    if not ch or not peer.requested.wait(5):return
                    with ch.makefile('rb') as f:raw=f.read(8193)
                    if len(raw)>8192:return
                    proc=subprocess.run([sys.executable,'-m','bundlebees_plugin.rails_owner_bridge',str(profile)],cwd=outer.bb,
                       env={'PATH':os.environ['PATH'],'HOME':str(root/'home')},input=raw,stdout=subprocess.PIPE,timeout=8)
                    result=json.loads(proc.stdout)
                    if not result['ok']:print('Fixture writer refused:',result['code'],file=sys.stderr)
                    if json.loads(raw)['action']=='confirm' and result['ok'] and outer.blackhole:
                        # Commit made it to the ledger; deliberately lose the first success reply.
                        outer.blackhole=False;ch.send_exit_status(1)
                    else:ch.sendall(proc.stdout);ch.send_exit_status(proc.returncode)
                    ch.shutdown_write();ch.close()
                    # Let OpenSSH receive the exit status and complete channel
                    # shutdown before the synthetic peer drops the transport.
                    t.join(timeout=3)
        server=socketserver.ThreadingTCPServer(('127.0.0.1',0),Handler);server.daemon_threads=True
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        cleanup.callback(server.server_close);cleanup.callback(thread.join);cleanup.callback(server.shutdown)
        self.env=dict(ORBIT_RAILS_FEEDBACK_WORKSPACE=workspace,ORBIT_RAILS_RELAY_PORT=str(server.server_address[1]),
                      ORBIT_RAILS_RELAY_USER='fixture-relay',ORBIT_RAILS_RELAY_HOST_KEYS=str(pins),ORBIT_RAILS_RELAY_IDENTITY=str(relay))

    def sign(self,text):
        return subprocess.run(['ssh-keygen','-Y','sign','-n','rizzstack-rails-feedback-v1','-f',str(self.owner)],input=text.encode('ascii'),
            stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,check=True).stdout.decode()
