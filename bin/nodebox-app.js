#!/usr/bin/env node
'use strict';
// Starts the NodeBox desktop window with an Electron binary found on this machine.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const cands = [];
try { cands.push(require('electron')); } catch (_) { /* not installed here */ }
cands.push(path.join(root, '..', 'paperbox', 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron'));
const bin = cands.find((c) => typeof c === 'string' && fs.existsSync(c));
if (!bin) { console.error('No Electron found. Install it (npm i -D electron) or run `nodebox serve --open` instead.'); process.exit(1); }
const child = spawn(bin, [root, ...process.argv.slice(2)], { stdio: 'inherit' });
child.on('exit', (c) => process.exit(c || 0));
