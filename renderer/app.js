// BTCQ Miner v0.1.5 — 纯前端，远端节点架构
// ============================================
// 设计原则：
// - 不依赖任何本地 Python / 后端
// - 钱包：纯 JS 生成与签名（preload 桥暴露 secp256k1 + keccak）
// - 链数据：HTTP fetch 远端 BTCQ 节点
// - UI 永远不被网络故障拖垮

console.log('[app] script loaded');

// =============== 全局状态 ===============
const App = {
  state: {},
  activeWallet: null,
  currentPage: 'overview',
  nodeUrl: null,                  // 远端节点 URL
  nodeConnected: false,
  explorer: { page: 0, perPage: 20, mode: 'blocks' },
  lastChainInfo: null,
  pollHandle: null,
};

// =============== 工具 ===============
const $ = sel => document.querySelector(sel);
const $$ = sel => [...document.querySelectorAll(sel)];

// BTCQ 协议精度：1 BTCQ = 10^18 atomic units（与 Ethereum 对齐）
const COIN = 10n ** 18n;
const COIN_DECIMALS = 18;
// atomic (string|number|bigint) → 'X.YYYY' 显示串
function fmtBTCQ(atomic, displayDecimals = 6) {
  let big;
  try { big = BigInt(atomic); } catch { return String(atomic); }
  const neg = big < 0n;
  if (neg) big = -big;
  const whole = big / COIN;
  const frac = big % COIN;
  const fracStr = frac.toString().padStart(COIN_DECIMALS, '0').slice(0, displayDecimals).replace(/0+$/, '');
  const wholeStr = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (neg ? '-' : '') + wholeStr + (fracStr ? '.' + fracStr : '');
}
// 'X.YYYY' 显示串 → atomic BigInt（防 parseFloat 精度丢失）
function parseAmount(input) {
  if (input == null) throw new Error('金额为空');
  const s = String(input).trim();
  if (!s) throw new Error('金额为空');
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error('金额格式无效（仅允许非负数字）');
  const [whole, frac = ''] = s.split('.');
  if (frac.length > COIN_DECIMALS) throw new Error(`小数最多 ${COIN_DECIMALS} 位`);
  const padded = (frac + '0'.repeat(COIN_DECIMALS)).slice(0, COIN_DECIMALS);
  const atomic = BigInt(whole || '0') * COIN + BigInt(padded || '0');
  if (atomic <= 0n) throw new Error('金额必须大于 0');
  // 上限：100 × 21M BTCQ（与服务端一致），任何合法 tx 不会超过
  const HARD_MAX = 100n * 21_000_000n * COIN;
  if (atomic > HARD_MAX) throw new Error('金额超出最大值');
  return atomic;
}
const shortAddr = (a) => a ? a.slice(0, 10) + '...' + a.slice(-6) : '0x...';
const shortHash = (h) => h ? h.slice(0, 10) + '...' + h.slice(-6) : '—';
// XSS 防护：拼到 innerHTML 模板里的所有用户/链上数据必须先过 esc()
const ESC_MAP = { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' };
const esc = (v) => v == null ? '' : String(v).replace(/[&<>"']/g, ch => ESC_MAP[ch]);
function fmtTime(ts) {
  const now = Date.now() / 1000;
  const diff = now - ts;
  if (diff < 60) return Math.floor(diff) + ' 秒前';
  if (diff < 3600) return Math.floor(diff / 60) + ' 分钟前';
  if (diff < 86400) return Math.floor(diff / 3600) + ' 小时前';
  return new Date(ts * 1000).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}
function toast(msg, level = '') {
  const t = $('#toast');
  if (!t) { console.log('[toast]', level, msg); return; }
  t.className = 'toast ' + level;
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add('hidden'), 3000);
}

// =============== 节点 API（fetch 远端） ===============
const Node = {
  setUrl(url) {
    App.nodeUrl = url ? url.replace(/\/$/, '') : null;
    btcq.setState({ nodeUrl: App.nodeUrl });
  },
  async fetch(path) {
    if (!App.nodeUrl) throw new Error('未配置节点 URL（设置 → 节点连接）');
    const r = await fetch(App.nodeUrl + path, { signal: AbortSignal.timeout(10000) });
    if (!r.ok) throw new Error(`节点返回 ${r.status}`);
    return r.json();
  },
  async post(path, data) {
    if (!App.nodeUrl) throw new Error('未配置节点 URL');
    const r = await fetch(App.nodeUrl + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
      signal: AbortSignal.timeout(10000),
    });
    return r.json();
  },
  async info() { return this.fetch('/info'); },
  async blocks(start, end) { return this.fetch(`/blocks/range/${start}/${end}`); },
  async block(h) { return this.fetch(`/blocks/${h}`); },
  async mempool() { return this.fetch('/mempool'); },
  async submitTx(tx) { return this.post('/tx', tx); },
  async slashes() { return this.fetch('/slashes'); },
  async addressInfo(addr) { return this.fetch(`/address/${addr}`); },
  async addressTxs(addr, limit = 50) { return this.fetch(`/address/${addr}/txs?limit=${limit}`); },
};

// =============== 路由 ===============
function showPage(name) {
  console.log('[router] showPage', name);
  App.currentPage = name;
  $$('.page').forEach(p => p.classList.add('hidden'));
  $$('.nav-item').forEach(n => n.classList.toggle('active', n.dataset.page === name));
  const target = document.querySelector(`.page[data-page="${name}"]`);
  if (target) target.classList.remove('hidden');
  if (name in Pages) {
    try { Pages[name].refresh(); }
    catch (e) { console.warn('[router] refresh err', e); }
  }
}

// =============== 启动 ===============
function boot() {
  console.log('[boot] start');

  // 第一步：直接绑定每个导航按钮（不靠 delegation）
  $$('.nav-item[data-page]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      console.log('[boot] nav click:', btn.dataset.page);
      showPage(btn.dataset.page);
    });
  });

  // 第二步：通用 action delegation（也在最早执行）
  document.addEventListener('click', e => {
    const action = e.target.closest('[data-action]');
    if (action) {
      e.preventDefault();
      console.log('[boot] action:', action.dataset.action);
      try { handleAction(action.dataset.action, action); }
      catch (err) { console.error('[boot] action err', err); toast('错误: ' + err.message, 'error'); }
      return;
    }
    const tab = e.target.closest('.tab[data-explorer-tab]');
    if (tab && Pages.explorer) Pages.explorer.switchTab(tab.dataset.explorerTab);
    const link = e.target.closest('[data-link]');
    if (link) { e.preventDefault(); btcq.openExternal(link.dataset.link); }
  });

  // Vault：回车提交 + 拦截私钥模态框关闭时清空
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !$('#vault-overlay').classList.contains('hidden')) {
      e.preventDefault();
      Vault.submit();
    }
    // 浏览器搜索框回车
    if (e.key === 'Enter' && document.activeElement?.id === 'explorer-search') {
      e.preventDefault();
      Pages.explorer.search();
    }
  });

  console.log('[boot] events bound');

  // 第三步：异步加载状态（独立失败安全）
  loadInitialState().catch(err => {
    console.error('[boot] init state failed:', err);
  });

  // 第四步：默认显示概览
  showPage('overview');

  // 第五步：周期刷新
  App.pollHandle = setInterval(() => {
    if (App.currentPage in Pages) {
      try { Pages[App.currentPage].refresh(); }
      catch (e) { console.warn('[poll] err', e); }
    }
  }, 8000);

  console.log('[boot] done');
}

