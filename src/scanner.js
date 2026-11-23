'use strict';
// NodeBox scanner: reads a Node project folder (read-only) and builds a model of
// files, exports, functions, routes and who-calls-whom. No code is executed.

const fs = require('fs');
const path = require('path');

const IGNORE_DIRS = new Set(['node_modules', '.git', '.next', 'dist', 'build', 'out', 'coverage', '.turbo', '.vercel', '.cache', '.nodebox', '.idea', '.vscode', 'storybook-static']);
const EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const MAX_SIZE = 1024 * 1024;
const VERBS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

const DB_PKG = /^(mssql|pg|pg-promise|mysql2?|mongodb|mongoose|@prisma\/client|redis|ioredis|better-sqlite3|sqlite3|typeorm|sequelize|knex|drizzle-orm|@azure\/cosmos|@azure\/data-tables|@supabase\/supabase-js|@supabase\/ssr|@vercel\/postgres|@neondatabase\/serverless|@upstash\/redis|@planetscale\/database|@libsql\/client|firebase-admin\/firestore)$/;
const CLOUD_PKG = /^(@azure\/(?!cosmos$|data-tables$)|@aws-sdk\/|aws-sdk$|@google-cloud\/|firebase|stripe$|@sendgrid\/|nodemailer$|axios$|node-fetch$|got$|undici$|jose$|next-auth|@octokit\/|openai$|@anthropic-ai\/)/;

function loadTS(root) {
  const tries = [() => require('typescript'), () => require(require.resolve('typescript', { paths: [root] }))];
  for (const t of tries) { try { return t(); } catch (_) { /* next */ } }
  throw new Error('NodeBox needs the "typescript" package (run npm install in the nodebox folder).');
}

const posix = (p) => p.split(path.sep).join('/');

function walk(root) {
  const out = [];
  (function rec(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      if (e.isDirectory()) { if (!IGNORE_DIRS.has(e.name) && !e.name.startsWith('.')) rec(path.join(dir, e.name)); continue; }
      if (!e.isFile()) continue;
      const ext = path.extname(e.name);
      if (!EXTS.has(ext) || e.name.endsWith('.d.ts')) continue;
      out.push(posix(path.relative(root, path.join(dir, e.name))));
    }
  })(root);
  return out;
}

