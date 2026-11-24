'use strict';
// Turns the scan model into flows: ordered steps, each with a section (lane),
// a file and a function. Auto flows come from the code; curated flows come from a
// flows.json written by a person (and are checked against the code for drift).

const fs = require('fs');
const os = require('os');
const path = require('path');

const KIND_OF_LANE = { you: 'user', ui: 'browser', srv: 'code', db: 'data', az: 'cloud' };
const MAX_STEPS = 12;

function curatedPaths(root, pkgName, explicit) {
  const list = [];
  if (explicit) list.push(path.resolve(explicit));
  list.push(path.join(root, '.nodebox', 'flows.json'));
  const safe = String(pkgName || path.basename(root)).replace(/[^\w.@-]+/g, '_');
  list.push(path.join(os.homedir(), '.nodebox', 'flows', safe + '.json'));
  return list;
}

class Flows {
  constructor(scanner, opts = {}) {
    this.sc = scanner;
    this.explicit = opts.flows || null;
    this.curated = { categories: [] };
    this.curatedFile = null;
  }

  get model() { return this.sc.model; }

  loadCurated() {
    this.curated = { categories: [] }; this.curatedFile = null;
    for (const f of curatedPaths(this.sc.root, this.model && this.model.name, this.explicit)) {
      try {
        const j = JSON.parse(fs.readFileSync(f, 'utf8'));
        if (j && Array.isArray(j.categories)) { this.curated = j; this.curatedFile = f; break; }
      } catch (_) { /* try next */ }
    }
    return this.curatedFile;
  }

  watchedFiles() { return curatedPaths(this.sc.root, this.model && this.model.name, this.explicit); }

  // ---------- listing ----------
  list() {
    const m = this.model;
    const cats = [
      { name: 'Dataflow', color: '#38d9ff', items: [] },
      { name: 'Feature', color: '#3dff9a', items: [] },
      { name: 'Function', color: '#a78bfa', items: [] },
      { name: 'Route', color: '#ff8a3d', items: [] },
    ];
    const byName = Object.fromEntries(cats.map((c) => [c.name, c]));
    for (const c of this.curated.categories) {
      const t = byName[c.name] || (cats.push({ name: c.name, color: c.color || '#9aa6c8', items: [] }), cats[cats.length - 1]);
      for (const it of c.items) t.items.push({ id: 'c:' + it.id, title: it.title, sub: it.sub || '', group: 'Curated', stale: this.staleCount(it) });
    }
    for (const r of m.routes) {
      if (r.kind === 'page') byName.Feature.items.push({ id: 'p:' + r.url + '|' + r.file, title: 'Page ' + r.url, sub: r.file, group: 'Pages' });
      else byName.Route.items.push({ id: 'r:' + r.method + ' ' + r.url + '|' + r.file + '|' + r.fn, title: (r.method === 'MIDDLEWARE' ? 'middleware' : r.method + ' ' + r.url), sub: r.file, group: r.method === 'MIDDLEWARE' ? 'Middleware' : '/' + (r.url.split('/')[1] || '') });
    }
    const files = [...this.sc.files.values()].filter((f) => !f.error && !this.sc.isTestFile(f.rel) && !m.routes.some((r) => r.file === f.rel && r.kind !== 'page'));
    files.sort((a, b) => a.rel.localeCompare(b.rel));
    for (const f of files) {
      for (const [name, d] of Object.entries(f.decls)) {
        if (!d.exported || name === '<module>') continue;
        byName.Function.items.push({ id: 'f:' + f.rel + '::' + name, title: name + '()', sub: f.rel, group: path.posix.dirname(f.rel) });
      }
    }
    return cats;
  }

