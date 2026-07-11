#!/usr/bin/env python3
"""Fail (exit 1) if any file contains a git merge conflict marker.

Detects the typical <<<<<<<, =======, >>>>>>> block markers at the start
of a line. Prints a one-line notice per offending file.
"""
import re
import sys
import pathlib

bad = re.compile(r"^(<{7}|={7}|>{7})( |$)", re.MULTILINE)
failed = [
    p for p in sys.argv[1:]
    if bad.search(pathlib.Path(p).read_text(encoding="utf-8", errors="ignore"))
]
for p in failed:
    print("CONFLICT MARKER in", p)
sys.exit(1 if failed else 0)
