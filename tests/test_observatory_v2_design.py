"""Admission tests for the Observatory v2 design spike (DESIGN-v2.md + mockup-v2/).

The spike is a design deliverable, not a shipped catalog app: the design doc
must carry the researched best-practice basis with citations, and the mockup
must be a fully clickable static no-build bundle with fake data that
implements the documented interaction contract (L0 overview -> drill-down,
RED above USE, burn-rate thresholds drawn on charts, deploy markers,
color = state only, keyboard navigation, reduced motion, dark-first tokens,
empty/stale/degraded states, owner-gated control surface with an audited F6
action queue).
"""
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / 'apps' / 'rizzstack-observatory'
DESIGN = APP / 'DESIGN-v2.md'
MOCKUP = APP / 'mockup-v2'
FILES = ('index.html', 'styles.css', 'app.js')


def source(name):
    return (MOCKUP / name).read_text()


def joined():
    return ''.join(source(name) for name in FILES)


class DesignDoc(unittest.TestCase):
    def test_design_doc_exists_and_cites_research(self):
        self.assertTrue(DESIGN.is_file())
        text = DESIGN.read_text()
        for expected in (
            'Google SRE', 'SRE Workbook', 'Grafana', 'aiAxonIQ',
            'RED', 'USE', 'drill-down', 'burn', 'threshold', 'deploy marker',
            'One question per view', 'custom elements', 'SSE', 'SVG',
            '34 KB', '70 KB', 'no-build',
        ):
            self.assertIn(expected, text, 'design doc must cite: ' + expected)

    def test_design_doc_defines_the_layered_view_map(self):
        text = DESIGN.read_text()
        for view in ('overview', 'fleet', 'usage', 'pipeline', 'backlog',
                     'topology', 'control'):
            self.assertIn(view, text)
        for stage in ('checkout', 'main', 'installed', 'loaded', 'deployed'):
            self.assertIn(stage, text, 'parity map stage: ' + stage)
        self.assertIn('UNKNOWN', text)
        self.assertIn('4 repos', text)

    def test_design_doc_specifies_interaction_and_mutation_contract(self):
        text = DESIGN.read_text()
        for expected in (
            'keyboard', 'prefers-reduced-motion', 'token', 'Empty',
            'stale', 'degraded', 'optimistic', 'Revert', 'Reconcile',
            'F6', 'owner-authenticated', 'fenced', 'audit', 'reason',
        ):
            self.assertIn(expected, text, 'design doc must specify: ' + expected)
        self.assertIn('never mutates through an open endpoint', text)


