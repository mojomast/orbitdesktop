"""Rails R03 acceptance gate: vendored vibeline reference material.

Upstream: https://github.com/listeningpost/vibeline, pinned at
d5d0f425a64906ae1a50c1222314a5420da404d5 (MIT, Copyright (c) 2026
ListeningPost).

The tree under contrib/vibeline/ is inert reference material. This suite
verifies it by bytes only: it never imports, executes, installs or spawns
any upstream module or entrypoint, and it statically proves that no
auto-run hook exists in the vendored subset and that the web asset is
plain readable text with no node dependency.
"""

import hashlib
import json
import stat
import sys
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
VENDOR_DIR = REPO_ROOT / "contrib" / "vibeline"
PROVENANCE_PATH = VENDOR_DIR / "PROVENANCE.json"

UPSTREAM_REPO = "https://github.com/listeningpost/vibeline"
UPSTREAM_PIN = "d5d0f425a64906ae1a50c1222314a5420da404d5"
MIT_COPYRIGHT_LINE = "Copyright (c) 2026 ListeningPost"

VENDORED_FILES = (
    "README.md",
    "LICENSE",
    "ledger.py",
    "rails.py",
    "web.py",
    "sessions.py",
    "swarm.py",
    "shell.py",
    "feedback.py",
    "rewind.py",
    "web/index.html",
)
# Top-level directory entries: the nine vendored files that live at the
# root, plus the web/ asset directory and the provenance manifest itself.
TOP_LEVEL_ENTRIES = frozenset(
    name for name in VENDORED_FILES if "/" not in name
) | {"web", "PROVENANCE.json"}

# Byte signatures of auto-run / install-time hooks. None of these may
# appear anywhere in the vendored subset: the copies are inert reference
# material and must not wire themselves to run at install or startup time.
# (The upstream direct-execution hook lives in __main__.py and cli.py,
# which are deliberately NOT part of the vendored subset.)
AUTO_RUN_HOOK_SIGNATURES = (
    b"if __name__",      # direct-execution hook
    b"console_scripts",  # setuptools install-time entry point
    b"entry_points",     # packaging entry points
    b"setuptools",       # install machinery
    b'"scripts"',        # npm-style lifecycle hooks
    b"postinstall",      # npm install hook
    b"preinstall",       # npm install hook
    b"uvicorn",          # server autostart wiring
)

# The explicit statement PROVENANCE.json must carry about runtime behavior.
NOTHING_EXECUTED_PHRASE = "nothing upstream is executed by orbit at runtime"


def _read_provenance():
    with PROVENANCE_PATH.open("r", encoding="utf-8") as fh:
        return json.load(fh)


def _sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(65536), b""):
            digest.update(chunk)
    return digest.hexdigest()


class RailsVendorProvenanceTest(unittest.TestCase):
    """PROVENANCE.json records the exact pin, fetch method and digests."""

    def setUp(self):
        if not PROVENANCE_PATH.is_file():
            self.fail(
                "contrib/vibeline/PROVENANCE.json is missing: the vendored "
                "vibeline reference material has not been vendored yet"
            )

    def test_provenance_manifest_present_with_exact_pin(self):
        provenance = _read_provenance()
        upstream = provenance.get("upstream")
        self.assertIsInstance(upstream, dict, "upstream section missing")
        self.assertEqual(upstream.get("repo"), UPSTREAM_REPO)
        self.assertEqual(upstream.get("pin"), UPSTREAM_PIN)

    def test_provenance_records_fetch_method_and_license(self):
        provenance = _read_provenance()
        upstream = provenance["upstream"]
        fetch_method = upstream.get("fetch_method")
        self.assertIsInstance(fetch_method, str)
        self.assertGreater(
            len(fetch_method.strip()),
            20,
            "fetch_method must describe how the pin was fetched",
        )
        self.assertEqual(upstream.get("license"), "MIT")
        self.assertEqual(upstream.get("copyright"), MIT_COPYRIGHT_LINE)

    def test_provenance_records_explicit_nothing_executed_statement(self):
        provenance = _read_provenance()
        policy = provenance.get("execution_policy")
        self.assertIsInstance(policy, str)
        self.assertIn(NOTHING_EXECUTED_PHRASE, policy.lower())


