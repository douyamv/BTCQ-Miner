// BTCQ Miner v0.1.4 — 多页面前端
const { btcq } = window;

// =============== 全局状态 ===============
const App = {
  state: {},
  activeWallet: null,        // {address, privateKey?}
  currentPage: 'overview',
  explorer: { page: 0, perPage: 20, mode: 'blocks' },
  mining: { running: false, sessionStart: null, blocksMined: 0, earnings: 0 },
  qubitAnimHandle: null,
  pollHandle: null,
};

// =============== 工具 ===============
const $ = sel => document.querySelector(sel);
const $$ = sel => [...document.querySelectorAll(sel)];

function fmtBTCQ(atomic) {
  return (Number(atomic) / 1e8).toLocaleString(undefined, {
    maximumFractionDigits: 8,
  });
}
function shortAddr(a) {
  if (!a) return '0x...';
  return a.slice(0, 10) + '...' + a.slice(-6);
}
function shortHash(h) {
  if (!h) return '—';
  return h.slice(0, 10) + '...' + h.slice(-6);
}
function fmtTime(ts) {
  const d = new Date(ts * 1000);
  const now = Date.now() / 1000;
  const diff = now - ts;
  if (diff < 60) return Math.floor(diff) + ' 秒前';
  if (diff < 3600) return Math.floor(diff / 60) + ' 分钟前';
  if (diff < 86400) return Math.floor(diff / 3600) + ' 小时前';
  return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}
function fmtUptime(s) {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return (h ? String(h).padStart(2,'0') + ':' : '') +
         String(m).padStart(2,'0') + ':' + String(sec).padStart(2,'0');
}

function toast(msg, level = '') {
  const t = $('#toast');
  t.className = 'toast ' + level;
  t.textContent = msg;
  t.classList.remove('hidden');
  setTimeout(() => t.classList.add('hidden'), 3000);
}

// =============== 路由 ===============
function showPage(name) {
  App.currentPage = name;
  $$('.page').forEach(p => p.classList.add('hidden'));
  $$('.nav-item').forEach(n => n.classList.toggle('active', n.dataset.page === name));
  const target = document.querySelector(`.page[data-page="${name}"]`);
  if (target) target.classList.remove('hidden');
  // 进入页面时刷新数据
  switch (name) {
    case 'overview':  Pages.overview.refresh(); break;
    case 'explorer':  Pages.explorer.refresh(); break;
    case 'wallet':    Pages.wallet.refresh(); break;
    case 'send':      Pages.send.refresh(); break;
    case 'stake':     Pages.stake.refresh(); break;
    case 'mining':    Pages.mining.refresh(); break;
    case 'network':   Pages.network.refresh(); break;
    case 'settings':  Pages.settings.refresh(); break;
  }
}

// =============== 启动 ===============
function boot() {
  // 关键：先绑事件，确保 UI 永远可点（即便后续异步加载失败）
  document.addEventListener('click', e => {
    try {
      const navItem = e.target.closest('.nav-item');
      if (navItem) { showPage(navItem.dataset.page); return; }

      const tab = e.target.closest('.tab[data-explorer-tab]');
      if (tab) { Pages.explorer.switchTab(tab.dataset.explorerTab); return; }

      const link = e.target.closest('[data-link]');
      if (link) { e.preventDefault(); btcq.openExternal(link.dataset.link); return; }

      const action = e.target.closest('[data-action]');
      if (action) { e.preventDefault(); handleAction(action.dataset.action, action); return; }
    } catch (err) {
      console.error('[boot] click handler error:', err);
      toast('操作出错: ' + err.message, 'error');
    }
  });

  // 挖矿事件订阅
  try {
    if (btcq?.onMiningEvent) btcq.onMiningEvent(handleMiningEvent);
  } catch (e) { console.warn(e); }

  // 异步加载状态（失败不阻塞 UI）
  loadInitialState().catch(err => {
    console.error('[boot] initial state load failed:', err);
    toast('初始化失败: ' + err.message, 'error');
  });

  // 默认进入概览
  showPage('overview');

  // 主循环：每 5 秒刷新当前页（失败不抛）
  App.pollHandle = setInterval(() => {
    try {
      if (App.currentPage in Pages) Pages[App.currentPage].refresh();
    } catch (e) { console.warn('refresh err', e); }
  }, 5000);
}

async function loadInitialState() {
  if (!window.btcq) {
    console.error('window.btcq 不存在 — preload 桥未加载');
    toast('IPC 桥未加载，请重启应用', 'error');
    return;
  }
  App.state = await btcq.getState() || {};
  if (App.state.walletAddress) {
    App.activeWallet = {
      address: App.state.walletAddress,
      privateKey: App.state.walletPrivateKey
    };
  }
  // 状态加载完后立即刷新当前页
  if (App.currentPage in Pages) Pages[App.currentPage].refresh();
}

