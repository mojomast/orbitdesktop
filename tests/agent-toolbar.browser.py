"""Compatibility entrypoint for the isolated agent-pane visual regression.

The old fixture required an unrelated development server on port 4187 and
asserted that advanced tool controls lived permanently in the header. The new
journey validates the compact header and accessible Inspector in both renderers.
"""
from pathlib import Path
import runpy

runpy.run_path(str(Path(__file__).with_name('agent-pane-ux.browser.py')), run_name='__main__')
