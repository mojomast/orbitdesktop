#!/usr/bin/env python3
"""Kitty graphics protocol tour.

A demonstration program for the Orbit Kitty DOOM window: it is not Doom, it just
speaks the same terminal graphics protocol kitty-doom uses, so the same pane
renders it. Four scenes, one per wire format the bridge decodes:

  1. f=24  RGB   direct, split into several m=1 chunks (the chunked path)
  2. f=32  RGBA  with a real alpha channel
  3. f=100 PNG   a zlib-compressed image
  4. a=f   an animation: several frames placed under one image id

Everything is stdlib. Text printed to stdout is shown in the pane's log, so the
program narrates what it is about to put on the wire.
"""
import base64
import os
import struct
import sys
import time
import zlib

WIDTH = 320
HEIGHT = 200
APC = "\x1b_G"
ST = "\x1b\\"
CHUNK = 4096  # base64 characters per chunk, the size kitty itself uses


def emit(control, payload="", last=True):
    """Write one graphics APC sequence (a chunk when payload spans several)."""
    body = f"{APC}{control};{payload}{ST}" if payload else f"{APC}{control}{ST}"
    sys.stdout.write(body)


def transmit(image_id, fmt, width, height, raw, action="T", extra=""):
    """Send raw bytes as a base64 payload, chunked with m=1 like a real client."""
    encoded = base64.b64encode(raw).decode("ascii")
    chunks = [encoded[i:i + CHUNK] for i in range(0, len(encoded), CHUNK)] or [""]
    for index, part in enumerate(chunks):
        more = index < len(chunks) - 1
        if index == 0:
            control = (f"a={action},f={fmt},s={width},v={height},i={image_id},"
                       f"c={width},r={height},m={1 if more else 0}{extra}")
        else:
            control = f"m={1 if more else 0}"
        emit(control, part)
    return len(chunks)


def png(width, height, rgb):
    """Minimal PNG encoder: one filter byte per row, zlib-deflated."""
    raw = bytearray()
    stride = width * 3
    for y in range(height):
        raw.append(0)
        raw += rgb[y * stride:(y + 1) * stride]

    def chunk(tag, data):
        return (struct.pack(">I", len(data)) + tag + data +
                struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))

    header = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) +
            chunk(b"IDAT", zlib.compress(bytes(raw), 6)) + chunk(b"IEND", b""))


def rgb_frame(phase):
    """A moving gradient with a sweeping bar, as RGB bytes."""
    data = bytearray(WIDTH * HEIGHT * 3)
    bar = (phase * 7) % WIDTH
    for y in range(HEIGHT):
        row = y * WIDTH * 3
        gy = y * 255 // HEIGHT
        for x in range(WIDTH):
            i = row + x * 3
            near = abs(x - bar) < 12
            data[i] = 255 if near else x * 255 // WIDTH
            data[i + 1] = gy if not near else 255
            data[i + 2] = 40 if not near else 255
    return bytes(data)


def rgba_frame(phase):
    """A translucent checkerboard so the alpha channel is visibly real."""
    data = bytearray(WIDTH * HEIGHT * 4)
    size = 20
    for y in range(HEIGHT):
        for x in range(WIDTH):
            i = (y * WIDTH + x) * 4
            on = ((x // size) + (y // size) + phase) % 2 == 0
            data[i] = 90 if on else 220
            data[i + 1] = 200 if on else 60
            data[i + 2] = 255 if on else 120
            data[i + 3] = 255 if on else 110  # the second block really is alpha
    return bytes(data)


def banner(text):
    sys.stdout.write(f"\r\n[demo] {text}\r\n")
    sys.stdout.flush()


def main():
    banner(f"stdout is live: TERM={os.environ.get('TERM', 'unset')} "
           f"COLORTERM={os.environ.get('COLORTERM', 'unset')}")
    banner("scene 1/4  RGB direct (f=24), chunked with m=1")
    chunks = transmit(1, 24, WIDTH, HEIGHT, rgb_frame(0))
    banner(f"           {WIDTH*HEIGHT*3} bytes -> {chunks} base64 chunks")
    time.sleep(2.5)

    banner("scene 2/4  RGBA with alpha (f=32)")
    transmit(2, 32, WIDTH, HEIGHT, rgba_frame(0))
    time.sleep(2.5)

    banner("scene 3/4  PNG, zlib compressed (f=100)")
    source = rgb_frame(20)
    encoded = png(WIDTH, HEIGHT, source)
    transmit(3, 100, WIDTH, HEIGHT, encoded)
    banner(f"           {len(source)} raw bytes -> {len(encoded)} encoded "
           f"({len(encoded)*100//max(1,len(source))}%)")
    time.sleep(2.5)

    banner("scene 4/4  animation: a base image, then a=f frames, then a=a")
    # Per the protocol an animation is an ordinary image first: the base image is
    # created with a=t and is not displayed. Frames are then added with a=f, where
    # r is the 1-based frame number, z the gap to the next frame in ms and X=1 an
    # overwrite rather than a blend. a=a,s=3 then runs the animation. This pane
    # paints each frame as it completes, which is what makes it look animated here.
    transmit(4, 24, WIDTH, HEIGHT, rgb_frame(0), action="t")
    banner("           base image created with a=t (transmitted, not displayed)")
    frames = 48
    for index in range(frames):
        transmit(4, 24, WIDTH, HEIGHT, rgb_frame(index), action="f",
                 extra=f",r={index + 1},z=40,X=1")
        time.sleep(0.06)
    emit("a=a,i=4,s=3")
    banner(f"           {frames} frames added with a=f, then a=a,s=3 to run it")
    time.sleep(1.5)
    return 0


if __name__ == "__main__":
    try:
        while True:
            main()
    except (KeyboardInterrupt, BrokenPipeError):
        sys.stdout.write("\r\n[demo] exiting\r\n")
