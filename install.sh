#!/usr/bin/env bash
# BTCQ Miner 一键安装并启动 · macOS / Linux
# 用法: curl -fsSL https://raw.githubusercontent.com/douyamv/BTCQ-Miner/main/install.sh | bash

set -e

INSTALL_DIR="${INSTALL_DIR:-$HOME/.btcq-miner}"
REPO_URL="https://github.com/douyamv/BTCQ-Miner.git"

cyan()   { printf "\033[36m%s\033[0m\n" "$*"; }
green()  { printf "\033[32m%s\033[0m\n" "$*"; }
yellow() { printf "\033[33m%s\033[0m\n" "$*"; }
red()    { printf "\033[31m%s\033[0m\n" "$*"; }

echo ""
cyan "=========================================="
cyan "  ⚛  BTCQ Miner · 桌面客户端一键安装"
cyan "=========================================="
echo ""

# 1) 系统识别
case "$(uname -s)" in
  Darwin*) OS="macOS";;
  Linux*)  OS="Linux";;
  *)       red "暂不支持系统: $(uname -s)（请到 GitHub releases 下载二进制）"; exit 1;;
esac
green "✓ 检测到 $OS"

# 2) Node.js (需要 18+)
need_node=0
if command -v node >/dev/null 2>&1; then
  NODE_MAJOR=$(node -v | sed 's/v//' | cut -d. -f1)
  if [ "$NODE_MAJOR" -lt 18 ]; then
    yellow "⚠ Node 版本过低 ($(node -v))，需 Node 18+"
    need_node=1
  else
    green "✓ Node $(node -v)"
  fi
else
  yellow "⚠ 未检测到 Node.js"
  need_node=1
fi

if [ "$need_node" -eq 1 ]; then
  if [ "$OS" = "macOS" ]; then
    if ! command -v brew >/dev/null 2>&1; then
      red "请先安装 Homebrew:"
      red '  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"'
      exit 1
    fi
    cyan "▶ brew install node@20..."
    brew install node@20 2>&1 | tail -3
    brew link --overwrite --force node@20 2>/dev/null || true
  else
    cyan "▶ 通过 NodeSource 安装 Node 20..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y nodejs
  fi
  green "✓ Node $(node -v)"
fi

# 3) Git
if ! command -v git >/dev/null 2>&1; then
  yellow "⚠ 未检测到 git，自动安装..."
  if [ "$OS" = "macOS" ]; then
    xcode-select --install 2>/dev/null || true
  else
    sudo apt-get install -y git
  fi
fi
green "✓ Git $(git --version | awk '{print $3}')"

# 4) 下载/更新 BTCQ-Miner
if [ -d "$INSTALL_DIR/.git" ]; then
  cyan "▶ 已安装，更新代码..."
  git -C "$INSTALL_DIR" pull --rebase --quiet
else
  cyan "▶ 下载 BTCQ-Miner 到 $INSTALL_DIR"
  git clone --depth 1 "$REPO_URL" "$INSTALL_DIR" --quiet
fi
cd "$INSTALL_DIR"

# 5) 安装 npm 依赖
cyan "▶ 安装 npm 依赖（首次约 1–2 分钟）..."
npm install --silent --no-audit --no-fund 2>&1 | tail -3
green "✓ 依赖安装完成"

echo ""
cyan "=========================================="
green "  🎉 BTCQ Miner 已就绪"
cyan "=========================================="
echo ""
echo "  📍 安装位置:  $INSTALL_DIR"
echo "  ▶ 立即启动:  cd $INSTALL_DIR && npm start"
echo ""

# 6) 自动启动（除非传 --no-launch）
if [[ "$*" != *"--no-launch"* ]]; then
  cyan "▶ 启动 BTCQ Miner..."
  exec npm start
fi
