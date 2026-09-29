"""Real picker regression: preset defaults must not become sticky custom styling."""
from playwright.sync_api import sync_playwright, expect
from theme_fixture import theme_fixture, unlock, open_theme_picker, ARTIFACTS

with theme_fixture('orbit-theme-switch-') as fixture, sync_playwright() as p:
    origin, token = fixture['origin'], fixture['token']
    browser = p.chromium.launch(headless=True, args=['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'])
    for renderer in ('default', 'docking'):
        context = browser.new_context(viewport={'width': 1440, 'height': 1000})
        page = context.new_page()
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.goto(origin + '/?renderer=' + renderer, wait_until='domcontentloaded')
        expect(page.locator('dialog.orbit-onboarding')).to_be_visible()
        page.keyboard.press('Escape')
        unlock(page, token)
        before = page.evaluate('JSON.parse(localStorage.getItem("orbit.workspace.v1")).monitors')

        def sync_response(response):
            return response.url == origin + '/api/workspace' and response.request.post_data_json.get('action') == 'sync' and response.status == 200

        def choose(name, style):
            open_theme_picker(page)
            with page.expect_response(sync_response):
                page.get_by_role('button', name='Apply ' + name + ' theme', exact=True).click()
            expect(page.locator('html')).to_have_attribute('data-orbit-style', style)
            page.get_by_role('button', name='Close workspace themes').click()

        choose('MS-DOS', 'msdos')
        open_theme_picker(page)
        page.locator('.theme-custom > summary').click()
        page.get_by_label('border Color', exact=True).fill('#123456')
        with page.expect_response(sync_response):
            page.get_by_role('button', name='Save custom styling', exact=True).click()
        page.get_by_role('button', name='Close workspace themes').click()
        choose('Nous Atelier', 'nous')
        appearance = page.evaluate('JSON.parse(localStorage.getItem("orbit.workspace.v1")).appearance')
        assert appearance['borderColor'] == '#123456'
        for key in ('surfaceColor','panelColor','mutedColor','titlebarColor','titlebarTextColor','buttonColor','buttonTextColor','controlRadius','titlebarHeight','uiFont'):
            assert key not in appearance, (key, appearance)
        assert page.locator('html').evaluate('e=>e.style.getPropertyValue("--theme-panelColor")') == ''
        assert page.locator('html').evaluate('e=>e.style.getPropertyValue("--theme-font")') == ''
        assert page.evaluate('JSON.parse(localStorage.getItem("orbit.workspace.v1")).monitors') == before
        page.reload(wait_until='domcontentloaded')
        expect(page.locator('html')).to_have_attribute('data-orbit-style', 'nous')
        unlock(page, token)
        assert page.evaluate('JSON.parse(localStorage.getItem("orbit.workspace.v1")).appearance') == appearance
        page.screenshot(path=str(ARTIFACTS / ('orbit-theme-switch-' + renderer + '.png')))
        assert not errors, errors
        context.close()
        print('PASS', renderer, 'MS-DOS -> customized border -> Nous: preset defaults removed, owner override/layout/reload preserved')
    browser.close()