  // ---------- overview: from the outer pages and entry points ----------
  overview() {
    const m = this.model, g = m.graph, sc = this.sc;
    const routeAt = new Map(m.routes.filter((r) => r.kind === 'api').map((r) => [r.file + '::' + r.fn, r]));
    const resolveStart = (file, fn) => { const real = fn !== '<module>' ? sc.resolveExport(file, fn) : null; return real ? real.file + '::' + real.fn : file + '::' + fn; };
    const reach = (startId) => {
      const seen = new Map([[startId, 0]]), q = [startId], out = { files: new Set(), ui: new Map(), actions: new Set(), api: new Set(), pkgs: new Set(), hints: new Set() };
      let n = 0;
      while (q.length && n++ < 4000) {
        const cur = q.shift(), d = seen.get(cur), node = g.nodes.get(cur);
        if (node && node.pkg) { out.pkgs.add(node.pkg); continue; }
        const [file, fn] = cur.split('::'), fi = sc.files.get(file);
        if (fi) {
          out.files.add(file);
          if (cur !== startId && sc.laneOf(file) === 'ui') { const mm = file.match(/(?:^|\/)components?\/(.+)$/); const label = mm ? (mm[1].includes('/') ? mm[1].split('/').slice(0, 2).join('/') : mm[1].replace(/\.[a-z]+$/, '')) : file.replace(/\.[a-z]+$/, '').split('/').slice(-2).join('/'); out.ui.set(label, (out.ui.get(label) || 0) + 1); }
          if (fi.useServer && fn !== '<module>' && fi.decls[fn] && fi.decls[fn].exported) out.actions.add(fn + '()');
          for (const h of (fi.hints && fi.hints[fn]) || []) out.hints.add(h);
        }
        const r = routeAt.get(cur); if (r && cur !== startId) out.api.add(r.method + ' ' + r.url);
        if (d >= 10) continue;
        for (const e of g.out.get(cur) || []) if (!seen.has(e.to)) { seen.set(e.to, d + 1); q.push(e.to); }
      }
      return out;
    };
    const card = (r, kindLabel) => {
      const o = reach(resolveStart(r.file, r.fn));
      const tables = [...o.hints].filter((h) => h.startsWith('from:') || h.startsWith('table:') || h.startsWith('collection:') || h.startsWith('container:')).map((h) => h.split(':')[1]);
      const rpcs = [...o.hints].filter((h) => h.startsWith('rpc:')).map((h) => 'rpc ' + h.split(':')[1]);
      return {
        id: (r.kind === 'page' ? 'p:' + r.url + '|' + r.file : 'r:' + r.method + ' ' + r.url + '|' + r.file + '|' + r.fn),
        title: r.kind === 'page' ? r.url : (r.method === 'MIDDLEWARE' ? r.file : r.method + ' ' + r.url), kind: kindLabel, file: r.file,
        ui: [...o.ui.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => k + (v > 1 ? ' ×' + v : '')),
        actions: [...o.actions].slice(0, 8), api: [...o.api].slice(0, 8),
        data: { packages: [...o.pkgs], tables: [...new Set(tables)].slice(0, 10), rpcs: [...new Set(rpcs)].slice(0, 6) },
        files: o.files.size,
      };
    };
    const groups = new Map();
    const add = (name, c) => { if (!groups.has(name)) groups.set(name, []); groups.get(name).push(c); };
    for (const r of m.routes) {
      if (r.kind === 'page') { const seg = r.url.split('/').filter(Boolean)[0] || 'home'; add('Pages · ' + seg, card(r, 'page')); }
    }
    for (const r of m.routes) {
      if (r.kind === 'middleware') add('Entry · middleware / proxy', card(r, 'middleware'));
      else if (r.kind === 'api') add('API routes' + (r.url.split('/')[1] ? ' · /' + r.url.split('/')[1] : ''), card(r, 'api'));
    }
    const actionFiles = [...sc.files.values()].filter((f) => f.useServer && !sc.isTestFile(f.rel)).map((f) => f.rel);
    const scripts = Object.entries(m.entry.scripts || {}).map(([name, cmd]) => ({ name, cmd }));
    return {
      project: { name: m.name, engines: m.engines, framework: m.framework, stats: m.stats },
      entry: { main: m.entry.main, bin: m.entry.bin, scripts, serverActionFiles: actionFiles.slice(0, 30), serverActionFileCount: actionFiles.length },
      groups: [...groups.entries()].map(([name, cards]) => ({ name, cards: cards.sort((a, b) => a.title.localeCompare(b.title)) })),
    };
  }


