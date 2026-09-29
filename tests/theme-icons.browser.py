"""Exercise the theme picker, icon assets and persistence in an isolated server/storage.

Uses the real orbit-menu -> Themes flow (the old direct theme button is gone) and
covers every merged personality including Hermes Relay and MS-DOS.
Isolation: disposable copied source + fresh isolated build, ephemeral port,
private HOME/runtime/cwd/tmux socket, no owner credentials. See theme_fixture.py.
"""
from playwright.sync_api import sync_playwright, expect
from theme_fixture import ARTIFACTS, THEMES, connect, open_theme_picker, theme_fixture, unlock


def run():
    with theme_fixture('orbit-themes-icons-') as fixture:
        origin, token = fixture['origin'], fixture['token']
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True, args=['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'])
            page = browser.new_page(viewport={'width': 1440, 'height': 1000})
            errors = []
            page.on('pageerror', lambda e: errors.append(str(e)))
            connect(page, origin, token)
            before = page.evaluate('JSON.parse(localStorage.getItem("orbit.workspace.v1")).monitors')
            for name, style in THEMES:
                open_theme_picker(page)
                page.get_by_role('button', name='Apply ' + name + ' theme', exact=True).click()
                expect(page.locator('html')).to_have_attribute('data-orbit-style', style)
                expect(page.get_by_role('status').filter(has_text=name + ' applied locally')).to_be_visible()
                page.get_by_role('button', name='Close workspace themes').click()
                page.wait_for_timeout(1200)
                assert f'/wallpapers/{style}.svg' in page.locator('.workspace').evaluate('e=>getComputedStyle(e).backgroundImage')
                assert page.request.get(f'{origin}/wallpapers/{style}.svg').ok
                icons = page.locator('.desktop-shortcut .theme-icon')
                assert icons.count() > 0
                for icon in icons.all():
                    url = icon.evaluate('e=>getComputedStyle(e,"::before").backgroundImage')
                    assert '/icons/' + style + '/' in url, (style, url)
                    assert icon.get_attribute('aria-hidden') == 'true'
                for role in ['folder', 'chat', 'terminal', 'browser', 'document', 'grid', 'image', 'key', 'app']:
                    assert page.request.get(f'{origin}/icons/{style}/{role}.svg').ok
                logo = page.locator('.start-logo').evaluate('e=>getComputedStyle(e,"::before").backgroundImage')
                if style == 'nous':
                    # Nous Atelier intentionally uses its own seal for the start logo.
                    assert '/art/nous/nous-girl.svg' in logo, logo
                    assert page.request.get(f'{origin}/art/nous/nous-girl.svg').ok
                else:
                    assert '/icons/' + style + '/' in logo, (style, logo)
                start = page.locator('.start-button')
                start.click()
                expect(page.locator('.start-panel')).to_be_visible()
                page.keyboard.press('Escape')
                expect(start).to_be_focused()
                tab = page.locator('.display-tabs button').first
                tab.hover()
                page.wait_for_timeout(350)
                if style == 'ocean':
                    print('OCEAN diagnostic', tab.evaluate('e=>({hover:e.matches(":hover"),focus:e.matches(":focus-visible"),style:document.documentElement.dataset.orbitStyle,bg:getComputedStyle(e).background,rect:e.getBoundingClientRect().toJSON()})'))
                    tab.focus()
                    expect(tab).to_have_css('background-position', '0px 100%')
                if style == 'forest':
                    expect(tab).to_have_css('border-top-left-radius', '22px')
                if style == 'phosphor':
                    assert '[1]' in tab.evaluate('e=>getComputedStyle(e,"::before").content') or 'counter(buffer)' in tab.evaluate('e=>getComputedStyle(e,"::before").content')
                page.mouse.move(1400, 5)
                assert page.evaluate('JSON.parse(localStorage.getItem("orbit.workspace.v1")).monitors') == before
                if style == 'aurora':
                    assert 'blur' in page.locator('.scene-navigation').evaluate('e=>getComputedStyle(e).backdropFilter')
                    b = page.locator('.start-button')
                    b.hover()
                    page.wait_for_timeout(250)
                    expect(b).to_have_css('translate', '0px -3px')
                    page.emulate_media(reduced_motion='reduce')
                    expect(b).to_have_css('translate', 'none')
                    page.emulate_media(reduced_motion='no-preference')
                if style == 'phosphor':
                    assert '/wallpapers/phosphor.svg' in page.locator('.workspace').evaluate('e=>getComputedStyle(e).backgroundImage')
                    page.locator('.start-button').hover()
                    expect(page.locator('.start-button')).to_have_css('color', 'rgb(6, 19, 12)')
                if style == 'blueprint':
                    expect(page.locator('.monitor').first).to_have_css('border-top-style', 'double')
                if style == 'pop':
                    b = page.locator('.start-button')
                    b.hover()
                    page.mouse.down()
                    page.wait_for_timeout(180)
                    expect(b).to_have_css('translate', '3px 3px')
                    page.mouse.move(1400, 5)
                    page.mouse.up()
                page.mouse.move(1400, 5)
                for width in [320, 480, 800]:
                    chat = page.locator('.chat-body').first
                    chat.evaluate('(e,w)=>{e.style.width=w+"px";e.style.maxWidth=w+"px"}', width)
                    assert chat.evaluate('e=>e.scrollWidth<=e.clientWidth+1'), (style, width)
                chat.evaluate('e=>{e.style.width="";e.style.maxWidth=""}')
                page.screenshot(path=str(ARTIFACTS / ('orbit-m3-theme-icons-' + style + '.png')))
                page.reload(wait_until='networkidle')
                expect(page.locator('html')).to_have_attribute('data-orbit-style', style)
                unlock(page, token)
                page.set_viewport_size({'width': 390, 'height': 844})
                open_theme_picker(page)
                assert page.locator('.theme-picker').evaluate('e=>e.scrollWidth<=e.clientWidth+1')
                page.get_by_role('button', name='Close workspace themes').click()
                page.set_viewport_size({'width': 1440, 'height': 1000})
                print('PASS', name, 'theme icons, wallpaper, persistence and pane preservation')
            assert not errors, errors
            browser.close()
            print('PASS dock hover, reduced motion, phosphor hover, blueprint borders, pop press depth, no JS exceptions')


if __name__ == '__main__':
    run()
