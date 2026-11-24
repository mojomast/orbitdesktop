"""Unix-socket HTTP transport shared by the plugin's channel adapters."""
import http.client
import socket


class UnixConnection(http.client.HTTPConnection):
    def __init__(self, filename):
        super().__init__("localhost", timeout=180)
        self.filename = filename

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect(self.filename)
