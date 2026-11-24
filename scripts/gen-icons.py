#!/usr/bin/env python3
"""Builds web/icons.js from the Lucide icon set (ISC license, https://lucide.dev).
Usage: npm i lucide-static in any folder, then  python3 scripts/gen-icons.py <path to node_modules/lucide-static/icons>"""
import re, sys, json, os
src = sys.argv[1]
NAMES = """panel-left panel-left-close sun-moon house pause play step-back step-forward rotate-ccw refresh-cw arrow-left arrow-right
square car x check triangle-alert chevron-right chevron-down circle-dot list-tree puzzle braces brackets type binary toggle-left
mail circle-slash package globe database cloud import circle-x minus plus undo-2 circle-check route flag crosshair""".split()
icons = {}
for n in NAMES:
    t = open(os.path.join(src, n + ".svg"), encoding="utf8").read()
    inner = re.search(r"<svg[^>]*>(.*)</svg>", t, re.S).group(1)
    icons[n] = re.sub(r"\s+", " ", inner).strip()
out = open(os.path.join(os.path.dirname(__file__), "icons.template.js"), encoding="utf8").read().replace("/*ICONS*/{}", json.dumps(icons, indent=1))
open(os.path.join(os.path.dirname(__file__), "..", "web", "icons.js"), "w", encoding="utf8").write(out)
print(len(icons), "icons")