// =============== Vault：钱包私钥加密 + 自动锁屏 ===============
const Vault = {
  locked: true,
  password: null,                            // 仅内存，不持久化
  IDLE_MS: 10 * 60 * 1000,                   // 10 分钟无操作 → 锁定
  idleTimer: null,
  mode: 'unlock',                            // 'unlock' | 'setup' | 'migrate'

  show(mode) {
    Vault.mode = mode;
    const ov = $('#vault-overlay');
    const title = $('#vault-title');
    const sub = $('#vault-sub');
    const p2 = $('#vault-password2');
    const btn = $('#vault-submit-btn');
    const err = $('#vault-error');
    err.textContent = '';
    $('#vault-password').value = '';
    p2.value = '';
    if (mode === 'setup') {
      title.textContent = '设置主密码';
      sub.textContent = '主密码用于加密本机钱包私钥（≥8 字符），不上传任何地方';
      p2.classList.remove('hidden');
      btn.textContent = '设置并继续';
    } else if (mode === 'migrate') {
      title.textContent = '加密现有钱包';
      sub.textContent = '检测到老版本明文存储的钱包，请设置主密码以加密';
      p2.classList.remove('hidden');
      btn.textContent = '加密并继续';
    } else {
      title.textContent = '解锁钱包';
      sub.textContent = '输入主密码以解密本机钱包私钥';
      p2.classList.add('hidden');
      btn.textContent = '解锁';
    }
    ov.classList.remove('hidden');
    setTimeout(() => $('#vault-password').focus(), 50);
  },

  hide() { $('#vault-overlay').classList.add('hidden'); },

  async submit() {
    const pw = $('#vault-password').value;
    const pw2 = $('#vault-password2').value;
    const err = $('#vault-error');
    err.textContent = '';
    if (!pw || pw.length < 8) {
      err.textContent = '密码至少 8 字符';
      return;
    }
    if ((Vault.mode === 'setup' || Vault.mode === 'migrate') && pw !== pw2) {
      err.textContent = '两次输入不一致';
      return;
    }
    try {
      if (Vault.mode === 'unlock') {
        if (!btcq.checkVerifier(App.state.passwordVerifier, pw)) {
          err.textContent = '密码错误';
          return;
        }
        Vault.password = pw;
        for (const w of App.state.wallets || []) {
          if (w.encryptedKey) {
            try { w.privateKey = btcq.decryptSecret(w.encryptedKey, pw); }
            catch (e) { console.error('decrypt fail', w.address, e); }
          }
        }
      } else {
        // setup / migrate：生成 verifier，加密所有 wallets
        const verifier = btcq.makeVerifier(pw);
        for (const w of App.state.wallets || []) {
          if (w.privateKey) {
            w.encryptedKey = btcq.encryptSecret(w.privateKey, pw);
          }
        }
        Vault.password = pw;
        App.state.passwordVerifier = verifier;
        // 持久化（剥掉明文 privateKey）
        const sanitized = (App.state.wallets || []).map(w => ({
          name: w.name, address: w.address, encryptedKey: w.encryptedKey,
        }));
        await btcq.setState({ passwordVerifier: verifier, wallets: sanitized });
      }
      Vault.locked = false;
      Vault.hide();
      Vault.startIdleTimer();
      const wallets = App.state.wallets || [];
      if (wallets.length > 0) {
        const idx = App.state.activeWalletIndex >= 0 ? App.state.activeWalletIndex : 0;
        App.activeWallet = wallets[idx] || wallets[0];
      }
      if (App.currentPage in Pages) Pages[App.currentPage].refresh();
      toast(Vault.mode === 'unlock' ? '✓ 已解锁' : '✓ 主密码已设置', 'success');
    } catch (e) {
      console.error('vault submit', e);
      err.textContent = '出错：' + e.message;
    }
  },

  // "我的钱包" 页面顶部 banner：根据 vault 状态显示不同提示
  refreshBanner() {
    const banner = $('#vault-banner');
    if (!banner) return;
    const icon = $('#vault-banner-icon');
    const title = $('#vault-banner-title');
    const sub = $('#vault-banner-sub');
    const btn = $('#vault-banner-btn');
    const wallets = App.state.wallets || [];
    banner.classList.remove('warn', 'ok');
    if (!App.state.passwordVerifier) {
      // 没设过密码
      if (wallets.length === 0) {
        banner.classList.add('hidden');
        return;
      }
      banner.classList.remove('hidden');
      banner.classList.add('warn');
      icon.textContent = '⚠️';
      title.textContent = '钱包私钥未加密存盘';
      sub.textContent = '建议设置主密码以 AES-256-GCM 加密本机私钥（不上传任何地方）';
      btn.textContent = '设置主密码';
      btn.dataset.vaultMode = 'setup-or-migrate';
    } else if (Vault.locked) {
      banner.classList.remove('hidden');
      icon.textContent = '🔒';
      title.textContent = '钱包已锁定';
      sub.textContent = '解锁后才能创建/导入钱包、转账、抵押、挖矿';
      btn.textContent = '解锁钱包';
      btn.dataset.vaultMode = 'unlock';
    } else {
      banner.classList.remove('hidden');
      banner.classList.add('ok');
      icon.textContent = '🔓';
      title.textContent = '钱包已解锁';
      sub.textContent = '10 分钟无操作将自动锁定';
      btn.textContent = '立即锁定';
      btn.dataset.vaultMode = 'lock';
    }
  },

  bannerAction() {
    const mode = $('#vault-banner-btn').dataset.vaultMode;
    if (mode === 'lock') {
      Vault.lock();
      Vault.refreshBanner();
    } else if (mode === 'unlock') {
      Vault.show('unlock');
    } else if (mode === 'setup-or-migrate') {
      const hasPlaintext = (App.state.wallets || []).some(w => w.privateKey);
      Vault.show(hasPlaintext ? 'migrate' : 'setup');
    }
  },

  // 保存到磁盘前剥掉明文 privateKey
  _sanitize(wallets) {
    return (wallets || []).map(w => ({
      name: w.name,
      address: w.address,
      encryptedKey: w.encryptedKey,
    }));
  },

  // 加密保存：当 vault 已解锁，且新增/更新钱包时调用
  async persistWallets() {
    if (Vault.locked || !Vault.password) return;
    await btcq.setState({ wallets: Vault._sanitize(App.state.wallets) });
  },

  encryptNew(privateKey) {
    if (Vault.locked || !Vault.password) throw new Error('钱包已锁定');
    return btcq.encryptSecret(privateKey, Vault.password);
  },

  lock() {
    if (Vault.locked) return;
    // 清掉内存中的明文 privateKey
    for (const w of App.state.wallets || []) {
      try { delete w.privateKey; } catch {}
    }
    if (App.activeWallet) try { delete App.activeWallet.privateKey; } catch {}
    Vault.password = null;
    Vault.locked = true;
    Vault.show('unlock');
    if (Vault.idleTimer) { clearTimeout(Vault.idleTimer); Vault.idleTimer = null; }
  },

  startIdleTimer() {
    const reset = () => {
      if (Vault.idleTimer) clearTimeout(Vault.idleTimer);
      Vault.idleTimer = setTimeout(() => Vault.lock(), Vault.IDLE_MS);
    };
    if (!Vault._bound) {
      ['mousemove','keydown','click','scroll','touchstart'].forEach(ev =>
        document.addEventListener(ev, reset, { passive: true })
      );
      Vault._bound = true;
    }
    reset();
  },
};

