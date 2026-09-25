import sys
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'extensions/supra2-studio'))
from prompt_cache import PromptCache

class Tensor:
    def numel(self): return 4
    def element_size(self): return 4

class CacheTests(unittest.TestCase):
    def test_hit_and_exact_key(self):
        c = PromptCache()
        calls = []
        def encode(p):
            calls.append(p)
            return (Tensor(), Tensor())
        first, hit = c.get('cat', encode)
        self.assertFalse(hit)
        second, hit = c.get('cat', encode)
        self.assertTrue(hit)
        self.assertIs(first, second)
        self.assertFalse(c.get('cat ', encode)[1])
        self.assertEqual(calls, ['cat', 'cat '])

    def test_lru_and_byte_limit(self):
        for c in (PromptCache(max_entries=2), PromptCache(max_bytes=64)):
            encode = lambda p: (Tensor(), Tensor())
            for p in ('a','b','a','c'): c.get(p, encode)
            self.assertEqual(list(c.entries), ['a','c'])
            self.assertEqual(c.bytes, 64)
            self.assertFalse(c.get('b', encode)[1])

    def test_oversize_and_disabled(self):
        encode = lambda p: (Tensor(), Tensor())
        c = PromptCache(max_bytes=1)
        self.assertFalse(c.get('a', encode)[1])
        self.assertEqual(c.bytes, 0)
        c = PromptCache()
        c.get('a', encode)
        self.assertFalse(c.get('a', encode, enabled=False)[1])
        self.assertTrue(c.get('a', encode)[1])

    def test_failure_not_cached_and_new_instance_empty(self):
        c = PromptCache()
        def fail(p): raise ValueError('test')
        with self.assertRaises(ValueError): c.get('a', fail)
        self.assertEqual(c.bytes, 0)
        c.get('a', lambda p: (Tensor(),))
        self.assertFalse(PromptCache().entries)

if __name__ == '__main__': unittest.main()
