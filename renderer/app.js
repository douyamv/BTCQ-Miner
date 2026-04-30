// BTCQ Miner — 前端逻辑（无框架，原生 JS）
const { btcq } = window;

// =========================== 状态 ===========================
let state = {};
let walletAddress = null;
let walletPrivateKey = null;     // 仅创建时短暂持有，存盘后清空
let backendsAvailable = [];
let usageInfo = null;
let mining = false;
let blocksMinedSession = 0;
let sessionStart = null;
let unsubMiningEvents = null;

// =========================== 屏幕路由 ===========================
function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const t = document.querySelector(`[data-screen="${name}"]`);
  if (t) t.classList.add('active');
  if (name === 'dashboard') initDashboard();
}

// =========================== 工具 ===========================
function $(sel) { return document.querySelector(sel); }
function $$(sel) { return [...document.querySelectorAll(sel)]; }
function fmtTime(s) {
  if (s < 60) return Math.floor(s) + '秒';
  if (s < 3600) return Math.floor(s/60) + '分' + Math.floor(s%60) + '秒';
  return Math.floor(s/3600) + '时' + Math.floor((s%3600)/60) + '分';
}
function fmtBTCQ(atomic) {
  return (atomic / 1e8).toFixed(4) + ' BTCQ';
}
function shortAddr(a) {
  if (!a) return '0x...';
  return a.slice(0, 6) + '...' + a.slice(-4);
}
function ts() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}`;
}
function logLine(text, level = '') {
  const body = $('#log-body');
  if (body.querySelector('.log-empty')) body.innerHTML = '';
  const line = document.createElement('div');
  line.className = `log-line ${level}`;
  line.innerHTML = `<span class="ts">${ts()}</span>${text}`;
  body.appendChild(line);
  while (body.children.length > 200) body.removeChild(body.firstChild);
  body.scrollTop = body.scrollHeight;
}

// =========================== 启动 ===========================
async function boot() {
  state = await btcq.getState();
  console.log('loaded state', state);

  // 已配置过 → 直接进入仪表盘
  if (state.walletAddress && state.ibmTokenSaved) {
    walletAddress = state.walletAddress;
    showScreen('dashboard');
  } else {
    showScreen('welcome');
  }

  // 监听挖矿事件
  unsubMiningEvents = btcq.onMiningEvent(handleMiningEvent);

  bindGlobalListeners();
}

function bindGlobalListeners() {
  // 屏幕切换按钮
  document.addEventListener('click', e => {
    const t = e.target.closest('[data-next]');
    if (t) { e.preventDefault(); showScreen(t.dataset.next); }
    const b = e.target.closest('[data-back]');
    if (b) { e.preventDefault(); showScreen(b.dataset.back); }
    const a = e.target.closest('[data-action]');
    if (a) { e.preventDefault(); handleAction(a.dataset.action, a); }
  });
}

// =========================== 操作处理 ===========================
async function handleAction(action, btn) {
  switch (action) {
    case 'open-ibm':
      btcq.openExternal('https://quantum.ibm.com');
      break;
    case 'open-token':
      btcq.openExternal('https://quantum.ibm.com/account');
      break;
    case 'test-token':
      await onTestToken(btn);
      break;
    case 'create-wallet':
      await onCreateWallet();
      break;
    case 'import-wallet':
      await onImportWallet();
      break;
    case 'copy-address':
      navigator.clipboard.writeText(walletAddress);
      btn.textContent = '✓';
      setTimeout(() => btn.textContent = '📋', 1200);
      break;
    case 'toggle-mine':
      await toggleMining();
      break;
    case 'verify-chain':
      await verifyChain();
      break;
    case 'clear-log':
      $('#log-body').innerHTML = '<div class="log-empty muted">日志已清空</div>';
      break;
    case 'open-settings':
      $('#settings-modal').classList.remove('hidden');
      $('#setting-btcq-path').value = state.btcqPath || '';
      break;
    case 'close-settings':
      $('#settings-modal').classList.add('hidden');
      break;
    case 'pick-btcq-path':
      const dir = await btcq.selectFolder();
      if (dir) $('#setting-btcq-path').value = dir;
      break;
    case 'save-settings':
      await btcq.setState({
        backend: $('#setting-backend').value,
        miningMode: $('#setting-mode').value,
        btcqPath: $('#setting-btcq-path').value,
      });
      state = await btcq.getState();
      $('#info-backend').textContent = state.backend || 'ibm_marrakesh';
      $('#settings-modal').classList.add('hidden');
      logLine('设置已保存', 'event');
      break;
  }

  // 钱包模式切换
  if (btn.classList.contains('wallet-option-btn')) {
    $$('.wallet-option-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const mode = btn.dataset.mode;
    $$('.wallet-mode').forEach(m => m.classList.remove('active'));
    $('#' + mode + '-mode').classList.add('active');
  }
}

async function onTestToken(btn) {
  const token = $('#token-input').value.trim();
  if (!token) {
    setTokenStatus('请先粘贴 Token', 'error');
    return;
  }
  btn.disabled = true;
  setTokenStatus('正在测试连接...', 'loading');
  try {
    const r = await btcq.testIbm(token);
    if (!r.ok) {
      setTokenStatus('❌ ' + (r.error || '连接失败'), 'error');
      return;
    }
    backendsAvailable = r.backends || [];
    usageInfo = r.usage;
    await btcq.setState({ ibmTokenSaved: true });
    state.ibmTokenSaved = true;
    setTokenStatus(`✓ 连接成功，发现 ${backendsAvailable.length} 台量子机器`, 'success');
    renderBackends();
    $('#next-wallet-btn').disabled = false;
  } catch (e) {
    setTokenStatus('❌ ' + e.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

function setTokenStatus(text, level) {
  const s = $('#token-status');
  s.textContent = text;
  s.className = 'status ' + level;
}

function renderBackends() {
  const sec = $('#backends-section');
  sec.classList.remove('hidden');
  $('#backend-count').textContent = backendsAvailable.length;
  const list = $('#backend-list');
  list.innerHTML = '';
  for (const b of backendsAvailable) {
    const div = document.createElement('div');
    div.className = 'backend-item';
    div.innerHTML = `
      <div class="name">${b.name}</div>
      <div class="meta">${b.qubits} 量子比特 · 队列 ${b.queue} · ${b.operational ? '✓ 在线' : '⚠ 离线'}</div>
    `;
    list.appendChild(div);
  }
  if (usageInfo) {
    $('#usage-remaining').textContent = usageInfo.usage_remaining_seconds || '—';
  }
}

async function onCreateWallet() {
  try {
    const r = await btcq.createWallet();
    walletAddress = r.address;
    walletPrivateKey = r.private_key;
    await btcq.setState({ walletAddress: r.address });
    showWalletResult();
  } catch (e) {
    alert('创建钱包失败：' + e.message);
  }
}

async function onImportWallet() {
  let key = $('#import-key-input').value.trim();
  if (key.startsWith('0x')) key = key.slice(2);
  if (!/^[0-9a-fA-F]{64}$/.test(key)) {
    alert('私钥格式错误：需要 64 字符十六进制');
    return;
  }
  try {
    const r = await btcq.importWallet(key);
    walletAddress = r.address;
    walletPrivateKey = key;
    await btcq.setState({ walletAddress: r.address });
    showWalletResult();
  } catch (e) {
    alert('导入失败：' + e.message);
  }
}

function showWalletResult() {
  $('#wallet-create-card').classList.add('hidden');
  $('#wallet-result-card').classList.remove('hidden');
  $('#wallet-address').textContent = walletAddress;
  $('#enter-dashboard-btn').disabled = false;
}

// =========================== 仪表盘 ===========================
let pollHandle = null;
let qubitsPainted = false;

async function initDashboard() {
  // 头部钱包
  $('#dash-address').textContent = shortAddr(walletAddress);

  // 量子可视化：绘制 24 个 qubit 圆
  if (!qubitsPainted) {
    const g = document.getElementById('qubits-row');
    for (let i = 0; i < 24; i++) {
      const cx = 30 + i * 23;
      const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      c.setAttribute('cx', cx);
      c.setAttribute('cy', 80);
      c.setAttribute('r', 8);
      c.setAttribute('class', 'qubit-circle');
      c.id = 'q-' + i;
      g.appendChild(c);
    }
    qubitsPainted = true;
  }

  // 加载 chain 状态
  await refreshDashboard();

  // 初始化链（如果未初始化）
  if (pollHandle) clearInterval(pollHandle);
  pollHandle = setInterval(refreshDashboard, 5000);

  // 计时器
  setInterval(updateUptime, 1000);
}

async function refreshDashboard() {
  try {
    const stats = await btcq.chainStats();
    if (!stats.initialized) {
      // 自动初始化
      logLine('未检测到链，自动初始化创世区块...', 'event');
      await btcq.initChain();
      return;
    }
    $('#stat-height').textContent = stats.height;
    $('#stat-reward').textContent = (stats.nextReward / stats.coin).toFixed(0);
    $('#stat-blocktime').textContent = Math.round(stats.targetBlockTime);

    if (stats.bootstrapBlocksLeft > 0) {
      $('#info-phase').textContent = 'Bootstrap (开放挖矿)';
      $('#info-bootstrap').textContent = stats.bootstrapBlocksLeft + ' 块开放挖矿剩余';
    } else if (stats.targetBlockTime < 600) {
      $('#info-phase').textContent = 'Bootstrap 过渡期';
      $('#info-bootstrap').textContent = '已进入 PoQ-Stake';
    } else {
      $('#info-phase').textContent = '稳态期 (10 min/块)';
      $('#info-bootstrap').textContent = '稳态运行';
    }
    $('#info-difficulty').textContent = 'XEB ≥ ' + stats.nextDifficulty.toFixed(4);

    if (walletAddress) {
      const bal = await btcq.balanceOf(walletAddress);
      $('#dash-balance').textContent = (bal.total / 1e8).toFixed(2) + ' BTCQ';
      $('#info-stake').textContent =
        (bal.staked / 1e8).toFixed(2) + ' BTCQ staked'
        + (bal.cooling > 0 ? `  + ${(bal.cooling/1e8).toFixed(2)} 冷却中` : '');
    }
    if (state.backend) $('#info-backend').textContent = state.backend;
  } catch (e) {
    console.warn('refresh failed', e.message);
  }
}

function updateUptime() {
  if (!sessionStart) {
    $('#stat-uptime').textContent = '00:00';
    return;
  }
  const s = (Date.now() - sessionStart) / 1000;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  $('#stat-uptime').textContent =
    (h > 0 ? String(h).padStart(2,'0') + ':' : '') +
    String(m).padStart(2,'0') + ':' + String(sec).padStart(2,'0');
}

// =========================== 挖矿控制 ===========================
async function toggleMining() {
  if (mining) {
    await btcq.stopMining();
    mining = false;
    sessionStart = null;
    setMiningUI(false);
  } else {
    const opts = {
      backend: state.backend || 'ibm_marrakesh',
      mode: state.miningMode || 'quantum',
      walletPath: 'wallet.json',
    };
    const r = await btcq.startMining(opts);
    if (!r.ok) {
      alert('启动失败：' + r.error);
      return;
    }
    mining = true;
    sessionStart = Date.now();
    blocksMinedSession = 0;
    setMiningUI(true);
  }
}

function setMiningUI(running) {
  const light = $('#status-light');
  const title = $('#status-title');
  const sub = $('#status-subtitle');
  const btn = $('#mine-toggle-btn');
  if (running) {
    light.classList.add('mining');
    title.textContent = '正在挖矿';
    sub.textContent = '量子机器正在执行 RCS 电路...';
    btn.textContent = '暂停';
    btn.classList.remove('btn-primary');
    btn.classList.add('btn-secondary');
  } else {
    light.classList.remove('mining', 'error');
    title.textContent = '未挖矿';
    sub.textContent = '点击右下角"开始挖矿"';
    btn.textContent = '开始挖矿';
    btn.classList.remove('btn-secondary');
    btn.classList.add('btn-primary');
    activateQubits(false);
  }
}

let qubitAnimHandle = null;
function activateQubits(active) {
  if (qubitAnimHandle) {
    clearInterval(qubitAnimHandle);
    qubitAnimHandle = null;
  }
  document.querySelectorAll('.qubit-circle').forEach(c => c.classList.remove('active'));
  if (active) {
    qubitAnimHandle = setInterval(() => {
      document.querySelectorAll('.qubit-circle').forEach(c => {
        c.classList.toggle('active', Math.random() < 0.5);
      });
    }, 150);
  }
}

function handleMiningEvent(ev) {
  switch (ev.type) {
    case 'mining-started':
      logLine(`▶ 挖矿启动 (${ev.mode}, backend=${ev.backend})`, 'event');
      break;
    case 'mining-stopped':
      logLine('■ 挖矿已停止', 'event');
      activateQubits(false);
      break;
    case 'block-attempt-start':
      logLine('提交量子作业...', 'event');
      activateQubits(true);
      break;
    case 'block-attempt-end':
      activateQubits(false);
      if (ev.code === 0) {
        logLine('✅ 区块出块成功', 'success');
        blocksMinedSession++;
        $('#stat-mined-session').textContent = blocksMinedSession;
        refreshDashboard();
      } else {
        logLine('⚠️ 此次尝试失败 (退出码 ' + ev.code + ')', 'error');
      }
      break;
    case 'log':
      // 解析 XEB 数值
      const xebMatch = (ev.text || '').match(/XEB\s*=\s*([\d.]+)/);
      if (xebMatch) $('#viz-xeb').textContent = parseFloat(xebMatch[1]).toFixed(2);
      const shotsMatch = (ev.text || '').match(/shots?[=\s]+(\d+)/i);
      if (shotsMatch) $('#viz-shots').textContent = shotsMatch[1];
      logLine(ev.text.trim(), ev.level === 'error' ? 'error' : '');
      break;
  }
}

async function verifyChain() {
  logLine('正在验证整条链...', 'event');
  try {
    const r = await btcq.verifyChain();
    logLine(r.ok ? '✓ ' + r.msg : '✗ ' + r.msg, r.ok ? 'success' : 'error');
  } catch (e) {
    logLine('验证失败：' + e.message, 'error');
  }
}

// =========================== 启动 ===========================
window.addEventListener('DOMContentLoaded', boot);