function isTest(rel) { return /\.(test|spec)\.[cm]?[jt]sx?$/.test(rel) || /(^|\/)(__tests__|__mocks__|e2e)\//.test(rel); }

function readTsconfig(ts, root) {
  const file = path.join(root, 'tsconfig.json');
  const out = { baseUrl: '', paths: [] };
  try {
    const cfg = ts.readConfigFile(file, ts.sys.readFile);
    const co = (cfg.config && cfg.config.compilerOptions) || {};
    out.baseUrl = co.baseUrl || '';
    for (const [k, v] of Object.entries(co.paths || {})) {
      out.paths.push({ prefix: k.replace(/\*$/, ''), wildcard: k.endsWith('*'), targets: (v || []).map((t) => t.replace(/\*$/, '')) });
    }
  } catch (_) { /* no tsconfig */ }
  return out;
}

function pkgName(spec) {
  if (spec.startsWith('node:')) return spec;
  const parts = spec.split('/');
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

function leadingComment(ts, text, pos) {
  const ranges = ts.getLeadingCommentRanges(text, pos) || [];
  if (!ranges.length) return '';
  const parts = [];
  for (const r of ranges) {
    const raw = text.slice(r.pos, r.end);
    parts.push(raw.replace(/^\/\*+/, '').replace(/\*+\/$/, '').split('\n').map((l) => l.replace(/^\s*(\/\/+|\*+)\s?/, '').trim()).filter(Boolean).join(' '));
    if (parts.join(' ').length > 500) break;
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim().slice(0, 500);
}

/** Parse one file into a FileInfo. */
function parseFile(ts, root, rel, stat) {
  const abs = path.join(root, rel);
  const text = fs.readFileSync(abs, 'utf8');
  const ext = path.extname(rel);
  const kind = ext === '.tsx' ? ts.ScriptKind.TSX : ext === '.jsx' ? ts.ScriptKind.JSX : ext === '.ts' ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, kind);
  const info = {
    rel, size: stat.size, mtimeMs: stat.mtimeMs, lines: sf.getLineAndCharacterOfPosition(sf.end).line + 1,
    client: false, serverOnly: false, useServer: false, hints: {}, cjs: false, comment: '', imports: [], exports: {}, decls: {}, fnUses: {}, apiStrings: [], express: [], usesBrowserGlobals: false, usesReact: false,
  };
  info.comment = leadingComment(ts, text, 0);

  const importLocals = new Map(); // local name -> import index
  const line = (node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

  // directives + imports
  for (const st of sf.statements) {
    if (ts.isExpressionStatement(st) && ts.isStringLiteral(st.expression)) {
      if (st.expression.text === 'use client') info.client = true;
      if (st.expression.text === 'use server') { info.serverOnly = true; info.useServer = true; }
    }
    if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier)) {
      const spec = st.moduleSpecifier.text;
      if (spec === 'server-only') info.serverOnly = true;
      const clause = st.importClause;
      const imp = { spec, names: [], default: null, ns: null, typeOnly: !!(clause && clause.isTypeOnly), line: line(st) };
      if (clause) {
        if (clause.name) { imp.default = clause.name.text; }
        if (clause.namedBindings) {
          if (ts.isNamespaceImport(clause.namedBindings)) imp.ns = clause.namedBindings.name.text;
          else for (const el of clause.namedBindings.elements) imp.names.push({ imported: (el.propertyName || el.name).text, local: el.name.text, typeOnly: el.isTypeOnly });
        }
      }
      info.imports.push(imp);
      const idx = info.imports.length - 1;
      if (imp.default) importLocals.set(imp.default, { idx, kind: 'default' });
      if (imp.ns) importLocals.set(imp.ns, { idx, kind: 'ns' });
      for (const n of imp.names) importLocals.set(n.local, { idx, kind: 'named', imported: n.imported, typeOnly: n.typeOnly });
      if (spec === 'react' || spec === 'react-dom' || spec.startsWith('next/navigation')) info.usesReact = true;
    }
    // require() at top level: const x = require('y')
  }

  const isExported = (node) => !!(node.modifiers && node.modifiers.some((m) => m.kind === ts.SyntaxKind.ExportKeyword));
  const isDefault = (node) => !!(node.modifiers && node.modifiers.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword));

  const HINT_CALLS = new Set(['from', 'rpc', 'collection', 'table', 'container', 'bucket']);
  let hintTarget = null;
  // usage collector: which imported/local names does this subtree reference?
  const collect = (node, into) => {
    const visit = (n) => {
      if (ts.isImportDeclaration(n)) return;
      if (hintTarget && ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && HINT_CALLS.has(n.expression.name.text) && n.arguments.length && ts.isStringLiteralLike(n.arguments[0])) {
        (info.hints[hintTarget] = info.hints[hintTarget] || []).push(n.expression.name.text + ':' + n.arguments[0].text);
      }
      if (ts.isIdentifier(n)) {
        const p = n.parent;
        const isPropName = p && ((ts.isPropertyAccessExpression(p) && p.name === n) || (ts.isPropertyAssignment(p) && p.name === n) || (ts.isQualifiedName(p) && p.right === n));
        if (!isPropName) into.add(n.text);
      }
      if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression) && importLocals.has(n.expression.text) && importLocals.get(n.expression.text).kind === 'ns') into.add(n.expression.text + '.' + n.name.text);
      if (ts.isIdentifier(n) && (n.text === 'window' || n.text === 'document' || n.text === 'localStorage' || n.text === 'sessionStorage' || n.text === 'navigator')) info.usesBrowserGlobals = true;
      ts.forEachChild(n, visit);
    };
    visit(node);
  };

  // API-string collector (fetch edges): strings that look like /api/...
  const apiScan = (node, fn) => {
    const visit = (n) => {
      let s = null, head = null;
      if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) s = n.text;
      else if (ts.isTemplateExpression(n)) { head = n.head.text; s = n.head.text + n.templateSpans.map((sp) => 'x' + sp.literal.text).join(''); }
      if (s && /^\/api\//.test(s)) info.apiStrings.push({ path: s.split('?')[0], head: head === null ? null : head.split('?')[0], fn, line: line(n) });
      ts.forEachChild(n, visit);
    };
    visit(node);
  };

  const isFnNode = (node) => ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isMethodDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node)
    || (ts.isVariableDeclaration(node) && !!node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer) || (ts.isCallExpression(node.initializer) && /^[A-Z]/.test(node.name.getText(sf)))))
    || (ts.isPropertyAssignment(node) && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)))
    || (ts.isExpressionStatement(node) && ts.isBinaryExpression(node.expression) && (ts.isArrowFunction(node.expression.right) || ts.isFunctionExpression(node.expression.right)))
    || ts.isExportAssignment(node);

  // does this declaration hand a value back? (functions with `return <value>`, arrow expressions, classes, constants: yes; no-return functions: no)
  const fnOf = (n) => {
    if (!n) return null;
    if (ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n)) return n;
    if (ts.isVariableDeclaration(n) || ts.isPropertyAssignment(n)) return fnOf(n.initializer);
    if (ts.isExportAssignment(n)) return fnOf(n.expression);
    if (ts.isExpressionStatement(n) && ts.isBinaryExpression(n.expression)) return fnOf(n.expression.right);
    if (ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isNonNullExpression(n)) return fnOf(n.expression);
    if (ts.isCallExpression(n)) { for (const a of n.arguments) { const f = fnOf(a); if (f) return f; } }
    return null;
  };
  const returnsValue = (node) => {
    if (ts.isClassDeclaration(node)) return true;
    const f = fnOf(node);
    if (!f) return true;                                         // a constant / value: it provides a value
    if (!f.body) return false;
    if (!ts.isBlock(f.body)) return !(ts.isVoidExpression(f.body));   // arrow with an expression body
    let found = false;
    const walkR = (n) => {
      if (found) return;
      if (n !== f && (ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n) || ts.isMethodDeclaration(n) || ts.isClassDeclaration(n))) return;
      if (ts.isReturnStatement(n) && n.expression && !(ts.isIdentifier(n.expression) && n.expression.text === 'undefined') && !ts.isVoidExpression(n.expression)) { found = true; return; }
      ts.forEachChild(n, walkR);
    };
    ts.forEachChild(f.body, walkR);
    return found;
  };

  const one = (t, n) => { const x = String(t).replace(/\s+/g, ' ').trim(); return x.length > n ? x.slice(0, n - 1) + '…' : x; };
  // what a function hands back (for the car icons) and whether it can fail (for the error cars)
  const isFnLike = (n) => ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n) || ts.isMethodDeclaration(n) || ts.isClassDeclaration(n);
  const addKinds = (e, set) => {
    if (!e) return;
    while (ts.isParenthesizedExpression(e) || ts.isAwaitExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e) || (ts.isSatisfiesExpression && ts.isSatisfiesExpression(e))) e = e.expression;
    if (ts.isJsxElement(e) || ts.isJsxSelfClosingElement(e) || ts.isJsxFragment(e)) set.add('element');
    else if (ts.isConditionalExpression(e)) { addKinds(e.whenTrue, set); addKinds(e.whenFalse, set); }
    else if (ts.isBinaryExpression(e) && (e.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken || e.operatorToken.kind === ts.SyntaxKind.BarBarToken || e.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)) { addKinds(e.right, set); if (ts.isJsxElement(e.left) || ts.isObjectLiteralExpression(e.left)) addKinds(e.left, set); }
    else if (ts.isObjectLiteralExpression(e)) set.add('object');
    else if (ts.isArrayLiteralExpression(e)) set.add('array');
    else if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e) || ts.isTemplateExpression(e)) set.add('string');
    else if (ts.isNumericLiteral(e)) set.add('number');
    else if (e.kind === ts.SyntaxKind.TrueKeyword || e.kind === ts.SyntaxKind.FalseKeyword) set.add('boolean');
    else if (e.kind === ts.SyntaxKind.NullKeyword) set.add('null');
    else if (ts.isNewExpression(e)) set.add(/Response/.test(e.expression.getText(sf)) ? 'response' : 'object');
    else if (ts.isCallExpression(e)) { const t = e.getText(sf); set.add(/(NextResponse|Response)\b|\bredirect\(|\bnotFound\(/.test(t) ? 'response' : /Promise\.all|\.map\(|\.filter\(/.test(t) ? 'array' : 'value'); }
    else set.add('value');
  };
  const kindsOfType = (t, set) => {
    if (!t) return; t = t.replace(/^Promise<(.*)>$/, '$1');
    if (/JSX|ReactNode|ReactElement/.test(t)) set.add('element'); else if (/Response/.test(t)) set.add('response');
    else if (/\[\]|Array</.test(t)) set.add('array'); else if (/^string\b/.test(t)) set.add('string'); else if (/^number\b/.test(t)) set.add('number'); else if (/^boolean\b/.test(t)) set.add('boolean');
    else if (/^\{|Record<|^object/.test(t)) set.add('object');
  };
  const ERR_RE = /\berror\b|status:\s*[45]\d\d|\bnotFound\(|unauthori|forbidden|\.reject\(/i;
  const carryInfo = (node) => {
    if (ts.isClassDeclaration(node)) return { params: null, retType: null, retExpr: 'a new ' + (node.name ? node.name.text : 'instance'), kinds: ['object'], throws: false, catches: false, errRet: false };
    const f = fnOf(node);
    if (!f) { const ks = new Set(); if (ts.isVariableDeclaration(node)) addKinds(node.initializer, ks); return { params: null, retType: null, retExpr: ts.isVariableDeclaration(node) && node.initializer ? one(node.initializer.getText(sf), 80) : null, kinds: [...ks], throws: false, catches: false, errRet: false }; }
    const params = f.parameters ? one(f.parameters.map((q) => q.getText(sf)).join(', '), 120) : '';
    const retType = f.type ? one(f.type.getText(sf), 70) : null;
    let retExpr = null, throws = false, catches = false, errRet = false; const ks = new Set();
    if (f.body && !ts.isBlock(f.body)) { retExpr = one(f.body.getText(sf), 90); addKinds(f.body, ks); if (ERR_RE.test(f.body.getText(sf).slice(0, 400))) errRet = true; }
    else if (f.body) {
      const w = (n) => {
        if (n !== f && isFnLike(n)) return;
        if (ts.isThrowStatement(n)) throws = true;
        if (ts.isTryStatement(n) && n.catchClause) catches = true;
        if (ts.isReturnStatement(n) && n.expression) { if (!retExpr) retExpr = one(n.expression.getText(sf), 90); addKinds(n.expression, ks); if (ERR_RE.test(n.expression.getText(sf).slice(0, 400))) errRet = true; }
        ts.forEachChild(n, w);
      };
      ts.forEachChild(f.body, w);
    }
    kindsOfType(retType, ks);
    if (ks.size > 1) ks.delete('value');
    return { params, retType, retExpr, kinds: [...ks].slice(0, 3), throws, catches, errRet };
  };
  const addDecl = (name, node, exported) => {
    const uses = new Set();
    hintTarget = name;
    collect(node, uses);
    hintTarget = null;
    uses.delete(name);
    info.fnUses[name] = (info.fnUses[name] || new Set());
    for (const u of uses) info.fnUses[name].add(u);
    info.decls[name] = { line: line(node), doc: leadingComment(ts, text, node.getFullStart()), exported: !!exported, fn: isFnNode(node), ret: returnsValue(node), carry: carryInfo(node) };
    apiScan(node, name);
  };

  // CommonJS: const x = require('y') / const { a, b: c } = require('y') / require('y') as a statement
  const requireSpec = (e) => (e && ts.isCallExpression(e) && ts.isIdentifier(e.expression) && e.expression.text === 'require' && e.arguments.length === 1 && ts.isStringLiteralLike(e.arguments[0])) ? e.arguments[0].text : null;
  const pushRequire = (spec, target, lineNo) => {
    info.cjs = true;
    const imp = { spec, names: [], default: null, ns: null, typeOnly: false, line: lineNo };
    if (target && ts.isIdentifier(target)) imp.ns = target.text;
    else if (target && ts.isObjectBindingPattern(target)) for (const el of target.elements) if (ts.isIdentifier(el.name)) imp.names.push({ imported: (el.propertyName && el.propertyName.text) || el.name.text, local: el.name.text, typeOnly: false });
    info.imports.push(imp);
    const idx = info.imports.length - 1;
    if (imp.ns) importLocals.set(imp.ns, { idx, kind: 'ns' });
    for (const nm of imp.names) importLocals.set(nm.local, { idx, kind: 'named', imported: nm.imported, typeOnly: false });
  };
  for (const st of sf.statements) {
    if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        const spec = requireSpec(d.initializer) || (d.initializer && ts.isPropertyAccessExpression(d.initializer) ? requireSpec(d.initializer.expression) : null);
        if (spec) pushRequire(spec, d.name, line(st));
      }
    }
  }
  const moduleUses = new Set();
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st)) continue;
    // module.exports = ... / module.exports.x = ... / exports.x = ...
    if (ts.isExpressionStatement(st) && ts.isBinaryExpression(st.expression) && st.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const l = st.expression.left, r = st.expression.right, txt = l.getText(sf);
      let exName = null;
      if (txt === 'module.exports') exName = 'default'; else { const m = txt.match(/^(?:module\.)?exports\.([A-Za-z_$][\w$]*)$/); if (m) exName = m[1]; }
      if (exName) {
        info.cjs = true;
        if (exName === 'default' && ts.isObjectLiteralExpression(r)) {
          for (const pr of r.properties) {
            if (ts.isShorthandPropertyAssignment(pr)) info.exports[pr.name.text] = { local: pr.name.text };
            else if (ts.isPropertyAssignment(pr) && ts.isIdentifier(pr.name)) {
              if (ts.isIdentifier(pr.initializer)) info.exports[pr.name.text] = { local: pr.initializer.text };
              else { addDecl(pr.name.text, pr, true); info.exports[pr.name.text] = { local: pr.name.text }; }
            } else if (ts.isMethodDeclaration(pr) && ts.isIdentifier(pr.name)) { addDecl(pr.name.text, pr, true); info.exports[pr.name.text] = { local: pr.name.text }; }
          }
          collect(st, moduleUses);
        } else if (exName === 'default' && ts.isIdentifier(r)) { info.exports.default = { local: r.text }; }
        else { addDecl(exName, st, true); info.exports[exName] = { local: exName }; if (exName === 'default') info.exports.default = { local: 'default' }; }
        continue;
      }
    }
    if (ts.isFunctionDeclaration(st) && st.name) {
      addDecl(st.name.text, st, isExported(st));
      if (isExported(st)) info.exports[st.name.text] = { local: st.name.text };
      if (isExported(st) && isDefault(st)) info.exports.default = { local: st.name.text };
    } else if (ts.isFunctionDeclaration(st) && isExported(st) && isDefault(st)) {
      addDecl('default', st, true); info.exports.default = { local: 'default' };
    } else if (ts.isClassDeclaration(st) && st.name) {
      addDecl(st.name.text, st, isExported(st));
      if (isExported(st)) info.exports[st.name.text] = { local: st.name.text };
      if (isExported(st) && isDefault(st)) info.exports.default = { local: st.name.text };
    } else if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (ts.isIdentifier(d.name)) {
          addDecl(d.name.text, d, isExported(st));
          if (isExported(st)) info.exports[d.name.text] = { local: d.name.text };
        } else { collect(d, moduleUses); }
      }
    } else if (ts.isExportAssignment(st)) {
      // export default <expr>
      const name = ts.isIdentifier(st.expression) ? st.expression.text : 'default';
      if (name === 'default') addDecl('default', st, true);
      info.exports.default = { local: name };
      collect(st, moduleUses);
    } else if (ts.isExportDeclaration(st)) {
      const from = st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier) ? st.moduleSpecifier.text : null;
      if (st.exportClause && ts.isNamedExports(st.exportClause)) {
        for (const el of st.exportClause.elements) {
          const exportedName = el.name.text, orig = (el.propertyName || el.name).text;
          info.exports[exportedName] = from ? { from, name: orig } : { local: orig };
        }
      } else if (from) { (info.exports['*'] = info.exports['*'] || { stars: [] }).stars.push(from); }
    } else if (ts.isTypeAliasDeclaration(st) || ts.isInterfaceDeclaration(st) || ts.isEnumDeclaration(st) || ts.isModuleDeclaration(st)) {
      // types: ignore for call graph
    } else {
      collect(st, moduleUses);
      apiScan(st, '<module>');
    }
  }
  info.fnUses['<module>'] = moduleUses;

  // Express-style routes: app.get('/x', ...), router.post('/y', ...)
  const routerLike = /^(app|router|server|api|route|routes)$|Router$/;
  const visitExpress = (n, encl) => {
    let e = encl;
    if (ts.isFunctionDeclaration(n) && n.name) e = n.name.text;
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))) e = n.name.text;
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && ts.isIdentifier(n.expression.expression) && routerLike.test(n.expression.expression.text)) {
      const m = n.expression.name.text.toLowerCase();
      if (['get', 'post', 'put', 'delete', 'patch', 'all'].includes(m) && n.arguments.length && ts.isStringLiteral(n.arguments[0])) {
        const handlers = n.arguments.slice(1).filter((a) => ts.isIdentifier(a)).map((a) => a.text);
        info.express.push({ method: m.toUpperCase(), url: n.arguments[0].text, fn: e || '<module>', handlers, line: line(n) });
      }
    }
    ts.forEachChild(n, (c) => visitExpress(c, e));
  };
  visitExpress(sf, null);

  info.importLocals = importLocals;
  return info;
}