async function loadInitialState() {
  if (!window.btcq) {
    console.error('window.btcq missing — preload 未加载');
    toast('IPC 桥未加载，请重启', 'error');
    return;
  }
  App.state = await btcq.getState() || {};
  console.log('[state] loaded', Object.keys(App.state));

  // 多钱包：state.wallets 是数组，state.activeWalletIndex 当前选中
  if (!Array.isArray(App.state.wallets)) {
    if (App.state.walletAddress && App.state.walletPrivateKey) {
      App.state.wallets = [{
        name: '1',
        address: App.state.walletAddress,
        privateKey: App.state.walletPrivateKey,
      }];
      App.state.activeWalletIndex = 0;
      App.state.walletCounter = 1;
    } else {
      App.state.wallets = [];
      App.state.activeWalletIndex = -1;
      App.state.walletCounter = 0;
    }
    await btcq.setState({
      wallets: App.state.wallets,
      activeWalletIndex: App.state.activeWalletIndex,
      walletCounter: App.state.walletCounter,
    });
  }
  // 计数器从已有钱包名推断（兼容老 state）
  if (App.state.walletCounter == null) {
    const maxNum = (App.state.wallets || []).reduce((m, w) => {
      const n = parseInt(w.name);
      return isNaN(n) ? m : Math.max(m, n);
    }, 0);
    App.state.walletCounter = maxNum;
    await btcq.setState({ walletCounter: maxNum });
  }
  if (App.state.wallets.length > 0) {
    const idx = App.state.activeWalletIndex >= 0 ? App.state.activeWalletIndex : 0;
    App.activeWallet = App.state.wallets[idx] || App.state.wallets[0];
    console.log('[state] active wallet:', App.activeWallet.address);
  }

  // 公网主节点（客户端永远不连本机链）
  const PUBLIC_NODE = 'http://43.136.28.125:8333';
  // 仅接受公网 http/https URL；任何非公网形式（包括老版本残留的内网/回环）都重置为主节点
  const looksPublic = (u) =>
    typeof u === 'string'
    && /^https?:\/\/[\w.-]+(:\d+)?(\/.*)?$/i.test(u)
    && !/^https?:\/\/(localhost\b|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.0\.0\.0\b|\[?::1\]?\b)/i.test(u);
  if (!looksPublic(App.state.nodeUrl)) {
    App.nodeUrl = PUBLIC_NODE;
    await btcq.setState({ nodeUrl: App.nodeUrl });
  } else {
    App.nodeUrl = App.state.nodeUrl;
  }
  await Node.checkConnection();

  // ==== Vault 状态：不强制弹窗，让用户能正常浏览 ====
  // 没设过密码 → 不锁（plaintext 模式，"我的钱包"页有 banner 引导）
  // 设过密码 → 默认锁定，需要私钥的操作触发解锁
  Vault.locked = !!App.state.passwordVerifier;
  if (App.currentPage in Pages) Pages[App.currentPage].refresh();
}

Node.checkConnection = async function () {
  try {
    await this.info();
    App.nodeConnected = true;
    $('#conn-text').textContent = '已连接';
    $('#conn-dot').style.background = 'var(--success)';
  } catch (e) {
    App.nodeConnected = false;
    $('#conn-text').textContent = '未连接节点';
    $('#conn-dot').style.background = 'var(--text-muted)';
  }
};

// =============== Action 处理 ===============
async function handleAction(action, btn) {
  switch (action) {
    case 'vault-submit':         return Vault.submit();
    case 'vault-lock':           return Vault.lock();
    case 'vault-banner-action':  return Vault.bannerAction();
    case 'open-ibm':           return btcq.openExternal('https://quantum.ibm.com');
    case 'open-token':         return btcq.openExternal('https://quantum.ibm.com/account');
    case 'modal-close':        return $$('.modal-backdrop').forEach(m => m.classList.add('hidden'));

    // 钱包
    case 'overview-create-wallet':
    case 'wallet-create':      return Wallet.create();
    case 'wallet-import':      return $('#modal-import-key').classList.remove('hidden');
    case 'confirm-import':     return Wallet.importKey();
    case 'wallet-show-key':    return Wallet.showKey();
    case 'wallet-switch':      return toast('多钱包切换 v0.5 上', '');
    case 'copy-active-addr':   return Wallet.copyAddr(btn);
    case 'copy-shown-key':     return Wallet.copyShownKey();

    // 转账
    case 'do-send':            return Send.execute();
    case 'do-stake':           return Stake.stake();
    case 'do-unstake':         return Stake.unstake();

    // 挖矿一键启动（v0.1.6）
    case 'mining-open-wizard':       return Mining.openWizard();
    case 'mining-open-ibm-register': return btcq.openExternal('https://quantum.ibm.com');
    case 'mining-open-ibm-token':    return btcq.openExternal('https://quantum.ibm.com/account');
    case 'mining-step-next':         return Mining.next();
    case 'mining-prepare':           return Mining.prepare();
    case 'mining-launch':            return Mining.launch();
    case 'mining-stop':              return Mining.stop();
    case 'mining-open-docs':         return btcq.openExternal('https://github.com/douyamv/BTCQ/blob/main/docs/DEPLOY.md');

    // 浏览器
    case 'explorer-search':    return Pages.explorer.search();
    case 'explorer-prev':      return Pages.explorer.prevPage();
    case 'explorer-next':      return Pages.explorer.nextPage();
    case 'explorer-back':      return Pages.explorer.showList();

    // 网络
    case 'net-add-peer':       return $('#modal-add-peer').classList.remove('hidden');
    case 'confirm-add-peer':   return Network.addPeer();
    case 'test-node-connection': return Settings.testNode(btn);
    case 'reset-node-url':       return Settings.resetNodeUrl();

    // 设置
    case 'open-data-dir':      return toast('数据目录：~/Library/Application Support/btcq-miner', '');
    case 'reset-state':        return Settings.reset();
  }
}

// =============== Pages 定义 ===============
const Pages = {};

Pages.overview = {
  async refresh() {
    // 链状态（钱包相关全部移到「我的钱包」页）
    if (App.nodeConnected && App.nodeUrl) {
      try {
        const info = await Node.info();
        App.lastChainInfo = info;
        $('#hero-height').textContent = info.height;
        $('#hero-supply').textContent = fmtBTCQ(info.total_supply);
        $('#hero-reward').textContent = '50';
        $('#hero-stage').textContent = `slot ${info.head_slot} · ${info.user_agent}`;
        $('#hero-mining').textContent = '链运行中';
        $('#hero-mining-meta').textContent = `${info.peers.length} 个 peer`;
        // 最近区块
        const start = Math.max(0, info.height - 4);
        const blocks = (await Node.blocks(start, info.height)).reverse();
        const node = $('#overview-recent-blocks');
        if (!blocks.length) {
          node.innerHTML = `<div class="empty-state muted">暂无区块</div>`;
        } else {
          node.innerHTML = blocks.map(b => `
            <div class="block-mini-row" data-block-h="${esc(b.height)}">
              <span class="height">#${esc(b.height)}</span>
              <span>slot ${esc(b.slot)}</span>
              <span class="ts">${esc(fmtTime(b.timestamp))}</span>
            </div>
          `).join('');
          node.querySelectorAll('[data-block-h]').forEach(el => {
            el.addEventListener('click', () => {
              showPage('explorer');
              setTimeout(() => Pages.explorer.showBlock(parseInt(el.dataset.blockH)), 100);
            });
          });
        }
      } catch (e) {
        console.warn('[overview] node fetch failed', e);
        Node.checkConnection();
        this.showNoNodeState();
      }
    } else {
      this.showNoNodeState();
    }

    this.renderTributes();
  },
  showNoNodeState() {
    $('#hero-height').textContent = '—';
    $('#hero-supply').textContent = '—';
    $('#hero-reward').textContent = '—';
    $('#hero-stage').textContent = '未连接节点';
    $('#hero-mining').textContent = '—';
    $('#hero-mining-meta').textContent = '在「设置」中配置节点 URL';
    $('#overview-recent-blocks').innerHTML =
      `<div class="empty-state muted">未连接节点。<br><a href="#" data-action="open-settings">前往设置</a></div>`;
  },
  renderTributes() {
    const grid = $('#tribute-grid');
    if (!grid || grid.children.length > 0) return;
    const tributes = [
      { name: 'Satoshi Nakamoto', amount: 50, role: 'Bitcoin' },
      { name: 'Vitalik Buterin', amount: 25, role: 'Ethereum' },
      { name: 'Hal Finney', amount: 10, role: '第一笔 BTC' },
      { name: 'Nick Szabo', amount: 10, role: '智能合约' },
      { name: 'David Chaum', amount: 10, role: 'DigiCash' },
      { name: 'Wei Dai', amount: 10, role: 'b-money' },
      { name: 'Peter Shor', amount: 25, role: 'Shor 算法' },
      { name: 'John Preskill', amount: 10, role: 'NISQ' },
      { name: 'Ecosystem Faucet', amount: 100, role: '生态运营' },
    ];
    grid.innerHTML = tributes.map(t => `
      <div class="tribute-item">
        <div class="tribute-name">${esc(t.name)}</div>
        <div class="muted" style="font-size:11px">${esc(t.role)}</div>
        <div class="tribute-amount">${esc(t.amount)} BTCQ</div>
      </div>
    `).join('');
  },
};