  // ---------- chain: the whole reachable structure as a foldable tree ----------
  chain(id, opts = {}) {
    const m = this.model, g = m.graph, sc = this.sc;
    let n = 0; const nodes = {};
    const mk = (o) => { const nid = 'n' + (++n); nodes[nid] = Object.assign({ id: nid, children: [] }, o); return nid; };
    const routeFns = new Set(m.routes.map((r) => r.file + '::' + r.fn));
    const real = (file, fn) => { const r = fn !== '<module>' ? sc.resolveExport(file, fn) : null; return r ? r.file + '::' + r.fn : file + '::' + fn; };
    const fields = (ref, etype) => {
      const gn = g.nodes.get(ref);
      if (gn && gn.pkg) { const hint = ''; return { ref, label: gn.pkg, file: 'package ' + gn.pkg, lane: gn.lane || 'az', kind: gn.lane === 'db' ? 'data' : 'cloud', etype, pkg: true, ret: true, doc: 'External package.', hints: [] }; }
      const [file, fn] = ref.split('::'); const fi = sc.files.get(file) || { decls: {}, hints: {}, comment: '' };
      const lane = sc.laneOf(file), d = fi.decls[fn];
      const callers = (g.rev.get(ref) || []).filter((r) => !sc.isTestFile(r.from.split('::')[0])).slice(0, 6).map((r) => r.from.replace('::', ' → '));
      return {
        ref, label: fn === '<module>' ? path.posix.basename(file) : fn === 'default' ? 'default export' : fn + (d && d.fn === false ? '' : '()'), file, fn, line: d ? d.line : null, lane, etype,
        kind: lane === 'ui' ? 'browser' : (fi.useServer || routeFns.has(ref)) ? 'server' : 'code',
        ret: d ? d.ret !== false : false, params: d && d.carry ? d.carry.params : null, retType: d && d.carry ? d.carry.retType : null, retExpr: d && d.carry ? d.carry.retExpr : null, kinds: d && d.carry ? d.carry.kinds || [] : [], throws: !!(d && d.carry && d.carry.throws), catches: !!(d && d.carry && d.carry.catches), errRet: !!(d && d.carry && d.carry.errRet),
        doc: ((d && d.doc) || fi.comment || '').slice(0, 220), hints: [...new Set((fi.hints && fi.hints[fn]) || [])].map((x) => x.replace(':', ' ')).slice(0, 10), action: !!(fi.useServer && d && d.exported), callers,
      };
    };
    const subtree = (startRef, o = {}) => {
      const depth = o.depth || 10, cap = o.cap || 250;
      const rootId = mk(fields(startRef, o.etype || 'child'));
      const seen = new Map([[startRef, rootId]]); const q = [[startRef, rootId, 0]]; let count = 1;
      while (q.length) {
        const [ref, nid, d] = q.shift();
        if (nodes[nid].pkg) continue;
        const outs = g.out.get(ref) || [];
        if (d >= depth) { if (outs.length) nodes[nid].lazy = ref; continue; }
        for (const e of outs) {
          if (seen.has(e.to)) { const l = (nodes[nid].links = nodes[nid].links || []); if (l.length < 10) l.push({ to: seen.get(e.to), label: (g.nodes.get(e.to) && g.nodes.get(e.to).pkg) || e.to.split('::')[1] + '()' }); continue; }
          if (count >= cap) { nodes[nid].lazy = ref; break; }
          const cid = mk(fields(e.to, e.type)); nodes[cid].via = e.label || ''; nodes[nid].children.push(cid); seen.set(e.to, cid); q.push([e.to, cid, d + 1]); count++;
        }
      }
      return rootId;
    };
    const group = (label, children, extra = {}) => mk(Object.assign({ label, kind: 'group', lane: 'ui', children, file: '', etype: 'group', doc: '' }, extra));
    const lazyNode = (label, ref, extra = {}) => mk(Object.assign({ label, ref, lazy: ref, kind: 'code', lane: sc.laneOf(ref.split('::')[0]), etype: 'child', file: ref.split('::')[0], doc: '' }, extra));

    // lazy expansion of one node
    if (opts.ref) { const rootId = subtree(opts.ref, { depth: 8, cap: 220 }); return { rootId, nodes, lazy: true }; }

    // the whole app, from the entry
    if (id === 'e:app') {
      const kids = [];
      const layouts = [...sc.files.keys()].filter((f) => /^(src\/)?app\/layout\.[cm]?[jt]sx?$/.test(f));
      if (layouts.length) kids.push(subtree(real(layouts[0], 'default'), { depth: 6, cap: 160, etype: 'child' }));
      const pagesBy = new Map();
      for (const r of m.routes.filter((x) => x.kind === 'page')) { const seg = r.url.split('/').filter(Boolean)[0] || 'home'; if (!pagesBy.has(seg)) pagesBy.set(seg, []); pagesBy.get(seg).push(r); }
      const pageGroups = [...pagesBy.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([seg, rs]) => group(seg === 'home' ? 'Home  /' : '/' + seg, rs.sort((a, b) => a.url.localeCompare(b.url)).map((r) => lazyNode(r.url, real(r.file, 'default'), { kind: 'page', lane: 'ui', file: r.file, doc: 'Page ' + r.url })), { lane: 'ui', doc: rs.length + ' page(s)' }));
      if (pageGroups.length) kids.push(group('Pages  (' + m.routes.filter((x) => x.kind === 'page').length + ')', pageGroups, { lane: 'ui' }));
      const apiBy = new Map();
      for (const r of m.routes.filter((x) => x.kind === 'api')) { const seg = r.url.split('/').filter(Boolean).slice(0, 2).join('/') || 'api'; if (!apiBy.has(seg)) apiBy.set(seg, []); apiBy.get(seg).push(r); }
      const apiGroups = [...apiBy.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([seg, rs]) => group('/' + seg, rs.map((r) => lazyNode(r.method + ' ' + r.url, real(r.file, r.fn), { kind: 'server', lane: 'srv', file: r.file, doc: r.method + ' ' + r.url })), { lane: 'srv' }));
      if (apiGroups.length) kids.push(group('API routes  (' + m.routes.filter((x) => x.kind === 'api').length + ')', apiGroups, { lane: 'srv' }));
      for (const r of m.routes.filter((x) => x.kind === 'middleware')) kids.push(lazyNode('middleware · ' + r.file, real(r.file, r.fn), { kind: 'security', lane: 'srv', file: r.file, doc: 'Runs before every request.' }));
      const af = [...sc.files.values()].filter((f) => f.useServer && !sc.isTestFile(f.rel));
      if (af.length) kids.push(group('Server actions  (' + af.length + ' files)', af.map((f) => group(f.rel, Object.entries(f.decls).filter(([, d]) => d.exported).map(([fn]) => lazyNode(fn + '()', f.rel + '::' + fn, { kind: 'server', lane: 'srv', file: f.rel, doc: 'Server action' })), { lane: 'srv' })), { lane: 'srv' }));
      const sc2 = Object.entries(m.entry.scripts || {}).map(([k, v]) => 'npm run ' + k + '  →  ' + v);
      if (sc2.length) kids.push(mk({ label: 'Scripts', kind: 'info', lane: 'you', file: 'package.json', etype: 'child', doc: sc2.join('\n'), children: [] }));
      const root = mk({ label: m.name, kind: 'entry', lane: 'you', file: 'package.json', etype: 'child', doc: (m.engines ? 'node ' + m.engines + ' · ' : '') + Object.keys(m.framework).join(', '), children: kids });
      return { rootId: root, nodes, title: m.name + ' · entry', sub: 'Root layout, every page, API route, middleware and server action. Click the chevron on a node to open a node.' };
    }

    // one page: its layouts (outer to inner) around the page, each with what it uses
    if (id.startsWith('p:')) {
      const [url, file] = id.slice(2).split('|');
      const dirs = path.posix.dirname(file).split('/'); const roots = [];
      for (let i = 1; i <= dirs.length; i++) {
        const dir = dirs.slice(0, i).join('/');
        const lay = ['tsx', 'jsx', 'ts', 'js'].map((x) => dir + '/layout.' + x).find((f) => sc.files.has(f));
        if (lay) { const r = subtree(real(lay, 'default'), { depth: 5, cap: 120 }); nodes[r].kind = nodes[r].kind === 'browser' ? 'browser' : nodes[r].kind; nodes[r].label = 'layout · ' + dir; roots.push(r); }
      }
      const pageRoot = subtree(real(file, 'default'), { depth: 10, cap: 260 }); nodes[pageRoot].label = 'Page ' + url; nodes[pageRoot].kind = 'page'; roots.push(pageRoot);
      for (let i = 0; i < roots.length - 1; i++) nodes[roots[i]].children.push(roots[i + 1]);
      return { rootId: roots[0], nodes, title: 'Page ' + url, sub: file + ' · layouts around the page, then what the page uses' };
    }
    // a route or a function
    let ref = null, title = '';
    if (id.startsWith('r:')) { const [mu, file, fn] = id.slice(2).split('|'); ref = real(file, fn); title = mu; }
    else if (id.startsWith('f:')) { ref = real(id.slice(2).split('::')[0], id.slice(2).split('::')[1]); title = id.slice(2).split('::')[1] + '()'; }
    if (!ref) return null;
    const rootId = subtree(ref, { depth: 10, cap: 260 });
    return { rootId, nodes, title, sub: ref.split('::')[0] };
  }

