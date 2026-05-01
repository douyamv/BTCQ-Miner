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

const fmtBTCQ = (atomic) => (Number(atomic) / 1e8).toLocaleString(undefined, { maximumFractionDigits: 8 });
const shortAddr = (a) => a ? a.slice(0, 10) + '...' + a.slice(-6) : '0x...';
const shortHash = (h) => h ? h.slice(0, 10) + '...' + h.slice(-6) : '—';
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

async function loadInitialState() {
  if (!window.btcq) {
    console.error('window.btcq missing — preload 未加载');
    toast('IPC 桥未加载，请重启', 'error');
    return;
  }
  App.state = await btcq.getState() || {};
  console.log('[state] loaded', Object.keys(App.state));
  if (App.state.walletAddress && App.state.walletPrivateKey) {
    App.activeWallet = {
      address: App.state.walletAddress,
      privateKey: App.state.walletPrivateKey,
    };
    console.log('[state] wallet', App.activeWallet.address);
  }
  // 默认连本地节点（如未配置）
  App.nodeUrl = App.state.nodeUrl || 'http://localhost:8333';
  if (!App.state.nodeUrl) {
    await btcq.setState({ nodeUrl: App.nodeUrl });
  }
  await Node.checkConnection();
  // 重刷当前页
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

    // 挖矿（v0.1.5：仅文档跳转）
    case 'mining-test-token':  return toast('挖矿启动需在终端运行 BTCQ Python 协议（见挖矿页文档链接）', '');
    case 'mining-toggle':      return toast('GUI 内启动挖矿在 v0.2 推出。当前请用终端：python scripts/propose.py', '');
    case 'mining-open-docs':   return btcq.openExternal('https://github.com/douyamv/BTCQ/blob/main/docs/DEPLOY.md');

    // 浏览器
    case 'explorer-search':    return Pages.explorer.search();
    case 'explorer-prev':      return Pages.explorer.prevPage();
    case 'explorer-next':      return Pages.explorer.nextPage();
    case 'explorer-back':      return Pages.explorer.showList();

    // 网络
    case 'net-add-peer':       return $('#modal-add-peer').classList.remove('hidden');
    case 'confirm-add-peer':   return Network.addPeer();
    case 'test-node-connection': return Settings.testNode(btn);

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
            <div class="block-mini-row" data-block-h="${b.height}">
              <span class="height">#${b.height}</span>
              <span>slot ${b.slot}</span>
              <span class="ts">${fmtTime(b.timestamp)}</span>
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
        <div class="tribute-name">${t.name}</div>
        <div class="muted" style="font-size:11px">${t.role}</div>
        <div class="tribute-amount">${t.amount} BTCQ</div>
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
        <tr data-block-h="${b.height}">
          <td class="height-cell">#${b.height}</td>
          <td>${b.slot}</td>
          <td>${fmtTime(b.timestamp)}</td>
          <td class="hash-cell">${shortHash(b.block_hash)}</td>
          <td class="hash-cell">${shortAddr(b.proposer_address)}</td>
          <td>${(b.transactions || []).length}</td>
          <td>${parseFloat(b.xeb_score).toFixed(2)}</td>
        </tr>
      `).join('');
      $('#explorer-blocks-tbody').querySelectorAll('tr[data-block-h]').forEach(tr => {
        tr.addEventListener('click', () => this.showBlock(parseInt(tr.dataset.blockH)));
      });
      $('#explorer-page-info').textContent = `${start}–${end} / 共 ${this.total}`;
    } catch (e) {
      $('#explorer-blocks-tbody').innerHTML =
        `<tr><td colspan="7" class="muted" style="text-align:center;padding:32px">节点拉取失败：${e.message}</td></tr>`;
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
          <td>${tx.kind}</td>
          <td class="hash-cell">${shortAddr(tx.sender)}</td>
          <td class="hash-cell">${shortAddr(tx.recipient)}</td>
          <td>${fmtBTCQ(tx.amount)}</td>
          <td>${tx.nonce}</td>
          <td class="hash-cell">${shortHash(tx.tx_hash)}</td>
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
    if (/^\d+$/.test(q)) this.showBlock(parseInt(q));
    else toast('暂仅支持按区块高度查找', '');
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
          <div><strong>#${i}</strong> · ${tx.kind} · ${fmtBTCQ(tx.amount)} BTCQ</div>
          <div class="muted" style="font-family:var(--font-mono);font-size:11px;margin-top:4px">
            from: ${tx.sender}<br>to: ${tx.recipient}<br>nonce: ${tx.nonce}
          </div>
        </div>
      `).join('') || '<div class="muted" style="margin-top:8px">无交易</div>';
      $('#block-detail-content').innerHTML = `
        <h2 style="margin-bottom:16px">区块 #${block.height}</h2>
        <dl>
          <dt>高度</dt><dd>${block.height}</dd>
          <dt>Slot</dt><dd>${block.slot}</dd>
          <dt>时间戳</dt><dd>${new Date(block.timestamp * 1000).toLocaleString('zh-CN')}</dd>
          <dt>区块哈希</dt><dd>${block.block_hash}</dd>
          <dt>前一区块哈希</dt><dd>${block.prev_hash}</dd>
          <dt>State Root</dt><dd>${block.state_root || '—'}</dd>
          <dt>出块人</dt><dd>${block.proposer_address}</dd>
          <dt>XEB</dt><dd>${parseFloat(block.xeb_score).toFixed(4)}</dd>
          <dt>奖励</dt><dd>${fmtBTCQ(block.reward || 0)} BTCQ</dd>
          <dt>电路</dt><dd>n=${block.n_qubits}, depth=${block.depth}, samples=${block.n_samples}</dd>
          <dt>交易（${(block.transactions || []).length} 笔）</dt><dd>${txList}</dd>
        </dl>
      `;
    } catch (e) { toast('区块加载失败: ' + e.message, 'error'); }
  },
  showList() {
    $('#explorer-blocks-view').classList.remove('hidden');
    $('#explorer-block-detail').classList.add('hidden');
    $('#explorer-mempool-view').classList.add('hidden');
    this.refreshBlocks();
  },
};

