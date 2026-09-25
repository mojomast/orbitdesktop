"""Single persistent subprocess, bounded requests, crash recovery and idle release."""
import atexit
import json
import os
from pathlib import Path
import selectors
import subprocess
import threading
import time

BASE = Path('/home/mojo/.hermes-instances/fresh/workspace/supra2-service')


class WarmWorker:
    def __init__(self, threads=16, idle_seconds=600, timeout=240, command=None):
        self.threads = threads
        self.idle_seconds = idle_seconds
        self.timeout = timeout
        self.command = command or [str(BASE / '.venv/bin/python'), '-u', str(Path(__file__).with_name('worker.py'))]
        self.process = None
        self.lock = threading.Lock()
        self.last_used = 0
        self.ready = False
        self.closed = threading.Event()
        threading.Thread(target=self._reaper, daemon=True).start()
        atexit.register(self.close)

    def _stop(self):
        p, self.process = self.process, None
        self.ready = False
        if p is not None:
            if p.poll() is None:
                p.terminate()
                try:
                    p.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    p.kill()
                    p.wait()
            p.stdin.close()
            p.stdout.close()

    def close(self):
        self.closed.set()
        with self.lock:
            self._stop()

    def _reaper(self):
        while not self.closed.wait(1):
            if self.lock.acquire(blocking=False):
                try:
                    if self.process and time.monotonic()-self.last_used >= self.idle_seconds:
                        self._stop()
                finally:
                    self.lock.release()

    def status(self):
        p = self.process
        return {'loaded': bool(self.ready and p and p.poll() is None), 'threads': self.threads, 'idle_unload_seconds': self.idle_seconds}

    def generate(self, request):
        with self.lock:
            warm = bool(self.ready and self.process and self.process.poll() is None)
            try:
                if not self.process or self.process.poll() is not None:
                    self._stop()
                    env = dict(os.environ, HF_HOME=str(BASE / '.cache/huggingface'), HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1', OMP_NUM_THREADS=str(self.threads), MKL_NUM_THREADS=str(self.threads), OPENBLAS_NUM_THREADS=str(self.threads), TOKENIZERS_PARALLELISM='false', CUDA_VISIBLE_DEVICES='')
                    self.process = subprocess.Popen(self.command, cwd=BASE, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
                p = self.process
                p.stdin.write((json.dumps(request)+'\n').encode())
                p.stdin.flush()
                deadline = time.monotonic()+self.timeout
                data = b''
                with selectors.DefaultSelector() as selector:
                    selector.register(p.stdout, selectors.EVENT_READ)
                    while b'\n' not in data:
                        remaining = deadline-time.monotonic()
                        if remaining <= 0 or not selector.select(remaining):
                            raise subprocess.TimeoutExpired(self.command, self.timeout)
                        chunk = os.read(p.stdout.fileno(), 4096)
                        if not chunk:
                            raise RuntimeError('Worker exited')
                        data += chunk
                        if len(data) > 4096:
                            raise RuntimeError('Invalid worker response')
                result = json.loads(data)
                if result.get('ok') is not True:
                    raise RuntimeError('Generation failed')
                self.ready = True
                self.last_used = time.monotonic()
                return dict(result, warm=warm, threads=self.threads)
            except Exception:
                self._stop()
                raise