/** Next.js route url from a file path under app/ or pages/. */
function nextUrl(rel) {
  const m = rel.match(/^(?:src\/)?(app|pages)\/(.*)$/);
  if (!m) return null;
  let rest = m[2].replace(/\.[cm]?[jt]sx?$/, '');
  const segs = rest.split('/').filter(Boolean);
  const last = segs[segs.length - 1];
  if (m[1] === 'app') {
    if (!['route', 'page'].includes(last)) return null;
    segs.pop();
  } else {
    if (last === 'index') segs.pop();
    if (/^_/.test(last)) return null;
  }
  const out = segs.filter((s) => !/^\(.*\)$/.test(s) && !s.startsWith('@')).map((s) => s.replace(/^\[\.\.\.(.+)\]$/, '*').replace(/^\[\[\.\.\.(.+)\]\]$/, '*').replace(/^\[(.+)\]$/, ':$1'));
  return { kind: m[1] === 'app' ? (last === 'route' ? 'api' : 'page') : (segs[0] === 'api' ? 'api' : 'page'), url: '/' + out.join('/') };
}

function routePattern(url) {
  const esc = url.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/:[A-Za-z_]+/g, '[^/]+').replace(/\*/g, '.+');
  return new RegExp('^' + esc + '/?$');
}

class Scanner {
  constructor(root) {
    this.root = path.resolve(root);
    this.ts = loadTS(this.root);
    this.files = new Map();
    this.pkg = {};
    this.tsconfig = { baseUrl: '', paths: [] };
    this.model = null;
  }

