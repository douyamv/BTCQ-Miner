// BTCQ Miner — Electron main process
const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { Miner } = require('./miner');

const isDev = process.argv.includes('--dev');
const userData = app.getPath('userData');
const stateFile = path.join(userData, 'state.json');

let mainWindow;
let miner;

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  } catch (e) {
    return {};
  }
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
    backgroundColor: '#0a0a14',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    show: false
  });
  mainWindow.loadFile('renderer/index.html');
  mainWindow.once('ready-to-show', () => mainWindow.show());
  if (isDev) mainWindow.webContents.openDevTools({ mode: 'detach' });
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (miner) miner.stop();
  if (process.platform !== 'darwin') app.quit();
});

// =================== IPC HANDLERS ===================

ipcMain.handle('state:get', () => loadState());

ipcMain.handle('state:set', (_e, patch) => {
  const s = { ...loadState(), ...patch };
  saveState(s);
  return s;
});

ipcMain.handle('shell:open', (_e, url) => shell.openExternal(url));

ipcMain.handle('ibm:test', async (_e, token) => {
  // 通过 Python 包测试 IBM 连接（避免 Electron 端做 HTTP 与凭据管理）
  return await new Miner(loadState()).testIbmConnection(token);
});

ipcMain.handle('wallet:create', async () => {
  return await new Miner(loadState()).createWallet();
});

ipcMain.handle('wallet:import', async (_e, privateKeyHex) => {
  return await new Miner(loadState()).importWallet(privateKeyHex);
});

ipcMain.handle('chain:init', async () => {
  return await new Miner(loadState()).initChain();
});

ipcMain.handle('chain:stats', async () => {
  return await new Miner(loadState()).getStats();
});

ipcMain.handle('chain:balance', async (_e, address) => {
  return await new Miner(loadState()).getBalance(address);
});

ipcMain.handle('chain:verify', async () => {
  return await new Miner(loadState()).verifyChain();
});

ipcMain.handle('chain:blocks', async (_e, start, end) => {
  return await new Miner(loadState()).getBlocks(start, end);
});

ipcMain.handle('chain:block', async (_e, height) => {
  return await new Miner(loadState()).getBlock(height);
});

ipcMain.handle('chain:txs', async (_e, address, limit) => {
  return await new Miner(loadState()).getTxsForAddress(address, limit);
});

ipcMain.handle('chain:mempool', async () => {
  return await new Miner(loadState()).getMempool();
});

ipcMain.handle('tx:send', async (_e, privateKey, to, amount, kind) => {
  return await new Miner(loadState()).sendTx(privateKey, to, amount, kind);
});

ipcMain.handle('wallet:list', async () => {
  return await new Miner(loadState()).listWallets(loadState().walletDir);
});

ipcMain.handle('mining:start', async (_e, opts) => {
  if (miner) miner.stop();
  miner = new Miner(loadState());
  miner.on('event', (ev) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('mining:event', ev);
    }
  });
  return await miner.start(opts);
});

ipcMain.handle('mining:stop', async () => {
  if (miner) await miner.stop();
  return { ok: true };
});

ipcMain.handle('mining:status', async () => {
  return miner ? miner.status() : { running: false };
});

ipcMain.handle('dialog:select-folder', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory']
  });
  return r.canceled ? null : r.filePaths[0];
});