// =============== Action 处理 ===============
async function handleAction(action, btn) {
  switch (action) {
    case 'open-ibm':           return btcq.openExternal('https://quantum.ibm.com');
    case 'open-token':         return btcq.openExternal('https://quantum.ibm.com/account');
    case 'modal-close':        return $$('.modal-backdrop').forEach(m => m.classList.add('hidden'));

    // 概览
    case 'overview-create-wallet':
    case 'wallet-create':      return Wallet.create();

    case 'wallet-import':      return $('#modal-import-key').classList.remove('hidden');
    case 'confirm-import':     return Wallet.importKey();
    case 'wallet-show-key':    return Wallet.showKey();
    case 'wallet-switch':      return toast('多钱包切换在 v0.5 加', '');
    case 'copy-active-addr':   return Wallet.copyAddress(btn);
    case 'copy-shown-key':     return Wallet.copyShownKey();

    // 转账
    case 'do-send':            return Send.execute();

    // 抵押
    case 'do-stake':           return Stake.stake();
    case 'do-unstake':         return Stake.unstake();

    // 挖矿
    case 'mining-test-token':  return Mining.testToken(btn);
    case 'mining-toggle':      return Mining.toggle();

    // 浏览器
    case 'explorer-search':    return Pages.explorer.search();
    case 'explorer-prev':      return Pages.explorer.prevPage();
    case 'explorer-next':      return Pages.explorer.nextPage();
    case 'explorer-back':      return Pages.explorer.showList();

    // 网络
    case 'net-start':          return toast('节点启动需要在终端运行 `python scripts/node.py`（v0.5 集成内置）', '');
    case 'net-stop':           return toast('待 v0.5 内置节点', '');
    case 'net-add-peer':       return $('#modal-add-peer').classList.remove('hidden');
    case 'confirm-add-peer':   return Network.addPeer();

    // 设置
    case 'pick-btcq-path':
      const dir = await btcq.selectFolder();
      if (dir) $('#setting-btcq-path').value = dir;
      return Settings.save();
    case 'open-data-dir':      return toast('数据目录：~/Library/Application Support/btcq-miner', '');
    case 'export-state':       return toast('设置已自动持久化，无需手动导出', '');
    case 'reset-state':        return Settings.reset();
  }
}

// =============== Pages ===============
const Pages = {};

