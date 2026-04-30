# BTCQ Miner

> 跨平台量子挖矿桌面客户端 · macOS / Windows / Linux

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

BTCQ Miner 是 [BTCQ 比特币量子](https://github.com/douyamv/BTCQ) 的官方桌面挖矿客户端。

* **零门槛**：四步引导用户完成 IBM Quantum 免费账号注册 → API Token → 钱包 → 开始挖矿
* **美观直观**：暗色量子风格 UI，实时显示挖矿状态、链高度、奖励、保真度
* **跨平台**：基于 Electron，一次代码三平台运行
* **本地优先**：私钥与 API Token 全部存储在本机，不上传任何服务器

---

## 快速开始

### 前置依赖

1. **Python 3.10+** 与 BTCQ 协议代码（首次运行时 Miner 会引导设置）
   ```bash
   git clone https://github.com/douyamv/BTCQ.git
   cd BTCQ
   pip install -r requirements.txt
   ```

2. **Node.js 18+**（运行 Miner 本身）

### 安装与启动

```bash
git clone https://github.com/douyamv/BTCQ-Miner.git
cd BTCQ-Miner
npm install
npm start
```

启动后跟随引导操作：

1. **欢迎屏** → 点击"开始"
2. **IBM Quantum 注册引导** → 自动跳转到 quantum.ibm.com 注册免费账号（每月 600 秒配额）
3. **粘贴 API Token** → 测试连接，确认能访问真量子机器
4. **创建钱包** → 一键生成新地址或导入已有私钥
5. **进入仪表盘** → 点击"开始挖矿"

---

## 仪表盘功能

* **量子状态可视化**：24 个 qubit 圆点动态显示当前电路活动
* **实时统计**：本会话挖到的区块、当前链高度、下一区块奖励、本月剩余配额、运行时长
* **链信息侧栏**：当前阶段（Bootstrap / 稳态）、难度阈值、抵押状态、bootstrap 剩余块数
* **实时日志**：量子作业提交、XEB 计算、出块成功一目了然
* **整链验证**：一键验证你本地链的完整性

---

## 技术栈

| 层 | 技术 |
|---|---|
| 桌面框架 | Electron 33+ |
| UI | 原生 HTML/CSS/JS（无框架，加载快） |
| 视觉 | 玻璃态卡片 + 紫青渐变 + 量子粒子背景 |
| 协议层 | 调用 [BTCQ Python 包](https://github.com/douyamv/BTCQ) 的 `scripts/propose.py` |
| 加密 | secp256k1 + keccak256（同 Ethereum） |

---

## 构建打包

```bash
# macOS .dmg + .zip
npm run build:mac

# Windows .exe + portable
npm run build:win

# Linux .AppImage + .deb
npm run build:linux

# 全平台
npm run build:all
```

输出在 `dist/` 目录。

---

## 设置

`⚙ 设置` 按钮可配置：

* **量子后端**：ibm_fez / ibm_marrakesh / ibm_kingston（皆为 Heron r2，156 qubits）
* **挖矿模式**：真量子机（推荐）或经典模拟（dev 用）
* **BTCQ 协议路径**：自动检测 `~/dd/qxeb`、`~/dd/BTCQ`、`~/BTCQ` 等

---

## 许可

MIT License — 见 [LICENSE](LICENSE)
