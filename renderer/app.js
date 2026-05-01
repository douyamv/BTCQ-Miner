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
  async addressInfo(addr) { return this.fetch(`/address/${addr}`); },
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

// =============== 钱包（多账户，纯 JS） ===============
const Wallet = {
  async create() {
    try {
      const w = btcq.generateWallet();
      const wallets = App.state.wallets || [];
      // 单调计数器：从 1 开始，永不重用，删除后下一个继续 +1
      const counter = (App.state.walletCounter || 0) + 1;
      const newWallet = {
        name: String(counter),
        address: w.address,
        privateKey: w.privateKey,
      };
      wallets.push(newWallet);
      App.state.wallets = wallets;
      App.state.walletCounter = counter;
      App.state.activeWalletIndex = wallets.length - 1;
      App.activeWallet = newWallet;
      await btcq.setState({
        wallets,
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
      const w = btcq.walletFromPrivate(k);
      const wallets = App.state.wallets || [];
      if (wallets.find(x => x.address === w.address)) {
        toast('该地址已存在', 'error');
        return;
      }
      const counter = (App.state.walletCounter || 0) + 1;
      const newWallet = {
        name: String(counter),
        address: w.address,
        privateKey: w.privateKey,
      };
      wallets.push(newWallet);
      App.state.wallets = wallets;
      App.state.walletCounter = counter;
      App.state.activeWalletIndex = wallets.length - 1;
      App.activeWallet = newWallet;
      await btcq.setState({
        wallets,
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
      wallets,
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
      <div class="wallet-row-card ${i === App.state.activeWalletIndex ? 'active' : ''}" data-wallet-idx="${i}">
        <div class="wallet-row-num">${w.name}</div>
        <div class="wallet-row-info">
          <code class="wallet-row-addr">${w.address}</code>
          ${i === App.state.activeWalletIndex ? '<span class="wallet-row-active-tag">活跃</span>' : ''}
          <div class="wallet-row-meta">
            <span>余额: <strong id="bal-${i}">读取中...</strong></span>
            <span>抵押: <strong id="stk-${i}">—</strong></span>
            <span>nonce: <strong id="nonce-${i}">—</strong></span>
          </div>
        </div>
        <div class="wallet-row-actions">
          ${i !== App.state.activeWalletIndex
            ? `<button class="btn btn-tertiary" data-wallet-action="set-active" data-wallet-idx="${i}">设为活跃</button>`
            : ''}
          <button class="btn btn-secondary" data-wallet-action="show-key" data-wallet-idx="${i}">显示私钥</button>
          <button class="btn btn-secondary" data-wallet-action="copy-addr" data-wallet-idx="${i}">复制地址</button>
          <button class="btn btn-ghost" data-wallet-action="remove" data-wallet-idx="${i}">删除</button>
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
    if (!App.activeWallet?.privateKey) { toast('请先创建钱包', 'error'); return; }
    if (!App.nodeConnected) { toast('未连接节点', 'error'); return; }
    const to = $('#send-to').value.trim();
    const amount = parseFloat($('#send-amount').value);
    if (!/^0x[0-9a-fA-F]{40}$/.test(to)) { toast('地址格式错误', 'error'); return; }
    if (!amount || amount <= 0) { toast('金额无效', 'error'); return; }
    try {
      // 从节点取实时 nonce
      const info = await Node.addressInfo(App.activeWallet.address);
      const tx = await btcq.signTransaction({
        privateKey: App.activeWallet.privateKey,
        recipient: to,
        amount: BigInt(Math.floor(amount * 1e8)).toString(),
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
            <div class="tx-kind">${tx.kind}</div>
            <div class="tx-meta">to ${shortAddr(tx.recipient)} · nonce ${tx.nonce}</div>
          </div>
          <div class="tx-amount">${fmtBTCQ(tx.amount)}</div>
          <div class="muted" style="font-size:11px">${shortHash(tx.tx_hash)}</div>
        </div>
      `).join('');
    } catch (e) {
      $('#send-current-bal').textContent = '查询失败';
      $('#send-current-nonce').textContent = '—';
    }
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
      const info = await Node.addressInfo(App.activeWallet.address);
      const tx = await btcq.signTransaction({
        privateKey: App.activeWallet.privateKey,
        recipient: '0x' + '00'.repeat(19) + '01',
        amount: BigInt(Math.floor(amount * 1e8)).toString(),
        nonce: info.nonce, kind,
      });
      const r = await Node.submitTx(tx);
      if (r.ok) {
        toast(`${kind} 已广播：${amount} BTCQ`, 'success');
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

// =============== 挖矿一键启动（v0.1.6） ===============
const Mining = {
  currentStep: 1,
  goStep(n) {
    Mining.currentStep = n;
    for (let i = 1; i <= 3; i++) {
      const el = document.getElementById(`mining-step-${i}`);
      if (el) el.classList.toggle('hidden', i !== n);
      const tab = document.querySelector(`.mstep[data-mstep="${i}"]`);
      if (tab) {
        tab.classList.toggle('active', i === n);
        tab.classList.toggle('done', i < n);
      }
    }
  },
  next() { Mining.goStep(Math.min(Mining.currentStep + 1, 3)); },
  openWizard() {
    $('#mining-cta').classList.add('hidden');
    $('#mining-wizard').classList.remove('hidden');
    Mining.goStep(1);
    Mining.checkPre();
  },
  async checkPre() {
    if (!btcq.miningCheckSetup) return;
    try {
      const setup = await btcq.miningCheckSetup();
      const set = (id, ok, label) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.classList.toggle('ok', ok);
        el.classList.toggle('bad', !ok);
        el.querySelector('.precheck-status').textContent = label;
      };
      set('pre-python', !!setup.python, setup.python?.version || '未检测到');
      set('pre-git',    !!setup.git,    setup.git ? '✓ 已安装' : '未安装');
      set('pre-btcq',   !!setup.btcqInstalled, setup.btcqInstalled ? '✓ 已下载' : '点击"自动安装"');
      set('pre-wallet', !!App.activeWallet, App.activeWallet ? '✓ ' + shortAddr(App.activeWallet.address) : '请先创建钱包');
      // 已就绪：自动隐藏"自动安装"按钮，强调"下一步"
      const ready = !!setup.python && !!setup.git && !!setup.btcqInstalled && !!App.activeWallet;
      $('#mining-prepare-btn').style.display = setup.btcqInstalled ? 'none' : '';
      $('#mining-step1-next').style.display = ready ? '' : 'none';
      // 已挖矿则切到 dashboard
      if (setup.miningRunning) {
        $('#mining-cta').classList.add('hidden');
        $('#mining-wizard').classList.add('hidden');
        $('#mining-dashboard').classList.remove('hidden');
        Mining._updateStats(setup);
      }
    } catch (e) { console.warn('checkPre fail', e); }
  },
  async prepare() {
    if (!App.activeWallet) {
      toast('请先在「我的钱包」页创建钱包', 'error');
      return;
    }
    const btn = $('#mining-prepare-btn');
    btn.disabled = true;
    Mining.log('▶ 自动下载 BTCQ 协议代码...', 'event');
    try {
      const inst = await btcq.miningInstall();
      if (!inst.ok) {
        Mining.log('❌ ' + inst.error, 'error');
        btn.disabled = false;
        return;
      }
      Mining.log('✅ BTCQ 协议代码就绪', 'success');
      Mining.checkPre();
    } catch (e) {
      Mining.log('❌ ' + e.message, 'error');
    }
    btn.disabled = false;
  },
  async launch() {
    const token = $('#mining-token-input').value.trim();
    if (!token) { toast('请粘贴 API Token', 'error'); return; }
    if (!App.activeWallet?.privateKey) { toast('请先创建钱包', 'error'); return; }

    const btn = $('#mining-launch-btn');
    btn.disabled = true;
    Mining.log('▶ 验证 IBM Quantum Token...', 'event');

    try {
      // 1. 验证 Token
      const tk = await btcq.miningSaveToken(token);
      if (!tk.ok) { Mining.log('❌ Token 错误：' + tk.error, 'error'); btn.disabled = false; return; }
      Mining.log(`✓ 检测到 ${tk.backends.length} 台量子机：${tk.backends.join(', ')}`, 'success');

      // 2. 导出钱包
      Mining.log('▶ 同步钱包到挖矿守护...', 'event');
      const wal = await btcq.miningExportWallet(App.activeWallet.privateKey);
      if (!wal.ok) { Mining.log('❌ ' + wal.error, 'error'); btn.disabled = false; return; }
      Mining.log(`✓ 挖矿地址：${wal.address}`, 'success');

      // 3. 启动
      Mining.log('▶ 启动量子挖矿守护进程...', 'event');
      const start = await btcq.miningStart({
        interval: 1200,
        backend: tk.backends[0] || 'ibm_marrakesh',
        shots: 4096,
      });
      if (!start.ok) { Mining.log('❌ ' + start.error, 'error'); btn.disabled = false; return; }
      Mining.log('🎉 量子挖矿已启动！', 'success');
      setTimeout(() => Mining.checkPre(), 1500);
    } catch (e) {
      Mining.log('❌ 异常：' + e.message, 'error');
    }
    btn.disabled = false;
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
      line.innerHTML = `<span class="ts">${ts}</span>${text}`;
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
    // 默认显示 CTA "开始挖矿"
    if (!$('#mining-wizard').classList.contains('hidden') === false &&
        !$('#mining-cta').classList.contains('hidden') === false) {
      $('#mining-cta').classList.remove('hidden');
      $('#mining-wizard').classList.add('hidden');
    }
    // 如果已经在挖矿了，自动展示状态
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
