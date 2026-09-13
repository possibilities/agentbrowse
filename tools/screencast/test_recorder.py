"""Real subprocess/pipe failure regressions; fake encoder is explicitly not film proof."""
import asyncio
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from recorder import Media


class RecorderTests(unittest.IsolatedAsyncioTestCase):
    async def test_repeated_pointer_position_is_read_back_without_motion_wait(self):
        with tempfile.TemporaryDirectory() as directory:
            executable = Path(directory) / 'xdotool'
            executable.write_text('#!/bin/sh\ncase "$*" in *--sync*) exit 9;; esac\nif [ "$1" = getmouselocation ]; then printf "X=100\\nY=200\\n"; fi\n')
            executable.chmod(0o700)
            with patch.dict(os.environ, {'PATH': directory + ':' + os.environ['PATH']}):
                media = Media()
                try:
                    for _ in range(2):
                        result = await media.handle({'op': 'pointer', 'x': 100, 'y': 200})
                        self.assertTrue(result['positionConfirmed'])
                    with self.assertRaisesRegex(RuntimeError, 'position not confirmed'):
                        await media.handle({'op': 'pointer', 'x': 101, 'y': 200})
                finally:
                    await media.close()

    async def test_source_allocation_precedes_launch_and_survives_lost_reply(self):
        media = Media()
        try:
            receipt = await media.handle({'op': 'allocate'})
            self.assertFalse(receipt['launched'])
            self.assertIsNone(media.proc)
            self.assertEqual(receipt['guestSource'], str(media.path('video')))
            self.assertEqual(receipt, await media.handle({'op': 'allocate'}))
        finally:
            await media.close()

    async def test_status_rejects_normal_exit_and_stale_progress(self):
        from types import SimpleNamespace
        import time
        media = Media()
        try:
            media.proc = SimpleNamespace(returncode=0)
            media.last_progress = time.monotonic()
            with self.assertRaisesRegex(RuntimeError, 'not running'):
                await media.handle({'op': 'status'})
            media.proc = SimpleNamespace(returncode=None)
            media.last_progress = time.monotonic() - 3
            with self.assertRaisesRegex(RuntimeError, 'progress stale'):
                await media.handle({'op': 'status'})
        finally:
            media.proc = None
            await media.close()

    async def test_stderr_backpressure_and_owned_stop(self):
        with tempfile.TemporaryDirectory() as directory:
            executable = Path(directory) / 'ffmpeg'
            executable.write_text('''#!/usr/bin/env python3
import os,signal,time,sys
signal.signal(signal.SIGINT,lambda *_:sys.exit(255))
os.write(1,b'frame=1\\ndrop_frames=0\\nprogress=continue\\n')
for _ in range(256): os.write(2,b'x'*16384)
os.write(1,b'frame=2\\nprogress=continue\\n')
time.sleep(30)
''')
            executable.chmod(0o700)
            with patch.dict(os.environ, {'PATH': directory + ':' + os.environ['PATH']}):
                media = Media()
                try:
                    result = await media.handle({'op': 'start', 'seconds': 10})
                    self.assertTrue(result['operational'])
                    deadline = asyncio.get_running_loop().time() + 15
                    while media.progress.get('frame') != '2':
                        self.assertLess(asyncio.get_running_loop().time(), deadline)
                        await asyncio.sleep(0.05)
                    self.assertEqual(media.stderr_bytes, 4 * 1024 * 1024)
                    result = await media.stop()
                    self.assertEqual(result['exitCode'], 255)
                    self.assertLessEqual(len(media.stderr), 16384)
                    self.assertIsNotNone(media.proc.returncode)
                finally:
                    await media.close()

    async def test_crashed_encoder_never_finalizes(self):
        with tempfile.TemporaryDirectory() as directory:
            executable = Path(directory) / 'ffmpeg'
            executable.write_text('#!/bin/sh\nexit 7\n')
            executable.chmod(0o700)
            with patch.dict(os.environ, {'PATH': directory + ':' + os.environ['PATH']}):
                media = Media()
                try:
                    with self.assertRaises(RuntimeError):
                        await media.handle({'op': 'start', 'seconds': 10})
                    self.assertFalse(media.finalized)
                    with self.assertRaises(RuntimeError):
                        await media.handle({'op': 'info', 'kind': 'video'})
                finally:
                    await media.close()

    async def test_uncooperative_owned_encoder_is_killed_and_reaped(self):
        with tempfile.TemporaryDirectory() as directory:
            executable = Path(directory) / 'ffmpeg'
            executable.write_text("#!/usr/bin/env python3\nimport os,signal,time\nsignal.signal(signal.SIGINT,signal.SIG_IGN)\nos.write(1,b'frame=1\\ndrop_frames=0\\n')\ntime.sleep(30)\n")
            executable.chmod(0o700)
            with patch.dict(os.environ, {'PATH': directory + ':' + os.environ['PATH']}):
                media = Media()
                try:
                    await media.handle({'op': 'start', 'seconds': 10})
                    started = asyncio.get_running_loop().time()
                    with self.assertRaisesRegex(RuntimeError, 'stop deadline'):
                        await media.stop()
                    self.assertLess(asyncio.get_running_loop().time() - started, 9)
                    self.assertIsNotNone(media.proc.returncode)
                    self.assertFalse(media.finalized)
                finally:
                    await media.close()

    async def test_source_size_limit_stops_owned_encoder(self):
        with tempfile.TemporaryDirectory() as directory:
            executable = Path(directory) / 'ffmpeg'
            executable.write_text("#!/usr/bin/env python3\nimport os,sys,time\nos.write(1,b'frame=1\\n')\nf=open(sys.argv[-1],'wb');f.truncate(256*1024*1024+1);f.close()\ntime.sleep(30)\n")
            executable.chmod(0o700)
            with patch.dict(os.environ, {'PATH': directory + ':' + os.environ['PATH']}):
                media = Media()
                try:
                    try:
                        await media.handle({'op': 'start', 'seconds': 10})
                    except RuntimeError:
                        pass
                    await asyncio.sleep(0.5)
                    with self.assertRaisesRegex(RuntimeError, 'source size limit'):
                        await media.stop()
                    self.assertIsNotNone(media.proc.returncode)
                    self.assertFalse(media.finalized)
                finally:
                    await media.close()
                    media.path('video').unlink(missing_ok=True)

    async def test_arbitrary_file_and_pointer_rejected(self):
        media = Media()
        with self.assertRaises(ValueError):
            await media.handle({'op': 'pointer', 'x': -1, 'y': 0})
        with self.assertRaises(ValueError):
            await media.handle({'op': 'read', 'kind': '/etc/passwd', 'offset': 0})
        await media.close()


if __name__ == '__main__':
    unittest.main()
