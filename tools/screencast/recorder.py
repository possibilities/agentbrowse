"""Owned virtual-display recorder, reachable only through the private exec peer.

Fixed display and private paths. All subprocess pipes are drained, every wait is finite,
only child handles created here receive signals, and transport loss stops recording.
"""
import asyncio
import base64
import hashlib
import os
from pathlib import Path
import signal
import shutil
import tempfile
import time

MAX_FILE = 256 * 1024 * 1024


class Media:
    def __init__(self):
        self.root = Path(tempfile.mkdtemp(prefix="agentbrowse-film-"))
        self.proc = None
        self.drains = []
        self.progress = {}
        self.last_progress = None
        self.stderr = bytearray()
        self.stderr_bytes = 0
        self.lock = asyncio.Lock()
        self.started = None
        self.stopped = None
        self.finalized = False
        self.failure = None

    async def command(self, args, timeout=5):
        proc = await asyncio.create_subprocess_exec(*args, stdout=asyncio.subprocess.PIPE,
                                                     stderr=asyncio.subprocess.PIPE)
        try:
            out, err = await asyncio.wait_for(proc.communicate(), timeout)
            if proc.returncode:
                raise RuntimeError("native command failed: " + err[-1000:].decode(errors="replace"))
            return out
        except asyncio.TimeoutError as error:
            raise RuntimeError("native command deadline exceeded") from error
        finally:
            if proc.returncode is None:
                proc.kill()
                await asyncio.wait_for(proc.wait(), 2)

    async def drain_progress(self):
        while line := await self.proc.stdout.readline():
            if len(line) > 4096:
                raise RuntimeError("encoder progress bound")
            key, _, value = line.decode().strip().partition("=")
            self.progress[key] = value
            self.last_progress = time.monotonic()

    async def drain_stderr(self):
        while data := await self.proc.stderr.read(16384):
            self.stderr_bytes += len(data)
            self.stderr.extend(data)
            if len(self.stderr) > 16384:
                del self.stderr[:-16384]

    async def watch_size(self):
        while self.proc.returncode is None:
            path = self.path("video")
            if path.exists() and path.stat().st_size > MAX_FILE:
                self.failure = "source size limit exceeded"
                self.proc.kill()
                return
            await asyncio.sleep(0.25)

    async def stop(self):
        if self.proc is None:
            raise RuntimeError("no owned recorder")
        if self.proc.returncode is None:
            self.proc.send_signal(signal.SIGINT)
            try:
                await asyncio.wait_for(self.proc.wait(), 6)
            except asyncio.TimeoutError:
                self.proc.kill()
                await asyncio.wait_for(self.proc.wait(), 2)
                raise RuntimeError("encoder stop deadline exceeded")
        await asyncio.wait_for(asyncio.gather(*self.drains), 2)
        self.stopped = {"utc": time.time(), "monotonic": time.monotonic()}
        if self.failure:
            raise RuntimeError(self.failure)
        if self.proc.returncode not in (0, 255):
            raise RuntimeError("encoder failed: " + self.stderr[-1000:].decode(errors="replace"))
        if int(self.progress.get("frame", "0")) < 1:
            raise RuntimeError("encoder produced no frames")
        if int(self.progress.get("drop_frames", "0")) > 0:
            raise RuntimeError("encoder reported dropped frames")
        self.finalized = True
        return {"exitCode": self.proc.returncode, "progress": self.progress,
                "start": self.started, "stop": self.stopped,
                "clockLimit": "process brackets; first encoded frame requires decoded proof"}

    def path(self, kind):
        if kind not in ("video", "snapshot"):
            raise ValueError("invalid file kind")
        return self.root / ("source.mp4" if kind == "video" else "ready.png")

    async def handle(self, request):
        async with self.lock:
            op = request.get("op")
            if op == "fullscreen":
                await self.command(["env", "DISPLAY=:1", "xdotool", "key", "F11"])
                return {"key": "F11"}
            if op == "pointer":
                x, y = request.get("x"), request.get("y")
                if type(x) is not int or type(y) is not int or not 0 <= x < 1920 or not 0 <= y < 1080:
                    raise ValueError("unverified pointer coordinates")
                # --sync waits for a motion event even when already at x/y.
                # Send one move, then verify actual X pointer coordinates instead.
                await self.command(["env", "DISPLAY=:1", "xdotool", "mousemove", str(x), str(y)])
                deadline = time.monotonic() + 0.5
                while True:
                    raw = await self.command(["env", "DISPLAY=:1", "xdotool", "getmouselocation", "--shell"])
                    position = dict(line.split("=", 1) for line in raw.decode().splitlines() if "=" in line)
                    if position.get("X") == str(x) and position.get("Y") == str(y):
                        break
                    if time.monotonic() >= deadline:
                        raise RuntimeError("native pointer position not confirmed")
                    await asyncio.sleep(0.05)
                return {"x": x, "y": y, "kind": "actual native hover", "positionConfirmed": True,
                        "ackMonotonic": time.monotonic()}
            if op == "snapshot":
                await self.command(["ffmpeg", "-nostdin", "-v", "error", "-y", "-f", "x11grab",
                                    "-draw_mouse", "1", "-video_size", "1920x1080", "-i", ":1.0",
                                    "-frames:v", "1", str(self.path("snapshot"))], 8)
                return {"captured": True}
            if op == "allocate":
                if self.proc is not None:
                    raise RuntimeError("recorder already launched")
                return {"guestSource": str(self.path("video")), "launched": False}
            if op == "start":
                duration = request.get("seconds")
                if self.proc is not None or type(duration) is not int or not 5 <= duration <= 120:
                    raise ValueError("one finite recording of 5..120 seconds required")
                self.started = {"utc": time.time(), "monotonic": time.monotonic()}
                self.proc = await asyncio.create_subprocess_exec(
                    "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-n",
                    "-f", "x11grab", "-draw_mouse", "1", "-framerate", "15",
                    "-video_size", "1920x1080", "-i", ":1.0", "-t", str(duration),
                    "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23",
                    "-fps_mode", "passthrough", "-stats_period", "0.25", "-progress", "pipe:1",
                    str(self.path("video")), stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE, start_new_session=True)
                self.drains = [asyncio.create_task(self.drain_progress()),
                               asyncio.create_task(self.drain_stderr()),
                               asyncio.create_task(self.watch_size())]
                deadline = time.monotonic() + 6
                while int(self.progress.get("frame", "0")) < 1:
                    if self.proc.returncode is not None or time.monotonic() > deadline:
                        raise RuntimeError(self.failure or "encoder first-progress deadline")
                    await asyncio.sleep(0.05)
                return {"operational": True, "pid": self.proc.pid, "start": self.started,
                        "note": "progress is not stable-frame proof", "guestSource": str(self.path("video"))}
            if op == "status":
                if self.proc is None or self.proc.returncode is not None:
                    raise RuntimeError("recorder is not running")
                if self.last_progress is None or time.monotonic() - self.last_progress > 2:
                    raise RuntimeError("recorder progress stale")
                return {"running": True, "frames": self.progress.get("frame", "0"),
                        "progressMonotonic": self.last_progress}
            if op == "stop":
                return await self.stop()
            if op in ("info", "read"):
                kind = request.get("kind")
                if kind == "video" and not self.finalized:
                    raise RuntimeError("video is not finalized")
                path = self.path(kind)
                size = path.stat().st_size
                if not 0 < size <= MAX_FILE:
                    raise RuntimeError("file size bound")
                if op == "info":
                    digest = hashlib.sha256()
                    with path.open("rb") as source:
                        while data := source.read(65536):
                            digest.update(data)
                    return {"size": size, "sha256": digest.hexdigest()}
                offset = request.get("offset")
                if type(offset) is not int or not 0 <= offset < size:
                    raise ValueError("invalid file offset")
                with path.open("rb") as source:
                    source.seek(offset)
                    data = source.read(24576)
                return {"offset": offset, "data": base64.b64encode(data).decode()}
            raise ValueError("unknown media operation")

    async def close(self):
        if self.proc is not None and self.proc.returncode is None:
            try:
                await self.stop()
            except Exception:
                if self.proc.returncode is None:
                    self.proc.kill()
                    await asyncio.wait_for(self.proc.wait(), 2)

        if not self.path("video").exists():
            shutil.rmtree(self.root)
