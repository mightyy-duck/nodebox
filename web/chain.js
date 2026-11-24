/* NodeBox chain view: the whole reachable structure as a foldable tree.
   Request goes down (solid), the answer comes back up (dashed). Needs index.html globals: $, get, svg, KIND, LANE, toast, zoom */
"use strict";
(function () {
  const NS = "http://www.w3.org/2000/svg";
  const NW = 262, NH = 48, GX = 58, GY = 8, PAD = 22;
  const KC = { browser: "--k-browser", server: "--k-server", code: "--k-code", data: "--k-data", cloud: "--k-cloud", security: "--k-security", page: "--k-browser", layout: "--k-user", entry: "--c", group: "--faint", info: "--k-user" };
  const CH = { pool: [], id: null, title: "", nodes: {}, vg: {}, rootId: null, open: new Set(), sel: null, q: "", lanes: new Set(["you", "ui", "srv", "db", "az"]), rows: [], parent: {}, up: {}, seq: 0, anim: null, vw: 800, zoom: 0.9 };
  let csvg = null, raf = 0, last = 0;
  const el = (n, a = {}, p) => { const e = document.createElementNS(NS, n); for (const k in a) e.setAttribute(k, a[k]); if (p) p.appendChild(e); return e; };
  const sty = (e, o) => { for (const k in o) e.style.setProperty(k, o[k]); return e; };
  const isV = (id) => id.startsWith("v:");
  const node = (id) => (isV(id) ? CH.vg[id] : CH.nodes[id]);
  const dirOf = (n) => { const f = n.file || ""; if (!f || f.startsWith("package")) return null; const p = f.split("/"); return p.slice(0, -1).slice(-2).join("/") || p[0]; };

  /* ---------- data ---------- */
  function merge(resp, parentId) {
    const pre = "x" + (++CH.seq) + "_", map = (id) => pre + id, out = {};
    for (const id in resp.nodes) { const n = Object.assign({}, resp.nodes[id]); n.id = map(id); n.children = n.children.map(map); if (n.links) n.links = n.links.map((l) => ({ to: map(l.to), label: l.label })); out[n.id] = n; }
    Object.assign(CH.nodes, out);
    return map(resp.rootId);
  }
  function indexUp() { CH.up = {}; for (const id in CH.nodes) for (const c of CH.nodes[id].children) CH.up[c] = id; }
  function displayKids(id) {
    if (isV(id)) return CH.vg[id].members.map((c) => ({ id: c }));
    const n = CH.nodes[id]; if (!n) return [];
    const arr = n.children;
    if (arr.length < 5) return arr.map((c) => ({ id: c }));
    const by = new Map();
    for (const c of arr) { const d = dirOf(CH.nodes[c]) || "~"; if (!by.has(d)) by.set(d, []); by.get(d).push(c); }
    const out = [];
    for (const [d, list] of by) {
      if (list.length >= 3 && d !== "~") { const gid = "v:" + id + ":" + d; CH.vg[gid] = { id: gid, virtual: true, label: d + "/", members: list, lane: CH.nodes[list[0]].lane, kind: "group", count: list.length, children: list, file: "", doc: list.length + " items in " + d, etype: "group" }; out.push({ id: gid }); }
      else list.forEach((c) => out.push({ id: c }));
    }
    return out;
  }
  function reveal(id) {
    let cur = id;
    while (cur && CH.up[cur] !== undefined) {
      const p = CH.up[cur]; CH.open.add(p);
      for (const k of displayKids(p)) if (isV(k.id) && CH.vg[k.id].members.includes(cur)) CH.open.add(k.id);
      cur = p;
    }
  }

  /* ---------- layout ---------- */
  const matchNode = (n) => { const q = CH.q; if (!q) return false; const f = n.file || ""; return ((n.label || "") + " " + (q.includes("/") ? f : f.split("/").pop())).toLowerCase().includes(q); };
  // search: keep only the matches and the route (ancestors) that leads to each of them
  function applySearch() {
    CH.hits = new Set(); CH.keep = null;
    if (!CH.q) return;
    for (const id in CH.nodes) if (matchNode(CH.nodes[id])) CH.hits.add(id);
    const keep = new Set([CH.rootId]);
    for (const id of CH.hits) {
      let cur = id; keep.add(cur);
      while (CH.up[cur] !== undefined) {
        const p = CH.up[cur]; keep.add(p);
        for (const k of displayKids(p)) if (isV(k.id) && CH.vg[k.id].members.includes(cur)) keep.add(k.id);
        cur = p;
      }
    }
    CH.keep = keep;
  }
  function layout() {
    CH.rows = []; CH.parent = {};
    (function rec(id, depth, par) {
      CH.rows.push({ id, depth, par, i: CH.rows.length });
      if (par !== null) CH.parent[id] = par;
      const all = displayKids(id);
      if (CH.q && CH.keep) { for (const k of all) if (CH.keep.has(k.id)) rec(k.id, depth + 1, id); }
      else if (CH.open.has(id)) for (const k of all) rec(k.id, depth + 1, id);
    })(CH.rootId, 0, null);
  }

  /* ---------- render ---------- */
  function render() {
    layout();
    const rows = CH.rows, maxD = Math.max(...rows.map((r) => r.depth));
    CH.vw = PAD * 2 + (maxD + 1) * NW + maxD * GX;
    const vh = PAD * 2 + rows.length * (NH + GY); CH.vh = vh;
    csvg.innerHTML = ""; CH.pool = [];
    csvg.setAttribute("viewBox", `0 0 ${CH.vw} ${vh}`);
    csvg.style.width = CH.vw * CH.zoom + "px"; csvg.classList.toggle("lod", CH.zoom < 0.3);
    const defs = el("defs", {}, csvg);
    [["mreq", "--g1"], ["mres", "--g3"]].forEach(([id, v]) => { const m = el("marker", { id, viewBox: "0 0 8 8", refX: 7, refY: 4, markerWidth: 6, markerHeight: 6, orient: "auto" }, defs); sty(el("path", { d: "M0 0 L8 4 L0 8 z" }, m), { fill: `var(${v})` }); });
    const pos = {}; rows.forEach((r) => { pos[r.id] = { x: PAD + r.depth * (NW + GX), y: PAD + r.i * (NH + GY) }; });
    CH.pos = pos;
    // connectors: request (solid, down) and answer (dashed, back up)
    const gC = el("g", {}, csvg);
    rows.forEach((r) => {
      if (r.par === null) return;
      const a = pos[r.par], b = pos[r.id], n = node(r.id);
      const px = a.x + NW, py = a.y + NH / 2, cx = b.x, cy = b.y + NH / 2, mx = px + GX / 2;
      const rq = sty(el("path", { d: `M${px} ${py - 3} H${mx - 3} V${cy - 3} H${cx}`, fill: "none", "stroke-width": 1.8, "marker-end": "url(#mreq)" }, gC), { stroke: "var(--g1)" });
      const rs = sty(el("path", { d: `M${cx} ${cy + 3} H${mx + 3} V${py + 3} H${px}`, fill: "none", "stroke-width": 1.4, "stroke-dasharray": "3 3", "marker-end": "url(#mres)" }, gC), { stroke: "var(--g3)", opacity: 0.8 });
      if (n && n.etype === "fetch") { const t = el("text", { x: mx + 6, y: cy - 8, "font-size": 9.5, "font-weight": 700 }, gC); t.textContent = "HTTP"; sty(t, { fill: "var(--k-data)" }); }
    });
    // animation layer placeholders (above connectors, below nodes)
    CH.trailF = sty(el("path", { d: "M0 0", fill: "none", "stroke-width": 3.4, "stroke-linecap": "round", "stroke-linejoin": "round", stroke: "url(#cgrad)" }, csvg), { display: "none" });
    CH.trailR = sty(el("path", { d: "M0 0", fill: "none", "stroke-width": 3, "stroke-linecap": "round", "stroke-linejoin": "round", "stroke-dasharray": "6 5" }, csvg), { display: "none", stroke: "var(--g3)" });
    const gr = el("linearGradient", { id: "cgrad", gradientUnits: "userSpaceOnUse", x1: 0, y1: 0, x2: CH.vw, y2: 0 }, defs);
    [["0", "--g1"], ["0.45", "--g2"], ["1", "--g4"]].forEach(([o, v]) => sty(el("stop", { offset: o }, gr), { "stop-color": `var(${v})` }));
    // nodes
    CH.els = {};
    rows.forEach((r) => {
      const n = node(r.id), p = pos[r.id]; if (!n) return;
      const col = `var(${KC[n.kind] || "--k-code"})`;
      const g = el("g", { class: "cnode" + (n.virtual ? " virt" : "") + (CH.sel === r.id ? " sel" : "") + (CH.hits && CH.hits.has(r.id) ? " hit" : "") + (!CH.lanes.has(n.lane || "srv") ? " dim" : "") }, csvg);
      g.style.setProperty("--nk", col);
      sty(el("rect", { x: p.x, y: p.y, width: NW, height: NH, rx: 10 }, g), { fill: "var(--node-under)" });
      const body = sty(el("rect", { class: "cbody", x: p.x, y: p.y, width: NW, height: NH, rx: 10, "stroke-width": 1.6 }, g), { fill: "var(--node-fill)", stroke: col });
      if (n.virtual) body.setAttribute("stroke-dasharray", "5 4");
      sty(el("rect", { x: p.x, y: p.y + 8, width: 4, height: NH - 16, rx: 2 }, g), { fill: col });
      const t = el("text", { x: p.x + 14, y: p.y + 20, "font-size": 12.5, "font-weight": 700 }, g); const lab = n.label || ""; t.textContent = lab.length > 27 ? lab.slice(0, 26) + "…" : lab; sty(t, { fill: "var(--title)" });
      const f = el("text", { x: p.x + 14, y: p.y + 36, "font-size": 9.8, "font-family": "ui-monospace, Menlo, Consolas, monospace", class: "sub" }, g);
      const ft = n.virtual ? n.count + " items" : (n.file || "").split("/").slice(-2).join("/"); f.textContent = ft.length > 36 ? "…" + ft.slice(-35) : ft; sty(f, { fill: "var(--desc)" });
      const inSearch = !!(CH.q && CH.keep);
      const kept = inSearch ? rows.filter((x) => x.par === r.id).length : 0;
      const kids = inSearch ? kept : (isV(r.id) ? n.members.length : n.children.length), can = inSearch ? kept > 0 : (kids > 0 || !!n.lazy);
      if (can) {
        const open = inSearch ? true : CH.open.has(r.id);
        const cg = el("g", { class: "chev" }, g);
        sty(el("rect", { x: p.x + NW - 46, y: p.y + 10, width: 38, height: 28, rx: 8 }, cg), { fill: "var(--hover)", stroke: "var(--bd)" });
        LI.g(cg, open ? "chevron-down" : "chevron-right", p.x + NW - 43, p.y + 18, 12, "var(--sub2)"); const ct = el("text", { x: p.x + NW - 13, y: p.y + 29, "text-anchor": "end", "font-size": 11, "font-weight": 700 }, cg); ct.textContent = String(kids || "…"); sty(ct, { fill: "var(--sub2)" });
        cg.addEventListener("click", (e) => { e.stopPropagation(); if (inSearch) { toast("Clear the search to fold or unfold"); return; } toggle(r.id); });
      }
      const bi = LI.g(g, "car", p.x + 10, p.y - 15, 12, "var(--dot)"); bi.style.display = "none"; const bd = el("text", { x: p.x + 26, y: p.y - 4, "font-size": 10, "font-weight": 700, class: "cbadge" }, g); bd.textContent = "";
      const vm = el("g", { class: "vmark", style: "display:none" }, g); LI.g(vm, "circle-slash", p.x + 10, p.y + NH + 2, 11, "var(--k-security)"); const vt = el("text", { x: p.x + 26, y: p.y + NH + 11, "font-size": 10, "font-weight": 700 }, vm); vt.textContent = "returns nothing: the cars stop here";
      g.addEventListener("click", () => select(r.id));
      g.addEventListener("dblclick", () => follow(r.id));
      CH.els[r.id] = g; g._bd = bd; g._bi = bi; g._vm = vm;
    });
    CH.dotH = sty(el("circle", { r: 15, class: "halo", style: "display:none" }, csvg), { fill: "var(--dot)" });
    CH.dot = sty(el("circle", { r: 8, "stroke-width": 2.5, style: "display:none" }, csvg), { fill: "var(--dot)", stroke: "var(--node-under)" });
    $("chcount").textContent = (CH.q ? (CH.hits ? CH.hits.size : 0) + " match(es) · only their route shown · " : "") + rows.length + " shown · " + Object.keys(CH.nodes).length + " loaded";
  }

  /* ---------- actions ---------- */
  async function toggle(id) {
    if (D.on) { toast("Stop the cars first (the road is fixed while they drive)"); return; }
    const n = node(id); if (!n) return;
    if (CH.open.has(id)) { CH.open.delete(id); render(); return; }
    if (!isV(id) && n.lazy && n.children.length === 0) {
      const resp = await get("/api/chain?ref=" + encodeURIComponent(n.lazy));
      if (resp && resp.rootId) { const rid = merge(resp, id), r = CH.nodes[rid]; n.children = r.children; n.links = (n.links || []).concat(r.links || []); n.lazy = null; delete CH.nodes[rid]; indexUp(); }
    }
    CH.open.add(id); render();
  }
  function select(id) {
    if (D.on) { CH.sel = id; info(id); return; }
    CH.sel = id; render(); info(id);
    const st = $("stage"), p = CH.pos[id]; if (p) { const k = csvg.clientWidth / CH.vw; const y = p.y * k; if (y < st.scrollTop + 30 || y > st.scrollTop + st.clientHeight - 80) st.scrollTop = y - st.clientHeight / 3; }
  }
  function jumpTo(id) { if (CH.q && CH.keep && !CH.keep.has(id)) { CH.q = ""; CH.keep = null; CH.hits = null; $("chq").value = ""; } reveal(id); select(id); }
  function info(id) {
    const n = node(id), box = $("info"); if (!n) return;
    box.innerHTML = `<div class="cols"><div><div class="k"></div><h3></h3><p></p><div class="lk"></div></div><div class="files"><div class="k" style="color:var(--dim)">Which file · which function</div></div></div>`;
    const k = box.querySelector(".k"); k.style.color = `var(${KC[n.kind] || "--k-code"})`; k.textContent = (n.virtual ? "Group" : (n.kind || "")) + (n.etype && n.etype !== "group" ? " · reached by " + n.etype : "") + " · " + ((LANE[n.lane] || LANE.srv).name);
    box.querySelector("h3").textContent = n.label;
    box.querySelector("p").textContent = [n.doc, n.hints && n.hints.length ? "Touches: " + n.hints.join(", ") : ""].filter(Boolean).join("\n") || "";
    const lk = box.querySelector(".lk");
    const links = (n.links || []);
    if (links.length) { const h = document.createElement("div"); h.className = "k"; h.style.color = "var(--dim)"; h.textContent = "also calls (shown elsewhere in this chain):"; lk.appendChild(h); links.forEach((l) => { const c = document.createElement("span"); c.className = "chip"; c.textContent = l.label; c.onclick = () => jumpTo(l.to); lk.appendChild(c); }); }
    if (n.callers && n.callers.length) { const h = document.createElement("div"); h.className = "k"; h.style.cssText = "color:var(--dim);margin-top:6px"; h.textContent = "called by: " + n.callers.join(", "); lk.appendChild(h); }
    const fb = box.querySelector(".files");
    const add = (m) => { if (!m.file) return; const r = document.createElement("div"); r.className = "fr"; const a = document.createElement("code"); a.className = "ff"; a.textContent = m.file + (m.line ? ":" + m.line : ""); const b = document.createElement("span"); b.className = "fn"; b.textContent = m.label; r.append(a, b); fb.appendChild(r); };
    if (n.virtual) n.members.slice(0, 40).forEach((c) => add(CH.nodes[c])); else add(n);
  }

  /* ---------- follow: request goes down, the answer comes back ---------- */
  function follow(id) {
    if (D.on) { toast("Stop the cars first"); return; }
    if (!id) id = CH.sel; if (!id) { toast("Select a node first"); return; }
    reveal(id); CH.sel = id; render(); info(id);
    // chain of display rows root -> id
    const path = []; for (let c = id; c; c = CH.parent[c]) path.unshift(c);
    if (path.length < 2) { toast("This is the root"); return; }
    const pts = [], arrive = [];
    const first = CH.pos[path[0]]; pts.push({ x: first.x + NW, y: first.y + NH / 2 }); arrive.push(0);
    for (let i = 1; i < path.length; i++) {
      const a = CH.pos[path[i - 1]], b = CH.pos[path[i]], px = a.x + NW, py = a.y + NH / 2, cx = b.x, cy = b.y + NH / 2, mx = px + GX / 2;
      pts.push({ x: mx, y: py }, { x: mx, y: cy }, { x: cx, y: cy });
      pts.push({ x: cx + NW - 46, y: cy });          // through the card to the point where the next link starts
    }
    const cum = [0]; for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
    // arrival length of each node = the point at its left edge
    const arr = [0]; let idx = 0; for (let i = 1; i < path.length; i++) { idx += 3; arr.push(cum[idx]); idx += 1; }
    const d = "M" + pts.map((p) => p.x + " " + p.y).join(" L");
    const rev = "M" + [...pts].reverse().map((p) => p.x + " " + p.y).join(" L");
    CH.trailF.setAttribute("d", d); CH.trailR.setAttribute("d", rev);
    CH.anim = { path, pts, cum, arr, total: cum[cum.length - 1], pos: 0, dir: 1, dwell: 500, pathEl: CH.trailF };
    CH.dot.style.display = ""; CH.dotH.style.display = ""; CH.trailF.style.display = "";
    LI.txt($("chfollow"), "{{square}} Stop");
    if (!raf) { last = performance.now(); raf = requestAnimationFrame(tick); }
  }
  function stopFollow() { CH.anim = null; if (CH.dot) { CH.dot.style.display = "none"; CH.dotH.style.display = "none"; CH.trailF.style.display = "none"; CH.trailR.style.display = "none"; } Object.values(CH.els || {}).forEach((g) => g.classList.remove("act")); LI.txt($("chfollow"), "{{play}} Follow"); }
  function tick(ts) {
    raf = 0; const a = CH.anim; if (!a || !CH.dot) return;
    const dt = Math.min(60, ts - last) / 1000; last = ts;
    const sp = +$("chspeed").value;
    if (a.dwell > 0) a.dwell -= dt * 1000 * sp;
    else { a.pos += a.dir * 360 * sp * dt; if (a.dir === 1 && a.pos >= a.total) { a.pos = a.total; a.dir = -1; a.dwell = 1100; } if (a.dir === -1 && a.pos <= 0) { a.pos = 0; stopFollow(); return; } }
    const pathEl = CH.trailF, p = pathEl.getPointAtLength(Math.max(0, Math.min(a.pos, a.total)));
    CH.dot.setAttribute("cx", p.x); CH.dot.setAttribute("cy", p.y); CH.dotH.setAttribute("cx", p.x); CH.dotH.setAttribute("cy", p.y);
    if (a.dir === 1) { CH.trailF.style.display = ""; CH.trailR.style.display = "none"; CH.trailF.setAttribute("stroke-dasharray", `${a.pos} ${a.total + 60}`); }
    else { CH.trailR.style.display = ""; CH.trailF.style.display = ""; CH.trailF.setAttribute("stroke-dasharray", `${a.pos} ${a.total + 60}`); CH.trailR.setAttribute("stroke-dasharray", `6 5`); }
    let ai = 0; for (let i = 0; i < a.arr.length; i++) if (a.pos >= a.arr[i] - 1) ai = i;
    Object.entries(CH.els).forEach(([id, g]) => g.classList.toggle("act", id === a.path[ai]));
    const st = $("stage"), k = csvg.clientWidth / CH.vw, want = p.y * k - st.clientHeight * 0.45; st.scrollTop += (want - st.scrollTop) * 0.1;
    $("chphase").textContent = a.dwell > 0 && a.dir === 1 && a.pos >= a.total ? "reached the end: now the answer goes back up" : a.dir === 1 ? "request going down" : "answer coming back up";
    raf = requestAnimationFrame(tick);
  }


  /* ---------- drive: cars split at crossroads, turn back at dead ends that return a value ---------- */
  const D = { on: false, T: 0, total: 0, legs: [], order: [], reached: 0, vmarks: [], pool: [], rep: {}, grp: {}, tDown: {}, done: {}, lit: new Set(), flash: {}, voided: new Set(), ended: 0, returned: 0, started: 0 };
  const DWELL = 0.07, ROAD = 800;
  function repOf(id) {
    if (D.rep[id] !== undefined) return D.rep[id];
    let cur = id, out = null;
    while (cur !== undefined && cur !== null) {
      if (CH.pos[cur]) { out = cur; break; }
      const g = D.grp[cur]; if (g && CH.pos[g]) { out = g; break; }
      cur = CH.up[cur];
    }
    return (D.rep[id] = out || CH.rootId);
  }
  function edgeTime(a, b) {
    const ra = repOf(a), rb = repOf(b); if (ra === rb) return 0.14;
    const pa = CH.pos[ra], pb = CH.pos[rb]; if (!pa || !pb) return 0.25;
    return Math.max(0.2, (Math.abs(pb.y - pa.y) + Math.max(0, pb.x - (pa.x + NW)) + 40) / ROAD);
  }
  function elbow(pa, pb, f) {           // point at fraction f along parent -> child connector
    const px = pa.x + NW, py = pa.y + NH / 2, cx = pb.x, cy = pb.y + NH / 2, mx = px + GX / 2;
    const l1 = Math.abs(mx - px), l2 = Math.abs(cy - py), l3 = Math.abs(cx - mx), L = l1 + l2 + l3 || 1, d = f * L;
    if (d <= l1) return { x: px + Math.sign(mx - px || 1) * d, y: py };
    if (d <= l1 + l2) return { x: mx, y: py + Math.sign(cy - py || 1) * (d - l1) };
    return { x: mx + Math.sign(cx - mx || 1) * (d - l1 - l2), y: cy };
  }
  // the filtered route: with a search active, only the kept nodes are driven
  const kidsOf = (x) => { const a = CH.nodes[x].children; return CH.q && CH.keep ? a.filter((c) => CH.keep.has(c)) : a; };
  // real code runs one call at a time: a function calls its first callee, waits until it is completely done and returned, then calls the next. One car = the one thread of control.
  function elbowLen(pa, pb) { const px = pa.x + NW, py = pa.y + NH / 2, cx = pb.x, cy = pb.y + NH / 2, mx = px + GX / 2; return Math.abs(mx - px) + Math.abs(cy - py) + Math.abs(cx - mx) || 1; }
  function pathPt(chain, f) {
    const lens = [], P = chain.map((c) => CH.pos[c]); let tot = 0;
    for (let i = 0; i < P.length - 1; i++) { const l = elbowLen(P[i], P[i + 1]); lens.push(l); tot += l; }
    let d = f * tot;
    for (let i = 0; i < lens.length; i++) { if (d <= lens[i] || i === lens.length - 1) return elbow(P[i], P[i + 1], Math.min(1, d / lens[i])); d -= lens[i]; }
  }
  function schedule() {
    D.rep = {}; D.grp = {};
    for (const id in CH.nodes) for (const k of displayKids(id)) if (isV(k.id)) for (const m of CH.vg[k.id].members) D.grp[m] = k.id;
    D.legs = []; D.tDown = {}; D.done = {}; D.order = []; let n = 0;
    D.seed = ((D.seed || 20260101) * 1664525 + 1013904223) >>> 0; let sd = D.seed;
    const rnd = () => { sd = (sd + 0x6D2B79F5) >>> 0; let z = sd; z = Math.imul(z ^ (z >>> 15), z | 1); z ^= z + Math.imul(z ^ (z >>> 7), z | 61); return ((z ^ (z >>> 14)) >>> 0) / 4294967296; };
    const mode = ($("cherr") || { value: "ok" }).value;
    D.errCount = 0; D.caughtCount = 0; D.rootErr = false;
    const risky = (nx) => !nx.pkg && (nx.throws || nx.errRet);
    const run = (x, t0) => {                 // returns { t: time it is done, err: it ended in an error }
      D.tDown[x] = t0; D.order.push(x); let t = t0 + DWELL; const nx = CH.nodes[x];
      if (n++ > 3000) { D.done[x] = t; return { t, err: false }; }
      if (risky(nx) && (mode === "force" || (mode === "random" && rnd() < 0.4))) { D.done[x] = t; return { t, err: true }; }   // a guard at the top fails: the function never reaches its callees
      for (const c of kidsOf(x)) {
        const tt = edgeTime(x, c); D.legs.push({ type: "down", a: x, b: c, t0: t, t1: t + tt });
        const r = run(c, t + tt); t = r.t;
        const back = edgeTime(c, x), lg = { type: "up", a: c, b: x, t0: t, t1: t + back, empty: !CH.nodes[c].ret && !r.err, err: r.err };
        D.legs.push(lg); t += back + DWELL * 0.5;
        if (r.err) {
          D.errCount++;
          if (nx.catches) { lg.caught = true; D.caughtCount++; }          // try/catch in the caller: it handles the error and carries on
          else { D.done[x] = t; return { t, err: true }; }               // not caught: the error keeps travelling up
        }
      }
      D.done[x] = t; return { t, err: false };
    };
    D.rootErr = run(CH.rootId, 0).err;
    D.legs.forEach((l, i) => { l.i = i; });
    D.total = D.done[CH.rootId] + 0.6;
    D.order.sort((a, b) => D.tDown[a] - D.tDown[b]);
    D.vmarks = D.order.filter((x) => !CH.nodes[x].ret).sort((a, b) => D.done[a] - D.done[b]);
    D.started = 1 + D.legs.filter((l) => l.type === "down").length;
    // lookups that do not scan every leg on every frame
    D.slice = 0.1; D.buckets = [];
    for (const l of D.legs) for (let b = Math.floor(l.t0 / D.slice); b <= Math.floor(l.t1 / D.slice); b++) (D.buckets[b] = D.buckets[b] || []).push(l);
    D.downFrom = {}; D.upFrom = {};
    for (const l of D.legs) { if (l.type === "down") (D.downFrom[l.a] = D.downFrom[l.a] || []).push(l); else D.upFrom[l.a] = l; }
    D.downEnd = D.legs.filter((l) => l.type === "down").map((l) => l.t1).sort((a, b) => a - b);
    D.upEnd = D.legs.filter((l) => l.type === "up" && !l.empty && !l.err).map((l) => l.t1).sort((a, b) => a - b);
  }
  const countLE = (arr, x) => { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] <= x) lo = m + 1; else hi = m; } return lo; };
  function driveExpand() {
    const depth = {}; (function rec(id, d) { depth[id] = d; for (const c of CH.nodes[id].children) rec(c, d + 1); })(CH.rootId, 0);
    CH.open = new Set([CH.rootId]);
    for (const id in CH.nodes) if (CH.nodes[id].children.length && depth[id] < 4) { CH.open.add(id); for (const k of displayKids(id)) if (isV(k.id)) CH.open.add(k.id); }
  }

  /* ---------- what a car carries, where it is from and where it goes ---------- */
  const short = (t, n) => { t = String(t || ""); return t.length > n ? t.slice(0, n - 1) + "…" : t; };
  const KE = { element: "{{puzzle}}", object: "{{braces}}", array: "{{brackets}}", string: "{{type}}", number: "{{binary}}", boolean: "{{toggle-left}}", response: "{{mail}}", null: "{{circle-slash}}", value: "{{package}}" };
  const KW = { element: "an element / HTML", object: "an object { }", array: "an array [ ]", string: "a string", number: "a number", boolean: "true / false", response: "an HTTP response", null: "null (nothing)", value: "a value" };
  function emojiOf(l) {                                  // the kind of data a car carries, as an icon
    const f = CH.nodes[l.a], t = CH.nodes[l.b];
    if (l.type === "down") return t.etype === "fetch" ? "{{globe}}" : t.pkg ? (t.lane === "db" ? "{{database}}" : "{{cloud}}") : t.params ? "{{import}}" : "{{circle-slash}}";
    if (l.err) return "{{circle-x}}"; if (l.empty) return "{{circle-slash}}";
    if (f.pkg) return f.lane === "db" ? "{{database}}" : "{{cloud}}";
    const ks = (f.kinds || []).map((k) => KE[k] || "{{package}}"); return ks.length ? [...new Set(ks)].join(" ") : "{{package}}";
  }
  function carryOf(l) {
    const from = CH.nodes[l.a], to = CH.nodes[l.b];
    if (l.type === "down") {
      const callee = to, how = callee.etype === "fetch" ? "HTTP request " + (callee.via || "") : callee.etype === "pkg" ? "call into package" : callee.etype === "local" ? "call inside the same file" : "call";
      const args = callee.pkg ? "arguments of the call" : callee.params === null || callee.params === undefined ? "the value it reads" : callee.params ? "arguments (" + callee.params + ")" : "no arguments";
      return { dir: "request, going down", how, carry: args, from, to };
    }
    if (l.err) { const why = from.throws ? "throws an error" : from.errRet ? "returns an error (" + (from.retExpr || "") + ")" : "fails"; return { dir: "error, coming back up {{circle-x}}", how: l.caught ? "caught by try/catch in " + (to.label || "the caller") + ": it carries on" : "not caught: the error keeps going up", carry: (from.label || "this function") + " " + why, from, to }; }
    if (from.ret === false || (!from.ret && !from.pkg)) return { dir: "control returning, no value", how: "return (nothing)", carry: "nothing: " + (from.label || "this function") + " returns no value, control just goes back to the caller", from, to };
    const kk = (from.kinds || []).filter((k) => k !== "null" || from.kinds.length === 1).map((k) => (KE[k] || "") + " " + (KW[k] || k)).join(", ");
    const ret = from.pkg ? "the answer of the package call" : from.retExpr ? (kk ? kk + "   · " : "") + "returns " + from.retExpr + (from.retType ? "   : " + from.retType : "") : from.retType ? "returns a value of type " + from.retType : "returns a value";
    return { dir: "answer, coming back up {{check}}", how: "return value", carry: ret, from, to };
  }
  // a selected car keeps its identity through its journey: it continues down (first road at a crossroad), turns back at a dead end, waits for its siblings, and stops where nothing is returned
  function nextLeg(l) { return D.legs[l.i + 1] || null; }
  function endReason(l) {
    const at = CH.nodes[l.b]; if (!at) return "the car finished";
    if (l.type === "down") return (at.label || "this function") + " returns nothing: the car stopped there {{circle-slash}}";
    return l.b === CH.rootId ? "the answer reached the start: " + (at.label || "") : (at.label || "this function") + " returns nothing: the answer stopped there {{circle-slash}}";
  }
  function carMsg(t) { const k = $("drvcar"); if (k && k.dataset.m !== t) { k.dataset.m = t; k.innerHTML = ""; const d = document.createElement("div"); d.className = "fn"; LI.txt(d, t); k.appendChild(d); } }
  function carPanel(leg, pt, T) {
    if (!D.sel) return;
    if (!leg) return;
    if (D.selInfo === 1 && (CH._ct = (CH._ct || 0) + 1) % 8) return;
    D.selInfo = 1;
    const x = carryOf(leg), box = $("drvcar"); if (!box) return;
    const fl = x.from.pkg ? x.from.file : (x.from.file || "") + (x.from.line ? ":" + x.from.line : ""), tl = x.to.pkg ? x.to.file : (x.to.file || "") + (x.to.line ? ":" + x.to.line : "");
    box.innerHTML = "";
    const row = (k, v, code) => { const r = document.createElement("div"); r.className = "fr"; const a = document.createElement("span"); a.className = "k"; a.style.cssText = "display:inline-block;min-width:74px;color:var(--dim)"; a.textContent = k; const b = document.createElement(code ? "code" : "span"); b.className = code ? "ff" : "fn"; b.style.display = "inline"; LI.txt(b, v, 13); r.append(a, b); box.appendChild(r); };
    row("car", x.dir); row("from", (x.from.label || "") + "   " + fl, true); row("going to", (x.to.label || "") + "   " + tl, true); row("how", x.how); row("carrying", x.carry);
  }

  const CARSIDE = `
    <h4>Count</h4>
    <div id="drvstat"></div>
    <h4>Selected car</h4>
    <div id="drvcar"><div class="fn">Click any car to see where it is from, where it is going and what it carries.</div></div>
    <h4>How the cars run</h4>
    <ul>
      <li>One car follows the code <b>step by step</b>, like the real program.</li>
      <li>A function calls its first callee, <b>waits until that call has fully finished</b>, then calls the next.</li>
      <li>With a search active, only the <b>filtered route</b> is driven.</li>
    </ul>
    <h4>Colours</h4>
    <ul>
      <li class="sw amber"><b>Amber</b>: a request going down</li>
      <li class="sw green"><b>Green</b>: success, an answer with a value</li>
      <li class="sw red"><b>Red {{circle-x}}</b>: an error; it keeps going up until a function with try/catch handles it</li>
      <li class="sw ring"><b>Dashed ring</b>: the function returns nothing</li>
    </ul>
    <h4>Icons (car details)</h4>
    <div class="icons">
      <span><i>{{puzzle}}</i>element / HTML</span><span><i>{{braces}}</i>object</span>
      <span><i>{{brackets}}</i>array</span><span><i>{{type}}</i>string</span>
      <span><i>{{binary}}</i>number</span><span><i>{{toggle-left}}</i>true / false</span>
      <span><i>{{mail}}</i>response</span><span><i>{{globe}}</i>HTTP request</span>
      <span><i>{{database}}</i>database</span><span><i>{{cloud}}</i>cloud</span>
      <span><i>{{import}}</i>arguments</span><span><i>{{circle-slash}}</i>nothing</span>
    </div>
    <h4>Controls</h4>
    <ul>
      <li><b>condition</b>: which risky functions (they throw or return an error) fail</li>
      <li><b>repeat / traffic</b>: watch the run again and again</li>
      <li><b>follow cars</b>: whether the view follows the car</li>
      <li><b>car details</b>: label every car with the icon of what it carries</li>
      <li><b>Click a car</b> for the full details</li>
    </ul>
`;
  function resetDriveState() {
    Object.values(CH.els).forEach((g) => { g.classList.add("dd"); g.classList.remove("act"); if (g._vm) g._vm.style.display = "none"; if (g._bd) g._bd.textContent = ""; if (g._bi) g._bi.style.display = "none"; });
    D.pi = 0; D.vi = 0; D.voided = new Set(); D.actSet = new Set(); D.insideLast = {}; D.cars = [];
    const root = CH.els[repOf(CH.rootId)]; if (root) root.classList.remove("dd");
  }
  /* cars are drawn on one canvas above the diagram: the browser composites it on the GPU, and many cars cost almost nothing */
  function canvasSize() {
    const cv = $("carcanvas"), dpr = window.devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    if (!D.ctx) D.ctx = cv.getContext("2d", { alpha: true, desynchronized: true });
    D.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return D.ctx;
  }
  function theme() { const cs = getComputedStyle(document.documentElement); D.col = { down: cs.getPropertyValue("--dot").trim() || "#ffd23f", up: cs.getPropertyValue("--g3").trim() || "#b9a4ff", edge: cs.getPropertyValue("--node-under").trim() || "#0b0b0c", text: cs.getPropertyValue("--strong").trim() || "#fff" }; }
  function drawCars() {
    const ctx = canvasSize(), cv = $("carcanvas"); ctx.clearRect(0, 0, cv.clientWidth, cv.clientHeight);
    if (!D.col || (D.frame = (D.frame || 0) + 1) % 90 === 0) theme();
    const st = $("stage").getBoundingClientRect(), sv = csvg.getBoundingClientRect(), k = sv.width / CH.vw, ox = sv.left - st.left, oy = sv.top - st.top;
    const showAll = $("chcarinfo").checked, R = Math.max(3.5, Math.min(11, 8 * k * 1.6));
    D.screen = [];
    ctx.font = "700 10px -apple-system, Helvetica, Arial, sans-serif"; ctx.textBaseline = "alphabetic";
    let labels = 0;
    for (const c of D.cars) {
      const x = ox + c.x * k, y = oy + c.y * k;
      if (x < -20 || y < -20 || x > cv.clientWidth + 20 || y > cv.clientHeight + 20) continue;
      D.screen.push({ x, y, key: c.key, r: R, leg: c.leg });
      const sel = D.sel === c.key;
      ctx.beginPath(); ctx.arc(x, y, sel ? R + 2.5 : R, 0, 6.2832); if (c.leg.err) { ctx.fillStyle = "#ff5470"; ctx.fill(); } else if (c.leg.empty) { ctx.fillStyle = D.col.edge; ctx.fill(); ctx.setLineDash([3, 2]); ctx.strokeStyle = D.col.up; ctx.lineWidth = 2; ctx.stroke(); ctx.setLineDash([]); } else { ctx.fillStyle = c.type === "down" ? D.col.down : "#4cd9a3"; ctx.fill(); }
      ctx.lineWidth = sel ? 3 : 2; ctx.strokeStyle = sel ? D.col.text : D.col.edge; ctx.stroke();
      if (sel || (showAll && labels < 22)) {
        labels++;
        const names = [...emojiOf(c.leg).matchAll(/\{\{([\w-]+)\}\}/g)].map((m) => m[1]), bx = x + R + 4, by = y - R - 13, bw = names.length * 18 + 4;
        ctx.save(); ctx.globalAlpha = 0.85; ctx.fillStyle = D.col.edge; ctx.beginPath(); ctx.roundRect(bx, by, bw, 20, 6); ctx.fill(); ctx.restore();
        names.forEach((n, i) => { const im = LI.img(n, D.col.text, 16); if (im.complete) ctx.drawImage(im, bx + 3 + i * 18, by + 2, 16, 16); });
      }
    }
  }
  function driveStart() {
    if (D.on) { driveStop(); return; }
    stopFollow();
    driveExpand(); render();
    schedule();
    D.sel = null; D.selInfo = 0; D.on = true; D.T = 0; D.base = 0; D.waves = [0]; D.loops = 0; D.lastWave = 0; D.interval = Math.max(2.5, D.total / 4); D.statAt = 0; D.col = null;
    resetDriveState();
    LI.txt($("chdrive"), "{{square}} Stop the cars"); D.paused = false; $("chpause").style.display = ""; LI.txt($("chpause"), "{{pause}} Pause");
    $("info").innerHTML = `<div class="cols"><div><div class="k" style="color:var(--dim)">Cars</div><p>The cars are driving. The guide, the counts and the selected car are in the sidebar.</p></div><div></div></div>`;
    $("carside").innerHTML = LI.tok(CARSIDE); document.body.classList.add("driveside");
    $("carcanvas").style.display = "block";
    const st = $("stage"); if (!$("chcam").checked) st.scrollTop = 0;
    D.last = performance.now(); CH.driveRaf = requestAnimationFrame(driveTick);
  }
  function driveStop(done) {
    D.on = false; cancelAnimationFrame(CH.driveRaf);
    if (D.ctx) { const cv = $("carcanvas"); D.ctx.clearRect(0, 0, cv.clientWidth, cv.clientHeight); }
    $("carcanvas").style.display = "none"; D.cars = []; D.screen = [];
    Object.values(CH.els || {}).forEach((g) => { g.classList.remove("act"); if (g._bd) g._bd.textContent = ""; if (g._bi) g._bi.style.display = "none"; });
    if (!done) Object.values(CH.els || {}).forEach((g) => g.classList.remove("dd"));
    D.paused = false; $("chpause").style.display = "none"; LI.txt($("chdrive"), "{{car}} Drive"); if (!done) $("chphase").textContent = "";
  }
  function driveTick(ts) {
    if (!D.on) return;
    const dt = Math.min(60, ts - D.last) / 1000; D.last = ts; D.T += D.paused ? 0 : dt * +$("chspeed").value;   // paused: time stands still, the cars stay put and stay clickable
    const T = D.T, mode = $("chloop").value;
    if (mode === "traffic") { while (T - D.lastWave >= D.interval) { D.lastWave += D.interval; D.waves.push(D.lastWave); } D.waves = D.waves.filter((w) => T - w < D.total + 1.6); }
    else if (D.waves.length > 1) D.waves = [D.waves[D.waves.length - 1]];
    if (mode === "repeat" && T - D.base >= D.total + 1.2) { D.loops++; D.base = T; D.waves = [T]; schedule(); resetDriveState(); }
    const lt0 = T - D.base;
    while (D.pi < D.order.length && D.tDown[D.order[D.pi]] <= lt0) { const g = CH.els[repOf(D.order[D.pi])]; if (g) g.classList.remove("dd"); D.pi++; }
    while (D.vi < D.vmarks.length && D.done[D.vmarks[D.vi]] <= lt0) { const x = D.vmarks[D.vi], r = repOf(x), g = CH.els[r]; if (g && r === x) g._vm.style.display = ""; D.voided.add(x); D.vi++; }
    // cars: only the legs that overlap this moment (time buckets)
    const inside = {}, act = new Set(), cars = []; let ys = 0, onRoad = 0, selPt = null, selLeg = null;
    for (const w of D.waves) {
      const lt = T - w, cand = D.buckets[Math.floor(lt / D.slice)] || [];
      for (const l of cand) {
        if (lt < l.t0 || lt >= l.t1) continue;
        const f = (lt - l.t0) / (l.t1 - l.t0), ra = repOf(l.a), rb = repOf(l.b);
        if (f > 0.8) act.add(rb);
        onRoad++;
        if (ra === rb) { inside[ra] = (inside[ra] || 0) + 1; continue; }
        const parent = l.type === "down" ? ra : rb, child = l.type === "down" ? rb : ra, chain = [child];
        for (let c = child, g = 0; CH.parent[c] !== undefined && c !== parent && g < 60; g++) { c = CH.parent[c]; chain.push(c); }   // the boxes the line passes through (e.g. via a folder group)
        if (chain[chain.length - 1] !== parent || chain.some((c) => !CH.pos[c])) { inside[ra] = (inside[ra] || 0) + 1; continue; }
        chain.reverse();
        const pt = pathPt(chain, l.type === "down" ? f : 1 - f), key = w + "|" + l.type + "|" + l.a + "|" + l.b;
        cars.push({ x: pt.x, y: pt.y, type: l.type, key, leg: l }); ys += pt.y;
        if (D.sel === key) { selPt = pt; selLeg = l; }
      }
    }
    D.cars = cars; drawCars();
    if (selLeg) D.selLeg = selLeg;
    else if (D.sel && D.selLeg) {
      const w = Number(D.sel.split("|")[0]), nl = nextLeg(D.selLeg), lt2 = T - w;
      if (nl && lt2 >= nl.t0) { D.sel = w + "|" + nl.type + "|" + nl.a + "|" + nl.b; D.selLeg = nl; D.selInfo = 0; }
      else if (nl) carMsg("running inside " + (CH.nodes[D.selLeg.b].label || "") + " ...");
      else carMsg(endReason(D.selLeg));
    }
    carPanel(selLeg, selPt, T);
    // only the box a car is arriving at glows; badges change only where something changed
    for (const r of D.actSet) if (!act.has(r)) { const g = CH.els[r]; if (g) g.classList.remove("act"); }
    for (const r of act) if (!D.actSet.has(r)) { const g = CH.els[r]; if (g) g.classList.add("act"); }
    D.actSet = act;
    const seen = new Set([...Object.keys(inside), ...Object.keys(D.insideLast || {})]);
    for (const r of seen) { const v = inside[r] || 0; if (v !== (D.insideLast[r] || 0)) { const g = CH.els[r]; if (g && g._bd) { g._bd.textContent = v ? "×" + v + " inside" : ""; g._bi.style.display = v ? "" : "none"; } } }
    D.insideLast = inside;
    const cur = D.waves[D.waves.length - 1] === undefined ? D.base : D.waves[D.waves.length - 1], lt = T - cur;
    if (ts - D.statAt > 250) {                                   // text updates 4x per second, not 60x
      D.statAt = ts;
      const stat = document.getElementById("drvstat");
      if (stat) stat.textContent = [`• cars on the road: ${onRoad}`, `• ${mode === "traffic" ? "waves in the city: " + D.waves.length : mode === "repeat" ? "round " + (D.loops + 1) : "single run"}`, `• roads travelled: ${countLE(D.downEnd, lt)} / ${D.downEnd.length}`, `• answers sent back: ${countLE(D.upEnd, lt)}`, `• stopped (returns nothing): ${D.voided.size}`, `• errors: ${D.errCount} (caught: ${D.caughtCount})`].join("\n");
      $("chphase").textContent = D.paused ? "paused" : mode === "traffic" ? "traffic running…" : lt < D.total ? "cars driving…" : "finished one run";
    }
    if ($("chcam").checked && cars.length) { const st = $("stage"), k = csvg.clientWidth / CH.vw, yy = selPt ? selPt.y : ys / cars.length, want = yy * k - st.clientHeight * 0.45; st.scrollTop += (want - st.scrollTop) * 0.08; }
    if (mode === "once" && lt0 >= D.total + 0.8) { driveStop(true); $("chphase").textContent = `finished: ${D.rootErr ? "the request ended with an ERROR, " : ""}${D.upEnd.length} answers came back, ${D.voided.size} node(s) returned nothing`; return; }
    CH.driveRaf = requestAnimationFrame(driveTick);
  }

  /* ---------- open / close ---------- */
  async function openChain(id, o = {}) {
    stopFollow(); if (D.on) driveStop(); curId = "__chain";
    $("title").textContent = "…"; $("subtitle").textContent = "";
    const resp = await get("/api/chain?id=" + encodeURIComponent(id));
    if (!resp || !resp.rootId) { toast("Nothing to show for this one"); return; }
    CH.id = id; CH.nodes = {}; CH.vg = {}; CH.open = new Set(); CH.sel = null; CH.q = (o.search || "").toLowerCase(); CH.hits = null; CH.seq = 0;
    CH.rootId = merge(resp, null); indexUp();
    // open the spine: the root, layouts, the page, and the first level of groups
    const spine = (nid, depth) => { const n = CH.nodes[nid]; CH.open.add(nid); if (depth < 1 || n.kind === "layout" || (n.label || "").startsWith("layout") || n.kind === "page") for (const c of n.children) { const cn = CH.nodes[c]; if (cn.kind === "group" || cn.kind === "page" || (cn.label || "").startsWith("layout") || (cn.label || "").startsWith("Page")) spine(c, depth + 1); } };
    spine(CH.rootId, 0);
    if (id !== "e:app") CH.open.add(CH.rootId);
    document.body.classList.remove("ovmode"); document.body.classList.add("chainmode");
    $("ov").style.display = "none"; svg.style.display = "none"; $("chainbox").style.display = "block";
    $("path").textContent = "Chain · foldable · request goes down, the answer comes back up";
    $("title").textContent = resp.title || id; $("subtitle").textContent = resp.sub || "";
    $("chips").innerHTML = ""; $("chq").value = o.search || "";
    $("info").innerHTML = LI.tok(`<div class="cols"><div><div class="k" style="color:var(--dim)">How to read</div><p>Each box is a function (or a group of them). <b>{{chevron-right}} n</b> opens what it calls. Solid line = the request going down, dashed = the answer coming back up. Double-click a box (or {{play}} Follow) to watch a request travel down and the answer return. Search opens the path to every match.</p></div><div class="files"><div class="k" style="color:var(--dim)">Entry</div><div class="fn">${(resp.title || id).replace(/</g, "&lt;")}</div></div></div>`);
    applySearch(); render();
    location.hash = "chain:" + encodeURIComponent(id);
    window.__lastChain = id;
  }
  function closeChain() { stopFollow(); if (D.on) driveStop(); document.body.classList.remove("chainmode"); document.body.classList.remove("driveside"); $("carside").innerHTML = ""; $("chainbox").style.display = "none"; svg.style.display = ""; }
  function expandAll(limit) { let n = 0; for (const id in CH.nodes) if (CH.nodes[id].children.length && n++ < limit) CH.open.add(id); for (const id in CH.vg) CH.open.add(id); render(); }
  function levels(delta) {
    const cur = Math.max(...CH.rows.map((r) => r.depth)); const target = Math.max(0, cur + delta);
    CH.open = new Set([CH.rootId]);
    (function rec(id, d) { if (d >= target) return; CH.open.add(id); for (const k of displayKids(id)) rec(k.id, d + 1); })(CH.rootId, 0);
    render();
  }

  /* ---------- wiring ---------- */
  function init() {
    csvg = el("svg", { xmlns: NS }); $("chainsvg").appendChild(csvg);
    $("chq").oninput = () => { if (D.on) { toast("Stop the cars first"); $("chq").value = CH.q; return; } CH.q = $("chq").value.trim().toLowerCase(); if (!CH.q) CH.hits = null; applySearch(); render(); };
    $("chdrive").onclick = driveStart;
    const togglePause = () => { if (!D.on) return; D.paused = !D.paused; LI.txt($("chpause"), D.paused ? "{{play}} Resume" : "{{pause}} Pause"); $("chphase").textContent = D.paused ? "paused" : "cars driving…"; };
    $("chpause").onclick = togglePause;
    document.addEventListener("keydown", (e) => { if (e.code !== "Space" || !D.on || /INPUT|TEXTAREA|SELECT|BUTTON/.test((e.target.tagName || ""))) return; e.preventDefault(); togglePause(); });
    $("stage").addEventListener("click", (e) => {
      if (!D.on || !D.screen || !D.screen.length) return;
      const r = $("stage").getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
      let best = null, bd = 1e9; for (const c of D.screen) { const d = Math.hypot(c.x - x, c.y - y); if (d < c.r + 6 && d < bd) { bd = d; best = c; } }
      if (best) { e.stopPropagation(); e.preventDefault(); D.sel = best.key; D.selInfo = 0; D.selLeg = best.leg; }
    }, true);
    $("chrefresh").onclick = () => openChain(CH.id, { search: CH.q });
    $("chfollow").onclick = () => { if (CH.anim) stopFollow(); else follow(CH.sel); };
    $("chexp").onclick = () => { if (D.on) return toast("Stop the cars first"); levels(+1); }; $("chcol").onclick = () => { if (D.on) return toast("Stop the cars first"); levels(-1); };
    $("chall").onclick = () => { if (D.on) return toast("Stop the cars first"); expandAll(250); }; $("chnone").onclick = () => { if (D.on) return toast("Stop the cars first"); CH.open = new Set([CH.rootId]); render(); };
    const zset = (around) => {
      CH.zoom = Math.max(0.04, Math.min(2.5, CH.zoom));
      csvg.style.width = CH.vw * CH.zoom + "px"; csvg.classList.toggle("lod", CH.zoom < 0.3);
      $("chzv").textContent = Math.round(CH.zoom * 100) + "%";
    };
    CH.zset = zset;
    $("chzin").onclick = () => { CH.zoom *= 1.25; zset(); }; $("chzout").onclick = () => { CH.zoom *= 0.8; zset(); };
    $("chfit").onclick = () => { const st = $("stage"); CH.zoom = Math.max(0.04, Math.min(1.3, Math.min((st.clientWidth - 30) / CH.vw, (st.clientHeight - 20) / CH.vh))); zset(); st.scrollTop = 0; st.scrollLeft = 0; };
    $("stage").addEventListener("wheel", (e) => {
      if (!document.body.classList.contains("chainmode") || !(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      const st = $("stage"), r = st.getBoundingClientRect(), mx = e.clientX - r.left + st.scrollLeft, my = e.clientY - r.top + st.scrollTop, old = CH.zoom;
      CH.zoom = Math.max(0.04, Math.min(2.5, old * Math.exp(-e.deltaY * 0.01))); zset();
      const k = CH.zoom / old; st.scrollLeft = mx * k - (e.clientX - r.left); st.scrollTop = my * k - (e.clientY - r.top);
    }, { passive: false });
    document.querySelectorAll("#chlanes .chip").forEach((c) => { c.onclick = () => { const l = c.dataset.l; if (CH.lanes.has(l)) CH.lanes.delete(l); else CH.lanes.add(l); c.classList.toggle("on", CH.lanes.has(l)); render(); }; });
    $("chback").onclick = () => { closeChain(); window.showOverview(); };
  }
  window.NodeChain = { debug: () => ({ D, CH, tick: driveTick }), init, open: openChain, close: closeChain, active: () => document.body.classList.contains("chainmode") };
})();
