'use strict';
// Local server: serves the UI and the model of ONE project folder (read-only), and pushes
// live updates when files change. Bound to 127.0.0.1 only; checks the Host header.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { Scanner, IGNORE_DIRS } = require('./scanner');
const { Flows } = require('./flows');
const { checkProject, loadRecents, addRecent, forgetRecent } = require('./projects');
const { execFile } = require('child_process');
const crypto = require('crypto');

const WEB = path.join(__dirname, '..', 'web');
const CODE = /\.[cm]?[jt]sx?$|(^|\/)(package|tsconfig)\.json$|flows\.json$/;

function isNodeProject(dir) { return checkProject(dir).ok; }

/** Folder picker for browser mode (macOS). The desktop app passes its own native dialog. */
function defaultPick() {
  return new Promise((resolve) => {
    if (process.platform !== 'darwin') return resolve(null);
    execFile('osascript', ['-e', 'POSIX path of (choose folder with prompt "Choose a Node project folder")'], (err, out) => resolve(err ? null : String(out).trim().replace(/\/$/, '')));
  });
}

function createServer(opts = {}) {
  let root = null, sc = null, flows = null, watchers = [], timer = null, pending = new Set(), scanning = false, version = 0, lastError = null;
  const clients = new Set();
  const host = opts.host || '127.0.0.1';

  const send = (obj) => { const d = 'data: ' + JSON.stringify(obj) + '\n\n'; for (const c of clients) { try { c.write(d); } catch (_) { clients.delete(c); } } };

  function stopWatch() { for (const w of watchers) { try { w.close(); } catch (_) { /* ignore */ } } watchers = []; clearTimeout(timer); pending = new Set(); }

  function rescan(changed) {
    if (!sc) return;
    scanning = true; send({ type: 'scanning' });
    try { sc.scan(changed); flows.loadCurated(); lastError = null; } catch (e) { lastError = String(e.message || e); }
    scanning = false; version++;
    send({ type: 'scan', version, scannedAt: sc.model && sc.model.scannedAt, changed: changed || [], error: lastError });
  }

  function startWatch() {
    try {
      watchers.push(fs.watch(root, { recursive: true }, (ev, name) => {
        if (!name) return;
        const rel = String(name).split(path.sep).join('/');
        if (rel.split('/').some((s) => IGNORE_DIRS.has(s) || (s.startsWith('.') && s !== '.nodebox'))) return;
        if (!CODE.test(rel)) return;
        pending.add(rel); clearTimeout(timer);
        timer = setTimeout(() => { const list = [...pending]; pending = new Set(); rescan(list); }, 350);
      }));
    } catch (e) { lastError = 'live watch failed: ' + e.message; }
    for (const f of flows.watchedFiles()) {
      const dir = path.dirname(f);
      try { if (fs.existsSync(dir)) watchers.push(fs.watch(dir, (ev, name) => { if (name === path.basename(f)) { clearTimeout(timer); timer = setTimeout(() => rescan([]), 250); } })); } catch (_) { /* ignore */ }
    }
  }

  function setRoot(dir) {
    const chk = checkProject(dir);
    if (!chk.ok) throw new Error('Not a Node project: ' + chk.checks.filter((c) => !c.ok).map((c) => c.detail || c.label).join('; '));
    const abs = chk.dir;
    addRecent(abs, chk.info.name);
    if (opts.onProject) { try { opts.onProject(chk); } catch (_) { /* ignore */ } }
    stopWatch();
    root = abs; sc = new Scanner(root); flows = new Flows(sc, { flows: opts.flows });
    flows.loadCurated();
    version++; send({ type: 'project', root: abs });
    setImmediate(() => { rescan(); startWatch(); });
  }

  // answers that only depend on the scan are built once per scan and then served from memory (304 for an unchanged browser copy)
  const bodyCache = new Map(); let cacheVer = '';
  const cached = (req, res, key, build) => {
    const ver = root + '|' + (sc && sc.model ? sc.model.scannedAt : 0);
    if (ver !== cacheVer) { bodyCache.clear(); cacheVer = ver; }
    let ent = bodyCache.get(key);
    if (!ent) {
      const obj = build(); if (!obj) return json(res, 404, { error: 'not found' });
      const body = JSON.stringify(obj);
      ent = { body, etag: '"' + crypto.createHash('md5').update(ver + key).digest('hex').slice(0, 16) + '"' };
      bodyCache.set(key, ent);
    }
    if (req.headers['if-none-match'] === ent.etag) { res.writeHead(304, { etag: ent.etag }); return res.end(); }
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache', etag: ent.etag });
    res.end(ent.body);
  };
  const json = (res, code, obj) => { const b = JSON.stringify(obj); res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(b); };

  const server = http.createServer((req, res) => {
    const h = String(req.headers.host || '').split(':')[0];
    if (h !== '127.0.0.1' && h !== 'localhost') { res.writeHead(403); return res.end('forbidden'); }
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write('retry: 2000\n\n'); clients.add(res); req.on('close', () => clients.delete(res)); return;
    }
    if (u.pathname === '/api/model') {
      if (!root) return json(res, 200, { noProject: true });
      if (!sc || !sc.model) return json(res, 200, { scanning: true, project: root ? { name: require('path').basename(root), root } : null });
      const m = sc.model;
      return json(res, 200, { scanning, version, error: lastError, project: { name: m.name, root: m.root, framework: m.framework, stats: m.stats, scannedAt: m.scannedAt, curatedFile: flows.curatedFile }, categories: flows.list() });
    }
    if (u.pathname === '/api/overview') {
      if (!flows || !sc.model) return json(res, 503, { error: 'scanning' });
      return cached(req, res, req.url, () => flows.overview());
    }
    if (u.pathname === '/api/chain') {
      if (!flows || !sc.model) return json(res, 503, { error: 'scanning' });
      return cached(req, res, req.url, () => flows.chain(u.searchParams.get('id') || '', { ref: u.searchParams.get('ref') || undefined }));
    }
    if (u.pathname === '/api/flow') {
      if (!flows || !sc.model) return json(res, 503, { error: 'scanning' });
      return cached(req, res, req.url, () => flows.get(u.searchParams.get('id') || '', { sink: u.searchParams.get('sink') || undefined }));
    }
    if (u.pathname === '/api/rescan' && req.method === 'POST') { rescan([]); return json(res, 200, { ok: true }); }
    if (u.pathname === '/api/projects') {
      return json(res, 200, { current: root, recent: loadRecents().map((r) => Object.assign({}, r, { ok: checkProject(r.dir).ok })) });
    }
    if (u.pathname.startsWith('/api/project/') && req.method === 'POST') {
      if (req.headers['x-nodebox'] !== '1') { res.writeHead(403); return res.end('forbidden'); }
      let body = ''; req.on('data', (d) => { body += d; if (body.length > 10000) req.destroy(); });
      req.on('end', async () => {
        let j = {}; try { j = JSON.parse(body || '{}'); } catch (_) { /* empty */ }
        try {
          if (u.pathname === '/api/project/check') return json(res, 200, checkProject(j.dir));
          if (u.pathname === '/api/project/pick') { const p = await (opts.pickFolder || defaultPick)(); return json(res, 200, { dir: p || null }); }
          if (u.pathname === '/api/project/forget') { forgetRecent(path.resolve(String(j.dir || ''))); return json(res, 200, { ok: true }); }
          if (u.pathname === '/api/project/open') { const chk = checkProject(j.dir); if (!chk.ok) return json(res, 400, chk); setRoot(chk.dir); return json(res, 200, chk); }
        } catch (e) { return json(res, 500, { error: String(e.message || e) }); }
        return json(res, 404, { error: 'not found' });
      });
      return;
    }
    // static
    let p = u.pathname === '/' ? '/index.html' : u.pathname;
    const file = path.normalize(path.join(WEB, p));
    if (!file.startsWith(WEB + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('not found'); }
    const type = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' }[path.extname(file)] || 'application/octet-stream';
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(opts.port || 0, host, () => {
      const port = server.address().port;
      if (opts.root) setRoot(opts.root);
      resolve({ server, port, url: 'http://127.0.0.1:' + port, setRoot, rescan: () => rescan([]), close: () => { stopWatch(); for (const c of clients) { try { c.end(); } catch (_) { /* ignore */ } } server.close(); }, get root() { return root; }, get scanner() { return sc; }, get flows() { return flows; } });
    });
  });
}

module.exports = { createServer, isNodeProject };