class MockupBundle(unittest.TestCase):
    def test_mockup_files_present_and_small(self):
        self.assertTrue(MOCKUP.is_dir())
        self.assertEqual(sorted(item.name for item in MOCKUP.iterdir()), sorted(FILES))
        total = 0
        for name in FILES:
            path = MOCKUP / name
            self.assertFalse(path.is_symlink(), name + ' must not be a symlink')
            self.assertTrue(path.is_file())
            total += path.stat().st_size
        self.assertLess(total, 100 * 1024, 'mockup must stay under the 100 KB asset budget')

    def test_mockup_references_the_design_doc(self):
        html = source('index.html')
        self.assertIn('DESIGN-v2.md', html)
        self.assertIn('DESIGN-v2.md', source('app.js'))
        self.assertIn('DESIGN-v2.md', source('styles.css'))

    def test_no_external_urls_or_cdns(self):
        for name in FILES:
            text = source(name)
            self.assertNotIn('http://', text, name)
            self.assertNotIn('https://', text, name)
            self.assertNotIn('src="//', text, name)
        html = source('index.html')
        refs = re.findall(r'(?:src|href)\s*=\s*"([^"]+)"', html)
        for ref in refs:
            self.assertTrue(ref.startswith('./') or ref.startswith('#'),
                            'only relative or in-page refs allowed, got: ' + ref)
        self.assertEqual(set(refs), {'./styles.css', './app.js', '#main'})
        scripts = re.findall(r'<script\b([^>]*)>', html)
        self.assertEqual(len(scripts), 1)
        self.assertIn('src="./app.js"', scripts[0])
        self.assertIn('type="module"', scripts[0])
        css = source('styles.css')
        self.assertNotIn('@import', css)
        self.assertNotIn('url(', css)

    def test_no_build_step_and_no_framework(self):
        for name in FILES:
            text = source(name)
            self.assertNotRegex(text, r'(?i)\b(webpack|vite|rollup|esbuild|babel|parcel)\b', name)
            self.assertNotIn('npm run', text, name)
            self.assertNotIn('node_modules', text, name)
        self.assertNotRegex(source('app.js'), r"import\s+.+\s+from\s+['\"]")
        self.assertNotRegex(joined(), r'(?i)\b(react|vue|angular|svelte|jquery)\b')
        self.assertNotIn('console.', source('app.js'))
        for existing in ('package.json', 'node_modules'):
            self.assertFalse((MOCKUP / existing).exists())

    def test_svg_charts_with_thresholds_and_deploy_markers(self):
        app = source('app.js')
        self.assertIn('<svg', app)
        self.assertIn('ch-threshold', app)
        self.assertIn('ch-marker', app)
        self.assertIn('aria-label', app)
        self.assertIn('deploy', app)

    def test_color_is_state_only_via_tokens(self):
        css = source('styles.css')
        self.assertIn(':root', css)
        self.assertIn('--ok:', css)
        self.assertIn('--warn:', css)
        self.assertIn('--bad:', css)
        self.assertIn('--unknown:', css)
        self.assertIn('#0d0f14', css)
        self.assertIn('#11141b', css)
        self.assertIn('#232733', css)
        self.assertIn('#6d8cff', css)
        self.assertIn('#54e6c6', css)
        self.assertIn('prefers-color-scheme:light', css)
        self.assertIn(':focus-visible', css)
        self.assertIn('.visually-hidden', css)

    def test_reduced_motion_is_respected(self):
        css = source('styles.css')
        self.assertIn('prefers-reduced-motion', css)
        self.assertIn('animation:none', css)

    def test_keyboard_navigation_wiring(self):
        html = source('index.html')
        app = source('app.js')
        self.assertIn('role="tablist"', html)
        self.assertEqual(html.count('role="tab"'), 7)
        self.assertEqual(html.count('role="tabpanel"'), 7)
        self.assertIn('aria-selected', html)
        self.assertIn('data-goto="control"', html)
        self.assertIn("addEventListener('keydown'", app)
        self.assertIn("event.key === 'Escape'", app)
        self.assertIn("'ArrowRight'", app)
        self.assertIn('tabIndex', app)
        self.assertIn('aria-live', html)
        self.assertIn('skip-link', html)
        for button in re.findall(r'<button\b([^>]*)>', html):
            self.assertIn('type=', button, 'every button declares an explicit type')
        self.assertNotIn('onclick', html)

    def test_views_and_fake_data_states(self):
        app = source('app.js')
        html = source('index.html')
        for view in ('overview', 'fleet', 'usage', 'pipeline', 'backlog',
                     'topology', 'control'):
            self.assertIn('panel-' + view, html)
        for scenario in ('normal', 'stale', 'degraded', 'empty'):
            self.assertIn('data-scenario="' + scenario + '"', html)
            self.assertIn("'" + scenario + "'", app)
        for marker in ('UNKNOWN', 'STALE', 'DEGRADED', 'NO DATA', 'empty-state'):
            self.assertIn(marker, app)
        self.assertIn('fake', html.lower())
        self.assertNotIn('fetch(', app)
        self.assertNotIn('XMLHttpRequest', app)
        self.assertNotRegex(app, r'new\s+EventSource')

    def test_topology_parity_map_covers_four_repos_and_five_stages(self):
        app = source('app.js')
        for repo in ('orbitdesktop', 'rizzstack-gateway', 'mojomast/hyvv',
                     'rizzstack-collector'):
            self.assertIn("'" + repo + "'", app)
        self.assertEqual(app.count("stage: '"), 20, '4 repos x 5 stages')
        for stage in ('checkout', 'main', 'installed', 'loaded', 'deployed'):
            self.assertIn("stage: '" + stage + "'", app)
        for cell_state in ('ok', 'warn', 'bad', 'unknown'):
            self.assertIn("state: '" + cell_state + "'", app)

    def test_control_surface_owner_gate_queue_and_audit(self):
        app = source('app.js')
        html = source('index.html')
        self.assertIn('id="owner-gate"', html)
        self.assertIn('Unlock as owner', app)
        self.assertIn('fq-', app)
        self.assertIn('queue-body', html)
        self.assertIn('audit-body', html)
        self.assertIn('Reason (required)', app)
        self.assertIn('owner API → F6', app)
        self.assertIn("role=\"switch\"", app)
        self.assertIn('aria-checked', app)
        self.assertIn('disabled', app)
        self.assertIn("state.rejectOpen", app)
        self.assertIn('reverted', app)

    def test_mutations_never_route_through_an_open_endpoint(self):
        app = source('app.js')
        self.assertIn('fenced', app)
        self.assertIn('audit(', app)
        self.assertIn("enqueue(", app)
        self.assertIn("resolveAction(", app)
        self.assertIn('commit', app)
        self.assertIn('revert', app)
        self.assertIn("state.owner", app)
        html = source('index.html')
        self.assertIn("owner-authenticated", html)

    def test_dialogs_are_accessible(self):
        html = source('index.html')
        self.assertIn('aria-labelledby="evidence-title"', html)
        self.assertIn('aria-labelledby="shortcuts-title"', html)
        self.assertIn('aria-haspopup="dialog"', html)


if __name__ == '__main__':
    unittest.main(verbosity=2)
