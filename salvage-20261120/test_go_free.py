import sys, pathlib, unittest
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import launcher as L
class GoFree(unittest.TestCase):
    def test_go_routed(self):
        cfg = {"model": "deepseek-v4.1-flash", "base_url": L.GO_BASE_URL, "wire": "openai-chat"}
        for m in ("minimax-m3.1-flash-free", "beam-free"):
            s = L.model_spec(cfg, m)
            self.assertEqual((s["model"], s["base_url"], s["wire"], s["key"]), (m, L.GO_BASE_URL, "openai-chat", "go"))
            self.assertIn(m, L.FREE_POOL)
            self.assertEqual(s["fallback"], "deepseek-v4.1-flash")
    def test_zen_unchanged(self):
        s = L.model_spec({"model": "deepseek-v4.1-flash"}, "glm-5.3-flash-free")
        self.assertEqual((s["model"], s["base_url"], s["key"]), ("opencode/glm-5.3-flash-free", None, "none"))
if __name__ == "__main__": unittest.main()
