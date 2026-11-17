"""Run from the packaged Orbit root: python3 -B -m contrib.rails_server"""
import argparse
import os
import sys

from .http import make_server


def main():
    parser = argparse.ArgumentParser(description='Serve a configured Rails ledger read-only on numeric loopback.')
    parser.add_argument('--ledger', default=os.environ.get('RIZZSTACK_RAILS_DB'))
    parser.add_argument('--read-token-file', default=os.environ.get('ORBIT_RAILS_READ_TOKEN_FILE'))
    parser.add_argument('--bind', default=os.environ.get('ORBIT_RAILS_BIND', '127.0.0.1'))
    parser.add_argument('--port', default=os.environ.get('ORBIT_RAILS_PORT'))
    args = parser.parse_args()
    try:
        port = int(args.port)
        if not 1 <= port <= 65535:
            raise ValueError
        server = make_server(args.bind, port, args.ledger, args.read_token_file)
    except (OSError, ValueError, TypeError):
        print('Rails configuration or listener unavailable', file=sys.stderr)
        return 2
    try:
        with server:
            server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.stopping.set()
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
