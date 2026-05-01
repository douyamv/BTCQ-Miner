// BTCQ Miner v0.1.6 — 纯前端 + 量子挖矿一键启动
const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, execSync } = require('child_process');

const isDev = process.argv.includes('--dev');
const userData = app.getPath('userData');
const stateFile = path.join(userData, 'state.json');
const BTCQ_DIR = path.join(os.homedir(), '.btcq-miner-runtime');    // 私有运行目录

let mainWindow;
let miningProc = null;
let miningStats = { running: false, blocksMined: 0, lastError: '', startedAt: null };

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

  if (isDev) mainWindow.webContents.openDevTools({ mode: 'detach' });

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
// URL 校验：只允许 https，且必须是白名单域名
const URL_HOST_ALLOWLIST = new Set([
  'quantum.ibm.com',
  'github.com',
  'raw.githubusercontent.com',
  'docs.github.com',
  'docs.quantum.ibm.com',
  'btcq.io',
]);
function safeOpenExternal(rawUrl) {
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== 'https:') return false;
    if (!URL_HOST_ALLOWLIST.has(u.hostname)) return false;
    shell.openExternal(u.toString());
    return true;
  } catch { return false; }
}
ipcMain.handle('shell:open', (_e, url) => safeOpenExternal(url));
ipcMain.handle('dialog:select-folder', async () => {
  const r = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});

// =================== 挖矿一键启动（v0.1.6） ===================
function emitMining(type, payload = {}) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('mining:event', { type, ...payload });
  }
}

function findPython() {
  for (const cmd of ['python3', 'python']) {
    try {
      const ver = execSync(`${cmd} --version`, { encoding: 'utf8' }).trim();
      return { cmd, version: ver };
    } catch {}
  }
  return null;
}

function findGit() {
  try {
    execSync('git --version', { encoding: 'utf8' });
    return true;
  } catch { return false; }
}

ipcMain.handle('mining:check_setup', async () => {
  const py = findPython();
  const git = findGit();
  const btcqInstalled = fs.existsSync(path.join(BTCQ_DIR, 'btcq', 'proposer.py'));
  const walletExported = fs.existsSync(path.join(BTCQ_DIR, 'wallet.json'));
  // Token 保存检测
  let tokenSaved = false;
  try {
    const ibmCred = path.join(os.homedir(), '.qiskit', 'qiskit-ibm.json');
    tokenSaved = fs.existsSync(ibmCred);
  } catch {}
  return {
    python: py,
    git,
    btcqInstalled,
    walletExported,
    tokenSaved,
    miningRunning: miningStats.running,
    blocksMined: miningStats.blocksMined,
    btcqDir: BTCQ_DIR,
  };
});

ipcMain.handle('mining:install_btcq', async () => {
  emitMining('install-progress', { msg: '准备下载 BTCQ 协议代码...' });
  fs.mkdirSync(BTCQ_DIR, { recursive: true });
  return new Promise((resolve) => {
    const exists = fs.existsSync(path.join(BTCQ_DIR, '.git'));
    // 不再用 shell:true 拼字符串，全部用 argv 数组
    const args = exists
      ? ['-C', BTCQ_DIR, 'pull', '--rebase']
      : ['clone', '--depth', '1', 'https://github.com/douyamv/BTCQ', BTCQ_DIR];
    emitMining('install-progress', { msg: `执行: git ${args.join(' ')}` });
    const proc = spawn('git', args, { shell: false });
    proc.stdout.on('data', d => emitMining('install-progress', { msg: d.toString().trim() }));
    proc.stderr.on('data', d => emitMining('install-progress', { msg: d.toString().trim() }));
    proc.on('close', code => {
      if (code !== 0) {
        emitMining('install-progress', { msg: `❌ 下载失败 (exit ${code})`, level: 'error' });
        resolve({ ok: false, error: '下载失败' });
        return;
      }
      emitMining('install-progress', { msg: '✅ 代码已下载，安装 Python 依赖...' });
      const py = findPython();
      if (!py) {
        emitMining('install-progress', { msg: '❌ 未检测到 python3', level: 'error' });
        resolve({ ok: false, error: '请先安装 Python 3.10+' });
        return;
      }
      const pip = spawn(py.cmd, ['-m', 'pip', 'install', '-r', path.join(BTCQ_DIR, 'requirements.txt'), '--quiet'], { shell: false });
      pip.stdout.on('data', d => emitMining('install-progress', { msg: d.toString().trim() }));
      pip.stderr.on('data', d => emitMining('install-progress', { msg: d.toString().trim() }));
      pip.on('close', code2 => {
        if (code2 !== 0) {
          emitMining('install-progress', { msg: `⚠️ pip install 退出码 ${code2}（可能部分依赖已存在）`, level: 'warn' });
          resolve({ ok: true });
          return;
        }
        emitMining('install-progress', { msg: '✅ 依赖安装完成' });
        resolve({ ok: true });
      });
    });
  });
});

