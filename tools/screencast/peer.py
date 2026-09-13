"""Private Hypeman exec peer. No credentials, shell, host listener, or arbitrary destination.

JSON lines on stdin/stdout; one loopback grant, bounded streams and acknowledged chunks.
An EOF, missed heartbeat, malformed frame or lease-owner disconnect revokes existing TCPs.
This module is also exercised by real subprocess/pipe tests without a browser.
"""
import asyncio
import base64
import json
import os
import sys
import time
from recorder import Media

MAX_LINE = 65536
MAX_STREAMS = 16
CHUNK = 16384


class Peer:
    def __init__(self, reader, writer):
        self.reader, self.writer = reader, writer
        self.server = None
        self.streams = {}
        self.tasks = set()
        self.next_id = 0
        self.last_ping = time.monotonic()
        self.stopping = asyncio.Event()
        self.write_lock = asyncio.Lock()
        self.reason = "revoked"
        self.media = Media()

    async def emit(self, message):
        data = json.dumps(message, separators=(",", ":")).encode() + b"\n"
        if len(data) > MAX_LINE:
            raise ValueError("oversize output")
        async with self.write_lock:
            self.writer.write(data)
            await asyncio.wait_for(self.writer.drain(), 2)

    async def accept(self, reader, writer):
        if self.stopping.is_set() or len(self.streams) >= MAX_STREAMS:
            writer.close()
            return
        self.next_id += 1
        stream_id = self.next_id
        ack = asyncio.Event()
        closed = asyncio.Event()
        self.streams[stream_id] = (writer, ack, closed)
        task = asyncio.current_task()
        self.tasks.add(task)
        try:
            await self.emit({"type": "open", "id": stream_id})
            await asyncio.wait_for(ack.wait(), 3)
            ack.clear()
            while data := await reader.read(CHUNK):
                await self.emit({"type": "data", "id": stream_id,
                                 "data": base64.b64encode(data).decode()})
                await asyncio.wait_for(ack.wait(), 3)
                ack.clear()
            await self.emit({"type": "eof", "id": stream_id})
            # Half-close only. The application may still return its response.
            await closed.wait()
        except (ConnectionError, asyncio.TimeoutError):
            pass
        finally:
            writer.close()
            self.streams.pop(stream_id, None)
            self.tasks.discard(task)
            if not self.stopping.is_set():
                await self.emit({"type": "close", "id": stream_id})

    async def receive(self, message):
        kind = message.get("type")
        if kind == "ping":
            self.last_ping = time.monotonic()
            await self.emit({"type": "pong"})
        elif kind == "rpc":
            if len(self.tasks) >= MAX_STREAMS + 2:
                raise ValueError("task bound")
            task = asyncio.create_task(self.rpc(message))
            self.tasks.add(task)
            task.add_done_callback(self.tasks.discard)
        elif kind == "grant":
            if self.server is not None:
                raise ValueError("grant already bound")
            port = message.get("port")
            if type(port) is not int or not 1024 <= port <= 65535:
                raise ValueError("invalid loopback port")
            self.server = await asyncio.start_server(self.accept, "127.0.0.1", port)
            await self.emit({"type": "ready", "port": port})
        elif kind == "revoke":
            self.reason = "revoked"
            self.stopping.set()
        elif kind in ("ack", "data", "eof", "close"):
            stream = self.streams.get(message.get("id"))
            if stream is None:
                return  # Late acknowledgement for a closed connection.
            writer, ack, closed = stream
            if kind == "ack":
                ack.set()
            elif kind == "data":
                data = base64.b64decode(message["data"], validate=True)
                if len(data) > CHUNK:
                    raise ValueError("oversize chunk")
                writer.write(data)
                await asyncio.wait_for(writer.drain(), 2)
                await self.emit({"type": "ack", "id": message["id"]})
            elif kind == "eof":
                if writer.can_write_eof():
                    writer.write_eof()
            else:
                writer.close()
                ack.set()
                closed.set()
        else:
            raise ValueError("unknown frame")

    async def rpc(self, message):
        try:
            result = await self.media.handle(message)
            await self.emit({"type": "rpc", "request": message["request"], "ok": True, "result": result})
        except Exception as error:
            await self.emit({"type": "rpc", "request": message.get("request"), "ok": False,
                             "error": str(error)[:2000]})

    async def read(self):
        while not self.stopping.is_set():
            line = await self.reader.readline()
            if not line:
                self.reason = "owner_eof"
                return
            if len(line) > MAX_LINE:
                raise ValueError("oversize input")
            await self.receive(json.loads(line))

    async def watchdog(self):
        while not self.stopping.is_set():
            await asyncio.sleep(0.25)
            if time.monotonic() - self.last_ping > 3:
                self.reason = "heartbeat_expired"
                return

    async def run(self):
        workers = [asyncio.create_task(self.read()), asyncio.create_task(self.watchdog()),
                   asyncio.create_task(self.stopping.wait())]
        try:
            done, _ = await asyncio.wait(workers, return_when=asyncio.FIRST_COMPLETED)
            for task in done:
                task.result()
        except Exception as error:
            self.reason = "failed:" + type(error).__name__
        finally:
            self.stopping.set()
            if self.server:
                self.server.close()
                await self.server.wait_closed()
            for writer, _, _ in list(self.streams.values()):
                writer.close()
            for task in list(self.tasks) + workers:
                task.cancel()
            await asyncio.gather(*list(self.tasks), *workers, return_exceptions=True)
            await self.media.close()
            try:
                await self.emit({"type": "stopped", "reason": self.reason})
            except Exception:
                pass
        return 0 if self.reason in ("revoked", "owner_eof") else 1


async def main():
    if sys.stdin.isatty():
        import tty
        tty.setraw(sys.stdin.fileno())
    loop = asyncio.get_running_loop()
    reader = asyncio.StreamReader(limit=MAX_LINE)
    await loop.connect_read_pipe(lambda: asyncio.StreamReaderProtocol(reader), sys.stdin.buffer)
    transport, protocol = await loop.connect_write_pipe(asyncio.streams.FlowControlMixin,
                                                       sys.stdout.buffer)
    writer = asyncio.StreamWriter(transport, protocol, None, loop)
    peer = Peer(reader, writer)
    await peer.emit({"type": "hello", "pid": os.getpid()})
    result = await peer.run()
    transport.abort()
    return result


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
