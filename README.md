# BTCQ Miner

> 跨平台量子挖矿桌面客户端（macOS / Windows / Linux）—— 现代化仪表盘 + 内置区块浏览器 + 完整钱包功能

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
![electron](https://img.shields.io/badge/electron-33+-blue.svg)
![status](https://img.shields.io/badge/status-v0.1.4-green)

BTCQ Miner 是 [BTCQ 比特币量子](https://github.com/douyamv/BTCQ) 的官方桌面客户端。

---

## ✨ 特点

* **左侧菜单 + 右侧功能** — 现代化仪表盘式布局，全部功能一屏可达
* **零门槛进入** — 无需登录、无需 API key 即可使用大部分功能（区块浏览器、钱包、转账）
* **挖矿** — 仅当真要挖矿时引导用户注册 IBM Quantum（每月 600 秒免费）
* **完整功能集**：
  - 📊 概览 — 链状态、钱包余额、最近区块、致敬榜
  - 🔍 区块浏览器 — 区块列表 / 详情 / 交易 / mempool
  - 💰 钱包 — 创建/导入/查看余额/交易历史
  - ↗ 转账 — 签名 + 广播
  - ⚓ 抵押 / 解抵押 — PoQ-Stake
  - ⚛ 量子挖矿 — 引导式 IBM 注册 + 实时挖矿仪表盘
  - 🌐 网络 — P2P 节点状态、peer 管理
  - ⚙ 设置 — 量子后端、奖励地址、路径配置
* **暗色量子风格 UI** — 紫青渐变 + 玻璃态卡片 + 量子粒子背景

---

## 快速开始

```bash
git clone https://github.com/douyamv/BTCQ-Miner.git
cd BTCQ-Miner
npm install
npm start
```

启动后默认进入"概览"页 — 不需要登录。

如果要挖矿，进入「挖矿」菜单，按引导 3 步注册 IBM Quantum。

---

## 配套要求

### 协议端

需要本地有 [BTCQ 协议代码](https://github.com/douyamv/BTCQ)：

```bash
git clone https://github.com/douyamv/BTCQ.git ~/BTCQ
cd ~/BTCQ && pip install -r requirements.txt
```

App 会自动在 `~/dd/qxeb`、`~/dd/BTCQ`、`~/BTCQ`、`~/btcq` 等位置查找。也可在「设置」中手动指定。

### Python

3.10+

---

## 截图风格

```
┌──────────┬────────────────────────────────────────┐
│ ⊟ 概览   │  概览                                  │
│ ⊠ 浏览器 │                                        │
│ ◈ 钱包   │  ┌────────┬────────┬────────┬──────┐ │
│ ⇄ 转账   │  │ 链高度  │总供应  │下一奖励│挖矿  │ │
│ ⚓ 抵押   │  │  10    │ 300    │  50    │运行  │ │
│ ⚛ 挖矿 ● │  └────────┴────────┴────────┴──────┘ │
│ ⊜ 网络   │                                        │
│ ⚙ 设置   │  ┌──────────────┬──────────────────┐  │
│          │  │ 我的钱包      │ 最近区块         │  │
│ 本地链   │  │              │                  │  │
│ v0.1.4   │  └──────────────┴──────────────────┘  │
└──────────┴────────────────────────────────────────┘
```

每个页面都是独立的右侧内容，左侧菜单永久可见。

---

## 构建打包

```bash
npm run build:mac    # .dmg + .zip
npm run build:win    # .exe + portable
npm run build:linux  # .AppImage + .deb
```

输出在 `dist/`。

---

## 技术栈

| 层 | 技术 |
|---|---|
| 桌面框架 | Electron 33+ |
| UI | 原生 HTML/CSS/JS（无框架） |
| 视觉 | 紫青量子渐变 + 玻璃态 + SVG 粒子背景 |
| 状态 | LocalStorage 风格的 state.json 持久化 |
| 协议层 | 调用 [BTCQ Python](https://github.com/douyamv/BTCQ) |
| 加密 | secp256k1 + keccak256（同 Ethereum） |

---

## 路线图

- v0.2 — 内置 Python 节点托管（无需用户开终端）
- v0.3 — Web 区块浏览器同步分支
- v0.4 — 多账户切换 + 助记词
- v0.5 — 智能合约调用（如有合约层）

---

## 许可

MIT
