'use strict';
// NodeBox desktop shell (Electron): starts the local scanner server on 127.0.0.1 and shows it
// in a window. Pick a Node project with File > Open Project (Cmd+O). Read-only, offline.

const { app, BrowserWindow, Menu, dialog, shell, session } = require('electron');
const fs = require('fs');
const path = require('path');
const { createServer } = require('./server');
const { checkProject } = require('./projects');

app.setName('NodeBox');
let win = null, srv = null;
const stateFile = () => path.join(app.getPath('userData'), 'state.json');
const loadState = () => { try { return JSON.parse(fs.readFileSync(stateFile(), 'utf8')); } catch (_) { return {}; } };
const saveState = (s) => { try { fs.mkdirSync(path.dirname(stateFile()), { recursive: true }); fs.writeFileSync(stateFile(), JSON.stringify(Object.assign(loadState(), s))); } catch (_) { /* ignore */ } };
// GPU: on by default (the cars are drawn on a GPU-composited canvas and the diagram is rasterized on the GPU); can be switched off in the View menu
if (loadState().gpu === false) app.disableHardwareAcceleration();
else { app.commandLine.appendSwitch('enable-gpu-rasterization'); app.commandLine.appendSwitch('ignore-gpu-blocklist'); app.commandLine.appendSwitch('enable-zero-copy'); }

function argDir() { const a = process.argv.slice(app.isPackaged ? 1 : 2).find((x) => !x.startsWith('-') && fs.existsSync(x) && fs.statSync(x).isDirectory()); return a ? path.resolve(a) : null; }

async function openProject(dir) {
  const c = checkProject(dir);
  if (!c.ok) { await dialog.showMessageBox(win, { type: 'warning', message: 'This is not a Node project', detail: c.checks.filter((x) => !x.ok).map((x) => '• ' + (x.detail || x.label)).join('\n') }); return false; }
  srv.setRoot(c.dir); saveState({ last: c.dir });
  win.setTitle('NodeBox — ' + c.info.name);
  if (!win.webContents.getURL().startsWith(srv.url)) win.webContents.loadURL(srv.url);
  return true;
}

async function pickFolder() {
  const r = await dialog.showOpenDialog(win, { title: 'Choose a Node project folder', properties: ['openDirectory'] });
  return r.canceled ? null : r.filePaths[0];
}

async function chooseProject() { const d = await pickFolder(); if (d) await openProject(d); }

function menu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'NodeBox', submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { type: 'separator' }, { role: 'quit' }] },
    { label: 'File', submenu: [{ label: 'Open Project…', accelerator: 'CmdOrCtrl+O', click: chooseProject }, { label: 'Rescan', accelerator: 'CmdOrCtrl+R', click: () => srv && srv.rescan() }, { type: 'separator' }, { role: 'close' }] },
    { label: 'Edit', submenu: [{ role: 'copy' }, { role: 'selectAll' }] },
    { label: 'View', submenu: [{ label: 'Use GPU acceleration (restart)', type: 'checkbox', checked: loadState().gpu !== false, click: async (item) => { saveState({ gpu: item.checked }); const r = await dialog.showMessageBox(win, { type: 'question', buttons: ['Restart now', 'Later'], message: 'Restart NodeBox to ' + (item.checked ? 'use' : 'stop using') + ' the GPU?' }); if (r.response === 0) { app.relaunch(); app.exit(0); } } }, { type: 'separator' }, { label: 'Toggle Sidebar', accelerator: 'CmdOrCtrl+B', click: () => win && win.webContents.executeJavaScript('window.toggleSidebar && window.toggleSidebar()') }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
  ]));
}

app.whenReady().then(async () => {
  // local only: block every request that is not to this machine
  session.defaultSession.webRequest.onBeforeRequest((d, cb) => cb({ cancel: !/^(http:\/\/127\.0\.0\.1|devtools:|data:|blob:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_wc, _p, cb) => cb(false));
  srv = await createServer({ pickFolder, onProject: (c) => { saveState({ last: c.dir }); if (win) win.setTitle('NodeBox — ' + c.info.name); } });
  win = new BrowserWindow({ width: 1500, height: 960, backgroundColor: '#070b14', title: 'NodeBox', icon: path.join(__dirname, '..', 'build', 'icon-source.png'), webPreferences: { contextIsolation: true, sandbox: true } });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  menu();
  const dir = argDir();                       // a folder given on the command line opens straight away
  if (dir && fs.existsSync(dir) && checkProject(dir).ok) await openProject(dir);
  else win.webContents.loadURL(srv.url);      // otherwise: the landing page, with the history of opened projects
});
app.on('window-all-closed', () => { if (srv) srv.close(); app.quit(); });
