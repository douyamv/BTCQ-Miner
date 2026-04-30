// BTCQ Miner — Preload bridge
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('btcq', {
  // 状态持久化
  getState: () => ipcRenderer.invoke('state:get'),
  setState: (patch) => ipcRenderer.invoke('state:set', patch),

  // 外部链接
  openExternal: (url) => ipcRenderer.invoke('shell:open', url),

  // IBM Quantum
  testIbm: (token) => ipcRenderer.invoke('ibm:test', token),

  // 钱包
  createWallet: () => ipcRenderer.invoke('wallet:create'),
  importWallet: (privateKey) => ipcRenderer.invoke('wallet:import', privateKey),

  // 链
  initChain: () => ipcRenderer.invoke('chain:init'),
  chainStats: () => ipcRenderer.invoke('chain:stats'),
  balanceOf: (addr) => ipcRenderer.invoke('chain:balance', addr),
  verifyChain: () => ipcRenderer.invoke('chain:verify'),

  // 挖矿
  startMining: (opts) => ipcRenderer.invoke('mining:start', opts),
  stopMining: () => ipcRenderer.invoke('mining:stop'),
  miningStatus: () => ipcRenderer.invoke('mining:status'),
  onMiningEvent: (cb) => {
    const handler = (_e, ev) => cb(ev);
    ipcRenderer.on('mining:event', handler);
    return () => ipcRenderer.removeListener('mining:event', handler);
  },

  // 工具
  selectFolder: () => ipcRenderer.invoke('dialog:select-folder'),

  // 平台
  platform: process.platform,
});