// ---------- 概览 ----------
Pages.overview = {
  async refresh() {
    try {
      const stats = await btcq.chainStats();
      if (!stats || !stats.initialized) {
        $('#hero-height').textContent = '0';
        $('#hero-supply').textContent = '0';
        $('#hero-reward').textContent = '50';
        $('#hero-stage').textContent = '链未初始化';
        return;
      }
      $('#hero-height').textContent = stats.height;
      $('#hero-supply').textContent = fmtBTCQ(stats.totalSupply);
      $('#hero-reward').textContent = (stats.nextReward / stats.coin).toFixed(0);
      $('#hero-stage').textContent = stats.bootstrapBlocksLeft > 0
        ? `Bootstrap (剩 ${stats.bootstrapBlocksLeft} 块)`
        : `稳态 ${Math.round(stats.targetBlockTime)}s/slot`;

      // 挖矿状态
      $('#hero-mining').textContent = App.mining.running ? '挖矿中' : '未启动';
      $('#hero-mining-meta').textContent = App.mining.running
        ? `${App.mining.blocksMined} 块 / +${App.mining.earnings} BTCQ`
        : '点击挖矿菜单开始';
      $('#mining-status-badge').textContent = App.mining.running ? '运行' : '未启动';

      // 钱包：有则显示卡片，无则显示 CTA 大块
      const walletCard = $('#overview-wallet-card');
      const noWalletCta = $('#overview-no-wallet-cta');
      const blocksCard = $('#overview-blocks-card');
      const row2 = $('#overview-row-2');
      const wInfo = $('#overview-wallet-info');

      if (App.activeWallet) {
        walletCard.style.display = '';
        noWalletCta.style.display = 'none';
        // 恢复双栏布局
        row2.style.gridTemplateColumns = '1fr 1fr';
        try {
          const bal = await btcq.balanceOf(App.activeWallet.address);
          wInfo.innerHTML = `
            <div style="margin-bottom:12px">
              <div class="muted" style="font-size:11px;text-transform:uppercase;letter-spacing:0.5px">活跃地址</div>
              <code class="address" style="font-size:13px">${shortAddr(App.activeWallet.address)}</code>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
              <div><div class="muted" style="font-size:11px">流动</div>
                <div style="font-family:var(--font-mono);font-size:18px;font-weight:700;color:var(--accent-cyan)">${fmtBTCQ(bal.liquid)}</div></div>
              <div><div class="muted" style="font-size:11px">已抵押</div>
                <div style="font-family:var(--font-mono);font-size:18px;font-weight:700">${fmtBTCQ(bal.staked)}</div></div>
            </div>
          `;
        } catch (e) {
          wInfo.innerHTML = '<div class="empty-state muted">无法读取余额（链未初始化？）</div>';
        }
      } else {
        // 没钱包：隐藏钱包卡片，让最近区块独占整行，下方显示创建 CTA
        walletCard.style.display = 'none';
        noWalletCta.style.display = '';
        row2.style.gridTemplateColumns = '1fr';
      }

      // 最近区块
      const recentH = stats.height;
      const blocks = await btcq.getBlocks(Math.max(0, recentH - 4), recentH);
      const recent = $('#overview-recent-blocks');
      if (blocks.length === 0) {
        recent.innerHTML = `<div class="empty-state muted">暂无区块</div>`;
      } else {
        recent.innerHTML = blocks.reverse().map(b => `
          <div class="block-mini-row" data-block-h="${b.height}">
            <span class="height">#${b.height}</span>
            <span>slot ${b.slot}</span>
            <span class="ts">${fmtTime(b.timestamp)}</span>
          </div>
        `).join('');
        recent.querySelectorAll('[data-block-h]').forEach(el => {
          el.addEventListener('click', () => {
            showPage('explorer');
            setTimeout(() => Pages.explorer.showBlock(parseInt(el.dataset.blockH)), 100);
          });
        });
      }

      // 致敬网格（一次注入即可）
      this.renderTributes();
    } catch (e) {
      console.warn('overview refresh failed', e);
    }
  },

  renderTributes() {
    const grid = $('#tribute-grid');
    if (grid.children.length > 0) return;
    const tributes = [
      { name: 'Satoshi Nakamoto', amount: 50, role: 'Bitcoin' },
      { name: 'Vitalik Buterin', amount: 25, role: 'Ethereum' },
      { name: 'Hal Finney', amount: 10, role: '第一笔 BTC tx' },
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

// ---------- 区块浏览器 ----------
Pages.explorer = {
  total: 0,

  async refresh() {
    if (App.explorer.mode === 'blocks') return this.refreshBlocks();
    if (App.explorer.mode === 'mempool') return this.refreshMempool();
  },

  async refreshBlocks() {
    try {
      $('#explorer-blocks-view').classList.remove('hidden');
      $('#explorer-block-detail').classList.add('hidden');
      $('#explorer-mempool-view').classList.add('hidden');

      const stats = await btcq.chainStats();
      this.total = stats.initialized ? stats.height + 1 : 0;
      const start = Math.max(0, this.total - (App.explorer.page + 1) * App.explorer.perPage);
      const end = Math.max(0, this.total - 1 - App.explorer.page * App.explorer.perPage);
      if (this.total === 0) {
        $('#explorer-blocks-tbody').innerHTML = `<tr><td colspan="7" class="muted" style="text-align:center;padding:32px">链未初始化</td></tr>`;
        $('#explorer-page-info').textContent = '0 / 0';
        return;
      }
      const blocks = (await btcq.getBlocks(start, end)).reverse();
      $('#explorer-blocks-tbody').innerHTML = blocks.map(b => `
        <tr data-block-h="${b.height}">
          <td class="height-cell">#${b.height}</td>
          <td>${b.slot}</td>
          <td>${fmtTime(b.timestamp)}</td>
          <td class="hash-cell">${shortHash(b.hash)}</td>
          <td class="hash-cell">${shortAddr(b.proposer)}</td>
          <td>${b.tx_count}</td>
          <td>${b.xeb.toFixed(2)}</td>
        </tr>
      `).join('');
      $('#explorer-blocks-tbody').querySelectorAll('tr[data-block-h]').forEach(tr => {
        tr.addEventListener('click', () => this.showBlock(parseInt(tr.dataset.blockH)));
      });
      const pageStart = start;
      const pageEnd = end;
      $('#explorer-page-info').textContent = `${pageStart}–${pageEnd} / 共 ${this.total}`;
    } catch (e) {
      console.warn('explorer refresh', e);
    }
  },

  async refreshMempool() {
    $('#explorer-blocks-view').classList.add('hidden');
    $('#explorer-block-detail').classList.add('hidden');
    $('#explorer-mempool-view').classList.remove('hidden');
    try {
      const txs = await btcq.getMempool();
      const tbody = $('#explorer-mempool-tbody');
      if (!txs.length) {
        tbody.innerHTML = `<tr><td colspan="6" class="muted" style="text-align:center;padding:32px">mempool 为空</td></tr>`;
        return;
      }
      tbody.innerHTML = txs.map(tx => `
        <tr>
          <td><span class="tribute-amount" style="font-size:11px">${tx.kind}</span></td>
          <td class="hash-cell">${shortAddr(tx.sender)}</td>
          <td class="hash-cell">${shortAddr(tx.recipient)}</td>
          <td>${fmtBTCQ(tx.amount)}</td>
          <td>${tx.nonce}</td>
          <td class="hash-cell">${shortHash(tx.tx_hash)}</td>
        </tr>
      `).join('');
    } catch (e) { console.warn(e); }
  },

  switchTab(mode) {
    App.explorer.mode = mode;
    $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.explorerTab === mode));
    if (mode === 'blocks') this.refreshBlocks();
    else if (mode === 'mempool') this.refreshMempool();
    else if (mode === 'txs') this.refreshTxs();
  },

  async refreshTxs() {
    // 简化：把所有区块的所有交易摊平展示（仅展示最近 50 笔）
    $('#explorer-blocks-view').classList.remove('hidden');
    $('#explorer-block-detail').classList.add('hidden');
    $('#explorer-mempool-view').classList.add('hidden');
    try {
      const stats = await btcq.chainStats();
      const start = Math.max(0, stats.height - 30);
      const blocks = await btcq.getBlocks(start, stats.height);
      const tbody = $('#explorer-blocks-tbody');
      // 把表头改成 tx
      const thead = $('#explorer-blocks-view thead tr');
      thead.innerHTML = `<th>区块</th><th>类型</th><th>From</th><th>To</th><th>金额</th><th>Hash</th><th></th>`;
      const allTxs = [];
      for (const b of blocks.reverse()) {
        const fullBlock = await btcq.getBlock(b.height);
        for (const tx of fullBlock.transactions || []) {
          allTxs.push({ ...tx, height: b.height });
          if (allTxs.length >= 50) break;
        }
        if (allTxs.length >= 50) break;
      }
      if (!allTxs.length) {
        tbody.innerHTML = `<tr><td colspan="7" class="muted" style="text-align:center;padding:32px">还没有交易</td></tr>`;
        return;
      }
      tbody.innerHTML = allTxs.map(tx => `
        <tr>
          <td class="height-cell">#${tx.height}</td>
          <td>${tx.kind}</td>
          <td class="hash-cell">${shortAddr(tx.sender)}</td>
          <td class="hash-cell">${shortAddr(tx.recipient)}</td>
          <td>${fmtBTCQ(tx.amount)}</td>
          <td class="hash-cell">${shortHash(tx.tx_hash)}</td>
          <td></td>
        </tr>
      `).join('');
      $('#explorer-page-info').textContent = `最近 ${allTxs.length} 笔`;
    } catch (e) { console.warn(e); }
  },

  search() {
    const q = $('#explorer-search').value.trim();
    if (!q) return;
    if (/^\d+$/.test(q)) {
      this.showBlock(parseInt(q));
    } else if (q.startsWith('0x') && q.length === 42) {
      toast('地址查找：请进入"我的钱包"切换到此地址', '');
    } else if (q.startsWith('0x') && q.length === 66) {
      toast('哈希查找尚在开发，请按高度搜索', '');
    } else {
      toast('未识别的搜索内容', 'error');
    }
  },

  prevPage() {
    if (App.explorer.page > 0) { App.explorer.page--; this.refreshBlocks(); }
  },
  nextPage() {
    const maxPage = Math.max(0, Math.floor((this.total - 1) / App.explorer.perPage));
    if (App.explorer.page < maxPage) { App.explorer.page++; this.refreshBlocks(); }
  },

  async showBlock(h) {
    try {
      const block = await btcq.getBlock(h);
      if (block.error) { toast(block.error, 'error'); return; }
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
          <dt>时间戳</dt><dd>${new Date(block.timestamp * 1000).toLocaleString('zh-CN')} (${block.timestamp})</dd>
          <dt>区块哈希</dt><dd>${block.block_hash}</dd>
          <dt>前一区块哈希</dt><dd>${block.prev_hash}</dd>
          <dt>State Root</dt><dd>${block.state_root}</dd>
          <dt>出块人</dt><dd>${block.proposer_address}</dd>
          <dt>XEB 分数</dt><dd>${parseFloat(block.xeb_score).toFixed(4)}</dd>
          <dt>奖励</dt><dd>${fmtBTCQ(block.reward)} BTCQ</dd>
          <dt>电路参数</dt><dd>n=${block.n_qubits}, depth=${block.depth}, samples=${block.n_samples}</dd>
          <dt>交易（${(block.transactions || []).length} 笔）</dt><dd>${txList}</dd>
        </dl>
      `;
    } catch (e) { console.warn(e); toast('加载区块失败', 'error'); }
  },

  showList() {
    $('#explorer-blocks-view').classList.remove('hidden');
    $('#explorer-block-detail').classList.add('hidden');
    $('#explorer-mempool-view').classList.add('hidden');
    this.refreshBlocks();
  },
};

// ---------- 钱包 ----------
const Wallet = {
  async create() {
    try {
      const r = await btcq.createWallet();
      App.activeWallet = { address: r.address, privateKey: r.private_key };
      await btcq.setState({ walletAddress: r.address, walletPrivateKey: r.private_key });
      toast('钱包已创建：' + shortAddr(r.address), 'success');
      Pages.wallet.refresh();
      Pages.overview.refresh();
    } catch (e) { toast('创建失败：' + e.message, 'error'); }
  },
  async importKey() {
    let key = $('#import-key-input').value.trim();
    if (key.startsWith('0x')) key = key.slice(2);
    if (!/^[0-9a-fA-F]{64}$/.test(key)) {
      toast('私钥格式错误：需要 64 位十六进制', 'error');
      return;
    }
    try {
      const r = await btcq.importWallet(key);
      App.activeWallet = { address: r.address, privateKey: key };
      await btcq.setState({ walletAddress: r.address, walletPrivateKey: key });
      $('#modal-import-key').classList.add('hidden');
      $('#import-key-input').value = '';
      toast('钱包已导入：' + shortAddr(r.address), 'success');
      Pages.wallet.refresh();
    } catch (e) { toast('导入失败：' + e.message, 'error'); }
  },
  showKey() {
    if (!App.activeWallet?.privateKey) {
      toast('钱包私钥未在本机存储（可能是早期导入未保留）', 'error');
      return;
    }
    $('#show-key-content').textContent = '0x' + App.activeWallet.privateKey;
    $('#modal-show-key').classList.remove('hidden');
  },
  copyAddress(btn) {
    if (!App.activeWallet) return;
    navigator.clipboard.writeText(App.activeWallet.address);
    if (btn) { btn.textContent = '✓'; setTimeout(() => btn.textContent = '📋', 1200); }
  },
  copyShownKey() {
    if (!App.activeWallet?.privateKey) return;
    navigator.clipboard.writeText('0x' + App.activeWallet.privateKey);
    toast('已复制到剪贴板', 'success');
  },
};

Pages.wallet = {
  async refresh() {
    if (!App.activeWallet) {
      $('#wallet-empty').classList.remove('hidden');
      $('#wallet-active').classList.add('hidden');
      return;
    }
    $('#wallet-empty').classList.add('hidden');
    $('#wallet-active').classList.remove('hidden');
    $('#wallet-active-addr').textContent = App.activeWallet.address;

    try {
      const bal = await btcq.balanceOf(App.activeWallet.address);
      $('#wallet-bal-liquid').textContent = fmtBTCQ(bal.liquid) + ' BTCQ';
      $('#wallet-bal-staked').textContent = fmtBTCQ(bal.staked) + ' BTCQ';
      $('#wallet-bal-cooling').textContent = fmtBTCQ(bal.cooling) + ' BTCQ';
      $('#wallet-bal-total').textContent = fmtBTCQ(bal.total) + ' BTCQ';

      const txs = await btcq.getTxs(App.activeWallet.address, 50);
      const hist = $('#wallet-tx-history');
      if (!txs.length) {
        hist.innerHTML = `<div class="empty-state muted">暂无交易历史</div>`;
        return;
      }
      hist.innerHTML = txs.map(tx => {
        const isIn = tx.kind === 'reward' || tx.direction === 'in';
        const iconClass = tx.kind === 'reward' ? 'reward' :
                          tx.kind === 'stake' || tx.kind === 'unstake' ? 'stake' :
                          tx.direction === 'in' ? 'in' : 'out';
        const sign = isIn ? '+' : '-';
        const icon = tx.kind === 'reward' ? '⚛' :
                     tx.kind === 'stake' ? '⚓' :
                     tx.kind === 'unstake' ? '↗' :
                     isIn ? '↓' : '↑';
        const meta = tx.kind === 'reward'
          ? `区块 #${tx.height} 出块奖励`
          : `区块 #${tx.height} · ${tx.kind} · ${shortAddr(tx.kind === 'reward' ? '' : (isIn ? tx.sender : tx.recipient))}`;
        return `
          <div class="tx-row">
            <div class="tx-icon ${iconClass}">${icon}</div>
            <div class="tx-info">
              <div class="tx-kind">${tx.kind === 'reward' ? '出块奖励' : tx.kind}</div>
              <div class="tx-meta">${meta}</div>
            </div>
            <div class="tx-amount ${isIn ? 'in' : 'out'}">${sign}${fmtBTCQ(tx.amount)}</div>
            <div class="muted" style="font-size:11px">slot ${tx.slot}</div>
          </div>
        `;
      }).join('');
    } catch (e) { console.warn(e); }
  },
};