// =============== 钱包（纯 JS） ===============
const Wallet = {
  async create() {
    try {
      const w = btcq.generateWallet();
      App.activeWallet = { address: w.address, privateKey: w.privateKey };
      await btcq.setState({ walletAddress: w.address, walletPrivateKey: w.privateKey });
      toast('钱包已创建：' + shortAddr(w.address), 'success');
      Pages.wallet.refresh();
      Pages.overview.refresh();
    } catch (e) { console.error(e); toast('创建失败：' + e.message, 'error'); }
  },
  async importKey() {
    const k = $('#import-key-input').value.trim();
    try {
      const w = btcq.walletFromPrivate(k);
      App.activeWallet = { address: w.address, privateKey: w.privateKey };
      await btcq.setState({ walletAddress: w.address, walletPrivateKey: w.privateKey });
      $('#modal-import-key').classList.add('hidden');
      $('#import-key-input').value = '';
      toast('钱包已导入：' + shortAddr(w.address), 'success');
      Pages.wallet.refresh();
    } catch (e) { toast('导入失败：' + e.message, 'error'); }
  },
  showKey() {
    if (!App.activeWallet?.privateKey) { toast('未保存私钥', 'error'); return; }
    $('#show-key-content').textContent = App.activeWallet.privateKey;
    $('#modal-show-key').classList.remove('hidden');
  },
  copyAddr(btn) {
    if (!App.activeWallet) return;
    navigator.clipboard.writeText(App.activeWallet.address);
    if (btn) { btn.textContent = '✓'; setTimeout(() => btn.textContent = '📋', 1200); }
  },
  copyShownKey() {
    if (!App.activeWallet?.privateKey) return;
    navigator.clipboard.writeText(App.activeWallet.privateKey);
    toast('已复制', 'success');
  },
};

Pages.wallet = {
  refresh() {
    if (!App.activeWallet) {
      $('#wallet-empty').classList.remove('hidden');
      $('#wallet-active').classList.add('hidden');
      return;
    }
    $('#wallet-empty').classList.add('hidden');
    $('#wallet-active').classList.remove('hidden');
    $('#wallet-active-addr').textContent = App.activeWallet.address;
    $('#wallet-bal-liquid').textContent = '— BTCQ';
    $('#wallet-bal-staked').textContent = '— BTCQ';
    $('#wallet-bal-cooling').textContent = '— BTCQ';
    $('#wallet-bal-total').textContent = '— BTCQ';
    $('#wallet-tx-history').innerHTML =
      App.nodeConnected
        ? `<div class="empty-state muted">余额查询需节点端点 /address/{addr} （v0.5 上）。<br>当前可在「区块浏览器」搜索您的地址相关区块。</div>`
        : `<div class="empty-state muted">未连接节点。在「设置」配置节点 URL 后查看完整历史。</div>`;
  },
};