  // ---------- one flow ----------
  get(id, opts = {}) {
    if (id.startsWith('c:')) return this.getCurated(id.slice(2));
    if (id.startsWith('r:')) { const [mu, file, fn] = id.slice(2).split('|'); const sp = mu.indexOf(' '); return this.autoFlow(file + '::' + fn, { title: mu, sub: file, upstream: true, sink: opts.sink }); }
    if (id.startsWith('p:')) { const [url, file] = id.slice(2).split('|'); return this.autoFlow(file + '::default', { title: 'Page ' + url, sub: file, upstream: false, sink: opts.sink }); }
    if (id.startsWith('f:')) { const key = id.slice(2); return this.autoFlow(key, { title: key.split('::')[1] + '()', sub: key.split('::')[0], upstream: true, sink: opts.sink }); }
    return null;
  }

  staleCount(flow) { let n = 0; for (const s of flow.steps) if (this.refsOf(s).some((r) => !r.ok)) n++; return n; }

  refsOf(step) {
    return (step.files || []).map(([file, fn]) => {
      if (!file || file.startsWith('(') || file.startsWith('package:') ) return { file, fn, ok: true, missing: [] };
      const abs = path.join(this.sc.root, file);
      let text = null;
      try { const st = fs.statSync(abs); if (st.isDirectory()) return { file, fn, ok: true, missing: [] }; text = fs.readFileSync(abs, 'utf8'); } catch (_) { return { file, fn, ok: false, missing: ['(file not found)'] }; }
      if (!/\.[cm]?[jt]sx?$/.test(file)) return { file, fn, ok: true, missing: [] };
      const names = [...String(fn).matchAll(/([A-Za-z_$][\w$]*)\(\)/g)].map((m) => m[1]);
      const missing = names.filter((n) => !text.includes(n));
      return { file, fn, ok: missing.length === 0, missing };
    });
  }

