#!/usr/bin/env python3
"""Parse each YAML file. If PyYAML is missing, fall back to a structural check.

The fallback is intentionally simple; it is not a real parser. It catches the
"file is not even vaguely YAML" case without requiring extra dependencies.
"""
import sys
import pathlib

have_yaml = True
try:
    import yaml  # type: ignore
except ImportError:
    have_yaml = False

problems = []
for p in sys.argv[1:]:
    text = pathlib.Path(p).read_text(encoding="utf-8", errors="ignore")
    if have_yaml:
        try:
            list(yaml.safe_load_all(text))
        except yaml.YAMLError as e:
            problems.append((p, str(e)))
    else:
        # Heuristic: refuse files that have no obvious top-level key.
        if not any(line.lstrip().startswith(tuple("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ")) and ":" in line
                   for line in text.splitlines()[:20]):
            problems.append((p, "no top-level mapping found"))

for p, msg in problems:
    print("YAML PARSE ERROR in", p, "->", msg)

if have_yaml:
    print("YAML OK (pyyaml present)")
else:
    print("YAML OK (pyyaml missing; structural check only)")
sys.exit(1 if problems else 0)
