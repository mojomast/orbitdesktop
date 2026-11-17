"""Inventory-first decomposition guard for Orbit Desktop (PLAN-ONLY).

Validates docs/orbit-inventory.json and docs/orbit-decomposition.md against the
real tree at base da8201617a55f8187642f7e03d6b30b6c3c294e5. Nothing may be
removed by the decomposition task: these tests fail if the inventory drifts
from the tree, if a claimed-unreachable module is actually reachable from
server/index.mjs, if the protected Observatory surfaces disappear, or if the
document omits a required decision section.

Run: python3 -m pytest tests/test_orbit_decomposition.py -q
"""

import json
import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
INVENTORY = ROOT / "docs" / "orbit-inventory.json"
DOC = ROOT / "docs" / "orbit-decomposition.md"

CLASSIFICATIONS = {"KEEP-CORE", "KEEP-PLATFORM", "RETIRE-PROPOSAL", "EXTRACT-PROPOSAL"}
SERVER_DIR = ROOT / "server"
SERVER_FILES = sorted(p.name for p in SERVER_DIR.iterdir() if p.is_file())
EXPECTED_SERVER_COUNT = 151

# Protected surfaces: the deployed Observatory and the campaign surfaces.
# The Observatory is in-repo; the rails proxy and decision queue are external
# campaign surfaces that must NOT exist in this repository.
PROTECTED_IN_REPO = [
    "apps/rizzstack-observatory/index.html",
    "apps/rizzstack-observatory/app.js",
    "apps/rizzstack-observatory/styles.css",
    "extensions/rizzstack-observatory/README.md",
    "contrib/rizzstack-observability/README.md",
    "contrib/rizzstack-observability/usage-ingest.service",
    "plugin-catalog/schema.json",
]

# Routes the operator mission depends on; each must remain wired in index.mjs.
CORE_ROUTES = [
    "/api/workspace",
    "/api/workspace/control",
    "/api/workspace/recovery",
    "/api/workspace/events",
    "/api/agent",
    "/api/terminal",
    "/api/health",
    "/api/auth",
    "/api/technology-capabilities",
    "/api/workbench",
    "/api/managed-terminals",
    "/api/grokbots-app",
]


def load_inventory():
    if not INVENTORY.exists():
        pytest.fail(
            "docs/orbit-inventory.json is missing: the decomposition inventory "
            "has not been produced yet (RED phase)."
        )
    return json.loads(INVENTORY.read_text())


def module_loc(rel: str) -> int:
    return len((ROOT / rel).read_text(errors="replace").splitlines())


def compute_reachable_from_index() -> set:
    """Independently recompute the server module closure of server/index.mjs.

    Covers static imports, dynamic import() and URL references used to spawn
    helper scripts (colab job worker, knowledge embed worker, workbench test
    runner), mirroring how the runtime actually reaches modules.
    """
    imp = re.compile(r"""['"](\.{1,2}/[A-Za-z0-9_./-]+\.mjs)['"]""")
    names = {n for n in SERVER_FILES if n.endswith(".mjs")}
    deps = {}
    for name in names:
        deps[name] = {
            m.group(1).split("/")[-1]
            for m in imp.finditer((SERVER_DIR / name).read_text(errors="replace"))
            if m.group(1).split("/")[-1] in names
        }
    seen = set()
    frontier = ["index.mjs"]
    while frontier:
        cur = frontier.pop()
        if cur in seen:
            continue
        seen.add(cur)
        frontier.extend(deps.get(cur, ()))
    return seen


@pytest.fixture(scope="module")
def inventory():
    return load_inventory()


# --------------------------------------------------------------------------
# Inventory completeness against the real tree
# --------------------------------------------------------------------------


def test_server_inventory_is_complete():
    inv = load_inventory()
    listed = set(inv["server_modules"])
    actual = set(SERVER_FILES)
    assert listed == actual, (
        f"inventory drift — missing from inventory: {sorted(actual - listed)}; "
        f"listed but absent from tree: {sorted(listed - actual)}"
    )
    assert len(actual) == EXPECTED_SERVER_COUNT


def test_nothing_was_removed_by_the_decomposition():
    # PLAN-ONLY: every module on disk must still exist and the count must not
    # have shrunk below the base revision's 151.
    assert len(SERVER_FILES) == EXPECTED_SERVER_COUNT
    for name in SERVER_FILES:
        assert (SERVER_DIR / name).is_file(), f"module removed from tree: {name}"


def test_every_module_has_classification_and_evidence(inventory):
    for name, entry in inventory["server_modules"].items():
        assert entry["classification"] in CLASSIFICATIONS, f"{name}: bad class"
        for field in ("loc", "family", "reachable_from_index", "consumers", "tests"):
            assert field in entry, f"{name}: missing evidence field {field}"
        assert isinstance(entry["loc"], int) and entry["loc"] > 0, f"{name}: loc"
        assert entry["evidence"], f"{name}: missing evidence note"


def test_recorded_loc_matches_real_files(inventory):
    for name, entry in inventory["server_modules"].items():
        real = module_loc(f"server/{name}")
        assert entry["loc"] == real, (
            f"{name}: inventory loc {entry['loc']} != actual {real}"
        )


def test_classification_counts_sum_to_module_total(inventory):
    counts = inventory["classification_counts"]
    assert sum(counts.values()) == len(SERVER_FILES) == EXPECTED_SERVER_COUNT
    for cls in CLASSIFICATIONS:
        assert cls in counts


