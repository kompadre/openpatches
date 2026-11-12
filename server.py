"""Dev server: static files with COOP/COEP, plus the collab room relay.

The relay is a stub of what the Go service will host: a WebSocket at
/api/room/<CODE>?peer=<id>. Every text message a connection sends is
forwarded, unchanged, to every other connection in the same room. It does
not read or check what it forwards; the host's referee does that
(html/components/collab*.js). When a connection drops, the others get
{"relay": "left", "peer": "<id>"} so they can tell the host has gone.

Standard library only: the WebSocket handshake and framing (RFC 6455) are
done here by hand. Threaded, because each socket holds its own thread.
"""

import base64
import hashlib
import http.server
import json
import re
import struct
import sys
import threading
from urllib.parse import parse_qs, urlsplit

WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
MAX_MESSAGE = 32 * 1024 * 1024        # a snapshot carries the patches; be generous
ROOM_PATH = re.compile(r'/api/room/([A-Z0-9]{4,12})')

rooms = {}                            # code -> set of Conn
rooms_lock = threading.Lock()


class Conn:
    def __init__(self, rfile, wfile, peer):
        self.rfile = rfile
        self.wfile = wfile
        self.peer = peer
        self.lock = threading.Lock()  # one writer at a time

    def send(self, opcode, payload=b''):
        n = len(payload)
        if n < 126:
            head = struct.pack('!BB', 0x80 | opcode, n)
        elif n < 65536:
            head = struct.pack('!BBH', 0x80 | opcode, 126, n)
        else:
            head = struct.pack('!BBQ', 0x80 | opcode, 127, n)
        with self.lock:
            self.wfile.write(head + payload)
            self.wfile.flush()

    def send_text(self, text):
        self.send(0x1, text.encode('utf-8'))

    def read_exact(self, n):
        data = self.rfile.read(n)
        if data is None or len(data) < n:
            raise ConnectionError('closed')
        return data

    def read_frame(self):
        b1, b2 = self.read_exact(2)
        fin, opcode = b1 & 0x80, b1 & 0x0F
        masked, n = b2 & 0x80, b2 & 0x7F
        if n == 126:
            n = struct.unpack('!H', self.read_exact(2))[0]
        elif n == 127:
            n = struct.unpack('!Q', self.read_exact(8))[0]
        if n > MAX_MESSAGE:
            raise ConnectionError('too big')
        mask = self.read_exact(4) if masked else None
        data = self.read_exact(n) if n else b''
        if mask:
            data = bytes(b ^ mask[i % 4] for i, b in enumerate(data))
        return bool(fin), opcode, data

    def messages(self):
        """Yield whole text messages; answer pings; stop on close."""
        parts, kind = [], None
        while True:
            fin, opcode, data = self.read_frame()
            if opcode == 0x8:                       # close
                try:
                    self.send(0x8, data[:2])
                except OSError:
                    pass
                return
            if opcode == 0x9:                       # ping
                self.send(0xA, data)
                continue
            if opcode == 0xA:                       # pong
                continue
            if opcode in (0x1, 0x2):
                parts, kind = [data], opcode
            elif opcode == 0x0 and kind is not None:
                parts.append(data)
            else:
                raise ConnectionError('bad frame')
            if sum(len(p) for p in parts) > MAX_MESSAGE:
                raise ConnectionError('too big')
            if fin:
                whole, was = b''.join(parts), kind
                parts, kind = [], None
                if was == 0x1:
                    yield whole.decode('utf-8', errors='replace')


def broadcast(code, sender, text):
    with rooms_lock:
        others = [c for c in rooms.get(code, ()) if c is not sender]
    for c in others:
        try:
            c.send_text(text)
        except OSError:
            pass                                    # its own thread will clean it up


class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory='.', **kw)

    def end_headers(self):
        self.send_header('Cross-Origin-Opener-Policy', 'same-origin')
        self.send_header('Cross-Origin-Embedder-Policy', 'require-corp')
        super().end_headers()

    def do_GET(self):
        url = urlsplit(self.path)
        m = ROOM_PATH.fullmatch(url.path)
        if m:
            return self.relay(m.group(1), parse_qs(url.query).get('peer', [''])[0][:64])
        return super().do_GET()

    def relay(self, code, peer):
        key = self.headers.get('Sec-WebSocket-Key')
        if self.headers.get('Upgrade', '').lower() != 'websocket' or not key:
            self.send_error(426, 'WebSocket upgrade required')
            return
        accept = base64.b64encode(hashlib.sha1((key + WS_GUID).encode()).digest()).decode()
        self.send_response(101, 'Switching Protocols')
        self.send_header('Upgrade', 'websocket')
        self.send_header('Connection', 'Upgrade')
        self.send_header('Sec-WebSocket-Accept', accept)
        self.end_headers()
        self.wfile.flush()
        self.close_connection = True

        conn = Conn(self.rfile, self.wfile, peer)
        with rooms_lock:
            rooms.setdefault(code, set()).add(conn)
        try:
            for text in conn.messages():
                broadcast(code, conn, text)
        except (ConnectionError, OSError, struct.error, ValueError):
            pass
        finally:
            with rooms_lock:
                room = rooms.get(code)
                if room is not None:
                    room.discard(conn)
                    if not room:
                        del rooms[code]
            if peer:
                broadcast(code, conn, json.dumps({'relay': 'left', 'peer': peer}))

    def log_message(self, fmt, *args):
        if not ROOM_PATH.fullmatch(urlsplit(getattr(self, 'path', '')).path):
            super().log_message(fmt, *args)


if __name__ == '__main__':
    port = 8000 if len(sys.argv) < 2 else sys.argv[1]
    server = http.server.ThreadingHTTPServer(('', int(port)), H)
    server.daemon_threads = True
    server.serve_forever()
