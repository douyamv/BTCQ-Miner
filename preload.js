// BTCQ Miner — Preload bridge (v0.1.5 纯前端 + 内置 JS 钱包)
console.log('[preload] === LOADING START ===');
const { contextBridge, ipcRenderer } = require('electron');
const crypto = require('crypto');
const EC = require('elliptic').ec;
const { keccak256 } = require('js-sha3');
const ec = new EC('secp256k1');
console.log('[preload] all modules required OK');

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
  const priv = crypto.randomBytes(32);
  return walletFromPrivate(priv);
}
// secp256k1 曲线阶 n（私钥必须 ∈ [1, n-1]）
const SECP256K1_N = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141');
function walletFromPrivate(priv) {
  const privBytes = priv instanceof Uint8Array || Buffer.isBuffer(priv)
    ? Uint8Array.from(priv)
    : hexToBytes(priv);
  if (privBytes.length !== 32) throw new Error('私钥必须是 32 字节');
  // 越界检查：!= 0 && < n
  let big = 0n;
  for (const b of privBytes) big = (big << 8n) | BigInt(b);
  if (big === 0n) throw new Error('私钥不能为 0');
  if (big >= SECP256K1_N) throw new Error('私钥超出 secp256k1 曲线阶');
  const key = ec.keyFromPrivate(privBytes);
  // 未压缩公钥：04 || X(32) || Y(32) → 切掉前缀，剩 64 字节
  const pubHex = key.getPublic(false, 'hex');     // '04' + x + y
  const pub = hexToBytes(pubHex.slice(2));
  const addr = keccak256Bytes(pub).slice(-20);
  return {
    privateKey: '0x' + bytesToHex(privBytes),
    publicKey: '0x' + bytesToHex(pub),
    address: '0x' + bytesToHex(addr),
  };
}

// ================== Tx 签名（仿照 BTCQ Python 端） ==================
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

  const privBytes = hexToBytes(privateKey);
  const key = ec.keyFromPrivate(privBytes);
  const sig = key.sign(txHash, { canonical: true });   // canonical = lowS
  const r = sig.r.toArrayLike(Uint8Array, 'be', 32);
  const s = sig.s.toArrayLike(Uint8Array, 'be', 32);
  // BTCQ Python (eth_keys) 期望 v ∈ {0, 1}，不是 {27, 28}
  const v = sig.recoveryParam || 0;
  const fullSig = concat(r, s, new Uint8Array([v]));
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

// ================== 加密：scrypt + AES-256-GCM ==================
const KDF_PARAMS = { N: 1 << 15, r: 8, p: 1, dkLen: 32 };  // ~50ms, 32MB
function scryptKey(password, salt) {
  return crypto.scryptSync(password, salt, KDF_PARAMS.dkLen, {
    N: KDF_PARAMS.N, r: KDF_PARAMS.r, p: KDF_PARAMS.p, maxmem: 64 * 1024 * 1024,
  });
}
function encryptSecret(plaintext, password) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = scryptKey(password, salt);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    v: 1,
    kdf: 'scrypt',
    N: KDF_PARAMS.N, r: KDF_PARAMS.r, p: KDF_PARAMS.p,
    salt: salt.toString('hex'),
    iv: iv.toString('hex'),
    ct: enc.toString('hex'),
    tag: tag.toString('hex'),
  };
}
function decryptSecret(blob, password) {
  if (!blob || blob.v !== 1) throw new Error('密文格式错误');
  const salt = Buffer.from(blob.salt, 'hex');
  const iv = Buffer.from(blob.iv, 'hex');
  const ct = Buffer.from(blob.ct, 'hex');
  const tag = Buffer.from(blob.tag, 'hex');
  const key = scryptKey(password, salt);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(ct), decipher.final()]);
  return dec.toString('utf8');
}
// 用一段固定的 magic 加密保存以验证密码（避免错密码 silent 解密垃圾）
const VERIFY_MAGIC = 'BTCQ-WALLET-VERIFY-v1';
function makeVerifier(password) { return encryptSecret(VERIFY_MAGIC, password); }
function checkVerifier(blob, password) {
  try { return decryptSecret(blob, password) === VERIFY_MAGIC; }
  catch { return false; }
}

// ================== 暴露给渲染层 ==================
try {
  contextBridge.exposeInMainWorld('btcq', {
    getState: () => ipcRenderer.invoke('state:get'),
    setState: (patch) => ipcRenderer.invoke('state:set', patch),
    encryptSecret,
    decryptSecret,
    makeVerifier,
    checkVerifier,
    openExternal: (url) => ipcRenderer.invoke('shell:open', url),
    selectFolder: () => ipcRenderer.invoke('dialog:select-folder'),
    generateWallet,
    walletFromPrivate,
    signTransaction,

    // 挖矿一键启动
    miningCheckSetup: () => ipcRenderer.invoke('mining:check_setup'),
    miningInstall: () => ipcRenderer.invoke('mining:install_btcq'),
    miningSaveToken: (token) => ipcRenderer.invoke('mining:save_token', token),
    miningExportWallet: (privateKey) => ipcRenderer.invoke('mining:export_wallet', privateKey),
    miningStart: (opts) => ipcRenderer.invoke('mining:start', opts),
    miningStop: () => ipcRenderer.invoke('mining:stop'),
    miningStatus: () => ipcRenderer.invoke('mining:status'),
    onMiningEvent: (cb) => {
      const handler = (_e, ev) => cb(ev);
      ipcRenderer.on('mining:event', handler);
      return () => ipcRenderer.removeListener('mining:event', handler);
    },

    platform: process.platform,
  });
  console.log('[preload] === btcq exposed via contextBridge ===');
} catch (e) {
  console.error('[preload] contextBridge.exposeInMainWorld 失败:', e);
}