  readPackage() {
    try { this.pkg = JSON.parse(fs.readFileSync(path.join(this.root, 'package.json'), 'utf8')); } catch (_) { this.pkg = {}; }
    this.tsconfig = readTsconfig(this.ts, this.root);
  }

  /** Full or incremental scan. `changed` = array of relative paths that changed (optional). */
  scan(changed) {
    const t0 = Date.now();
    this.readPackage();
    const all = walk(this.root);
    const set = new Set(all);
    for (const rel of [...this.files.keys()]) if (!set.has(rel)) this.files.delete(rel);
    let parsed = 0;
    for (const rel of all) {
      let st; try { st = fs.statSync(path.join(this.root, rel)); } catch (_) { continue; }
      if (st.size > MAX_SIZE) continue;
      const old = this.files.get(rel);
      if (old && old.mtimeMs === st.mtimeMs && old.size === st.size && !(changed && changed.includes(rel))) continue;
      try { this.files.set(rel, parseFile(this.ts, this.root, rel, st)); parsed++; } catch (e) { this.files.set(rel, { rel, error: String(e.message || e), imports: [], exports: {}, decls: {}, fnUses: {}, apiStrings: [], express: [], size: st.size, mtimeMs: st.mtimeMs, lines: 0, comment: '' }); }
    }
    this.model = this.build();
    this.model.stats.parsed = parsed;
    this.model.stats.ms = Date.now() - t0;
    return this.model;
  }

