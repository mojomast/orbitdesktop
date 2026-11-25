"""Legacy launcher option B (BEST-PRACTICE item 11): marker, docs and a CI guard.

pc-launcher/launcher.py is frozen at 0.1.9; the maintained worker host is hyvv/launcher.py.
The directory stays (usage ingest, Orbit's test double), but its launcher and PowerShell
scripts may only change on a PR labelled legacy-launcher-ok.
"""
import importlib.util
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("guard", ROOT / "scripts" / "legacy_launcher_guard.py")


def guard():
    mod = importlib.util.module_from_spec(SPEC)
    SPEC.loader.exec_module(mod)
    return mod


class GuardDecision(unittest.TestCase):
    def test_protected_paths(self):
        g = guard()
        for path in ("pc-launcher/launcher.py", "pc-launcher/scripts/start.ps1", "pc-launcher/scripts/common.ps1"):
            self.assertTrue(g.is_protected(path), path)
        for path in ("pc-launcher/scripts/usage_ingest_service.py", "pc-launcher/prices.json",
                     "pc-launcher/tests/test_sdk_contract.py", "hyvv/launcher.py", "launcher.py",
                     "pc-launcher/scripts/sub/x.ps1x"):
            self.assertFalse(g.is_protected(path), path)

    def test_refuses_a_protected_change_without_the_label(self):
        g = guard()
        ok, hits = g.decide(["README.md", "pc-launcher/launcher.py"], [])
        self.assertFalse(ok)
        self.assertEqual(hits, ["pc-launcher/launcher.py"])
        self.assertFalse(g.decide(["pc-launcher/scripts/stop.ps1"], ["bug", "Legacy-Launcher-OK "])[0])

    def test_allows_with_the_exact_label_or_no_protected_change(self):
        g = guard()
        self.assertTrue(g.decide(["pc-launcher/launcher.py"], ["legacy-launcher-ok"])[0])
        self.assertEqual(g.decide(["pc-launcher/scripts/usage_ingest_service.py", "docs/x.md"], []), (True, []))


class MarkerAndDocs(unittest.TestCase):
    def test_deprecated_marker_points_to_hyvv(self):
        text = (ROOT / "pc-launcher" / "DEPRECATED.md").read_text(encoding="utf-8")
        self.assertIn("hyvv/launcher.py", text)
        self.assertIn("0.1.9", text)
        self.assertIn("legacy-launcher-ok", text)

    def test_launcher_header_says_deprecated(self):
        head = (ROOT / "pc-launcher" / "launcher.py").read_text(encoding="utf-8")[:800]
        self.assertRegex(head, r"DEPRECATED.*\n?.*hyvv/launcher\.py")

    def test_local_workers_doc_points_to_hyvv_first(self):
        text = (ROOT / "docs" / "LOCAL_WORKERS.md").read_text(encoding="utf-8")
        first = text[:1500]
        self.assertIn("hyvv", first)
        self.assertIn("DEPRECATED", first)

    def test_server_adapter_comment_names_no_author_machine(self):
        head = (ROOT / "server" / "local-workers.mjs").read_text(encoding="utf-8").splitlines()[0]
        self.assertNotIn("Kyle", head)
        self.assertIn("hyvv", head)

    def test_ci_runs_the_guard_and_gates_on_it(self):
        y = (ROOT / ".github" / "workflows" / "test.yml").read_text(encoding="utf-8")
        self.assertIn("python3 scripts/legacy_launcher_guard.py", y)
        gate = y[y.index("  ci-gate:"):]
        self.assertRegex(gate, r"needs:(\n\s+- [\w-]+)*\n\s+- legacy-launcher-guard")


if __name__ == "__main__":
    unittest.main()
