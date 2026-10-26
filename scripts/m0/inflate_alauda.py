#!/usr/bin/env python3
"""Inflate alaudalog pages: scan for zlib streams anywhere in the file."""
import sys, zlib, re

path = sys.argv[1]
data = open(path, "rb").read()
out = []
i = 0
n = len(data)
HDRS = {b"\x78\x9c", b"\x78\x01", b"\x78\xda", b"\x78\x5e"}
while i < n - 2:
    if data[i:i+2] in HDRS:
        d = zlib.decompressobj()
        try:
            chunk = d.decompress(data[i:])
            if len(chunk) > 40:
                out.append(chunk)
                i += (len(data) - i) - len(d.unused_data)
                continue
        except zlib.error:
            pass
    i += 1
blob = b"\n".join(out)
sys.stdout.buffer.write(blob)
sys.stderr.write(f"pages={len(out)} bytes={len(blob)}\n")
