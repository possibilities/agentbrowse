"""Loopback TCP and UDP access to owned Hypeman guests on macOS."""
import json
import selectors
import socket
import threading
import time
import urllib.request


class Forward:
    def __init__(self, port, host, guest_port, udp=False):
        self.destination = (host, guest_port)
        self.udp = udp
        self.stop = threading.Event()
        self.connections = set()
        self.lock = threading.Lock()
        self.socket = socket.socket(socket.AF_INET, socket.SOCK_DGRAM if udp else socket.SOCK_STREAM)
        if not udp:
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            self.socket.bind(("127.0.0.1", port))
        except OSError:
            self.socket.close()
            raise
        if not udp:
            self.socket.listen(32)
        self.socket.settimeout(0.5)
        self.thread = threading.Thread(target=self.datagrams if udp else self.accept, daemon=True)
        self.thread.start()

    def accept(self):
        while not self.stop.is_set():
            try:
                client, _ = self.socket.accept()
            except socket.timeout:
                continue
            except OSError:
                break
            with self.lock:
                if len(self.connections) >= 128:
                    client.close()
                    continue
                self.connections.add(client)
            threading.Thread(target=self.stream, args=(client,), daemon=True).start()

    def stream(self, client):
        import select
        upstream = None
        try:
            upstream = socket.create_connection(self.destination, timeout=3)
            upstream.settimeout(3)
            client.settimeout(3)
            with self.lock:
                self.connections.add(upstream)
            while not self.stop.is_set():
                readable, _, _ = select.select([client, upstream], [], [], 0.5)
                for source in readable:
                    data = source.recv(65536)
                    if not data:
                        return
                    (upstream if source is client else client).sendall(data)
        except OSError:
            pass
        finally:
            with self.lock:
                self.connections.discard(client)
                self.connections.discard(upstream)
            client.close()
            if upstream:
                upstream.close()

    def datagrams(self):
        selector = selectors.DefaultSelector()
        selector.register(self.socket, selectors.EVENT_READ)
        peers = {}
        try:
            while not self.stop.is_set():
                for key, _ in selector.select(0.5):
                    if key.fileobj is self.socket:
                        packet, client = self.socket.recvfrom(65535)
                        if client not in peers:
                            if len(peers) >= 128:
                                continue
                            upstream = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
                            upstream.connect(self.destination)
                            upstream.setblocking(False)
                            peers[client] = [upstream, time.monotonic()]
                            selector.register(upstream, selectors.EVENT_READ, client)
                        upstream, _ = peers[client]
                        peers[client][1] = time.monotonic()
                        try:
                            upstream.send(packet)
                        except OSError:
                            pass
                    else:
                        client = key.data
                        try:
                            self.socket.sendto(key.fileobj.recv(65535), client)
                            peers[client][1] = time.monotonic()
                        except OSError:
                            pass
                for client, (upstream, last) in list(peers.items()):
                    if time.monotonic() - last > 60:
                        selector.unregister(upstream)
                        upstream.close()
                        del peers[client]
        except OSError:
            pass
        finally:
            selector.close()
            for upstream, _ in peers.values():
                upstream.close()

    def close(self):
        self.stop.set()
        self.thread.join(timeout=2)
        self.socket.close()
        with self.lock:
            for connection in self.connections:
                connection.close()


class Relay:
    def __init__(self, root):
        self.root = root
        self.forwards = {}

    def sync(self):
        import ipaddress
        config = json.loads((self.root / "connection.json").read_text())
        token = (self.root / "token").read_text().strip()
        req = urllib.request.Request(config["baseUrl"] + "/instances", headers={"Authorization": "Bearer " + token})
        with urllib.request.urlopen(req, timeout=2) as response:
            instances = json.load(response)
        wanted = {}
        for instance in instances:
            tags = instance.get("tags") or {}
            if tags.get("dev.agentbrowse.managed") != "true" or tags.get("dev.agentbrowse.role") != "kernel-browser" or tags.get("dev.agentbrowse.hypeman.spec") != "1":
                continue
            if instance["state"] not in ("Initializing", "Running"):
                continue
            ip = ipaddress.IPv4Address(instance["network"]["ip"])
            if ip not in ipaddress.IPv4Network("192.168.0.0/16"):
                raise RuntimeError("Hypeman local guest is outside the private VM network")
            slot, offset = int(tags["dev.agentbrowse.slot"]), int(tags["dev.agentbrowse.port-offset"])
            if not 0 <= slot <= 999 or not 0 <= offset <= 8536:
                raise RuntimeError("invalid owned forwarding ports")
            for port, guest, udp in [(9222+slot+offset,9222,False), (18080+slot+offset,8080,False), (56000+slot+offset,56000+slot+offset,True)]:
                key = (port, udp)
                if key in wanted:
                    raise RuntimeError("duplicate Hypeman forwarding port")
                wanted[key] = (str(ip), guest, instance["id"])
        for key, (spec, forward) in list(self.forwards.items()):
            if wanted.get(key) != spec:
                forward.close()
                del self.forwards[key]
        for key, spec in wanted.items():
            if key not in self.forwards:
                self.forwards[key] = (spec, Forward(key[0], spec[0], spec[1], key[1]))

    def close(self):
        for _, forward in self.forwards.values():
            forward.close()
        self.forwards.clear()
