"""Test-only SSH peer using the system Paramiko, for hosts without usable sshd.

Only the pinned ephemeral test key and ONE fixed loopback direct-tcpip target
are allowed. All session channels and other SSH requests are denied.
"""
import base64
from pathlib import Path
import socket
import sys
import threading
import paramiko

root = Path(sys.argv[1])
port, peer_port = map(int, sys.argv[2:])
host = paramiko.Ed25519Key.from_private_key_file(str(root/'host'))
client = base64.b64decode((root/'peer.key.pub').read_text().split()[1])

class Enrolled(paramiko.ServerInterface):
    def get_allowed_auths(self, username): return 'publickey'
    def check_auth_publickey(self, username, key):
        return paramiko.AUTH_SUCCESSFUL if username == 'root' and key.asbytes() == client else paramiko.AUTH_FAILED
    def check_channel_direct_tcpip_request(self, chanid, origin, dest):
        return paramiko.OPEN_SUCCEEDED if dest == ('127.0.0.1', peer_port) else paramiko.OPEN_FAILED_ADMINISTRATIVELY_PROHIBITED

def transfer(src,dst):
    try:
        while data := src.recv(8192): dst.sendall(data)
    except OSError: pass
    finally:
        try: dst.shutdown(socket.SHUT_WR)
        except OSError: pass

def serve(conn):
    with conn, paramiko.Transport(conn) as transport:
        transport.add_server_key(host)
        try:
            transport.start_server(server=Enrolled()); channel=transport.accept(5)
            if channel is None: return
            with channel,socket.create_connection(('127.0.0.1',peer_port),timeout=5) as peer:
                threading.Thread(target=transfer,args=(channel,peer),daemon=True).start();transfer(peer,channel)
        except (OSError,EOFError,paramiko.SSHException): pass

with socket.socket() as listener:
    listener.bind(('127.0.0.1',port));listener.listen(4);print('Server listening',file=sys.stderr,flush=True)
    while True: threading.Thread(target=serve,args=(listener.accept()[0],),daemon=True).start()