// ---------- 转账 ----------
const Send = {
  async execute() {
    const to = $('#send-to').value.trim();
    const amount = parseFloat($('#send-amount').value);
    if (!App.activeWallet?.privateKey) {
      toast('需要私钥才能签名转账，请重新创建/导入钱包', 'error');
      return;
    }
    if (!to.startsWith('0x') || to.length !== 42) {
      toast('收款地址格式错误', 'error');
      return;
    }
    if (!amount || amount <= 0) {
      toast('请输入有效金额', 'error');
      return;
    }
    try {
      const r = await btcq.sendTx(App.activeWallet.privateKey, to, amount, 'transfer');
      toast(`转账已签名并写入 mempool: ${shortHash(r.tx_hash)}`, 'success');
      $('#send-to').value = '';
      $('#send-amount').value = '';
      Pages.send.refresh();
    } catch (e) { toast('发送失败：' + e.message, 'error'); }
  },
};
Pages.send = {
  async refresh() {
    if (!App.activeWallet) {
      $('#send-current-bal').textContent = '请先创建钱包';
      return;
    }
    try {
      const bal = await btcq.balanceOf(App.activeWallet.address);
      $('#send-current-bal').textContent = fmtBTCQ(bal.liquid) + ' BTCQ';
      $('#send-current-nonce').textContent = bal.nonce;
      const mp = await btcq.getMempool();
      const node = $('#send-mempool');
      if (!mp.length) {
        node.innerHTML = '<div class="empty-state muted">mempool 为空</div>';
        return;
      }
      node.innerHTML = mp.map(tx => `
        <div class="tx-row">
          <div class="tx-icon out">↑</div>
          <div class="tx-info">
            <div class="tx-kind">${tx.kind}</div>
            <div class="tx-meta">to ${shortAddr(tx.recipient)} · nonce ${tx.nonce}</div>
          </div>
          <div class="tx-amount">${fmtBTCQ(tx.amount)}</div>
          <div class="muted" style="font-size:11px">${shortHash(tx.tx_hash)}</div>
        </div>
      `).join('');
    } catch (e) { console.warn(e); }
  },
};

