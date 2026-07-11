#!/usr/bin/env python3
"""Ensure each file ends with exactly one trailing newline."""
import sys
import pathlib

for p in sys.argv[1:]:
    fp = pathlib.Path(p)
    try:
        text = fp.read_text(encoding="utf-8", errors="ignore")
    except Exception:
        continue
    if not text.endswith("\n"):
        fp.write_text(text + "\n", encoding="utf-8")