# --------------------------------------------------------------------------
# Reachability and route wiring evidence
# --------------------------------------------------------------------------


def test_unreachable_claims_match_recomputed_closure(inventory):
    reachable = compute_reachable_from_index()
    claimed_unreachable = set(inventory["unreachable_from_index"])
    assert claimed_unreachable == (set(SERVER_FILES) & {n for n in SERVER_FILES if n.endswith(".mjs")}) - reachable, (
        "unreachable_from_index disagrees with a fresh import scan:\n"
        f"claimed unreachable but reachable: {sorted(claimed_unreachable & reachable)}\n"
        f"reachable but claimed unreachable: {sorted(reachable ^ claimed_unreachable & reachable)}"
    )
    for name, entry in inventory["server_modules"].items():
        if name.endswith(".mjs"):
            assert entry["reachable_from_index"] == (name in reachable), name


def test_retire_proposals_are_justified_by_evidence(inventory):
    # A RETIRE-PROPOSAL must cite at least one hard signal: unreachable from
    # the composition root, zero server consumers, or an explicit superseded
    # marker in its evidence note.
    for name, entry in inventory["server_modules"].items():
        if entry["classification"] != "RETIRE-PROPOSAL":
            continue
        note = entry["evidence"].lower()
        hard = (
            not entry["reachable_from_index"]
            or not [c for c in entry["consumers"] if c.startswith("server/")]
            or "unwired" in note
            or "superseded" in note
            or "test-only" in note
            or "orphan" in note
            or "entertainment" in note
            or "demo script" in note
            or "out of mission" in note
        )
        assert hard, f"{name}: RETIRE-PROPOSAL without hard evidence"


def test_core_routes_are_wired(inventory):
    index_text = (SERVER_DIR / "index.mjs").read_text()
    missing = [r for r in CORE_ROUTES if r not in index_text]
    assert not missing, f"core routes missing from server/index.mjs: {missing}"


# --------------------------------------------------------------------------
# Apps, areas, families
# --------------------------------------------------------------------------


def test_app_inventory_matches_tree(inventory):
    actual_apps = sorted(p.name for p in (ROOT / "apps").iterdir() if p.is_dir())
    listed = [a["slug"] for a in inventory["apps"]]
    assert sorted(listed) == actual_apps
    by_slug = {a["slug"]: a for a in inventory["apps"]}
    assert by_slug["rizzstack-observatory"]["protected"] is True
    assert by_slug["grokbots"]["builtin"] is True


def test_family_loc_sums_match_members(inventory):
    fams = {}
    for name, entry in inventory["server_modules"].items():
        fams.setdefault(entry["family"], {"loc": 0, "count": 0})
        fams[entry["family"]]["loc"] += entry["loc"]
        fams[entry["family"]]["count"] += 1
    for fam, agg in fams.items():
        claimed = inventory["families"].get(fam)
        assert claimed is not None, f"family {fam} missing from families section"
        assert claimed["loc"] == agg["loc"], f"{fam}: loc sum drift"
        assert claimed["count"] == agg["count"], f"{fam}: member count drift"


def test_top_level_areas_listed(inventory):
    actual = sorted(
        p.name for p in ROOT.iterdir() if p.is_dir() and not p.name.startswith(".")
    )
    listed = sorted(a["area"] for a in inventory["areas"])
    assert listed == actual, f"area drift: {sorted(set(actual) ^ set(listed))}"


# --------------------------------------------------------------------------
# Protected surfaces
# --------------------------------------------------------------------------


def test_protected_observatory_surfaces_exist():
    for rel in PROTECTED_IN_REPO:
        assert (ROOT / rel).is_file(), f"protected surface missing: {rel}"


def test_campaign_surfaces_are_external_and_untouched(inventory):
    protected = inventory["protected_surfaces"]
    assert protected["observatory"]["status"] == "protected-in-repo"
    for name in ("rails_proxy", "decision_queue"):
        entry = protected[name]
        assert entry["status"] == "protected-external"
        assert entry["in_repo"] is False


# --------------------------------------------------------------------------
# Decomposition document
# --------------------------------------------------------------------------


def test_document_has_required_sections():
    if not DOC.exists():
        pytest.fail("docs/orbit-decomposition.md is missing (RED phase).")
    text = DOC.read_text()
    required = [
        "## 1. Scope and method",
        "## 2. What is load-bearing",
        "## 3. Inventory",
        "## 4. Classification",
        "## 5. Bloat report",
        "## 6. Extraction plan",
        "## 7. Retirement sequence",
        "## 8. Owner decision checklist",
        "Protected surfaces",
    ]
    missing = [s for s in required if s not in text]
    assert not missing, f"document missing sections: {missing}"


def test_document_counts_match_inventory(inventory):
    text = DOC.read_text()
    counts = inventory["classification_counts"]
    for cls, n in counts.items():
        assert f"{cls}: {n}" in text or f"{cls}** — {n}" in text or re.search(
            rf"{re.escape(cls)}\D{{0,40}}\b{n}\b", text
        ), f"document does not state {cls}: {n}"


def test_document_decisions_cover_every_retire_and_extract(inventory):
    text = DOC.read_text()
    for name, entry in inventory["server_modules"].items():
        if entry["classification"] in ("RETIRE-PROPOSAL", "EXTRACT-PROPOSAL"):
            assert f"`server/{name}`" in text, (
                f"decision checklist does not mention server/{name}"
            )