ipcMain.handle('mining:save_token', async (_e, token) => {
  const py = findPython();
  if (!py) return { ok: false, error: '未检测到 python3' };
  if (typeof token !== 'string' || token.length < 8 || token.length > 4096) {
    return { ok: false, error: 'Token 格式无效' };
  }
  return new Promise((resolve) => {
    // Token 走 stdin，不进命令行；脚本仅是固定字符串，不拼接 user 数据
    const code = `
import sys, json
payload = json.loads(sys.stdin.read())
try:
    from qiskit_ibm_runtime import QiskitRuntimeService
    QiskitRuntimeService.save_account(channel='ibm_quantum_platform', token=payload['token'], overwrite=True, set_as_default=True)
    svc = QiskitRuntimeService()
    backends = [b.name for b in svc.backends(simulator=False, operational=True)]
    print('OK ' + ','.join(backends))
except Exception as e:
    print('ERR ' + str(e))
`;
    const proc = spawn(py.cmd, ['-c', code], { cwd: BTCQ_DIR, shell: false });
    let out = ''; let err = '';
    proc.stdout.on('data', d => out += d.toString());
    proc.stderr.on('data', d => err += d.toString());
    proc.on('close', () => {
      const trimmed = out.trim().split('\n').pop() || '';
      if (trimmed.startsWith('OK')) {
        const backends = trimmed.slice(3).split(',').filter(Boolean);
        resolve({ ok: true, backends });
      } else {
        resolve({ ok: false, error: trimmed.replace(/^ERR /, '') || err.trim() });
      }
    });
    proc.stdin.write(JSON.stringify({ token }));
    proc.stdin.end();
  });
});

ipcMain.handle('mining:export_wallet', async (_e, privateKey) => {
  // 把 GUI 的钱包私钥写为 BTCQ Python 端能读的 wallet.json（私钥走 stdin，绝不进命令行）
  const py = findPython();
  if (!py) return { ok: false, error: '未检测到 python3' };
  if (typeof privateKey !== 'string') return { ok: false, error: '私钥格式无效' };
  const hex = privateKey.replace(/^0x/, '');
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) return { ok: false, error: '私钥必须是 32 字节 hex' };
  return new Promise((resolve) => {
    const code = `
import sys, json
payload = json.loads(sys.stdin.read())
sys.path.insert(0, payload['btcq_dir'])
from btcq.wallet import Wallet
w = Wallet(bytes.fromhex(payload['priv']))
w.save(payload['wallet_path'])
print('OK ' + w.address_hex())
`;
    const proc = spawn(py.cmd, ['-c', code], { shell: false });
    let out = ''; let err = '';
    proc.stdout.on('data', d => out += d.toString());
    proc.stderr.on('data', d => err += d.toString());
    proc.on('close', () => {
      const last = out.trim().split('\n').pop() || '';
      if (last.startsWith('OK')) resolve({ ok: true, address: last.slice(3) });
      else resolve({ ok: false, error: err || out });
    });
    proc.stdin.write(JSON.stringify({
      priv: hex,
      btcq_dir: BTCQ_DIR,
      wallet_path: path.join(BTCQ_DIR, 'wallet.json'),
    }));
    proc.stdin.end();
  });
});

ipcMain.handle('mining:start', async (_e, opts = {}) => {
  if (miningStats.running) return { ok: false, error: '已在挖矿' };
  const py = findPython();
  if (!py) return { ok: false, error: '未检测到 python3' };
  const interval = opts.interval || 1200;
  const backend = opts.backend || 'ibm_marrakesh';
  // 确保链已初始化
  if (!fs.existsSync(path.join(BTCQ_DIR, 'chain_data', 'blocks', '00000000.json'))) {
    try {
      execSync(`${py.cmd} scripts/init_chain.py`, { cwd: BTCQ_DIR });
    } catch (e) {
      return { ok: false, error: '初始化链失败：' + e.message };
    }
  }
  miningProc = spawn(py.cmd, [
    '-u', 'scripts/auto_mine.py',
    '--interval', String(interval),
    '--backend', backend,
    '--wallet', 'wallet.json',
    '--shots', String(opts.shots || 4096),
  ], { cwd: BTCQ_DIR });
  miningStats = { running: true, blocksMined: 0, lastError: '', startedAt: Date.now() };
  emitMining('mining-started', { backend, interval });
  miningProc.stdout.on('data', d => {
    const text = d.toString();
    text.split('\n').forEach(line => {
      if (!line.trim()) return;
      emitMining('log', { text: line });
      if (line.includes('区块出块成功') || /累计 \d+ 块/.test(line)) {
        const m = line.match(/累计 (\d+) 块/);
        if (m) miningStats.blocksMined = parseInt(m[1]);
      }
    });
  });
  miningProc.stderr.on('data', d => emitMining('log', { text: d.toString(), level: 'error' }));
  miningProc.on('close', code => {
    miningStats.running = false;
    miningProc = null;
    emitMining('mining-stopped', { exitCode: code });
  });
  return { ok: true };
});

ipcMain.handle('mining:stop', async () => {
  if (miningProc) {
    miningProc.kill();
    miningProc = null;
  }
  miningStats.running = false;
  emitMining('mining-stopped', {});
  return { ok: true };
});

ipcMain.handle('mining:status', async () => {
  return {
    ...miningStats,
    uptime: miningStats.startedAt ? Date.now() - miningStats.startedAt : 0,
  };
});
