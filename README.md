<p align="center"><img src="docs/icon.png" alt="NodeBox icon" width="128"></p>

<h1 align="center">NodeBox</h1>

Point NodeBox at a **Node project folder** and it explains the project as animated flows:
which route calls which function in which file, from the browser down to the database or cloud
service. It reads the code (never runs it), is **read-only**, runs **only on this computer**
(127.0.0.1), and **updates live** while you edit the project.

MIT licensed. Part of the "Box" suite (PaperBox, LinkedBox, DriveBox, NodeBox).

## Use

```bash
npm install                      # once (installs typescript, used to read the code)
node bin/nodebox.js serve /path/to/node-project --open     # local app in your browser
npm run app -- /path/to/node-project                       # desktop window (needs Electron on this machine)
npm run dist                     # builds dist/mac-arm64/NodeBox.app (reuses ../paperbox's Electron)
```

Desktop app: `File → Open Project… (Cmd+O)`; it remembers the last project. `Cmd+R` rescans.

Other commands:

| Command | What it does |
|---|---|
| `nodebox scan <dir> [--json]` | list routes, files, functions found |
| `nodebox flow <dir> <text>` | print one flow as text |
| `nodebox check <dir>` | check a hand-written `flows.json` against the code (exit 1 if stale) |

Only Node projects (a `package.json`) are supported. NodeBox only *reads* the code, so the project's own Node version does not matter: it understands Node 14-era CommonJS (`require`, `module.exports`, `exports.x`), ES modules, TypeScript and JSX, plus `engines.node` is shown. Today it understands Next.js (app and pages
router), Express-style routes (`app.get(...)`), TypeScript path aliases, `"use client"`, and
re-exports. Other frameworks still scan (files, functions, imports) but have no route list.

## What you see

**Project overview** (the start screen): the entry points (`npm run ...`, `main`, `bin`), every outer page (`page.tsx`) and API route as a card, with what each one reaches: UI parts, server actions (`"use server"`), API routes, and data (packages, tables via `.from("table")`, RPCs). Cards can be searched, filtered (pages / API / middleware / has data / has server actions), grouped (by route, kind, data store or main UI part) and folded.

**Chain** (click a card, or the big *App entry chain* card): the whole reachable structure as one foldable tree. App → root layout and providers → every page (grouped) → API routes → middleware → server actions; open a page and it unfolds into its components, then the cells inside them, their calls, the API they reach and the data below. Related functions of one folder fold into a group. The solid line is the request going down, the dashed line is the answer coming back up. Search opens the path to every match; lane chips (people / UI / server / data / cloud) dim the rest; *Follow* (or double-click a box) animates a request down to that box and the answer back up. **🚗 Drive**: sends cars from the start. At a crossroad (a function that calls several things) the car splits into one car per road; at a dead end, if that function returns a value, the car turns around and drives back up, merging with its siblings, through every function that returns a value, and stops at the first one that returns nothing (✕). "Returns a value" is read from the code (`return <value>`, an arrow expression, a class or a constant count as returning; a function with no `return <value>` does not), so it is a static answer, not a runtime one. Click a car (or tick *car details*) to see where it is from, where it is going and what it carries: the call's arguments on the way down, the returned value on the way back. A selected car keeps its identity: it takes the first road at a crossroad, turns back at a dead end, waits for its siblings and stops where nothing is returned. Speed goes down to 0.1x; *repeat* runs it again and again, *traffic* sends overlapping waves, *follow cars* is optional, *Fit all* and Ctrl/Cmd + scroll zoom out far enough to see everything, and the sidebar hides with the ◀ button or Ctrl/Cmd+B. Cars inside a folded box show as "🚗 ×n inside".

Nodes that cross-link elsewhere are listed as clickable *also calls* chips.


Left: **Dataflow**, **Feature**, **Function**, **Route**.