  resolve(fromRel, spec) {
    const exts = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '/index.ts', '/index.tsx', '/index.js', '/index.jsx'];
    const tryBase = (base) => {
      const b = posix(path.normalize(base)).replace(/^\.\//, '');
      for (const e of exts) { if (this.files.has(b + e)) return b + e; }
      // .js specifier pointing at .ts source
      const noExt = b.replace(/\.[cm]?jsx?$/, '');
      if (noExt !== b) for (const e of ['.ts', '.tsx']) if (this.files.has(noExt + e)) return noExt + e;
      return null;
    };
    if (spec.startsWith('.')) return tryBase(path.posix.join(path.posix.dirname(fromRel), spec));
    for (const p of this.tsconfig.paths) {
      if (p.wildcard ? spec.startsWith(p.prefix) : spec === p.prefix) {
        const rest = p.wildcard ? spec.slice(p.prefix.length) : '';
        for (const t of p.targets) {
          const r = tryBase(path.posix.join(this.tsconfig.baseUrl || '.', t, rest));
          if (r) return r;
        }
      }
    }
    if (this.tsconfig.baseUrl) { const r = tryBase(path.posix.join(this.tsconfig.baseUrl, spec)); if (r) return r; }
    return null;
  }

  /** Where does `name` exported from `file` really live? Follows re-exports. */
  resolveExport(file, name, depth = 0) {
    const fi = this.files.get(file);
    if (!fi || depth > 6) return null;
    const ex = fi.exports[name] || (name !== 'default' && fi.decls[name] ? { local: name } : null);
    if (ex && ex.local !== undefined) {
      const local = ex.local;
      if (fi.decls[local]) return { file, fn: local };
      // exported identifier that is itself an import (export default Foo where Foo imported)
      const imp = fi.importLocals && fi.importLocals.get(local);
      if (imp) {
        const i = fi.imports[imp.idx], r = this.resolve(file, i.spec);
        if (r) return this.resolveExport(r, imp.kind === 'default' ? 'default' : imp.imported || local, depth + 1) || { file: r, fn: '<module>' };
      }
      return { file, fn: '<module>' };
    }
    if (ex && ex.from) {
      const r = this.resolve(file, ex.from);
      if (r) return this.resolveExport(r, ex.name, depth + 1);
      return null;
    }
    const star = fi.exports['*'];
    if (star) for (const from of star.stars) { const r = this.resolve(file, from); if (r) { const x = this.resolveExport(r, name, depth + 1); if (x) return x; } }
    return null;
  }

