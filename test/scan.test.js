'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { Scanner } = require('../src/scanner');
const { Flows } = require('../src/flows');

const root = path.join(__dirname, 'fixture');
const sc = new Scanner(root); sc.scan();
const flows = new Flows(sc);

test('finds the route and the client call site', () => {
  const r = sc.model.routes.find((x) => x.url === '/api/items');
  assert.ok(r, 'route found'); assert.strictEqual(r.method, 'GET'); assert.strictEqual(r.file, 'app/api/items/route.ts');
  assert.strictEqual(sc.laneOf('components/List.tsx'), 'ui');
});

test('route flow runs component -> client call -> route -> service -> db function -> package pg', () => {
  const f = flows.get('r:GET /api/items|app/api/items/route.ts|GET');
  const names = f.steps.map((s) => s.t);
  assert.deepStrictEqual(names, ['List()', 'loadItems()', 'GET()', 'getItems()', 'listItems()', 'pool', 'pg']);
  assert.deepStrictEqual(f.steps.map((s) => s.lane), ['ui', 'ui', 'srv', 'srv', 'srv', 'srv', 'db']);
  assert.match(f.steps[4].files[0][0], /^lib\/db\.ts:\d+/);
});

test('function flow follows callers and callees', () => {
  const f = flows.get('f:lib/items.ts::getItems');
  const names = f.steps.map((s) => s.t);
  assert.ok(names.includes('GET()') && names.includes('listItems()') && names.at(-1) === 'pg');
});

test('refuses a folder that is not a node project', () => {
  const { isNodeProject } = require('../src/server');
  assert.strictEqual(isNodeProject(path.join(__dirname)), false);
});

test('project checker accepts a node project and explains why it refuses others', () => {
  const { checkProject } = require('../src/projects');
  const ok = checkProject(root);
  assert.strictEqual(ok.ok, true); assert.strictEqual(ok.info.name, 'fixture-shop');
  const no = checkProject(path.join(__dirname));          // a folder without package.json
  assert.strictEqual(no.ok, false); assert.match(no.checks.find((c) => !c.ok).detail, /package\.json/);
  assert.strictEqual(checkProject(require('os').homedir()).ok, false);   // too broad
  assert.strictEqual(checkProject('/definitely/not/here').ok, false);
});

test('older CommonJS projects (Node 14 style) are read: require, module.exports, exports.x, Express routes', () => {
  const root2 = path.join(__dirname, 'fixture-cjs');
  const sc2 = new Scanner(root2); const m = sc2.scan();
  assert.strictEqual(m.engines, '>=14');
  const r = m.routes.find((x) => x.url === '/users/:id');
  assert.ok(r, 'express route found'); assert.strictEqual(r.method, 'GET'); assert.strictEqual(r.fn, 'showUser');
  const f = new Flows(sc2).get('r:GET /users/:id|src/server.js|showUser');
  assert.deepStrictEqual(f.steps.map((s) => s.t), ['server.js', 'showUser()', 'getUser()', 'findUser()', 'pool', 'pg']);
});

test('chain: whole-app tree with grouped pages, and a page chain with layouts and a foldable subtree', () => {
  const sc3 = new Scanner(root); sc3.scan();
  const fl = new Flows(sc3);
  const app = fl.chain('e:app');
  const kids = app.nodes[app.rootId].children.map((c) => app.nodes[c].label);
  assert.ok(kids.some((k) => k.startsWith('API routes')), 'API routes group');
  const r = fl.chain('r:GET /api/items|app/api/items/route.ts|GET');
  const labels = []; (function walk(id) { const n = r.nodes[id]; labels.push(n.label); n.children.forEach(walk); })(r.rootId);
  assert.deepStrictEqual(labels, ['GET()', 'getItems()', 'listItems()', 'pool', 'pg']);
  const lazy = fl.chain('', { ref: 'lib/items.ts::getItems' });
  assert.ok(lazy.lazy && lazy.nodes[lazy.rootId].children.length >= 1, 'lazy expansion returns the subtree');
});