class RailsVendorTreeTest(unittest.TestCase):
    """The vendored tree is exactly the leased, inert, digest-verified set."""

    def setUp(self):
        if not VENDOR_DIR.is_dir():
            self.fail(
                "contrib/vibeline/ is missing: the vendored vibeline "
                "reference material has not been vendored yet"
            )

    def test_vendored_tree_contains_exactly_the_leased_files(self):
        top_level = {entry.name for entry in VENDOR_DIR.iterdir()}
        self.assertEqual(
            top_level,
            TOP_LEVEL_ENTRIES,
            "contrib/vibeline/ must hold exactly the leased files",
        )
        web_dir = VENDOR_DIR / "web"
        self.assertTrue(web_dir.is_dir())
        self.assertEqual(
            {entry.name for entry in web_dir.iterdir()},
            {"index.html"},
            "contrib/vibeline/web/ must hold exactly index.html",
        )
        for rel_path in VENDORED_FILES:
            path = VENDOR_DIR / rel_path
            self.assertTrue(path.is_file(), f"{rel_path} must be a file")
            mode = path.stat().st_mode
            self.assertFalse(
                mode & (stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH),
                f"{rel_path} must not be executable",
            )

    def test_every_vendored_file_digest_matches_manifest(self):
        provenance = _read_provenance()
        manifest = provenance.get("files")
        self.assertIsInstance(manifest, list, "files manifest missing")
        recorded = {entry["path"]: entry for entry in manifest}
        self.assertEqual(
            set(recorded),
            set(VENDORED_FILES),
            "manifest must cover exactly the vendored files",
        )
        for rel_path, entry in recorded.items():
            digest = entry.get("sha256", "")
            self.assertRegex(digest, r"^[0-9a-f]{64}$")
            self.assertEqual(
                digest,
                _sha256_of(VENDOR_DIR / rel_path),
                f"{rel_path} is not byte-identical to the recorded digest",
            )
            expected_bytes = entry.get("bytes")
            if expected_bytes is not None:
                self.assertEqual(
                    expected_bytes,
                    (VENDOR_DIR / rel_path).stat().st_size,
                    f"{rel_path} byte count drifted from the manifest",
                )

    def test_license_present_with_mit_copyright_line(self):
        license_bytes = (VENDOR_DIR / "LICENSE").read_bytes()
        license_text = license_bytes.decode("utf-8")
        self.assertTrue(license_text.startswith("MIT License"))
        self.assertIn(MIT_COPYRIGHT_LINE, license_text)

    def test_no_auto_run_hook_in_vendored_bytes(self):
        for rel_path in VENDORED_FILES:
            payload = (VENDOR_DIR / rel_path).read_bytes()
            for signature in AUTO_RUN_HOOK_SIGNATURES:
                self.assertNotIn(
                    signature,
                    payload,
                    f"{rel_path} contains auto-run hook bytes {signature!r}",
                )

    def test_web_index_inspectable_without_node(self):
        payload = (VENDOR_DIR / "web" / "index.html").read_bytes()
        self.assertGreater(len(payload), 0)
        text = payload.decode("utf-8")
        self.assertIn("<!DOCTYPE html>", text)
        self.assertIn("<html", text)
        self.assertNotIn("node_modules", text)
        self.assertNotIn("require(", text)

    def test_suite_never_imported_vendored_modules(self):
        vendor_root = str(VENDOR_DIR)
        for name, module in list(sys.modules.items()):
            module_file = getattr(module, "__file__", None)
            if module_file:
                self.assertFalse(
                    str(Path(module_file).resolve()).startswith(vendor_root),
                    f"vendored module {name} was imported: the gate must "
                    "inspect the vendored bytes only",
                )


if __name__ == "__main__":
    unittest.main()