// ---------- 抵押 ----------
const Stake = {
  async stake() {
    const amount = parseFloat($('#stake-amount').value);
    if (!App.activeWallet?.privateKey) { toast('需要私钥', 'error'); return; }
    if (!amount || amount < 1) { toast('最低抵押 1 BTCQ', 'error'); return; }
    try {
      const r = await btcq.sendTx(App.activeWallet.privateKey, '0x' + '00'.repeat(19) + '01', amount, 'stake');
      toast(`抵押已写入 mempool: +${amount} BTCQ`, 'success');
      $('#stake-amount').value = '';
      Pages.stake.refresh();
    } catch (e) { toast('抵押失败：' + e.message, 'error'); }
  },
  async unstake() {
    const amount = parseFloat($('#unstake-amount').value);
    if (!App.activeWallet?.privateKey) { toast('需要私钥', 'error'); return; }
    if (!amount || amount <= 0) { toast('请输入金额', 'error'); return; }
    try {
      const r = await btcq.sendTx(App.activeWallet.privateKey, '0x' + '00'.repeat(19) + '01', amount, 'unstake');
      toast(`解抵押已申请：${amount} BTCQ，需 100 块冷却`, 'success');
      $('#unstake-amount').value = '';
      Pages.stake.refresh();
    } catch (e) { toast('解抵押失败：' + e.message, 'error'); }
  },
};
Pages.stake = {
  async refresh() {
    if (!App.activeWallet) {
      $('#stake-liquid').textContent = '请先创建钱包';
      return;
    }
    try {
      const bal = await btcq.balanceOf(App.activeWallet.address);
      $('#stake-liquid').textContent = fmtBTCQ(bal.liquid) + ' BTCQ';
      $('#stake-staked').textContent = fmtBTCQ(bal.staked) + ' BTCQ';
      $('#stake-cooling').textContent = fmtBTCQ(bal.cooling) + ' BTCQ';
      $('#stake-eligible').textContent = bal.eligible ? '✅ 已激活' : '❌ 需 ≥ 1 BTCQ';
    } catch (e) { console.warn(e); }
  },
};

