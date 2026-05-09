#!/usr/bin/env python3
"""Check that ASCII box diagrams in a file have consistent line widths.
Usage: python3 check-box-align.py <file> [--fix]

Scans for lines containing box-drawing characters (─│┌┐└┘├┤┬┴┼)
and groups them into blocks. Reports width mismatches."""

import sys
import unicodedata

BOX_CHARS = set("─│┌┐└┘├┤┬┴┼═║╔╗╚╝╠╣╦╩╬")
# Horizontal chars that indicate an actual box (not a directory tree)
BOX_HORIZ = set("─═┌┐└┘┬┴╔╗╚╝╦╩")

def display_width(s):
    """Count display columns (East Asian wide = 2, others = 1)."""
    w = 0
    for ch in s:
        eaw = unicodedata.east_asian_width(ch)
        w += 2 if eaw in ("W", "F") else 1
    return w

def find_box_blocks(lines):
    blocks = []
    current = []
    for i, line in enumerate(lines):
        if any(ch in BOX_CHARS for ch in line):
            current.append((i + 1, line.rstrip("\n")))
        else:
            if current:
                blocks.append(current)
                current = []
    if current:
        blocks.append(current)
    return blocks

def check(path):
    with open(path) as f:
        lines = f.readlines()

    blocks = find_box_blocks(lines)
    ok = True

    for block in blocks:
        # Skip blocks without a top-left corner (trees use ├── but not ┌/╔)
        has_corner = any(any(ch in "┌╔" for ch in text) for _, text in block)
        if not has_corner:
            continue
        widths = [(lineno, display_width(text), text) for lineno, text in block]
        target = max(w for _, w, _ in widths)
        for lineno, w, text in widths:
            if w != target:
                print(f"  L{lineno}: width {w} (expected {target})")
                print(f"    {text}")
                ok = False

    if ok:
        print(f"✅ {path}: all {len(blocks)} box block(s) aligned")
    else:
        print(f"❌ {path}: misaligned lines found")
    return ok

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(f"Usage: {sys.argv[0]} <file>")
        sys.exit(1)
    sys.exit(0 if check(sys.argv[1]) else 1)
