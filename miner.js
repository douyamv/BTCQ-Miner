// BTCQ Miner — Python subprocess wrapper
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { EventEmitter } = require('events');

class Miner extends EventEmitter {
  constructor(state) {
    super();
    this.state = state || {};
    this.btcqPath = state.btcqPath || this._detectBtcqPath();
    this.proc = null;
    this.running = false;
    this.stats = {
      blocksMinedThisSession: 0,
      lastBlock: null,
      lastError: null,
      startedAt: null,
    };
  }

  _detectBtcqPath() {
    const candidates = [
      path.join(require('os').homedir(), 'dd/qxeb'),
      path.join(require('os').homedir(), 'dd/BTCQ'),
      path.join(require('os').homedir(), 'BTCQ'),
      path.join(require('os').homedir(), 'btcq'),
    ];
    for (const p of candidates) {
      if (fs.existsSync(path.join(p, 'btcq', 'proposer.py'))) return p;
    }
    return null;
  }

  _python() {
    return this.state.pythonPath || 'python3';
  }

  _runPyScript(script, args = []) {
    return new Promise((resolve, reject) => {
      if (!this.btcqPath) {
        return reject(new Error('未检测到 BTCQ 协议代码路径，请在设置里指定'));
      }
      const proc = spawn(this._python(), [script, ...args], {
        cwd: this.btcqPath,
        env: { ...process.env, PYTHONUNBUFFERED: '1' }
      });
      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', d => stdout += d.toString());
      proc.stderr.on('data', d => stderr += d.toString());
      proc.on('close', code => {
        if (code === 0) resolve({ stdout, stderr });
        else reject(new Error(stderr || `脚本退出码 ${code}`));
      });
      proc.on('error', err => reject(err));
    });
  }

  // ============ IBM 连接测试 ============
  async testIbmConnection(token) {
    if (!this.btcqPath) {
      return { ok: false, error: '未检测到 BTCQ 路径' };
    }
    const code = `
import sys, json
try:
    from qiskit_ibm_runtime import QiskitRuntimeService
    QiskitRuntimeService.save_account(channel='ibm_quantum_platform',
                                       token=${JSON.stringify(token)},
                                       overwrite=True, set_as_default=True)
    svc = QiskitRuntimeService()
    backends = []
    for b in svc.backends(simulator=False, operational=True):
        try:
            st = b.status()
            backends.append({
                'name': b.name,
                'qubits': b.configuration().num_qubits,
                'queue': st.pending_jobs,
                'operational': st.operational,
            })
        except Exception:
            pass
    usage = svc.usage()
    print(json.dumps({'ok': True, 'backends': backends, 'usage': usage}, default=str))
except Exception as e:
    print(json.dumps({'ok': False, 'error': str(e)}))
`;
    return new Promise((resolve, reject) => {
      const proc = spawn(this._python(), ['-c', code], { cwd: this.btcqPath });
      let out = ''; let err = '';
      proc.stdout.on('data', d => out += d.toString());
      proc.stderr.on('data', d => err += d.toString());
      proc.on('close', () => {
        try {
          const j = JSON.parse(out.trim().split('\n').pop());
          resolve(j);
        } catch (e) {
          resolve({ ok: false, error: err || out || String(e) });
        }
      });
    });
  }

  // ============ 钱包 ============
  async createWallet() {
    const code = `
import sys, json
sys.path.insert(0, '.')
from btcq.wallet import Wallet
w = Wallet.generate()
print(json.dumps({
    'address': w.address_hex(),
    'private_key': w._sk.to_bytes().hex(),
}))
`;
    const r = await this._runPyInline(code);
    return JSON.parse(r);
  }

  async importWallet(privateKeyHex) {
    const code = `
import sys, json
sys.path.insert(0, '.')
from btcq.wallet import Wallet
w = Wallet(bytes.fromhex(${JSON.stringify(privateKeyHex)}))
print(json.dumps({'address': w.address_hex()}))
`;
    const r = await this._runPyInline(code);
    return JSON.parse(r);
  }

  // ============ 链 ============
  async initChain() {
    const r = await this._runPyScript('scripts/init_chain.py');
    return { ok: true, output: r.stdout };
  }

