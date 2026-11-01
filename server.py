import http.server
import sys

class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory='.', **kw)
    def end_headers(self):
        self.send_header('Cross-Origin-Opener-Policy', 'same-origin')
        self.send_header('Cross-Origin-Embedder-Policy', 'require-corp')
        super().end_headers()


port = 8000 if len(sys.argv) < 2 else sys.argv[1]
http.server.HTTPServer(('', int(port)), H).serve_forever()