  getCurated(id) {
    for (const c of this.curated.categories) for (const it of c.items) {
      if (it.id !== id) continue;
      const steps = it.steps.map((s) => {
        const refs = this.refsOf(s);
        return Object.assign({}, s, { refs, stale: refs.some((r) => !r.ok) });
      });
      return { id: 'c:' + id, title: it.title, sub: it.sub || '', curated: true, laneNames: this.curated.laneNames, steps };
    }
    return null;
  }

  // ---------- auto flows ----------
  autoFlow(startId, { title, sub, upstream, sink: wantSink }) {
    const g = this.model.graph;
    { const [f0, fn0] = startId.split('::'); const real = fn0 !== '<module>' ? this.sc.resolveExport(f0, fn0) : null; if (real) startId = real.file + '::' + real.fn; }
    if (!g.nodes.has(startId)) {
      // the start may not have outgoing edges (a leaf): still show it
      const [file, fn] = startId.split('::'); g.nodes.set(startId, { id: startId, file, fn });
    }
    const down = this.downPath(startId, wantSink);
    const up = upstream ? this.upPath(startId) : [];
    const ids = [...up, ...down.path].slice(0, MAX_STEPS + 3);
    const steps = ids.map((id, i) => this.stepFor(id, { first: i === 0, entry: id === startId, prev: i > 0 ? ids[i - 1] : null }));
    const note = down.sink ? `Ends at ${down.sink} (${down.hops} hops)` : 'No database or cloud package reached from here';
    return { id: startId, title, sub: sub + ' · ' + note, auto: true, steps, sink: down.sink, others: down.others };
  }

  downPath(startId, wantSink) {
    const g = this.model.graph;
    const prev = new Map([[startId, null]]), depth = new Map([[startId, 0]]);
    const q = [startId], sinks = [];
    let deepest = startId, seen = 0;
    while (q.length && seen++ < 6000) {
      const cur = q.shift(), d = depth.get(cur), n = g.nodes.get(cur);
      if (n && n.pkg) { sinks.push(cur); continue; }
      if (d >= MAX_STEPS) continue;
      for (const e of g.out.get(cur) || []) {
        if (prev.has(e.to)) continue;
        prev.set(e.to, cur); depth.set(e.to, d + 1); q.push(e.to);
        if (depth.get(e.to) > depth.get(deepest) && depth.get(e.to) <= 6) deepest = e.to;
      }
    }
    const pick = (wantSink && sinks.find((s) => g.nodes.get(s).pkg === wantSink)) || sinks[0] || null;
    const target = pick || deepest;
    const path = []; for (let c = target; c; c = prev.get(c)) path.unshift(c);
    const others = sinks.filter((s) => s !== pick).map((s) => g.nodes.get(s).pkg);
    return { path, sink: pick ? g.nodes.get(pick).pkg : null, hops: path.length - 1, others: [...new Set(others)].slice(0, 8) };
  }