  build() {
    const routes = [];
    const entries = [];
    for (const fi of this.files.values()) {
      if (fi.error || isTest(fi.rel)) continue;
      const u = nextUrl(fi.rel);
      if (u) {
        if (u.kind === 'api' && /(^|\/)route\.[cm]?[jt]sx?$/.test(fi.rel)) {
          const verbs = VERBS.filter((v) => fi.exports[v]);
          for (const v of verbs) routes.push({ method: v, url: u.url, file: fi.rel, fn: v, kind: 'api' });
        } else if (u.kind === 'api') {
          routes.push({ method: 'ANY', url: u.url, file: fi.rel, fn: 'default', kind: 'api' });
        } else if (/(^|\/)page\.[cm]?[jt]sx?$/.test(fi.rel) || /^(src\/)?pages\//.test(fi.rel)) {
          routes.push({ method: 'PAGE', url: u.url, file: fi.rel, fn: 'default', kind: 'page' });
        }
      }
      if (/^(src\/)?(middleware|proxy)\.[cm]?[jt]s$/.test(fi.rel)) { const fnName = ['middleware', 'proxy', 'default'].find((n) => fi.exports[n]); if (fnName) routes.push({ method: 'MIDDLEWARE', url: '/*', file: fi.rel, fn: fnName, kind: 'middleware' }); }
      for (const ex of fi.express || []) routes.push({ method: ex.method, url: ex.url, file: fi.rel, fn: ex.handlers[0] && fi.decls[ex.handlers[0]] ? ex.handlers[0] : ex.fn, kind: 'api', express: true });
    }
    routes.sort((a, b) => (a.kind + a.url + a.method).localeCompare(b.kind + b.url + b.method));
    for (const r of routes) r.pattern = routePattern(r.url);

    // graph: node id = file::fn
    const out = new Map(); // id -> [{to, type, label}]
    const nodes = new Map(); // id -> {file, fn}
    const addNode = (file, fn) => { const id = file + '::' + fn; if (!nodes.has(id)) nodes.set(id, { id, file, fn }); return id; };
    const addEdge = (from, to, type, label) => { if (from === to) return; if (!out.has(from)) out.set(from, []); const l = out.get(from); if (!l.some((e) => e.to === to && e.type === type)) l.push({ to, type, label }); };
    const pkgs = new Map(); // pkg name -> {lane}

    for (const fi of this.files.values()) {
      if (fi.error || isTest(fi.rel)) continue;
      const locals = fi.importLocals;
      const fnNames = Object.keys(fi.fnUses);
      for (const fn of fnNames) {
        const from = addNode(fi.rel, fn);
        for (const u of fi.fnUses[fn]) {
          // local declaration?
          if (fi.decls[u] && u !== fn) { addEdge(from, addNode(fi.rel, u), 'local', u); continue; }
          // imported name?
          let base = u, member = null;
          if (u.includes('.')) { [base, member] = u.split('.'); }
          const imp = locals && locals.get(base);
          if (!imp) continue;
          const i = fi.imports[imp.idx];
          if (i.typeOnly || imp.typeOnly) continue;
          const r = this.resolve(fi.rel, i.spec);
          if (r) {
            const exportName = imp.kind === 'default' ? 'default' : imp.kind === 'ns' ? (member || 'default') : imp.imported;
            const tgt = this.resolveExport(r, exportName);
            if (tgt) addEdge(from, addNode(tgt.file, tgt.fn), 'import', exportName);
          } else if (!i.spec.startsWith('.')) {
            const pk = pkgName(i.spec);
            const lane = DB_PKG.test(pk) ? 'db' : CLOUD_PKG.test(pk) ? 'az' : null;
            if (lane) { pkgs.set(pk, { lane }); const id = 'pkg:' + pk; if (!nodes.has(id)) nodes.set(id, { id, file: 'pkg:' + pk, fn: pk, pkg: pk, lane }); addEdge(from, id, 'pkg', pk); }
          }
        }
        // fetch edges: this function builds a /api/... url
        for (const a of fi.apiStrings) {
          if (a.fn !== fn) continue;
          let hit = 0;
          for (const r of routes) {
            if (r.kind !== 'api') continue;
            if (r.pattern.test(a.path) || r.pattern.test(a.path.replace(/\/$/, ''))) { addEdge(from, addNode(r.file, r.fn), 'fetch', r.method + ' ' + r.url); hit++; }
          }
          // a base path such as "/api/delegation" (the rest is added at run time): connect to the routes below it
          const baseSrc = a.head !== null && a.head !== undefined ? a.head : a.path;
          if (!hit && baseSrc.split('/').filter(Boolean).length >= 2) {
            const base = baseSrc.replace(/\/$/, '');
            for (const r of routes) if (r.kind === 'api' && r.url.startsWith(base + '/')) addEdge(from, addNode(r.file, r.fn), 'fetch', r.method + ' ' + r.url);
          }
        }
      }
    }
    const rev = new Map();
    for (const [from, list] of out) for (const e of list) { if (!rev.has(e.to)) rev.set(e.to, []); rev.get(e.to).push({ from, type: e.type, label: e.label }); }

    const framework = {};
    const deps = Object.assign({}, this.pkg.dependencies, this.pkg.devDependencies);
    for (const k of ['next', 'express', 'fastify', 'koa', 'hono', '@nestjs/core', 'react', 'vite', 'electron']) if (deps[k]) framework[k] = deps[k];
    return {
      root: this.root,
      name: this.pkg.name || path.basename(this.root),
      engines: (this.pkg.engines && this.pkg.engines.node) || null,
      entry: { main: this.pkg.main || null, bin: this.pkg.bin || null, scripts: this.pkg.scripts || {} },
      framework,
      routes, graph: { out, rev, nodes, pkgs },
      stats: { files: this.files.size, tests: [...this.files.keys()].filter(isTest).length, routes: routes.length, functions: [...this.files.values()].reduce((n, f) => n + Object.keys(f.decls || {}).length, 0), edges: [...out.values()].reduce((n, l) => n + l.length, 0) },
      scannedAt: Date.now(),
    };
  }

