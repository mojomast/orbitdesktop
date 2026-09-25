"""Worker-local exact-prompt LRU. Never persisted; model lifetime is cache lifetime."""
from collections import OrderedDict


class PromptCache:
    def __init__(self, max_entries=32, max_bytes=32 * 1024 * 1024):
        self.max_entries = max_entries
        self.max_bytes = max_bytes
        self.entries = OrderedDict()
        self.bytes = 0

    def get(self, prompt, encode, enabled=True):
        if enabled and prompt in self.entries:
            value, size = self.entries.pop(prompt)
            self.entries[prompt] = (value, size)
            return value, True
        value = encode(prompt)
        if enabled:
            size = sum(t.numel() * t.element_size() for t in value)
            if size <= self.max_bytes and self.max_entries > 0:
                while self.entries and (len(self.entries) >= self.max_entries or self.bytes + size > self.max_bytes):
                    _, (_, old_size) = self.entries.popitem(last=False)
                    self.bytes -= old_size
                self.entries[prompt] = (value, size)
                self.bytes += size
        return value, False
