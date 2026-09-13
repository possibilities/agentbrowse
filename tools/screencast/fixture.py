"""Serial disposable HTTP/SSE fixture. Never accesses Studio or changes host settings."""
import json
from pathlib import Path
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

root = Path(sys.argv[1]).resolve()
root.mkdir(mode=0o700)
events = []
html = b'''<!doctype html><title>Isolated screencast fixture</title><style>body{font:30px sans-serif;background:#162024;color:#eef3e8;padding:40px}button,select{font:inherit;margin:20px;padding:10px}#clock{font:40px monospace}</style><h1>Mac app / isolated recording</h1><button id="write">Write</button><select id="route"><option value="parallel">Parallel</option><option value="splayed">Splayed</option><option value="circuit">Circuit</option></select><p id="result">Ready</p><p id="live">waiting</p><p id="clock"></p><script>window.nonce=crypto.randomUUID();setInterval(()=>clock.textContent=performance.now().toFixed(0),50);window.liveCount=0;new EventSource('/live').onmessage=e=>{live.textContent=e.data;fetch('/live-event',{method:'POST',body:String(++liveCount)})};write.onclick=async()=>{result.textContent=await(await fetch('/write',{method:'POST'})).text();const end=performance.now()+1500;while(performance.now()<end){}};route.onchange=e=>fetch('/event',{method:'POST',body:JSON.stringify({value:route.value,trusted:e.isTrusted,nonce})});</script>'''


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_GET(self):
        if self.headers.get('Host') != f'127.0.0.1:{self.server.server_port}':
            self.send_error(403)
            return
        self.send_response(200)
        if self.path == '/live':
            self.send_header('Content-Type', 'text/event-stream')
            self.end_headers()
            try:
                for _ in range(60):
                    self.wfile.write(b'data: connected\n\n')
                    self.wfile.flush()
                    time.sleep(0.5)
            except (ConnectionError, BrokenPipeError):
                pass
        else:
            self.send_header('Content-Type', 'text/html')
            self.send_header('Content-Length', str(len(html)))
            self.end_headers()
            self.wfile.write(html)

    def do_POST(self):
        origin = f'http://127.0.0.1:{self.server.server_port}'
        valid = self.headers.get('Host') == origin[7:] and self.headers.get('Origin') == origin
        body = self.rfile.read(int(self.headers.get('Content-Length', '0')))
        events.append({'path': self.path, 'valid': valid, 'body': body.decode(), 'time': time.monotonic()})
        result = b'Exact Host/Origin write succeeded' if valid else b'Denied'
        self.send_response(200 if valid else 403)
        self.send_header('Content-Length', str(len(result)))
        self.end_headers()
        self.wfile.write(result)


server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
thread = threading.Thread(target=server.serve_forever, daemon=True)
thread.start()
actions = [
    {'type': 'expectText', 'selector': '#live', 'value': 'connected'},
    {'type': 'click', 'selector': '#write'}, {'type': 'wait', 'ms': 1800},
    {'type': 'expectText', 'selector': '#result', 'value': 'Exact Host/Origin write succeeded'},
    {'type': 'click', 'selector': '#route'}, {'type': 'expectOpen', 'selector': '#route', 'value': 'true'}, {'type': 'wait', 'ms': 1500},
    {'type': 'press', 'key': 'ArrowDown'}, {'type': 'press', 'key': 'Enter'},
    {'type': 'expectValue', 'selector': '#route', 'value': 'splayed'},
    {'type': 'wait', 'ms': 1000},
]
(root/'script.json').write_text(json.dumps(actions))
try:
    with (root/'helper.log').open('w') as log:
        result = subprocess.run(['bun', str(Path(__file__).with_name('run.ts')), '--url', f'http://127.0.0.1:{server.server_port}/', '--script', str(root/'script.json'), '--output', str(root/'capture'), '--seconds', '20'], stdout=log, stderr=subprocess.STDOUT, timeout=240)
    print(json.dumps({'exitCode': result.returncode, 'evidence': str(root)}))
    if result.returncode:
        print((root/'helper.log').read_text()[-3000:])
    sys.exit(result.returncode)
finally:
    server.shutdown()
    server.server_close()
    thread.join(2)
    (root/'requests.json').write_text(json.dumps(events, indent=2))