  upPath(startId) {
    const g = this.model.graph, seen = new Set([startId]), up = [];
    let cur = startId;
    for (let level = 0; level < 3; level++) {
      const list = (g.rev.get(cur) || []).filter((r) => !seen.has(r.from) && !this.sc.isTestFile(r.from.split('::')[0]));
      if (!list.length) break;
      const prefer = list.find((r) => r.type === 'fetch' && this.sc.laneOf(r.from.split('::')[0]) === 'ui') || list.find((r) => this.sc.laneOf(r.from.split('::')[0]) === 'ui') || list[0];
      seen.add(prefer.from); up.unshift(prefer.from); cur = prefer.from;
    }
    return up;
  }

  stepFor(id, ctx) {
    const g = this.model.graph, n = g.nodes.get(id);
    if (n && n.pkg) {
      const lane = n.lane || 'az';
      const callers = (g.rev.get(id) || []).slice(0, 4).map((r) => r.from.replace('::', ' → '));
      let hint = '';
      if (ctx && ctx.prev) { const [pf, pfn] = ctx.prev.split('::'); const h = ((this.sc.files.get(pf) || {}).hints || {})[pfn]; if (h && h.length) hint = [...new Set(h)].map((x) => x.replace(':', ' ')).join(', '); }
      return { kind: KIND_OF_LANE[lane], lane, t: n.pkg, d: hint ? 'Touches: ' + hint : 'External package (' + (lane === 'db' ? 'data store client' : 'cloud / identity client') + ').', detail: 'External package ' + n.pkg + '.\n' + (hint ? 'Touches: ' + hint + '\n' : '') + 'Used by: ' + (callers.join(', ') || '—'), name: 'package ' + n.pkg, files: [['package: ' + n.pkg, hint ? hint : 'used by ' + (callers[0] || '—')]] };
    }
    const [file, fn] = id.split('::');
    const fi = this.sc.files.get(file) || { comment: '', decls: {}, lines: 0 };
    const lane = this.sc.laneOf(file);
    const doc = (fi.decls[fn] && fi.decls[fn].doc) || '';
    const outs = (g.out.get(id) || []).map((e) => e.label).filter(Boolean);
    const callers = (g.rev.get(id) || []).filter((r) => !this.sc.isTestFile(r.from.split('::')[0])).slice(0, 5).map((r) => r.from.replace('::', ' → '));
    const t = fn === '<module>' ? path.posix.basename(file) : fn === 'default' ? 'default export' : fn + ((fi.decls[fn] && fi.decls[fn].fn === false) ? '' : '()');
    const text = doc || fi.comment || '';
    const hintList = (fi.hints && fi.hints[fn]) ? [...new Set(fi.hints[fn])].map((x) => x.replace(':', ' ')) : [];
    const detail = [text, hintList.length ? 'Touches: ' + hintList.join(', ') : '', fi.useServer ? 'Server action ("use server").' : '', outs.length ? 'Calls: ' + [...new Set(outs)].slice(0, 10).join(', ') : '', callers.length ? 'Called by: ' + callers.join(', ') : ''].filter(Boolean).join('\n');
    const others = Object.entries(fi.decls || {}).filter(([k, d]) => d.exported && k !== fn).map(([k]) => k + '()');
    const files = [[file + (fi.decls[fn] ? ':' + fi.decls[fn].line : ''), fn === '<module>' ? '(module level)' : t + (others.length ? '   · also in this file: ' + others.slice(0, 4).join(', ') + (others.length > 4 ? ' …' : '') : '')]];
    return { kind: lane === 'ui' ? 'browser' : ((fi.useServer || this.model.routes.some((r) => r.file === file && r.fn === fn)) ? 'server' : 'code'), lane, t, d: (text || (outs.length ? 'Calls ' + [...new Set(outs)].slice(0, 4).join(', ') : 'Leaf function.')).slice(0, 120), detail, name: (fi.useServer ? 'server action · ' : '') + shortPath(file), files };
  }
}

function shortPath(p) { const parts = p.split('/'); return parts.length > 3 ? parts.slice(-3).join('/') : p; }

module.exports = { Flows, curatedPaths };