  async getStats() {
    const code = `
import sys, json, time
sys.path.insert(0, '.')
from btcq.chain import Chain
from btcq.constants import (COIN, TOTAL_SUPPLY, INITIAL_BLOCK_REWARD, HALVING_INTERVAL,
    GENESIS_TIMESTAMP, BOOTSTRAP_OPEN_BLOCKS, target_block_time_at, difficulty_window_at)
chain = Chain('./chain_data')
head = chain.head
if head is None:
    print(json.dumps({'initialized': False}))
else:
    secs = max(0, head.timestamp - GENESIS_TIMESTAMP)
    print(json.dumps({
        'initialized': True,
        'height': chain.height,
        'lastBlockHash': '0x' + head.block_hash().hex(),
        'lastBlockTime': head.timestamp,
        'secondsSinceGenesis': secs,
        'targetBlockTime': target_block_time_at(secs),
        'difficultyWindow': difficulty_window_at(secs),
        'nextDifficulty': chain.next_difficulty(),
        'nextReward': INITIAL_BLOCK_REWARD >> ((chain.height + 1) // HALVING_INTERVAL),
        'totalSupply': chain.total_supply_so_far(),
        'totalSupplyCap': TOTAL_SUPPLY,
        'bootstrapOpenBlocks': BOOTSTRAP_OPEN_BLOCKS,
        'bootstrapBlocksLeft': max(0, BOOTSTRAP_OPEN_BLOCKS - chain.height - 1),
        'totalStake': chain.total_stake(),
        'totalTxCount': chain.total_tx_count(),
        'coin': COIN,
    }))
`;
    return JSON.parse(await this._runPyInline(code));
  }

  async getBalance(address) {
    const code = `
import sys, json
sys.path.insert(0, '.')
from btcq.chain import Chain
from btcq.constants import COIN, MIN_STAKE
addr = ${JSON.stringify(address)}
if addr.startswith('0x'): addr = addr[2:]
addr_bytes = bytes.fromhex(addr)
chain = Chain('./chain_data')
print(json.dumps({
    'liquid': chain.balance_of(addr_bytes),
    'staked': chain.staked_of(addr_bytes),
    'cooling': chain.cooling_of(addr_bytes),
    'total': chain.total_balance_of(addr_bytes),
    'eligible': chain.staked_of(addr_bytes) >= MIN_STAKE,
}))
`;
    return JSON.parse(await this._runPyInline(code));
  }

  async verifyChain() {
    const code = `
import sys, json
sys.path.insert(0, '.')
from btcq.verifier import verify_chain
ok, msg = verify_chain('./chain_data', recompute_xeb=False)
print(json.dumps({'ok': ok, 'msg': msg}))
`;
    return JSON.parse(await this._runPyInline(code));
  }

  _runPyInline(code) {
    return new Promise((resolve, reject) => {
      if (!this.btcqPath) return reject(new Error('未检测到 BTCQ 路径'));
      const proc = spawn(this._python(), ['-c', code], { cwd: this.btcqPath });
      let out = ''; let err = '';
      proc.stdout.on('data', d => out += d.toString());
      proc.stderr.on('data', d => err += d.toString());
      proc.on('close', code => {
        if (code === 0) resolve(out.trim().split('\n').pop());
        else reject(new Error(err || `退出码 ${code}`));
      });
    });
  }

  // ============ 挖矿循环 ============
  async start({ backend = 'ibm_marrakesh', mode = 'quantum', walletPath = 'wallet.json' } = {}) {
    if (this.running) return { ok: false, error: '已在挖矿' };
    if (!this.btcqPath) return { ok: false, error: '未检测到 BTCQ 路径' };
    this.running = true;
    this.stats.startedAt = Date.now();
    this.stats.blocksMinedThisSession = 0;
    this._spawnNextBlock({ backend, mode, walletPath });
    this.emit('event', { type: 'mining-started', mode, backend });
    return { ok: true };
  }

  _spawnNextBlock({ backend, mode, walletPath }) {
    if (!this.running) return;
    const args = mode === 'quantum'
      ? ['scripts/propose.py', '--quantum', '--backend', backend, '--wallet', walletPath]
      : ['scripts/propose.py', '--classical', '--wallet', walletPath];
    this.proc = spawn(this._python(), args, {
      cwd: this.btcqPath,
      env: { ...process.env, PYTHONUNBUFFERED: '1' }
    });
    this.emit('event', { type: 'block-attempt-start', timestamp: Date.now() });

    this.proc.stdout.on('data', d => {
      const text = d.toString();
      text.split('\n').forEach(line => {
        if (!line.trim()) return;
        this.emit('event', { type: 'log', text: line });
        if (line.includes('区块出块成功')) {
          this.stats.blocksMinedThisSession++;
        }
        if (line.includes('哈希:')) {
          const m = line.match(/0x([0-9a-f]+)/i);
          if (m) this.stats.lastBlock = m[0];
        }
      });
    });
    this.proc.stderr.on('data', d => {
      this.emit('event', { type: 'log', text: d.toString(), level: 'error' });
    });

    this.proc.on('close', code => {
      this.emit('event', { type: 'block-attempt-end', code, timestamp: Date.now() });
      this.proc = null;
      if (this.running) {
        // 等到下一个目标出块时间再尝试
        setTimeout(() => this._spawnNextBlock({ backend, mode, walletPath }), 10_000);
      }
    });
  }

  async stop() {
    this.running = false;
    if (this.proc) {
      this.proc.kill();
      this.proc = null;
    }
    this.emit('event', { type: 'mining-stopped' });
    return { ok: true };
  }

  status() {
    return {
      running: this.running,
      ...this.stats,
      uptime: this.stats.startedAt ? Date.now() - this.stats.startedAt : 0,
    };
  }
}

module.exports = { Miner };
