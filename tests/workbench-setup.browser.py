"""Goal-first owner journey with real setup service, records and pinned Hermes.

The model provider is deterministic and loopback-only. One response is discarded
after the real preparation commits to exercise exact-key recovery in the UI.
"""
import argparse
import json
import re
import time
import uuid

from playwright.sync_api import expect, sync_playwright
from theme_fixture import unlock
from workbench_setup_fixture import setup_fixture, seed, WRONG


def main(renderer):
    with setup_fixture() as fixture, sync_playwright() as playwright:
        origin, token = fixture['origin'], fixture['token']
        browser = playwright.chromium.launch(headless=True, args=['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'])
        context = browser.new_context(viewport={'width': 1280, 'height': 1000})
        seed(context, fixture)
        page = context.new_page()
        errors, setup_responses = [], []
        page.on('pageerror', lambda error: errors.append(str(error)))

        def record(response):
            if response.url == origin + '/api/workbench/setup':
                setup_responses.append(response)

        page.on('response', record)

        def api(route, body, credential=token):
            response = context.request.post(origin + route, data={'workspace_id': fixture['workspace'], **body},
                                            headers={'Authorization': 'Bearer ' + credential, 'Origin': origin})
            return response.status, response.json()

        def last(action):
            matching = [r for r in setup_responses if r.request.post_data_json.get('action') == action]
            assert matching, ('No setup response', action)
            response = matching[-1]
            assert response.status == 200, (action, response.status, response.json())
            return response.json()

        def click(button, action):
            with page.expect_response(lambda r: r.url == origin + '/api/workbench/setup' and r.request.post_data_json.get('action') == action):
                button.click()
            return last(action)

        def size_fixture_window(narrow):
            # Use the real keyboard-resize control. Dockview owns its placement
            # and reflows with the viewport; the default window keeps its saved
            # desktop width unless explicitly resized.
            if renderer == 'default':
                handle = page.get_by_role('button', name='Resize Goal-first fixture')
                handle.focus()
                for _ in range(16):
                    handle.press('Shift+ArrowLeft' if narrow else 'Shift+ArrowRight')

        def assert_setup_fits():
            boxes = setup.evaluate('''node => ({
              width: innerWidth, left: node.getBoundingClientRect().left, right: node.getBoundingClientRect().right,
              client: node.clientWidth, scroll: node.scrollWidth,
              controls: [...node.querySelectorAll('textarea,select,button:not([hidden])')]
                .filter(el => el.getClientRects().length && !el.closest('[hidden]'))
                .map(el => ({name: el.getAttribute('aria-label') || el.textContent, right: el.getBoundingClientRect().right}))
            })''')
            assert boxes['left'] >= -1 and boxes['right'] <= boxes['width'] + 1, boxes
            assert boxes['scroll'] <= boxes['client'] + 2, boxes
            assert all(item['right'] <= boxes['width'] + 1 for item in boxes['controls']), boxes

        page.goto(origin + '/?renderer=' + renderer, wait_until='domcontentloaded')
        expect(page.locator('dialog.orbit-onboarding')).to_be_visible()
        page.keyboard.press('Escape')
        expect(page.locator('dialog.orbit-onboarding')).not_to_be_visible()
        if not page.get_by_role('button', name='Connect local host', exact=True).count():
            page.screenshot(path=f'/tmp/opencode/orbit-setup-{renderer}-startup.png')
            raise AssertionError(('Workspace startup did not render host connection', errors, page.locator('body').inner_text()[:3000]))
        assert not errors, errors
        unlock(page, token)
        pane = page.locator(f'.pane[data-pane-id="{fixture["pane"]}"]')
        expect(pane).to_be_visible()
        composer = pane.get_by_role('textbox', name='Message to Hermes', exact=True)
        goal = 'Fix sum so it adds two numbers and verify the existing tests. Stop at review.'
        composer.fill(goal)
        assert not fixture['model'].requests

        # Enter during the very first state read. The composer goal must survive
        # that load even though no project has been registered yet.
        pane.get_by_role('button', name='Create Workbench task', exact=True).click()
        setup = pane.locator('.workbench-setup')
        def action(label):
            return setup.locator('button').filter(has_text=re.compile('^' + re.escape(label) + '$'))
        expect(setup).to_be_visible()
        expect(setup.get_by_role('textbox', name='What are we working on?', exact=True)).to_have_value(goal)
        expect(action('Register project')).to_be_visible()
        expect(action('Review setup')).to_be_disabled()
        expect(setup.get_by_text('Saved task setups', exact=True)).not_to_be_visible()
        expect(setup.get_by_text('Work limits', exact=True)).not_to_be_visible()
        pane.locator('.pane-workbench-settings summary').first.click()
        expect(pane.get_by_role('button', name='Open task creation and context handoff')).to_be_visible()
        pane.locator('.pane-workbench-settings summary').first.click()

        # Register one fixture folder through the existing exact owner preview.
        status, registration = api('/api/workbench', {'action': 'register_preview', 'root': str(fixture['project']), 'name': 'Setup fixture'})
        assert status == 200, registration
        status, registered = api('/api/workbench', {'action': 'register_commit', 'approval_id': registration['approval_id']})
        assert status == 200, registered
        project_id = registered['project']['id']
        click(action('Check saved state'), 'state')
        expect(setup.get_by_role('combobox', name='Project for this task')).to_have_value(project_id)

        # Proposal-only controller action runs with a workspace capability, not
        # the owner token. It cannot create a task or launch a worker.
        projection = json.loads((fixture['root'] / 'runtime/workspace-access' / (fixture['workspace'] + '.json')).read_text())
        proposal = {'op_id': str(uuid.uuid4()), 'goal': goal, 'project_id': project_id,
                    'title': 'Repair addition', 'acceptance_statement': 'sum(2,3) is 5 and existing tests pass',
                    'check_definition_id': 'node-test'}
        status, proposed = api('/api/workspace/control', {'action': 'workbench_setup', 'request': proposal}, projection['capability'])
        assert status == 200, proposed
        status, forbidden = api('/api/workbench/setup', {'action': 'state', 'pane_id': fixture['pane'], 'expected_binding_revision': 1}, projection['capability'])
        assert status >= 400, forbidden
        status, execution = api('/api/workbench/execution', {'action': 'execution_state', 'project_id': project_id})
        assert status == 200 and not execution['tasks'], execution
        assert not fixture['model'].requests

        # Actual UI selectors are kept explicit so missing entry/controls fail.
        click(action('Check saved state'), 'state')
        expect(setup).to_contain_text('What are we working on?')
        action('Adopt suggestion').first.click()
        expect(setup.get_by_role('textbox', name='What are we working on?', exact=True)).to_have_value(goal)
        setup.get_by_text('Adjust plan', exact=True).click()
        edited_acceptance = 'sum(2,3) is 5 and existing tests pass; stop for review'
        setup.get_by_role('textbox', name='What success looks like').fill(edited_acceptance)
        click(action('Review setup'), 'preview')
        draft = last('draft')['draft']
        assert draft['acceptance_statement'] == edited_acceptance, draft
        expect(setup).to_contain_text('Repair addition')
        assert not fixture['model'].requests
        page.screenshot(path=f'/tmp/opencode/orbit-setup-{renderer}-review.png')
        size_fixture_window(True)
        page.set_viewport_size({'width': 520, 'height': 900})
        setup.scroll_into_view_if_needed()
        assert_setup_fits()
        page.screenshot(path=f'/tmp/opencode/orbit-setup-{renderer}-narrow-review.png')
        action('Set up task').scroll_into_view_if_needed()
        assert_setup_fits()
        page.screenshot(path=f'/tmp/opencode/orbit-setup-{renderer}-narrow-decision.png')
        page.set_viewport_size({'width': 1280, 'height': 1000})
        size_fixture_window(False)

        lost = []

        def lose_response(route):
            body = route.request.post_data_json
            if body.get('action') == 'prepare':
                lost.append(body)
                if len(lost) == 1:
                    response = route.fetch()
                    assert response.status == 200, response.text()
                    route.abort()
                    return
            route.continue_()

        page.route('**/api/workbench/setup', lose_response)
        action('Set up task').click()
        expect(setup).to_contain_text('unknown', timeout=20000)
        action('Retry exact request').click()
        expect(action('Review start')).to_be_visible(timeout=20000)
        expect(setup.get_by_text('Work limits', exact=True)).to_be_visible()
        assert len(lost) == 2 and lost[0] == lost[1], lost
        page.unroute('**/api/workbench/setup', lose_response)
        prepared = last('prepare')['draft']
        assert prepared['id'] == draft['id'] and prepared['task_id'] and prepared['candidate_id'] and prepared['attempt_id']
        assert not fixture['model'].requests
        status, execution = api('/api/workbench/execution', {'action': 'execution_state', 'project_id': project_id})
        assert status == 200 and len(execution['tasks']) == 1 and len(execution['candidates']) == 1

        pane.get_by_role('button', name='Normal Hermes mode', exact=True).click()
        expect(composer).to_have_value(goal)
        pane.get_by_role('button', name='Workbench Hermes mode', exact=True).click()
        page.reload(wait_until='domcontentloaded')
        unlock(page, token)
        expect(action('Review start')).to_be_visible(timeout=20000)
        preview = click(action('Review start'), 'launch_preview')
        assert preview['preview']['candidate_id'] == prepared['candidate_id']
        expect(setup).to_contain_text('orbit-local-fixture')
        expect(setup).to_contain_text('Reviewed work limits: 20 calls, 2 checks, 300 seconds, 1 repairs')
        assert not fixture['model'].requests
        launched = click(action('Start work'), 'launch')
        grant_id = launched['grant']['id']
        # Poll via Playwright's bounded assertion; each query is an actual owner
        # read and never resubmits work. The tool/check run remains real Hermes.
        observations = []
        deadline = time.monotonic() + 120
        while time.monotonic() < deadline:
            status, result = api('/api/workbench/native', {'action': 'status', 'project_id': project_id, 'grant_id': grant_id})
            assert status == 200, result
            observations.append((result['grant']['status'], result.get('result', {}).get('availability'), result['grant'].get('runtime_status')))
            if result.get('result', {}).get('availability') == 'available':
                break
            time.sleep(.3)
        assert result['result']['availability'] == 'available', (observations[-12:], fixture['model'].errors, len(fixture['model'].requests))
        assert fixture['model'].requests and not fixture['model'].errors
        assert (fixture['project'] / 'math.js').read_text() == WRONG
        status, execution = api('/api/workbench/execution', {'action': 'execution_state', 'project_id': project_id})
        assert any(e['verdict'] == 'pass' for e in execution['evidence']), execution
        size_fixture_window(True)
        page.set_viewport_size({'width': 520, 'height': 900})
        setup.scroll_into_view_if_needed()
        assert_setup_fits()
        page.screenshot(path=f'/tmp/opencode/orbit-setup-{renderer}-narrow.png')
        assert not errors, errors
        context.close(); browser.close()
        print('PASS goal-first setup', renderer, 'proposal-only transport, review, exact retry, restored draft, native worker and recorded passing check')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--renderer', choices=['default', 'docking'], required=True)
    main(parser.parse_args().renderer)