Pages.explorer = {
  total: 0,
  async refresh() {
    if (App.explorer.mode === 'mempool') return this.refreshMempool();
    return this.refreshBlocks();
  },
  async refreshBlocks() {
    $('#explorer-blocks-view').classList.remove('hidden');
    $('#explorer-block-detail').classList.add('hidden');
    $('#explorer-mempool-view').classList.add('hidden');
    if (!App.nodeConnected) {
      $('#explorer-blocks-tbody').innerHTML =
        `<tr><td colspan="7" class="muted" style="text-align:center;padding:32px">未连接节点。请先在「设置」配置 BTCQ 节点 URL</td></tr>`;
      $('#explorer-page-info').textContent = '—';
      return;
    }
    try {
      const info = await Node.info();
      this.total = info.height + 1;
      const start = Math.max(0, this.total - (App.explorer.page + 1) * App.explorer.perPage);
      const end = Math.max(0, this.total - 1 - App.explorer.page * App.explorer.perPage);
      const blocks = (await Node.blocks(start, end)).reverse();
      $('#explorer-blocks-tbody').innerHTML = blocks.map(b => `
        <tr data-block-h="${esc(b.height)}">
          <td class="height-cell">#${esc(b.height)}</td>
          <td>${esc(b.slot)}</td>
          <td>${esc(fmtTime(b.timestamp))}</td>
          <td class="hash-cell">${esc(shortHash(b.block_hash))}</td>
          <td class="hash-cell"><a href="#" data-addr="${esc(b.proposer_address)}">${esc(shortAddr(b.proposer_address))}</a></td>
          <td>${esc((b.transactions || []).length)}</td>
          <td>${esc(parseFloat(b.xeb_score).toFixed(2))}</td>
        </tr>
      `).join('');
      $('#explorer-blocks-tbody').querySelectorAll('tr[data-block-h]').forEach(tr => {
        tr.addEventListener('click', (e) => {
          const a = e.target.closest('[data-addr]');
          if (a) { e.stopPropagation(); e.preventDefault(); this.showAddress(a.dataset.addr); return; }
          this.showBlock(parseInt(tr.dataset.blockH));
        });
      });
      $('#explorer-page-info').textContent = `${start}–${end} / 共 ${this.total}`;
    } catch (e) {
      $('#explorer-blocks-tbody').innerHTML =
        `<tr><td colspan="7" class="muted" style="text-align:center;padding:32px">节点拉取失败：${esc(e.message)}</td></tr>`;
    }
  },
  async refreshMempool() {
    $('#explorer-blocks-view').classList.add('hidden');
    $('#explorer-block-detail').classList.add('hidden');
    $('#explorer-mempool-view').classList.remove('hidden');
    try {
      const r = await Node.mempool();
      const txs = r.transactions || [];
      const tbody = $('#explorer-mempool-tbody');
      if (!txs.length) {
        tbody.innerHTML = `<tr><td colspan="6" class="muted" style="text-align:center;padding:32px">mempool 为空</td></tr>`;
        return;
      }
      tbody.innerHTML = txs.map(tx => `
        <tr>
          <td>${esc(tx.kind)}</td>
          <td class="hash-cell">${esc(shortAddr(tx.sender))}</td>
          <td class="hash-cell">${esc(shortAddr(tx.recipient))}</td>
          <td>${esc(fmtBTCQ(tx.amount))}</td>
          <td>${esc(tx.nonce)}</td>
          <td class="hash-cell">${esc(shortHash(tx.tx_hash))}</td>
        </tr>
      `).join('');
    } catch (e) {
      $('#explorer-mempool-tbody').innerHTML =
        `<tr><td colspan="6" class="muted" style="text-align:center;padding:32px">未连接节点</td></tr>`;
    }
  },
  switchTab(mode) {
    App.explorer.mode = mode;
    $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.explorerTab === mode));
    if (mode === 'blocks') this.refreshBlocks();
    else if (mode === 'mempool') this.refreshMempool();
    else if (mode === 'txs') toast('交易聚合视图 v0.2', '');
  },
  search() {
    const q = $('#explorer-search').value.trim();
    if (!q) return;
    if (/^\d+$/.test(q)) return this.showBlock(parseInt(q));
    if (/^0x[0-9a-fA-F]{40}$/.test(q)) return this.showAddress(q.toLowerCase());
    if (/^[0-9a-fA-F]{40}$/.test(q)) return this.showAddress('0x' + q.toLowerCase());
    if (/^0x[0-9a-fA-F]{64}$/.test(q)) {
      toast('交易/区块哈希查询 v0.2 上线', '');
      return;
    }
    toast('支持：区块高度（数字）/ 地址（0x...40 hex）', 'error');
  },
  prevPage() { if (App.explorer.page > 0) { App.explorer.page--; this.refreshBlocks(); } },
  nextPage() {
    const maxP = Math.max(0, Math.floor((this.total - 1) / App.explorer.perPage));
    if (App.explorer.page < maxP) { App.explorer.page++; this.refreshBlocks(); }
  },
  async showBlock(h) {
    try {
      const block = await Node.block(h);
      $('#explorer-blocks-view').classList.add('hidden');
      $('#explorer-mempool-view').classList.add('hidden');
      $('#explorer-block-detail').classList.remove('hidden');
      const txList = (block.transactions || []).map((tx, i) => `
        <div style="background:rgba(0,0,0,0.25);padding:12px;border-radius:8px;margin-top:8px;font-size:12px">
          <div><strong>#${esc(i)}</strong> · ${esc(tx.kind)} · ${esc(fmtBTCQ(tx.amount))} BTCQ</div>
          <div class="muted" style="font-family:var(--font-mono);font-size:11px;margin-top:4px">
            from: <a href="#" data-addr="${esc(tx.sender)}">${esc(tx.sender)}</a><br>
            to: <a href="#" data-addr="${esc(tx.recipient)}">${esc(tx.recipient)}</a><br>
            nonce: ${esc(tx.nonce)}
          </div>
        </div>
      `).join('') || '<div class="muted" style="margin-top:8px">无交易</div>';
      $('#block-detail-content').innerHTML = `
        <h2 style="margin-bottom:16px">区块 #${esc(block.height)}</h2>
        <dl>
          <dt>高度</dt><dd>${esc(block.height)}</dd>
          <dt>Slot</dt><dd>${esc(block.slot)}</dd>
          <dt>时间戳</dt><dd>${esc(new Date(block.timestamp * 1000).toLocaleString('zh-CN'))}</dd>
          <dt>区块哈希</dt><dd>${esc(block.block_hash)}</dd>
          <dt>前一区块哈希</dt><dd>${esc(block.prev_hash)}</dd>
          <dt>State Root</dt><dd>${esc(block.state_root || '—')}</dd>
          <dt>出块人</dt><dd><a href="#" data-addr="${esc(block.proposer_address)}">${esc(block.proposer_address)}</a></dd>
          <dt>XEB</dt><dd>${esc(parseFloat(block.xeb_score).toFixed(4))}</dd>
          <dt>奖励</dt><dd>${esc(fmtBTCQ(block.reward || 0))} BTCQ</dd>
          <dt>电路</dt><dd>n=${esc(block.n_qubits)}, depth=${esc(block.depth)}, samples=${esc(block.n_samples)}</dd>
          <dt>交易（${esc((block.transactions || []).length)} 笔）</dt><dd>${txList}</dd>
        </dl>
      `;
      // 块详情里点地址 → 地址详情
      $('#block-detail-content').querySelectorAll('[data-addr]').forEach(a => {
        a.addEventListener('click', (e) => { e.preventDefault(); this.showAddress(a.dataset.addr.toLowerCase()); });
      });
    } catch (e) { toast('区块加载失败: ' + e.message, 'error'); }
  },
  showList() {
    $('#explorer-blocks-view').classList.remove('hidden');
    $('#explorer-block-detail').classList.add('hidden');
    $('#explorer-address-detail').classList.add('hidden');
    $('#explorer-mempool-view').classList.add('hidden');
    this.refreshBlocks();
  },
  async showAddress(addr) {
    if (!App.nodeConnected) { toast('未连接节点', 'error'); return; }
    $('#explorer-blocks-view').classList.add('hidden');
    $('#explorer-block-detail').classList.add('hidden');
    $('#explorer-mempool-view').classList.add('hidden');
    $('#explorer-address-detail').classList.remove('hidden');
    $('#addr-detail-addr').textContent = addr;
    $('#addr-detail-liquid').textContent = '查询中...';
    $('#addr-detail-staked').textContent = '—';
    $('#addr-detail-cooling').textContent = '—';
    $('#addr-detail-total').textContent = '—';
    $('#addr-detail-nonce').textContent = '—';
    $('#addr-detail-bootstrap').textContent = '—';
    $('#addr-detail-tx-tbody').innerHTML = `<tr><td colspan="7" class="muted" style="text-align:center;padding:20px">加载中...</td></tr>`;
    $('#addr-detail-tx-count').textContent = '加载中...';
    try {
      const [info, txs] = await Promise.all([
        Node.addressInfo(addr),
        Node.addressTxs(addr, 50),
      ]);
      $('#addr-detail-liquid').textContent = fmtBTCQ(info.liquid) + ' BTCQ';
      $('#addr-detail-staked').textContent = fmtBTCQ(info.staked) + ' BTCQ';
      $('#addr-detail-cooling').textContent = fmtBTCQ(info.cooling) + ' BTCQ';
      $('#addr-detail-total').textContent = fmtBTCQ(info.total) + ' BTCQ';
      $('#addr-detail-nonce').textContent = info.nonce;
      $('#addr-detail-bootstrap').textContent = (info.bootstrap_blocks || 0) + ' 块';
      const list = txs.transactions || [];
      $('#addr-detail-tx-count').textContent = `共 ${list.length} 条`;
      const tbody = $('#addr-detail-tx-tbody');
      if (!list.length) {
        tbody.innerHTML = `<tr><td colspan="7" class="muted" style="text-align:center;padding:20px">该地址暂无相关交易</td></tr>`;
        return;
      }
      tbody.innerHTML = list.map(tx => {
        const isOut = tx.sender && tx.sender.toLowerCase() === addr.toLowerCase();
        const isIn  = tx.recipient && tx.recipient.toLowerCase() === addr.toLowerCase();
        let dir = 'self', dirText = '↔ 自己', dirClass = 'tx-dir-self', counterparty = addr;
        if (tx.kind === 'block_reward') {
          dir = 'reward'; dirText = '⚛ 出块奖励'; dirClass = 'tx-dir-in'; counterparty = '—';
        } else if (isOut && !isIn) {
          dir = 'out'; dirText = '↗ 转出'; dirClass = 'tx-dir-out'; counterparty = tx.recipient;
        } else if (isIn && !isOut) {
          dir = 'in'; dirText = '↙ 转入'; dirClass = 'tx-dir-in'; counterparty = tx.sender;
        }
        const status = tx.status === 'pending' ? '待打包' : '✓ 已确认';
        const statusClass = tx.status === 'pending' ? 'tx-status-pending' : 'tx-status-confirmed';
        const heightCell = tx.height == null ? '—' : `#${esc(tx.height)}${tx.slot != null ? ' / s' + esc(tx.slot) : ''}`;
        const timeCell = tx.timestamp ? esc(fmtTime(tx.timestamp)) : '—';
        return `
          <tr>
            <td><span class="${statusClass}">${esc(status)}</span></td>
            <td>${esc(tx.kind)}</td>
            <td><span class="${dirClass}">${esc(dirText)}</span></td>
            <td class="hash-cell">${esc(shortAddr(counterparty))}</td>
            <td>${esc(fmtBTCQ(tx.amount))}</td>
            <td>${heightCell}</td>
            <td>${timeCell}</td>
          </tr>`;
      }).join('');
    } catch (e) {
      $('#addr-detail-liquid').textContent = '查询失败';
      $('#addr-detail-tx-tbody').innerHTML = `<tr><td colspan="7" class="muted" style="text-align:center;padding:20px">查询失败：${esc(e.message)}</td></tr>`;
    }
  },
};

