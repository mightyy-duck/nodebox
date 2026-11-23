#!/usr/bin/env node
'use strict';
const path = require('path');
const { spawn } = require('child_process');
const { createServer, isNodeProject } = require('../src/server');
const { Scanner } = require('../src/scanner');
const { Flows } = require('../src/flows');

const args = process.argv.slice(2);
const cmd = ['serve', 'scan', 'check', 'flow', 'help'].includes(args[0]) ? args.shift() : 'serve';
const opt = (n) => { const i = args.indexOf('--' + n); if (i < 0) return null; const v = args[i + 1]; args.splice(i, 2); return v; };
const flag = (n) => { const i = args.indexOf('--' + n); if (i < 0) return false; args.splice(i, 1); return true; };
const flowsFile = opt('flows'), port = +(opt('port') || 0), asJson = flag('json'), open = flag('open');
const target = args.find((a) => !a.startsWith('--')) ;
const dir = path.resolve(cmd === 'flow' ? (args[1] ? args[0] : '.') : (target || '.'));

function usage() {
  console.log(`NodeBox: explain a Node project as animated flows (local, read-only, live).

  nodebox serve [dir] [--port N] [--flows file] [--open]   start the local app for a project folder
  nodebox scan  [dir] [--json]                              print what was found (routes, files, functions)
  nodebox check [dir] [--flows file]                        check a curated flows.json against the code (exit 1 on drift)
  nodebox flow  [dir] <text>                                print one flow as text (first item whose title contains <text>)

Only Node projects (a package.json) are supported.`);
}

function needNode() { if (!isNodeProject(dir)) { console.error('NodeBox supports Node projects only: no package.json in ' + dir); process.exit(2); } }

(async () => {
  if (cmd === 'help') return usage();
  needNode();
  if (cmd === 'serve') {
    const s = await createServer({ root: dir, port, flows: flowsFile });
    console.log('NodeBox serving ' + dir + '\n  ' + s.url + '  (this computer only; Ctrl+C to stop)');
    if (open) spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [s.url], { stdio: 'ignore', detached: true }).unref();
    return;
  }
  const sc = new Scanner(dir); const model = sc.scan();
  const fl = new Flows(sc, { flows: flowsFile }); const cur = fl.loadCurated();
  if (cmd === 'scan') {
    if (asJson) return console.log(JSON.stringify({ name: model.name, framework: model.framework, stats: model.stats, routes: model.routes.map(({ pattern, ...r }) => r) }, null, 2));
    console.log(model.name, JSON.stringify(model.stats), JSON.stringify(model.framework));
    for (const r of model.routes) console.log(r.method.padEnd(10), r.url.padEnd(40), r.file + '::' + r.fn);
    return;
  }
  if (cmd === 'check') {
    if (!cur) { console.log('No curated flows file found (looked for .nodebox/flows.json, ~/.nodebox/flows/<name>.json, --flows).'); return; }
    let bad = 0, total = 0;
    for (const c of fl.curated.categories) for (const it of c.items) {
      const f = fl.getCurated(it.id);
      f.steps.forEach((s, i) => { total++; for (const r of s.refs || []) if (!r.ok) { bad++; console.log(`STALE  ${c.name} > ${it.title} > step ${i + 1} (${s.t}): ${r.file} ${r.missing.join(', ')}`); } });
    }
    console.log(`${total} steps checked against ${model.stats.files} files: ${bad} stale reference(s)  [${cur}]`);
    process.exit(bad ? 1 : 0);
  }
  if (cmd === 'flow') {
    const text = (args[1] || args[0] || '').toLowerCase();
    const cats = fl.list(); let hit = null;
    for (const c of cats) { hit = c.items.find((i) => i.title.toLowerCase().includes(text)); if (hit) break; }
    if (!hit) { console.error('no flow matches "' + text + '"'); process.exit(1); }
    const f = fl.get(hit.id);
    console.log(f.title + '\n' + f.sub + '\n');
    f.steps.forEach((s, i) => console.log(`${i + 1}. [${s.lane}] ${s.t}\n     ${(s.files || []).map((x) => x.join('  →  ')).join('\n     ')}`));
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
