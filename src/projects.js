'use strict';
// Project checker + recent projects. NodeBox only opens real Node projects.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { IGNORE_DIRS } = require('./scanner');

const SRC = /\.[cm]?[jt]sx?$/;
const FILE = path.join(os.homedir(), '.nodebox', 'projects.json');

/** Quick, bounded count of source files (stops at `cap`). */
function countSources(root, cap = 4000) {
  let n = 0, dirs = 0;
  (function rec(dir, depth) {
    if (n >= cap || depth > 12 || dirs > 6000) return;
    dirs++;
    let list; try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of list) {
      if (e.isDirectory()) { if (!IGNORE_DIRS.has(e.name) && !e.name.startsWith('.')) rec(path.join(dir, e.name), depth + 1); }
      else if (SRC.test(e.name) && !e.name.endsWith('.d.ts')) { n++; if (n >= cap) return; }
    }
  })(root, 0);
  return n;
}

/**
 * Is this folder a Node project NodeBox can read?
 * returns { ok, dir, checks: [{ok, label, detail?}], info? }
 */
function checkProject(input) {
  const checks = [];
  const add = (ok, label, detail) => checks.push({ ok, label, detail });
  const dir = path.resolve(String(input || '').replace(/^~(?=$|\/)/, os.homedir()));
  let st = null;
  try { st = fs.statSync(dir); } catch (_) { /* missing */ }
  if (!st || !st.isDirectory()) { add(false, 'Folder exists', 'No such folder: ' + dir); return { ok: false, dir, checks }; }
  add(true, 'Folder exists');

  const home = os.homedir();
  if (dir === path.parse(dir).root || dir === home || dir === path.dirname(home) || dir === '/Users' || dir === '/Applications' || dir === '/System') {
    add(false, 'Not a broad system or home folder', 'Pick the project folder itself, not ' + dir);
    return { ok: false, dir, checks };
  }
  add(true, 'Not a broad system or home folder');

  if (dir.split(path.sep).includes('node_modules')) { add(false, 'Not inside node_modules', 'This folder is inside node_modules'); return { ok: false, dir, checks }; }

  const pj = path.join(dir, 'package.json');
  let pkg = null;
  if (!fs.existsSync(pj)) { add(false, 'Has package.json (Node project)', 'No package.json here. NodeBox supports Node projects only.'); return { ok: false, dir, checks }; }
  try { pkg = JSON.parse(fs.readFileSync(pj, 'utf8')); add(true, 'Has a valid package.json'); } catch (e) { add(false, 'package.json is valid JSON', e.message); return { ok: false, dir, checks }; }
  if (typeof pkg !== 'object' || pkg === null || Array.isArray(pkg)) { add(false, 'package.json is an object'); return { ok: false, dir, checks }; }

  const sources = countSources(dir);
  if (sources === 0) { add(false, 'Has JavaScript or TypeScript source files', 'No .js/.ts/.jsx/.tsx files found outside node_modules.'); return { ok: false, dir, checks }; }
  add(true, 'Has source files', sources >= 4000 ? '4000+ files (large project: first scan may take a while)' : sources + ' files');

  const deps = Object.assign({}, pkg.dependencies, pkg.devDependencies);
  const frameworks = ['next', 'express', 'fastify', 'koa', 'hono', '@nestjs/core', 'react', 'vite', 'electron'].filter((k) => deps[k]);
  add(true, frameworks.length ? 'Framework: ' + frameworks.join(', ') : 'No known framework (files and functions still scan; no route list)');
  if (pkg.engines && pkg.engines.node) add(true, 'Node ' + pkg.engines.node + ' (NodeBox only reads the code; it does not run it)');
  return { ok: true, dir, checks, info: { name: pkg.name || path.basename(dir), frameworks, sources } };
}

function loadRecents() {
  try { const j = JSON.parse(fs.readFileSync(FILE, 'utf8')); return Array.isArray(j.recent) ? j.recent.filter((r) => r && r.dir) : []; } catch (_) { return []; }
}
function addRecent(dir, name) {
  const list = loadRecents().filter((r) => r.dir !== dir);
  list.unshift({ dir, name: name || path.basename(dir), at: Date.now() });
  try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify({ recent: list.slice(0, 12) }, null, 2)); } catch (_) { /* ignore */ }
}
function forgetRecent(dir) {
  const list = loadRecents().filter((r) => r.dir !== dir);
  try { fs.writeFileSync(FILE, JSON.stringify({ recent: list }, null, 2)); } catch (_) { /* ignore */ }
}

module.exports = { checkProject, loadRecents, addRecent, forgetRecent };