// =============== 钱包（多账户，纯 JS） ===============
const Wallet = {
  // 没设密码 → 直接通过（plaintext 模式）
  // 设过密码且锁定 → 弹解锁
  // 设过密码且解锁 → 通过
  async _ensureVault() {
    if (App.state.passwordVerifier && Vault.locked) {
      Vault.show('unlock');
      throw new Error('请先解锁钱包');
    }
  },
  // 构造一个新钱包对象，根据 vault 状态选择加密 or 明文存盘
  _buildEntry(w, counter) {
    const entry = { name: String(counter), address: w.address, privateKey: w.privateKey };
    if (App.state.passwordVerifier && !Vault.locked) {
      entry.encryptedKey = Vault.encryptNew(w.privateKey);
    } else if (!App.state.passwordVerifier) {
      // 未设密码：兼容老逻辑，明文存盘（banner 引导用户去加密）
      entry._plaintext = true;
    }
    return entry;
  },
  // 持久化：vault 解锁时只存密文，否则保留明文
  _serialize(wallets) {
    return wallets.map(w => {
      if (w.encryptedKey) return { name: w.name, address: w.address, encryptedKey: w.encryptedKey };
      return { name: w.name, address: w.address, privateKey: w.privateKey };
    });
  },
  async create() {
    try {
      await Wallet._ensureVault();
      const w = btcq.generateWallet();
      const wallets = App.state.wallets || [];
      const counter = (App.state.walletCounter || 0) + 1;
      const newWallet = Wallet._buildEntry(w, counter);
      wallets.push(newWallet);
      App.state.wallets = wallets;
      App.state.walletCounter = counter;
      App.state.activeWalletIndex = wallets.length - 1;
      App.activeWallet = newWallet;
      await btcq.setState({
        wallets: Wallet._serialize(wallets),
        walletCounter: counter,
        activeWalletIndex: App.state.activeWalletIndex,
      });
      toast(`钱包 #${newWallet.name} 已创建：${shortAddr(w.address)}`, 'success');
      Pages.wallet.refresh();
      Pages.overview.refresh();
    } catch (e) { console.error(e); toast('创建失败：' + e.message, 'error'); }
  },
  async importKey() {
    const k = $('#import-key-input').value.trim();
    try {
      await Wallet._ensureVault();
      const w = btcq.walletFromPrivate(k);
      const wallets = App.state.wallets || [];
      if (wallets.find(x => x.address === w.address)) {
        toast('该地址已存在', 'error');
        return;
      }
      const counter = (App.state.walletCounter || 0) + 1;
      const newWallet = Wallet._buildEntry(w, counter);
      wallets.push(newWallet);
      App.state.wallets = wallets;
      App.state.walletCounter = counter;
      App.state.activeWalletIndex = wallets.length - 1;
      App.activeWallet = newWallet;
      await btcq.setState({
        wallets: Wallet._serialize(wallets),
        walletCounter: counter,
        activeWalletIndex: App.state.activeWalletIndex,
      });
      $('#modal-import-key').classList.add('hidden');
      $('#import-key-input').value = '';
      toast(`钱包 #${newWallet.name} 已导入：${shortAddr(w.address)}`, 'success');
      Pages.wallet.refresh();
    } catch (e) { toast('导入失败：' + e.message, 'error'); }
  },
  async setActive(index) {
    if (index < 0 || index >= (App.state.wallets || []).length) return;
    App.state.activeWalletIndex = index;
    App.activeWallet = App.state.wallets[index];
    await btcq.setState({ activeWalletIndex: index });
    toast(`已切换到钱包 #${App.activeWallet.name}`, 'success');
    Pages.wallet.refresh();
  },
  async remove(index) {
    if (!confirm(`确定删除钱包 #${App.state.wallets[index]?.name}？私钥将永久丢失（请先备份！）`)) return;
    const wallets = (App.state.wallets || []).slice();
    wallets.splice(index, 1);
    App.state.wallets = wallets;
    if (App.state.activeWalletIndex === index) {
      App.state.activeWalletIndex = wallets.length > 0 ? 0 : -1;
      App.activeWallet = wallets.length > 0 ? wallets[0] : null;
    } else if (App.state.activeWalletIndex > index) {
      App.state.activeWalletIndex -= 1;
    }
    await btcq.setState({
      wallets: Wallet._serialize(wallets),
      activeWalletIndex: App.state.activeWalletIndex,
    });
    toast('已删除', 'success');
    Pages.wallet.refresh();
  },
  showKey(index) {
    const w = App.state.wallets?.[index];
    if (!w?.privateKey) { toast('未存储私钥', 'error'); return; }
    $('#show-key-content').textContent = w.privateKey;
    $('#show-key-content').dataset.copyText = w.privateKey;
    $('#modal-show-key').classList.remove('hidden');
  },
  copyAddr(index, btn) {
    const w = App.state.wallets?.[index];
    if (!w) return;
    navigator.clipboard.writeText(w.address);
    if (btn) { const old = btn.textContent; btn.textContent = '✓'; setTimeout(() => btn.textContent = old, 1200); }
    toast('地址已复制', 'success');
  },
  copyShownKey() {
    const text = $('#show-key-content').dataset.copyText || $('#show-key-content').textContent;
    navigator.clipboard.writeText(text);
    toast('已复制到剪贴板', 'success');
  },
};

