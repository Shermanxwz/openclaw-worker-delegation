#!/usr/bin/env python3
"""Light markdown sanity check.

For each .md file:
  - balanced fenced code blocks (``` or ~~~, count must be even)
  - at least one ATX-style heading (#, ##, ...)

Does NOT validate links; that is a separate, optional check.
"""
import re
import sys
import pathlib

problems = []
for p in sys.argv[1:]:
    text = pathlib.Path(p).read_text(encoding="utf-8", errors="ignore")
    fences = re.findall(r"^(?:```|~~~)", text, flags=re.MULTILINE)
    if len(fences) % 2 != 0:
        problems.append((p, "unbalanced code fences"))
        continue
    if not re.search(r"^#{1,6}\s+\S", text, flags=re.MULTILINE):
        problems.append((p, "no ATX heading"))

for p, msg in problems:
    print("MARKDOWN SANITY FAIL in", p, "->", msg)
sys.exit(1 if problems else 0)