- **Route**: one item per `GET/POST/...` handler and the middleware. The flow starts at the UI code
  that calls the route (a `fetch("/api/...")` string), follows the call chain function by function,
  and ends at the first database or cloud package it reaches (pg, mssql, @azure/cosmos, jose, ...).
  Other packages it also reaches are chips: click one to follow that path instead.
- **Feature**: one item per page, following the same way through `fetch` into the API.
- **Function**: every exported function: who calls it, what it calls, down to a package.
- **Dataflow** (and curated Feature/Route/Function): hand-written flows, see below.

The moving dot and the line use the icon colours (amber dot, coral to butter gradient line); glow is used only on the active node.

Sections (lanes): People/Dev machine, Browser/UI, Server, Data stores, External/cloud. Click a section
header to list its steps with **file and function**. Click a step for details. Zoom with the buttons or `-` / `+`.

Auto flows are a guess from the import graph (the shortest path to a data/cloud package). They are
exact about files and functions, not about meaning. Meaning is what curated flows are for.

## Curated flows (your own explanations)

Put a `flows.json` in one of these places (first found wins):

1. `--flows <file>`
2. `<project>/.nodebox/flows.json`
3. `~/.nodebox/flows/<package name>.json`

Shape: see `examples/items.flows.json`. Each step has `kind`, `lane`, `t` (title), `d` (one line),
`detail`, `name` and `files: [["path/file.ts", "functionA(), functionB()"]]`.
NodeBox checks every file and `function()` named there against the code: a step whose code was
renamed or deleted shows **⚠** (in the app and with `nodebox check`). So the explanations cannot
silently go stale.

## Look

Dark (black/gray) and light (warm white) themes, switched with the Theme button (animated, remembered). Both use the colours of the app icon (coral, butter yellow, pink, lavender, peach). Colours live in CSS variables at the top of `web/index.html`.

## Projects

Click the project name in the sidebar (or Cmd+O in the desktop app). The checker refuses anything that is not a readable Node project and says why; recent projects are remembered in `~/.nodebox/projects.json`.

## Safety

- Reads source files only; never executes project code, never writes into the project.
- Server listens on 127.0.0.1 only and rejects other Host headers. The desktop window blocks all
  non-local requests and denies permissions.
- Skips `node_modules`, hidden folders, build output.

## Develop

`npm test` (fixture project in `test/fixture`). Scanner: `src/scanner.js`, flows: `src/flows.js`,
server: `src/server.js`, UI: `web/index.html`, desktop shell: `src/main.js`.

## Performance

- The project is scanned once and incrementally (only changed files are re-read). Overview, chain and flow answers are built once per scan, kept in memory, and revalidated with ETags (304); the browser side keeps its own copy until the project changes.
- The cars are drawn on a single canvas, composited by the GPU; per frame only the roads that overlap the current moment are looked up (time buckets), and text counters update 4 times a second. Idle animation loops stop scheduling frames.
- Desktop app: GPU acceleration is on by default; *View → Use GPU acceleration (restart)* turns it off (for example on a machine with a faulty driver).

## Windows installer (.msi)

An `.msi` has to be built on Windows (the WiX tool it needs does not run on macOS).

- **On a Windows PC:** install Node 18+, then in this folder run
  `npm install`, `npm install --no-save electron@45.4.1 electron-builder@26.18.0`, `npm run dist:win`.
  The installer is written to `dist-win/NodeBox-<version>-x64.msi`.
- **With GitHub Actions:** push the repo and run the *Windows MSI* workflow (`.github/workflows/windows-msi.yml`);
  download the `NodeBox-msi` artifact.

The installer is per-user (no admin rights), adds a Start-menu and desktop shortcut, and is not code-signed, so Windows SmartScreen will warn until it is signed.

## Icons

The buttons, legends and car labels use [Lucide](https://lucide.dev) icons (ISC license), embedded in `web/icons.js`. Regenerate it with `scripts/gen-icons.py`.