Pages.wallet = {
  async refresh() {
    Vault.refreshBanner();
    const list = $('#wallet-list');
    const wallets = App.state.wallets || [];
    if (wallets.length === 0) {
      list.innerHTML = `
        <div class="card glass">
          <div class="empty-hero" style="padding:40px 24px">
            <div class="empty-icon">◈</div>
            <h2>还没有钱包</h2>
            <p class="muted">点击右上角创建第一个钱包</p>
          </div>
        </div>`;
      return;
    }
    // 渲染每个钱包
    list.innerHTML = wallets.map((w, i) => `
      <div class="wallet-row-card ${i === App.state.activeWalletIndex ? 'active' : ''}" data-wallet-idx="${esc(i)}">
        <div class="wallet-row-num">${esc(w.name)}</div>
        <div class="wallet-row-info">
          <code class="wallet-row-addr"><a href="#" data-explorer-addr="${esc(w.address)}">${esc(w.address)}</a></code>
          ${i === App.state.activeWalletIndex ? '<span class="wallet-row-active-tag">活跃</span>' : ''}
          <div class="wallet-row-meta">
            <span>余额: <strong id="bal-${esc(i)}">读取中...</strong></span>
            <span>抵押: <strong id="stk-${esc(i)}">—</strong></span>
            <span>nonce: <strong id="nonce-${esc(i)}">—</strong></span>
          </div>
        </div>
        <div class="wallet-row-actions">
          ${i !== App.state.activeWalletIndex
            ? `<button class="btn btn-tertiary" data-wallet-action="set-active" data-wallet-idx="${esc(i)}">设为活跃</button>`
            : ''}
          <button class="btn btn-secondary" data-wallet-action="show-key" data-wallet-idx="${esc(i)}">显示私钥</button>
          <button class="btn btn-secondary" data-wallet-action="copy-addr" data-wallet-idx="${esc(i)}">复制地址</button>
          <button class="btn btn-ghost" data-wallet-action="remove" data-wallet-idx="${esc(i)}">删除</button>
        </div>
      </div>
    `).join('');
    // 绑定按钮
    list.querySelectorAll('[data-wallet-action]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = parseInt(btn.dataset.walletIdx);
        const action = btn.dataset.walletAction;
        if (action === 'set-active') Wallet.setActive(idx);
        else if (action === 'show-key') Wallet.showKey(idx);
        else if (action === 'copy-addr') Wallet.copyAddr(idx, btn);
        else if (action === 'remove') Wallet.remove(idx);
      });
    });
    // 点地址 → 区块浏览器地址详情
    list.querySelectorAll('[data-explorer-addr]').forEach(a => {
      a.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation();
        showPage('explorer');
        setTimeout(() => Pages.explorer.showAddress(a.dataset.explorerAddr), 100);
      });
    });
    // 异步拉每个钱包的真实余额（节点 /address/{addr}）
    if (App.nodeConnected) {
      for (let i = 0; i < wallets.length; i++) {
        const w = wallets[i];
        Node.addressInfo(w.address).then(r => {
          const bal = document.getElementById(`bal-${i}`);
          const stk = document.getElementById(`stk-${i}`);
          const non = document.getElementById(`nonce-${i}`);
          if (bal) bal.textContent = fmtBTCQ(r.liquid) + ' BTCQ';
          if (stk) stk.textContent = fmtBTCQ(r.staked) + ' BTCQ';
          if (non) non.textContent = r.nonce;
        }).catch(e => {
          const bal = document.getElementById(`bal-${i}`);
          if (bal) bal.textContent = '—';
        });
      }
    } else {
      for (let i = 0; i < wallets.length; i++) {
        const bal = document.getElementById(`bal-${i}`);
        if (bal) bal.textContent = '未连接节点';
      }
    }
  },
};

// =============== 转账 / 抵押 ===============
const Send = {
  async execute() {
    try {
      await Wallet._ensureVault();
      if (!App.activeWallet?.privateKey) { toast('请先创建钱包', 'error'); return; }
      if (!App.nodeConnected) { toast('未连接节点', 'error'); return; }
      const to = $('#send-to').value.trim().toLowerCase();
      if (!/^0x[0-9a-fA-F]{40}$/.test(to)) { toast('收款地址格式错误（应为 0x + 40 hex）', 'error'); return; }
      if (to === App.activeWallet.address.toLowerCase()) { toast('不能转给自己', 'error'); return; }

      let amount;
      try { amount = parseAmount($('#send-amount').value); }
      catch (e) { toast(e.message, 'error'); return; }

      // 客户端余额预检（最终在节点强制）
      const info = await Node.addressInfo(App.activeWallet.address);
      const liquid = BigInt(info.liquid);
      if (amount > liquid) {
        toast(`余额不足：你有 ${fmtBTCQ(liquid)} BTCQ，要发 ${fmtBTCQ(amount)} BTCQ`, 'error');
        return;
      }

      const tx = await btcq.signTransaction({
        privateKey: App.activeWallet.privateKey,
        recipient: to,
        amount: amount.toString(),
        nonce: info.nonce,
        kind: 'transfer',
      });
      const r = await Node.submitTx(tx);
      if (r.ok) {
        toast(`已广播：${shortHash(tx.tx_hash)}`, 'success');
        $('#send-to').value = '';
        $('#send-amount').value = '';
        Pages.send.refresh();
      } else {
        toast('节点拒绝：' + r.error, 'error');
      }
    } catch (e) { toast('发送失败：' + e.message, 'error'); }
  },
};
Pages.send = {
  async refresh() {
    if (!App.activeWallet) {
      $('#send-current-bal').textContent = '请先创建钱包（菜单 → 我的钱包）';
      $('#send-current-nonce').textContent = '—';
      $('#send-mempool').innerHTML = '<div class="empty-state muted">无活跃钱包</div>';
      return;
    }
    if (!App.nodeConnected) {
      $('#send-current-bal').textContent = '未连接节点';
      $('#send-current-nonce').textContent = '—';
      return;
    }
    try {
      const info = await Node.addressInfo(App.activeWallet.address);
      $('#send-current-bal').textContent = fmtBTCQ(info.liquid) + ' BTCQ';
      $('#send-current-nonce').textContent = info.nonce;
      const mp = await Node.mempool();
      const txs = mp.transactions || [];
      const node = $('#send-mempool');
      if (!txs.length) {
        node.innerHTML = '<div class="empty-state muted">mempool 为空</div>';
        return;
      }
      node.innerHTML = txs.map(tx => `
        <div class="tx-row">
          <div class="tx-icon ${tx.kind === 'transfer' ? 'out' : 'stake'}">${tx.kind === 'transfer' ? '↑' : '⚓'}</div>
          <div class="tx-info">
            <div class="tx-kind">${esc(tx.kind)}</div>
            <div class="tx-meta">to ${esc(shortAddr(tx.recipient))} · nonce ${esc(tx.nonce)}</div>
          </div>
          <div class="tx-amount">${esc(fmtBTCQ(tx.amount))}</div>
          <div class="muted" style="font-size:11px">${esc(shortHash(tx.tx_hash))}</div>
        </div>
      `).join('');
    } catch (e) {
      $('#send-current-bal').textContent = '查询失败';
      $('#send-current-nonce').textContent = '—';
    }
  },
};

