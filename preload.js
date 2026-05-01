// BTCQ Miner — Preload bridge (v0.1.5 纯前端 + 内置 JS 钱包)
const { contextBridge, ipcRenderer } = require('electron');
const secp = require('@noble/secp256k1');
const { keccak256 } = require('js-sha3');

// ================== 工具：bytes <-> hex ==================
const bytesToHex = (b) => Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
const hexToBytes = (h) => {
  const s = h.startsWith('0x') ? h.slice(2) : h;
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16);
  return out;
};
const keccak256Bytes = (data) => new Uint8Array(keccak256.arrayBuffer(data));

// ================== Wallet（纯 JS，无后端） ==================
function generateWallet() {
  const priv = secp.utils.randomPrivateKey();
  return walletFromPrivate(priv);
}
function walletFromPrivate(priv) {
  const privBytes = priv instanceof Uint8Array ? priv : hexToBytes(priv);
  if (privBytes.length !== 32) throw new Error('私钥必须是 32 字节');
  const pub = secp.getPublicKey(privBytes, false).slice(1);    // 去掉 0x04 前缀
  const addr = keccak256Bytes(pub).slice(-20);
  return {
    privateKey: '0x' + bytesToHex(privBytes),
    publicKey: '0x' + bytesToHex(pub),
    address: '0x' + bytesToHex(addr),
  };
}

// ================== Tx 签名（仿照 BTCQ Python 端） ==================
// unsigned_bytes = sender(20) || recipient(20) || amount(16, BE) || nonce(8, BE) || kind_len(1) || kind(utf8)
async function signTransaction({ privateKey, recipient, amount, nonce, kind = 'transfer' }) {
  const w = walletFromPrivate(privateKey);
  const sender = hexToBytes(w.address);
  const recipientBytes = hexToBytes(recipient);
  const amtBytes = bigUintToBytes(BigInt(amount), 16);
  const nonceBytes = bigUintToBytes(BigInt(nonce), 8);
  const kindBytes = new TextEncoder().encode(kind);
  const kindLen = new Uint8Array([kindBytes.length]);
  const unsigned = concat(sender, recipientBytes, amtBytes, nonceBytes, kindLen, kindBytes);
  const txHash = keccak256Bytes(unsigned);
  // recoverable signature (r || s || v)
  const sig = await secp.signAsync(txHash, hexToBytes(privateKey), { lowS: true });
  const sigBytes = sig.toCompactRawBytes();
  // recovery byte：@noble v2 的 sig 含 recovery
  const v = sig.recovery + 27;
  const fullSig = concat(sigBytes, new Uint8Array([v]));
  return {
    sender: '0x' + bytesToHex(sender),
    recipient: '0x' + bytesToHex(recipientBytes),
    amount: amount.toString(),
    nonce,
    kind,
    signature: '0x' + bytesToHex(fullSig),
    tx_hash: '0x' + bytesToHex(txHash),
  };
}

function bigUintToBytes(n, len) {
  const out = new Uint8Array(len);
  let i = len - 1;
  while (n > 0n && i >= 0) { out[i--] = Number(n & 0xffn); n >>= 8n; }
  return out;
}
function concat(...arrs) {
  let total = 0;
  for (const a of arrs) total += a.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrs) { out.set(a, off); off += a.length; }
  return out;
}

// ================== 暴露给渲染层 ==================
contextBridge.exposeInMainWorld('btcq', {
  // 状态
  getState: () => ipcRenderer.invoke('state:get'),
  setState: (patch) => ipcRenderer.invoke('state:set', patch),

  // shell
  openExternal: (url) => ipcRenderer.invoke('shell:open', url),
  selectFolder: () => ipcRenderer.invoke('dialog:select-folder'),

  // 钱包（纯 JS，零延迟）
  generateWallet,
  walletFromPrivate,
  signTransaction,

  platform: process.platform,
});