// ---------- 挖矿 ----------
const Mining = {
  async testToken(btn) {
    const token = $('#mining-token-input').value.trim();
    if (!token) { toast('请粘贴 Token', 'error'); return; }
    btn.disabled = true;
    const status = $('#mining-token-status');
    status.textContent = '测试中...';
    status.className = 'status loading';
    try {
      const r = await btcq.testIbm(token);
      if (!r.ok) {
        status.textContent = '❌ ' + r.error;
        status.className = 'status error';
        return;
      }
      status.textContent = `✓ 已连接 ${r.backends?.length || 0} 台量子机`;
      status.className = 'status success';
      await btcq.setState({ ibmTokenSaved: true, backends: r.backends, usage: r.usage });
      App.state = await btcq.getState();
      setTimeout(() => Pages.mining.refresh(), 500);
    } catch (e) {
      status.textContent = '❌ ' + e.message;
      status.className = 'status error';
    } finally { btn.disabled = false; }
  },
  async toggle() {
    if (App.mining.running) {
      await btcq.stopMining();
      App.mining.running = false;
      App.mining.sessionStart = null;
      Mining.setUI(false);
    } else {
      if (!App.activeWallet) { toast('请先创建钱包', 'error'); return; }
      const r = await btcq.startMining({
        backend: App.state.backend || 'ibm_marrakesh',
        mode: App.state.miningMode || 'quantum',
      });
      if (!r.ok) { toast('启动失败：' + r.error, 'error'); return; }
      App.mining.running = true;
      App.mining.sessionStart = Date.now();
      App.mining.blocksMined = 0;
      App.mining.earnings = 0;
      Mining.setUI(true);
    }
  },
  setUI(running) {
    $('#mining-light').classList.toggle('mining', running);
    $('#mining-title').textContent = running ? '正在挖矿' : '未挖矿';
    $('#mining-subtitle').textContent = running
      ? '量子机器正在执行 RCS 电路...'
      : '点击下方按钮开始';
    $('#mining-toggle').textContent = running ? '暂停' : '开始挖矿';
    $('#mining-toggle').className = running ? 'btn btn-secondary btn-lg' : 'btn btn-primary btn-lg';
    $('#mining-status-badge').textContent = running ? '运行' : '未启动';
    Mining.activateQubits(running);
  },
  activateQubits(active) {
    if (App.qubitAnimHandle) { clearInterval(App.qubitAnimHandle); App.qubitAnimHandle = null; }
    document.querySelectorAll('.qubit-circle').forEach(c => c.classList.remove('active'));
    if (active) {
      App.qubitAnimHandle = setInterval(() => {
        document.querySelectorAll('.qubit-circle').forEach(c => {
          c.classList.toggle('active', Math.random() < 0.5);
        });
      }, 150);
    }
  },
  log(text, level = '') {
    const body = $('#mining-log');
    if (body.querySelector('.log-empty')) body.innerHTML = '';
    const line = document.createElement('div');
    line.className = 'log-line ' + level;
    const ts = new Date().toLocaleTimeString('zh-CN');
    line.innerHTML = `<span class="ts">${ts}</span>${text}`;
    body.appendChild(line);
    while (body.children.length > 200) body.removeChild(body.firstChild);
    body.scrollTop = body.scrollHeight;
  },
};