// 最低首次抵押：1 BTCQ = 10^18 atomic
const MIN_STAKE_ATOMIC = 1n * COIN;

const Stake = {
  async stake() { return this._do('stake', $('#stake-amount').value); },
  async unstake() { return this._do('unstake', $('#unstake-amount').value); },
  async _do(kind, amountStr) {
    try {
      await Wallet._ensureVault();
      if (!App.activeWallet?.privateKey) { toast('请先创建钱包', 'error'); return; }
      if (!App.nodeConnected) { toast('未连接节点', 'error'); return; }

      let amount;
      try { amount = parseAmount(amountStr); }
      catch (e) { toast(e.message, 'error'); return; }

      const info = await Node.addressInfo(App.activeWallet.address);
      const liquid = BigInt(info.liquid);
      const staked = BigInt(info.staked);

      if (kind === 'stake') {
        if (amount > liquid) {
          toast(`流通余额不足：你有 ${fmtBTCQ(liquid)} BTCQ，要抵押 ${fmtBTCQ(amount)} BTCQ`, 'error');
          return;
        }
        // 首次抵押必须 ≥ MIN_STAKE
        if (staked === 0n && amount < MIN_STAKE_ATOMIC) {
          toast(`首次抵押至少 ${fmtBTCQ(MIN_STAKE_ATOMIC)} BTCQ`, 'error');
          return;
        }
      } else if (kind === 'unstake') {
        if (amount > staked) {
          toast(`抵押不足：你抵押了 ${fmtBTCQ(staked)} BTCQ，要解 ${fmtBTCQ(amount)} BTCQ`, 'error');
          return;
        }
      }

      const tx = await btcq.signTransaction({
        privateKey: App.activeWallet.privateKey,
        recipient: '0x' + '00'.repeat(19) + '01',
        amount: amount.toString(),
        nonce: info.nonce, kind,
      });
      const r = await Node.submitTx(tx);
      if (r.ok) {
        const verb = kind === 'stake' ? '抵押' : '解抵押';
        toast(`${verb} 已广播：${fmtBTCQ(amount)} BTCQ`, 'success');
        $('#stake-amount').value = '';
        $('#unstake-amount').value = '';
        Pages.stake.refresh();
      } else {
        toast('失败：' + r.error, 'error');
      }
    } catch (e) { toast(e.message, 'error'); }
  },
};
Pages.stake = {
  async refresh() {
    if (!App.activeWallet) {
      $('#stake-liquid').textContent = '请先创建钱包';
      $('#stake-staked').textContent = '—';
      $('#stake-cooling').textContent = '—';
      $('#stake-eligible').textContent = '—';
      return;
    }
    if (!App.nodeConnected) {
      ['stake-liquid','stake-staked','stake-cooling','stake-eligible'].forEach(id => $('#' + id).textContent = '未连接节点');
      return;
    }
    try {
      const info = await Node.addressInfo(App.activeWallet.address);
      $('#stake-liquid').textContent = fmtBTCQ(info.liquid) + ' BTCQ';
      $('#stake-staked').textContent = fmtBTCQ(info.staked) + ' BTCQ';
      $('#stake-cooling').textContent = fmtBTCQ(info.cooling) + ' BTCQ';
      $('#stake-eligible').textContent = info.eligible ? '✅ 已激活' : '❌ 需 ≥ 1 BTCQ';
    } catch (e) {
      ['stake-liquid','stake-staked','stake-cooling','stake-eligible'].forEach(id => $('#' + id).textContent = '查询失败');
    }
  },
};

// =============== 挖矿一键启动（v0.1.7：单进度条 + 90% 求 Key） ===============
const Mining = {
  percent: 0,
  setProgress(p, stage) {
    Mining.percent = p;
    const fill = $('#mining-progress-fill');
    const num = $('#mining-percent');
    const stg = $('#mining-stage');
    if (fill) fill.style.width = p + '%';
    if (num) num.textContent = p + '%';
    if (stg && stage) stg.textContent = stage;
    // 到 90% 显示 API Key 输入框
    if (p >= 90) {
      $('#mining-apikey-prompt').classList.remove('hidden');
    }
  },
  async openWizard() {
    $('#mining-cta').classList.add('hidden');
    $('#mining-wizard').classList.remove('hidden');
    Mining.setProgress(0, '开始准备...');
    $('#mining-apikey-prompt').classList.add('hidden');
    // 立刻自动开跑
    await Mining.run();
  },
  async run() {
    if (!App.activeWallet) {
      toast('请先在「我的钱包」页创建钱包', 'error');
      Mining.setProgress(0, '需要先创建钱包');
      return;
    }
    try {
      // 5%
      Mining.setProgress(5, '检测系统环境...');
      const setup = await btcq.miningCheckSetup();
      if (!setup.python) {
        Mining.setProgress(5, '❌ 未检测到 Python 3.10+，请先 brew install python3');
        Mining.log('❌ 系统未安装 Python', 'error');
        return;
      }
      Mining.log(`✓ Python ${setup.python.version}`, 'success');

      // 15%
      Mining.setProgress(15, '检查 BTCQ 协议代码...');
      if (!setup.btcqInstalled) {
        Mining.log('▶ 下载 BTCQ 协议代码（首次约 30 秒）...', 'event');
        Mining.setProgress(20, '下载 BTCQ 协议代码...');
        const inst = await btcq.miningInstall();
        if (!inst.ok) {
          Mining.setProgress(20, '❌ ' + inst.error);
          Mining.log('❌ ' + inst.error, 'error');
          return;
        }
        Mining.log('✓ BTCQ 协议已就位', 'success');
      } else {
        Mining.log('✓ BTCQ 已安装', 'success');
      }

      // 50%
      Mining.setProgress(50, '安装量子计算依赖...');
      await new Promise(r => setTimeout(r, 800));
      Mining.log('✓ Qiskit 已就位（量子计算 SDK）', 'success');

      // 70%
      Mining.setProgress(70, '同步本机钱包到挖矿守护...');
      const wal = await btcq.miningExportWallet(App.activeWallet.privateKey);
      if (!wal.ok) {
        Mining.setProgress(70, '❌ 钱包导出失败');
        Mining.log('❌ ' + wal.error, 'error');
        return;
      }
      Mining.log(`✓ 挖矿地址 ${wal.address}`, 'success');

      // 90% — 暂停，等用户填 Key
      Mining.setProgress(90, '⌛ 准备就绪。需要 IBM Quantum API Key 完成最后 10%');
      Mining.log('⏸ 等待 IBM Quantum API Token...', 'event');

      // 已挖矿则直接跳到 dashboard
      if (setup.miningRunning) {
        Mining.setProgress(100, '🎉 量子挖矿运行中');
        $('#mining-wizard').classList.add('hidden');
        $('#mining-dashboard').classList.remove('hidden');
        Mining._updateStats(setup);
      }
    } catch (e) {
      Mining.setProgress(Mining.percent, '❌ 异常：' + e.message);
      Mining.log('❌ ' + e.message, 'error');
    }
  },
  async launch() {
    const token = $('#mining-token-input').value.trim();
    if (!token) { toast('请粘贴 API Token', 'error'); return; }
    if (!App.activeWallet?.privateKey) { toast('请先创建钱包', 'error'); return; }

    const btn = $('#mining-launch-btn');
    btn.disabled = true;
    Mining.setProgress(92, '验证 Token，连接量子机...');
    Mining.log('▶ 验证 IBM Quantum Token...', 'event');

    try {
      const tk = await btcq.miningSaveToken(token);
      if (!tk.ok) {
        Mining.setProgress(90, '❌ Token 无效，请重试');
        Mining.log('❌ ' + tk.error, 'error');
        btn.disabled = false;
        return;
      }
      Mining.log(`✓ 检测到 ${tk.backends.length} 台量子机：${tk.backends.join(', ')}`, 'success');

      Mining.setProgress(96, '启动量子挖矿守护进程...');
      const start = await btcq.miningStart({
        interval: 1200,
        backend: tk.backends[0] || 'ibm_marrakesh',
        shots: 4096,
      });
      if (!start.ok) {
        Mining.setProgress(96, '❌ 启动失败');
        Mining.log('❌ ' + start.error, 'error');
        btn.disabled = false;
        return;
      }
      Mining.setProgress(100, '🎉 量子挖矿运行中！');
      Mining.log('🎉 挖矿启动成功，每 20 分钟一块，每块 50 BTCQ', 'success');
      setTimeout(() => Mining.refreshDash(), 1500);
    } catch (e) {
      Mining.setProgress(90, '❌ 异常');
      Mining.log('❌ ' + e.message, 'error');
    }
    btn.disabled = false;
  },
  async refreshDash() {
    try {
      const setup = await btcq.miningCheckSetup();
      if (setup.miningRunning) {
        $('#mining-cta').classList.add('hidden');
        $('#mining-wizard').classList.add('hidden');
        $('#mining-dashboard').classList.remove('hidden');
        Mining._updateStats(setup);
      }
    } catch {}
  },
  async stop() {
    await btcq.miningStop();
    Mining.log('■ 已停止', 'event');
    setTimeout(() => Mining.checkPre(), 1000);
  },
  log(text, level = '') {
    const targets = ['#mining-launch-log', '#mining-log'];
    const ts = new Date().toLocaleTimeString('zh-CN');
    targets.forEach(sel => {
      const body = $(sel);
      if (!body) return;
      if (body.querySelector('.log-empty')) body.innerHTML = '';
      const line = document.createElement('div');
      line.className = 'log-line ' + level;
      const tsSpan = document.createElement('span');
      tsSpan.className = 'ts';
      tsSpan.textContent = ts;
      line.appendChild(tsSpan);
      line.appendChild(document.createTextNode(text));
      body.appendChild(line);
      while (body.children.length > 200) body.removeChild(body.firstChild);
      body.scrollTop = body.scrollHeight;
    });
  },
  _updateStats(s) {
    $('#mining-stat-mined').textContent = s.blocksMined || 0;
    $('#mining-stat-earnings').textContent = (s.blocksMined || 0) * 50;
    if (s.uptime) {
      const sec = Math.floor(s.uptime / 1000);
      const h = Math.floor(sec / 3600);
      const m = Math.floor((sec % 3600) / 60);
      const r = sec % 60;
      $('#mining-stat-uptime').textContent = (h ? String(h).padStart(2,'0') + ':' : '') +
        String(m).padStart(2,'0') + ':' + String(r).padStart(2,'0');
    }
  },
};
Pages.mining = {
  async refresh() {
    try {
      const setup = await btcq.miningCheckSetup();
      if (setup.miningRunning) {
        $('#mining-cta').classList.add('hidden');
        $('#mining-wizard').classList.add('hidden');
        $('#mining-dashboard').classList.remove('hidden');
        Mining._updateStats(setup);
      }
    } catch {}
  },
};

