#!/usr/bin/env python3
"""Terminal-emulation probe.

The hard half of the bridge is not decoding pixels, it is *being a terminal*:
kitty-doom only draws after the terminal answers its queries, and it decides its
grid from the cursor-position reply. This program asks the bridge the same
questions and prints the answers it gets, then draws a frame so a correct answer
is visibly confirmed rather than asserted.

Run in the Orbit Kitty DOOM window ("Terminal probe" in the program picker).
"""
import base64
import os
import select
import sys
import time

QUERIES = [
    ("Kitty keyboard protocol", "\x1b[?u", "expect ESC[?11u"),
    ("Cursor position (DSR)", "\x1b[6n", "expect ESC[<rows>;<cols>R"),
    ("Primary device attributes", "\x1b[c", "expect ESC[?62;c"),
    ("Kitty graphics capability", "\x1b_Ga=q,i=probe\x1b\\", "expect ESC_Gi=probe;OK"),
]


def read_replies(seconds=1.2):
    """Collect whatever the terminal wrote back inside the window."""
    out = ""
    deadline = time.time() + seconds
    while time.time() < deadline:
        ready, _, _ = select.select([sys.stdin], [], [], 0.1)
        if not ready:
            continue
        data = os.read(sys.stdin.fileno(), 4096)
        if not data:
            break
        out += data.decode("latin1", "replace")
    return out


def show(value):
    """Make a raw escape sequence printable so the pane's log is readable."""
    return value.replace("\x1b", "ESC").replace("\r", "\\r").replace("\n", "\\n")


def emit(control, payload=""):
    body = f"\x1b_G{control};{payload}\x1b\\" if payload else f"\x1b_G{control}\x1b\\"
    sys.stdout.write(body)


def frame(image_id, colour, label_row):
    """A small RGB frame: a solid field plus a bright marker bar."""
    width, height = 320, 200
    raw = bytearray(width * height * 3)
    for y in range(height):
        row = y * width * 3
        for x in range(width):
            i = row + x * 3
            if label_row <= y < label_row + 8:
                raw[i], raw[i + 1], raw[i + 2] = 255, 255, 255
            else:
                raw[i] = colour[0] if (x // 16 + y // 16) % 2 else 20
                raw[i + 1] = colour[1] if (x // 16 + y // 16) % 2 else 20
                raw[i + 2] = colour[2] if (x // 16 + y // 16) % 2 else 20
    encoded = base64.b64encode(bytes(raw)).decode("ascii")
    chunks = [encoded[i:i + 4096] for i in range(0, len(encoded), 4096)]
    for index, part in enumerate(chunks):
        more = index < len(chunks) - 1
        if index == 0:
            emit(f"a=T,f=24,s={width},v={height},i={image_id},c={width},r={height},"
                 f"m={1 if more else 0}", part)
        else:
            emit(f"m={1 if more else 0}", part)


def main():
    sys.stdout.write(f"\r\n[probe] TERM={os.environ.get('TERM')} "
                     f"COLORTERM={os.environ.get('COLORTERM')}\r\n")
    sys.stdout.write("[probe] asking this terminal the questions kitty-doom asks\r\n")
    sys.stdout.flush()
    answered = 0
    for name, query, expectation in QUERIES:
        sys.stdout.write(f"[probe] {name}: sent {show(query)}\r\n")
        sys.stdout.flush()
        sys.stdout.write(query)
        sys.stdout.flush()
        time.sleep(0.35)
        reply = read_replies(0.7)
        if reply:
            answered += 1
            sys.stdout.write(f"[probe]   answer  {show(reply.strip())}  ({expectation})\r\n")
        else:
            sys.stdout.write(f"[probe]   NO ANSWER  ({expectation})\r\n")
        sys.stdout.flush()
    sys.stdout.write(f"[probe] {answered} of {len(QUERIES)} queries answered; "
                     f"drawing a frame to confirm the graphics path\r\n")
    sys.stdout.flush()
    for index in range(12):
        frame(90, (90, 200, 120), 40 + index * 12)
        time.sleep(0.25)
    sys.stdout.write("[probe] done — the pane drew 320x200 RGB frames in 12 chunked "
                     "transmissions\r\n")
    sys.stdout.flush()


if __name__ == "__main__":
    try:
        main()
    except (KeyboardInterrupt, BrokenPipeError):
        pass
