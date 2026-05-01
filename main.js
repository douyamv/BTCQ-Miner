// BTCQ Miner v0.1.5 — 纯前端，不依赖 Python
const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

const isDev = process.argv.includes('--dev');
const userData = app.getPath('userData');
const stateFile = path.join(userData, 'state.json');

let mainWindow;

function loadState() {
  try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); }
  catch { return {}; }
}
function saveState(s) {
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify(s, null, 2));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 980,
    minHeight: 680,
    backgroundColor: '#06070d',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,    // preload 需要 require 加密库
    },
    show: false,
  });
  mainWindow.loadFile('renderer/index.html');
  mainWindow.once('ready-to-show', () => mainWindow.show());

  // v0.1.5：默认打开 DevTools 方便用户排查（v0.2 会去掉）
  mainWindow.webContents.openDevTools({ mode: 'detach' });

  // 把 renderer 的 console 转发到主进程的 stdout，便于从终端看错
  mainWindow.webContents.on('console-message', (e, level, message, line, sourceId) => {
    const lvl = ['VERBOSE','INFO','WARN','ERROR'][level] || 'LOG';
    console.log(`[renderer:${lvl}] ${message}`);
  });
  mainWindow.webContents.on('preload-error', (e, preloadPath, error) => {
    console.error(`[preload-error] ${preloadPath}:`, error);
  });
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// =================== IPC（极简，仅状态持久化与 shell） ===================
ipcMain.handle('state:get', () => loadState());
ipcMain.handle('state:set', (_e, patch) => {
  const s = { ...loadState(), ...patch };
  saveState(s);
  return s;
});
ipcMain.handle('shell:open', (_e, url) => shell.openExternal(url));
ipcMain.handle('dialog:select-folder', async () => {
  const r = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});