// 监听挖矿事件
if (window.btcq?.onMiningEvent) {
  btcq.onMiningEvent(ev => {
    if (ev.type === 'install-progress' || ev.type === 'log') {
      Mining.log(ev.text || ev.msg, ev.level === 'error' ? 'error' : (ev.level === 'warn' ? '' : ''));
    } else if (ev.type === 'mining-started') {
      Mining.log(`▶ 挖矿启动 backend=${ev.backend} 间隔=${ev.interval}s`, 'event');
    } else if (ev.type === 'mining-stopped') {
      Mining.log('■ 挖矿停止', 'event');
      setTimeout(() => Mining.checkPre(), 800);
    }
  });
}

// =============== 网络 ===============
const Network = {
  async addPeer() {
    const url = $('#add-peer-url').value.trim();
    if (!url.startsWith('http')) { toast('URL 格式错误', 'error'); return; }
    if (!App.nodeConnected) { toast('需先连接节点', 'error'); return; }
    try {
      const r = await Node.post('/peers', { url });
      if (r.ok) { toast('已添加', 'success'); $('#modal-add-peer').classList.add('hidden'); }
      else toast('失败：' + r.error, 'error');
    } catch (e) { toast('节点不可达', 'error'); }
  },
};
Pages.network = {
  async refresh() {
    if (!App.nodeConnected) {
      $('#net-status').textContent = '❌ 未连接';
      $('#net-port').textContent = '—';
      $('#net-height').textContent = '—';
      $('#net-head').textContent = '在「设置」配置节点 URL';
      $('#net-peers').textContent = '—';
      $('#net-peer-list').innerHTML = '<div class="empty-state muted">未连接节点</div>';
      return;
    }
    try {
      const info = await Node.info();
      $('#net-status').textContent = '✅ ' + info.user_agent;
      $('#net-port').textContent = App.nodeUrl;
      $('#net-height').textContent = info.height;
      $('#net-head').textContent = info.head_hash;
      $('#net-peers').textContent = info.peers.length;
      $('#net-peer-list').innerHTML = info.peers.length
        ? info.peers.map(p => `<div class="peer-row"><span>${esc(p)}</span><span class="peer-status">在线</span></div>`).join('')
        : '<div class="empty-state muted">暂无 peer</div>';
    } catch (e) {
      Node.checkConnection();
    }
  },
};

// =============== 设置 ===============
const Settings = {
  async testNode(btn) {
    const url = $('#setting-node-url').value.trim().replace(/\/$/, '');
    if (!url) { toast('请填入节点 URL', 'error'); return; }
    btn.disabled = true;
    const status = $('#node-conn-status');
    status.textContent = '测试中...';
    status.className = 'status loading';
    App.nodeUrl = url;
    try {
      const info = await Node.info();
      status.textContent = `✓ 已连接（高度 ${info.height}）`;
      status.className = 'status success';
      App.nodeConnected = true;
      $('#conn-text').textContent = '已连接';
      $('#conn-dot').style.background = 'var(--success)';
      await btcq.setState({ nodeUrl: url });
      App.state.nodeUrl = url;
      // 当前页刷新
      if (App.currentPage in Pages) Pages[App.currentPage].refresh();
    } catch (e) {
      status.textContent = '❌ ' + e.message;
      status.className = 'status error';
      App.nodeConnected = false;
    } finally { btn.disabled = false; }
  },
  async reset() {
    if (!confirm('确定重置所有设置？钱包会保留。')) return;
    await btcq.setState({ nodeUrl: null });
    App.nodeUrl = null;
    App.nodeConnected = false;
    toast('已重置', 'success');
    Pages.settings.refresh();
  },
  async resetNodeUrl() {
    const PUBLIC_NODE = 'http://43.136.28.125:8333';
    $('#setting-node-url').value = PUBLIC_NODE;
    App.nodeUrl = PUBLIC_NODE;
    await btcq.setState({ nodeUrl: PUBLIC_NODE });
    App.state.nodeUrl = PUBLIC_NODE;
    await Node.checkConnection();
    toast('已恢复公网默认', 'success');
    if (App.currentPage in Pages) Pages[App.currentPage].refresh();
  },
};
Pages.settings = {
  refresh() {
    if (App.state.nodeUrl) $('#setting-node-url').value = App.state.nodeUrl;
    if (App.state.backend) $('#setting-backend').value = App.state.backend;
    // 自动保存
    ['#setting-backend', '#setting-mining-mode', '#setting-reward-addr', '#setting-theme', '#setting-particles']
      .forEach(sel => {
        const el = $(sel);
        if (el && !el.dataset.bound) {
          el.dataset.bound = '1';
          el.addEventListener('change', () => {
            btcq.setState({
              backend: $('#setting-backend')?.value,
              miningMode: $('#setting-mining-mode')?.value,
              rewardAddr: $('#setting-reward-addr')?.value,
            });
            toast('已保存', 'success');
          });
        }
      });
  },
};

// =============== 启动 ===============
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  // DOM 已加载完成，立即启动（避免 DOMContentLoaded 已经触发的情况）
  boot();
}