Pages.mining = {
  async refresh() {
    // qubit row
    const g = document.getElementById('qubits-row');
    if (g && g.children.length === 0) {
      for (let i = 0; i < 30; i++) {
        const cx = 30 + i * 18;
        const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        c.setAttribute('cx', cx);
        c.setAttribute('cy', 80);
        c.setAttribute('r', 6);
        c.setAttribute('class', 'qubit-circle');
        g.appendChild(c);
      }
    }

    // Show setup or dashboard
    if (App.state.ibmTokenSaved) {
      $('#mining-setup').classList.add('hidden');
      $('#mining-dashboard').classList.remove('hidden');

      // Update stats
      $('#mining-stat-mined').textContent = App.mining.blocksMined;
      $('#mining-stat-earnings').textContent = App.mining.earnings;
      if (App.state.usage) {
        $('#mining-stat-quota').textContent = App.state.usage.usage_remaining_seconds || '—';
      }
      if (App.mining.sessionStart) {
        const s = (Date.now() - App.mining.sessionStart) / 1000;
        $('#mining-stat-uptime').textContent = fmtUptime(s);
      } else {
        $('#mining-stat-uptime').textContent = '00:00';
      }
    } else {
      $('#mining-setup').classList.remove('hidden');
      $('#mining-dashboard').classList.add('hidden');
    }
  },
};

