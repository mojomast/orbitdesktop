"""Launcher fixes: LF-exact project export (CRLF bug) and stop/start killing the python child.
Run: python3 pc-launcher/tests/test_export_and_scripts.py   (no cua, no network)"""
import io, json, os, subprocess, sys, tarfile, tempfile, unittest
from pathlib import Path
from unittest import mock
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.modules.setdefault("cua", mock.MagicMock())  # export/pidfile helpers need no SDK
import launcher  # noqa: E402

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"

class ExportProject(unittest.TestCase):
    def test_archive_is_lf_exact_even_with_autocrlf_true(self):
        with tempfile.TemporaryDirectory() as d:
            g = ["git", "-C", d]
            subprocess.run(g + ["init", "-q"], check=True)
            subprocess.run(g + ["config", "core.autocrlf", "true"], check=True)  # what a Windows clone has
            body = b"line one\nline two\n"
            Path(d, "a.txt").write_bytes(body)
            subprocess.run(g + ["add", "a.txt"], check=True)
            subprocess.run(g + ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "x"], check=True)
            # Precondition: plain git archive really does emit CRLF here (the bug).
            raw = subprocess.run(g + ["archive", "--format=tar", "HEAD"], capture_output=True, check=True).stdout
            self.assertIn(b"\r\n", tarfile.open(fileobj=io.BytesIO(raw)).extractfile("a.txt").read())
            rev, tar = launcher.export_project(d)
            self.assertEqual(len(rev), 40)
            self.assertEqual(tarfile.open(fileobj=io.BytesIO(tar)).extractfile("a.txt").read(), body)

class PidFileAndScripts(unittest.TestCase):
    def test_serve_records_python_pid(self):
        with tempfile.TemporaryDirectory() as d:
            pf = launcher.write_pidfile({"data_dir": d})
            self.assertEqual(pf.read_text(), str(os.getpid()))
            self.assertEqual(pf.name, "launcher.py.pid")

    def test_stop_kills_child_and_start_cleans_stale(self):
        common = (SCRIPTS / "common.ps1").read_text()
        stop = (SCRIPTS / "stop.ps1").read_text()
        start = (SCRIPTS / "start.ps1").read_text()
        self.assertIn("launcher.py.pid", common)
        self.assertIn("CommandLine", common)            # matches the python child, not just uv
        self.assertIn("Stop-Launcher", stop)
        self.assertIn("Get-LauncherProcesses", stop)    # verifies nothing is left
        self.assertIn("Stop-Launcher", start)           # stale cleanup before start
        self.assertIn("Get-NetTCPConnection", start)    # refuses when the port is taken
        self.assertLess(start.index("Get-NetTCPConnection"), start.index("Start-Process"))

if __name__ == "__main__":
    unittest.main()
