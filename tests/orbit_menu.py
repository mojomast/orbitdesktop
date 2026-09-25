"""Shared helper for live browser tests.

Workspace controls (windows/spatial/focus, themes, panel, full viewport,
wallpaper, transparency and the Hermes tools) live in the orbit menu that opens
from the orbit logo in the top-left corner. Call ``open_menu`` before clicking
one of those controls.

The first-run "Getting started" tour is a modal dialog that covers the logo on a
fresh browser profile, so every entry point dismisses it first.
"""
from playwright.sync_api import Page

LOGO = 'Open orbit menu'
TOUR = 'dialog.orbit-onboarding'


def dismiss_tour(page: Page):
    """Close the first-run onboarding tour if it is open.

    The tour is a modal ``<dialog>`` that intercepts pointer events over the
    orbit logo, so controls are unreachable until it is dismissed. Skipping
    persists the "done" flag; Escape (used as a fallback) only closes it.
    """
    tour = page.locator(TOUR)
    if tour.count() == 0 or not tour.first.is_visible():
        return
    skip = page.get_by_role('button', name='Skip tour', exact=True)
    if skip.count() and skip.first.is_visible():
        skip.first.click()
    else:
        page.keyboard.press('Escape')
    page.wait_for_timeout(80)


def open_menu(page: Page):
    """Ensure the orbit menu drawer is open (no-op when already open)."""
    dismiss_tour(page)
    logo = page.get_by_role('button', name=LOGO, exact=True)
    if not logo.is_visible():
        return
    if logo.get_attribute('aria-expanded') != 'true':
        logo.click()
    page.wait_for_timeout(80)


def menu(page: Page, label: str):
    """Open the orbit menu and click the named control inside it."""
    open_menu(page)
    page.get_by_role('button', name=label, exact=True).click()


def close_menu(page: Page):
    """Close the orbit menu drawer if it is open."""
    logo = page.get_by_role('button', name=LOGO, exact=True)
    if logo.is_visible() and logo.get_attribute('aria-expanded') == 'true':
        logo.click()