function handleMiningEvent(ev) {
  switch (ev.type) {
    case 'mining-started':
      Mining.log(`▶ 挖矿启动 (${ev.mode}, ${ev.backend})`, 'event');
      break;
    case 'mining-stopped':
      Mining.log('■ 挖矿已停止', 'event');
      Mining.activateQubits(false);
      break;
    case 'block-attempt-start':
      Mining.log('提交量子作业...', 'event');
      Mining.activateQubits(true);
      break;
    case 'block-attempt-end':
      Mining.activateQubits(false);
      if (ev.code === 0) {
        Mining.log('✅ 区块出块成功 +50 BTCQ', 'success');
        App.mining.blocksMined++;
        App.mining.earnings += 50;
        if (App.currentPage === 'mining') Pages.mining.refresh();
      } else {
        Mining.log(`⚠️ 此次失败 (退出码 ${ev.code})`, 'error');
      }
      break;
    case 'log':
      const xebMatch = (ev.text || '').match(/XEB\s*=\s*([\d.]+)/);
      if (xebMatch) $('#viz-xeb').textContent = parseFloat(xebMatch[1]).toFixed(2);
      const shotsMatch = (ev.text || '').match(/shots[=\s]+(\d+)/i);
      if (shotsMatch) $('#viz-shots').textContent = shotsMatch[1];
      const timeMatch = (ev.text || '').match(/接口总耗时:\s*([\d.]+)s/);
      if (timeMatch) $('#viz-time').textContent = timeMatch[1] + 's';
      Mining.log(ev.text.trim(), ev.level === 'error' ? 'error' : '');
      break;
  }
}

// ---------- 网络 ----------
const Network = {
  async addPeer() {
    const url = $('#add-peer-url').value.trim();
    if (!url.startsWith('http')) { toast('URL 格式错误', 'error'); return; }
    try {
      // 简化：通过本地节点 API 提交（如果在跑）
      const r = await fetch('http://localhost:8333/peers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      });
      const data = await r.json();
      if (data.ok) {
        toast(`已添加 peer: ${url}`, 'success');
        $('#modal-add-peer').classList.add('hidden');
        $('#add-peer-url').value = '';
        Pages.network.refresh();
      } else {
        toast('添加失败：' + data.error, 'error');
      }
    } catch (e) {
      toast('请先启动本地节点（终端 python scripts/node.py）', 'error');
    }
  },
};
Pages.network = {
  async refresh() {
    try {
      const r = await fetch('http://localhost:8333/info');
      const info = await r.json();
      $('#net-status').textContent = '✅ 运行中';
      $('#net-port').textContent = '8333';
      $('#net-height').textContent = info.height;
      $('#net-head').textContent = info.head_hash;
      $('#net-peers').textContent = info.peers.length + ' 个';
      const list = $('#net-peer-list');
      if (info.peers.length === 0) {
        list.innerHTML = `<div class="empty-state muted">暂无 peer。点击"添加 Peer"</div>`;
      } else {
        list.innerHTML = info.peers.map(p => `
          <div class="peer-row">
            <span>${p}</span>
            <span class="peer-status">在线</span>
          </div>`).join('');
      }
    } catch (e) {
      $('#net-status').textContent = '❌ 未运行';
      $('#net-port').textContent = '—';
      $('#net-height').textContent = '—';
      $('#net-head').textContent = '终端运行 python scripts/node.py 启动节点';
      $('#net-peers').textContent = '—';
      $('#net-peer-list').innerHTML = `<div class="empty-state muted">本地节点未启动</div>`;
    }
  },
};

// ---------- 设置 ----------
const Settings = {
  save: async () => {
    await btcq.setState({
      backend: $('#setting-backend').value,
      miningMode: $('#setting-mining-mode').value,
      btcqPath: $('#setting-btcq-path').value,
      pythonPath: $('#setting-python').value,
      rewardAddr: $('#setting-reward-addr').value,
    });
    toast('设置已保存', 'success');
  },
  reset: async () => {
    if (!confirm('确定重置所有设置？钱包仍会保留（如已创建）。')) return;
    await btcq.setState({ backend: null, miningMode: null, btcqPath: null, pythonPath: null, ibmTokenSaved: false, usage: null });
    App.state = await btcq.getState();
    toast('已重置', 'success');
    Pages.settings.refresh();
  },
};
Pages.settings = {
  async refresh() {
    App.state = await btcq.getState();
    if (App.state.backend) $('#setting-backend').value = App.state.backend;
    if (App.state.miningMode) $('#setting-mining-mode').value = App.state.miningMode;
    if (App.state.btcqPath) $('#setting-btcq-path').value = App.state.btcqPath;
    if (App.state.pythonPath) $('#setting-python').value = App.state.pythonPath;
    if (App.state.rewardAddr) $('#setting-reward-addr').value = App.state.rewardAddr;
    // 设置项变化时自动保存
    ['#setting-backend', '#setting-mining-mode', '#setting-reward-addr', '#setting-python', '#setting-theme', '#setting-particles']
      .forEach(sel => {
        const el = $(sel);
        if (el && !el.dataset.bound) {
          el.dataset.bound = '1';
          el.addEventListener('change', Settings.save);
        }
      });
  },
};

// =============== 启动 ===============
window.addEventListener('DOMContentLoaded', boot);
