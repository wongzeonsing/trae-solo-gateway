#!/usr/bin/env python3
"""Brute-force raw-deflate inflate at every offset; report successful streams."""
import sys, zlib

path = sys.argv[1]
data = open(path, "rb").read()
best = []
for i in range(len(data) - 2):
    d = zlib.decompressobj(-15)
    try:
        chunk = d.decompress(data[i:], 8 * 1024 * 1024)
    except zlib.error:
        continue
    if len(chunk) > 200 and b"level" in chunk[:2000] or (len(chunk) > 200 and b"{" in chunk[:200]):
        best.append((i, len(chunk), chunk))
    if len(best) >= 50:
        break
sys.stderr.write(f"streams={len(best)}\n")
for off, n, _ in best[:10]:
    sys.stderr.write(f"  off={off} len={n}\n")
blob = b"\n\n=====PAGE=====\n\n".join(c for _, _, c in best)
sys.stdout.buffer.write(blob)
