#!/usr/bin/env python3
"""Trim trailing whitespace from each file path passed in argv."""
import sys
import pathlib

for p in sys.argv[1:]:
    fp = pathlib.Path(p)
    try:
        text = fp.read_text(encoding="utf-8", errors="ignore")
    except Exception:
        continue
    new = "\n".join(line.rstrip() for line in text.split("\n"))
    if new != text:
        fp.write_text(new, encoding="utf-8")
