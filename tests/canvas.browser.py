"""Run the real Excalidraw branch of the isolated documents acceptance fixture."""
import importlib.util
from pathlib import Path
spec = importlib.util.spec_from_file_location('documents_browser', Path(__file__).with_name('documents.browser.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
if __name__ == '__main__':
    module.run_fixture('scene')