  /** Which section (lane) does a file belong to? */
  laneOf(file) {
    if (file.startsWith('pkg:')) { const m = this.model.graph.nodes.get(file); return m ? m.lane : 'az'; }
    const fi = this.files.get(file);
    if (!fi) return 'srv';
    if (fi.client) return 'ui';
    if (fi.serverOnly) return 'srv';
    if (/(^|\/)(route|middleware)\.[cm]?[jt]sx?$/.test(fi.rel) || /(^|\/)(api|server|services?|db|models?|controllers?|handlers?)\//.test(fi.rel)) return 'srv';
    if (/(^|\/)(components?|hooks?|providers?|stores?|contexts?|pages?|views?|ui)\//.test(fi.rel) || /(^|\/)(page|layout|loading|error|not-found|template)\.[jt]sx$/.test(fi.rel)) return 'ui';
    if (fi.usesBrowserGlobals) return 'ui';
    if (fi.apiStrings && fi.apiStrings.length && !this.model.routes.some((r) => r.file === fi.rel)) return 'ui';
    if (/\.[jt]sx$/.test(fi.rel)) return 'ui';
    return 'srv';
  }

  isTestFile(rel) { return isTest(rel); }
}

module.exports = { Scanner, VERBS, DB_PKG, CLOUD_PKG, IGNORE_DIRS, isTest, walk };