// =============== 转账 / 抵押 ===============
const Send = {
  async execute() {
    if (!App.activeWallet?.privateKey) { toast('请先创建钱包', 'error'); return; }
    if (!App.nodeConnected) { toast('未连接节点', 'error'); return; }
    const to = $('#send-to').value.trim();
    const amount = parseFloat($('#send-amount').value);
    if (!/^0x[0-9a-fA-F]{40}$/.test(to)) { toast('地址格式错误', 'error'); return; }
    if (!amount || amount <= 0) { toast('金额无效', 'error'); return; }
    try {
      // nonce 需要从节点查询；v0.5 加 /address/{addr}/nonce 端点
      const nonce = parseInt(prompt('当前 nonce（v0.5 自动获取）：', '0') || '0');
      const tx = await btcq.signTransaction({
        privateKey: App.activeWallet.privateKey,
        recipient: to,
        amount: BigInt(Math.floor(amount * 1e8)).toString(),
        nonce, kind: 'transfer',
      });
      const r = await Node.submitTx(tx);
      if (r.ok) toast(`已广播：${shortHash(tx.tx_hash)}`, 'success');
      else toast('节点拒绝：' + r.error, 'error');
    } catch (e) { toast('发送失败：' + e.message, 'error'); }
  },
};
Pages.send = {
  refresh() {
    $('#send-current-bal').textContent = App.activeWallet ? '需节点 /address 端点 (v0.5)' : '请先创建钱包';
    $('#send-current-nonce').textContent = '—';
    $('#send-mempool').innerHTML = '<div class="empty-state muted">查看待打包交易请前往「区块浏览器 → 待打包」</div>';
  },
};

const Stake = {
  async stake() { return this._do('stake', $('#stake-amount').value); },
  async unstake() { return this._do('unstake', $('#unstake-amount').value); },
  async _do(kind, amountStr) {
    if (!App.activeWallet?.privateKey) { toast('请先创建钱包', 'error'); return; }
    if (!App.nodeConnected) { toast('未连接节点', 'error'); return; }
    const amount = parseFloat(amountStr);
    if (!amount || amount <= 0) { toast('金额无效', 'error'); return; }
    try {
      const nonce = parseInt(prompt('当前 nonce：', '0') || '0');
      const tx = await btcq.signTransaction({
        privateKey: App.activeWallet.privateKey,
        recipient: '0x' + '00'.repeat(19) + '01',    // STAKE_VAULT
        amount: BigInt(Math.floor(amount * 1e8)).toString(),
        nonce, kind,
      });
      const r = await Node.submitTx(tx);
      if (r.ok) toast(`${kind} 已广播：${amount} BTCQ`, 'success');
      else toast('失败：' + r.error, 'error');
    } catch (e) { toast(e.message, 'error'); }
  },
};
Pages.stake = {
  refresh() {
    $('#stake-liquid').textContent = '—';
    $('#stake-staked').textContent = '—';
    $('#stake-cooling').textContent = '—';
    $('#stake-eligible').textContent = App.activeWallet ? '需节点端点 (v0.5)' : '请先创建钱包';
  },
};

// =============== 挖矿（v0.1.5 仅文档跳转） ===============
Pages.mining = {
  refresh() {
    $('#mining-setup').classList.remove('hidden');
    $('#mining-dashboard').classList.add('hidden');
    // 重写 setup 内容：v0.1.5 不在 GUI 内启动挖矿
    $('#mining-setup').innerHTML = `
      <div class="setup-hero">
        <div class="setup-icon">⚛</div>
        <h2>量子挖矿（GUI 启动 v0.2）</h2>
        <p class="muted">v0.1.5 GUI 不在本机启动量子挖矿，避免依赖本地 Python。</p>
      </div>
      <div class="setup-steps">
        <div class="setup-step">
          <span class="step-no">1</span>
          <div>
            <h4>注册 IBM Quantum 免费账号</h4>
            <p class="muted">每月 600 秒配额，足够挖几百块</p>
            <button class="btn btn-secondary" data-action="open-ibm">打开 quantum.ibm.com ↗</button>
          </div>
        </div>
        <div class="setup-step">
          <span class="step-no">2</span>
          <div>
            <h4>本地运行 BTCQ 协议代码</h4>
            <p class="muted">在终端：</p>
            <pre style="background:rgba(0,0,0,0.4);padding:12px;border-radius:8px;font-size:12px;color:#22d3ee;overflow:auto">
git clone https://github.com/douyamv/BTCQ
cd BTCQ
pip install -r requirements.txt
python scripts/init_chain.py
python scripts/new_wallet.py
python scripts/propose.py --quantum --backend ibm_marrakesh
            </pre>
            <button class="btn btn-secondary" data-action="mining-open-docs">查看完整部署文档 ↗</button>
          </div>
        </div>
        <div class="setup-step">
          <span class="step-no">3</span>
          <div>
            <h4>用本 GUI 监控你的链</h4>
            <p class="muted">同时运行 P2P 节点：<code>python scripts/node.py --port 8333</code></p>
            <p class="muted">然后在「设置 → 节点 URL」填入 <code>http://localhost:8333</code></p>
          </div>
        </div>
      </div>
    `;
    $('#mining-status-badge').textContent = '需在终端启动';
  },
};

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
        ? info.peers.map(p => `<div class="peer-row"><span>${p}</span><span class="peer-status">在线</span></div>`).join('')
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
