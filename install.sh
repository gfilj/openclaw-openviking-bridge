#!/usr/bin/env bash
set -euo pipefail

# ============================================================
# OpenClaw × OpenViking 一键安装脚本
# 
# 安装内容：
#   1. Ollama + bge-m3 embedding 模型
#   2. OpenViking (Python, 从源码编译)
#   3. OpenViking 配置文件
#   4. 系统服务（macOS launchd / Linux systemd）
#   5. OpenClaw 插件配置
# ============================================================

OPENVIKING_REPO="https://github.com/volcengine/OpenViking.git"
OPENVIKING_DIR="${OPENVIKING_DIR:-$HOME/OpenViking}"
OPENVIKING_PORT="${OPENVIKING_PORT:-1933}"
OPENVIKING_CONF_DIR="$HOME/.openviking"
OPENVIKING_CONF="$OPENVIKING_CONF_DIR/ov.conf"
OPENCLAW_CONF="$HOME/.openclaw/openclaw.json"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log()   { echo -e "${GREEN}[✓]${NC} $*"; }
warn()  { echo -e "${YELLOW}[!]${NC} $*"; }
err()   { echo -e "${RED}[✗]${NC} $*"; exit 1; }
info()  { echo -e "${BLUE}[i]${NC} $*"; }

# ---- Pre-flight checks ----

check_python() {
    if command -v python3 &>/dev/null; then
        local ver
        ver=$(python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')
        local major minor
        major=$(echo "$ver" | cut -d. -f1)
        minor=$(echo "$ver" | cut -d. -f2)
        if [ "$major" -ge 3 ] && [ "$minor" -ge 10 ]; then
            log "Python $ver ✓"
            return 0
        fi
    fi
    err "需要 Python ≥ 3.10。请安装后重试。"
}

check_cmake() {
    if command -v cmake &>/dev/null; then
        log "cmake $(cmake --version | head -1 | awk '{print $3}') ✓"
        return 0
    fi
    warn "cmake 未安装，尝试自动安装..."
    if [[ "$OSTYPE" == "darwin"* ]]; then
        if command -v brew &>/dev/null; then
            brew install cmake
        else
            err "需要 Homebrew 来安装 cmake。运行: /bin/bash -c \"\$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\""
        fi
    elif command -v apt &>/dev/null; then
        sudo apt update && sudo apt install -y cmake build-essential
    elif command -v yum &>/dev/null; then
        sudo yum install -y cmake gcc-c++ make
    else
        err "无法自动安装 cmake，请手动安装后重试。"
    fi
    log "cmake 已安装 ✓"
}

check_ollama() {
    if command -v ollama &>/dev/null; then
        log "Ollama 已安装 ✓"
        return 0
    fi
    warn "Ollama 未安装，正在安装..."
    if [[ "$OSTYPE" == "darwin"* ]]; then
        if command -v brew &>/dev/null; then
            brew install ollama
        else
            err "请从 https://ollama.com 下载安装 Ollama"
        fi
    else
        curl -fsSL https://ollama.com/install.sh | sh
    fi
    log "Ollama 已安装 ✓"
}

# ---- Step 1: Ollama + bge-m3 ----

setup_embedding() {
    info "Step 1/5: 设置 embedding 模型..."
    check_ollama

    # Ensure Ollama is running
    if ! curl -s http://localhost:11434/api/tags &>/dev/null; then
        warn "Ollama 未运行，尝试启动..."
        if [[ "$OSTYPE" == "darwin"* ]]; then
            open -a Ollama || ollama serve &
        else
            ollama serve &
        fi
        sleep 3
    fi

    # Pull bge-m3
    if ollama list 2>/dev/null | grep -q "bge-m3"; then
        log "bge-m3 已存在 ✓"
    else
        info "拉取 bge-m3 模型（约 1.2GB）..."
        ollama pull bge-m3
        log "bge-m3 拉取完成 ✓"
    fi
}

# ---- Step 2: Install OpenViking ----

install_openviking() {
    info "Step 2/5: 安装 OpenViking..."
    check_python
    check_cmake

    if [ -d "$OPENVIKING_DIR" ]; then
        warn "OpenViking 目录已存在: $OPENVIKING_DIR"
        read -rp "是否更新？(y/N) " update
        if [[ "$update" =~ ^[Yy]$ ]]; then
            cd "$OPENVIKING_DIR"
            git pull
        fi
    else
        info "克隆 OpenViking..."
        git clone "$OPENVIKING_REPO" "$OPENVIKING_DIR"
    fi

    cd "$OPENVIKING_DIR"

    # Create venv
    if [ ! -d ".venv" ]; then
        info "创建 Python 虚拟环境..."
        python3 -m venv .venv
    fi

    source .venv/bin/activate
    info "编译安装 OpenViking（可能需要几分钟）..."
    pip install -e . 2>&1 | tail -5
    log "OpenViking 安装完成 ✓"
}

# ---- Step 3: Configure ----

configure_openviking() {
    info "Step 3/5: 配置 OpenViking..."
    mkdir -p "$OPENVIKING_CONF_DIR"

    if [ -f "$OPENVIKING_CONF" ]; then
        warn "配置文件已存在: $OPENVIKING_CONF"
        read -rp "是否覆盖？(y/N) " overwrite
        if [[ ! "$overwrite" =~ ^[Yy]$ ]]; then
            log "保留现有配置 ✓"
            return 0
        fi
    fi

    # Ask for VLM API key
    echo ""
    info "OpenViking 需要一个 VLM（大语言模型）API 来提取记忆。"
    info "推荐使用 DeepSeek（便宜好用），也支持 OpenAI、Anthropic、智谱等。"
    echo ""
    read -rp "请输入 DeepSeek API Key（留空跳过，稍后手动配置）: " api_key

    if [ -z "$api_key" ]; then
        api_key="YOUR_API_KEY_HERE"
        warn "API Key 未设置，请稍后编辑 $OPENVIKING_CONF"
    fi

    cat > "$OPENVIKING_CONF" << CONF
{
  "storage": {
    "workspace": "$OPENVIKING_CONF_DIR/workspace"
  },
  "log": {
    "level": "INFO",
    "output": "stdout"
  },
  "embedding": {
    "dense": {
      "provider": "openai",
      "model": "bge-m3",
      "dimension": 1024,
      "api_key": "ollama",
      "api_base": "http://localhost:11434/v1"
    }
  },
  "vlm": {
    "provider": "deepseek",
    "model": "deepseek-chat",
    "api_key": "$api_key",
    "api_base": "https://api.deepseek.com"
  }
}
CONF

    log "配置文件已写入: $OPENVIKING_CONF ✓"
}

# ---- Step 4: System service ----

setup_service() {
    info "Step 4/5: 配置系统服务..."

    local python_path="$OPENVIKING_DIR/.venv/bin/python3"

    if [[ "$OSTYPE" == "darwin"* ]]; then
        # macOS launchd
        local plist="$HOME/Library/LaunchAgents/dev.openviking.server.plist"

        cat > "$plist" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>dev.openviking.server</string>
    <key>ProgramArguments</key>
    <array>
        <string>$python_path</string>
        <string>-m</string>
        <string>openviking</string>
        <string>serve</string>
        <string>--port</string>
        <string>$OPENVIKING_PORT</string>
        <string>--config</string>
        <string>$OPENVIKING_CONF</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$OPENVIKING_DIR</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>$OPENVIKING_CONF_DIR/server.log</string>
    <key>StandardErrorPath</key>
    <string>$OPENVIKING_CONF_DIR/server.err</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    </dict>
</dict>
</plist>
PLIST

        # Load service
        launchctl unload "$plist" 2>/dev/null || true
        launchctl load "$plist"
        log "macOS launchd 服务已配置并启动 ✓"

    elif command -v systemctl &>/dev/null; then
        # Linux systemd
        sudo tee /etc/systemd/system/openviking.service > /dev/null << SERVICE
[Unit]
Description=OpenViking Context Database Server
After=network.target

[Service]
Type=simple
User=$USER
WorkingDirectory=$OPENVIKING_DIR
ExecStart=$python_path -m openviking serve --port $OPENVIKING_PORT --config $OPENVIKING_CONF
Restart=always
RestartSec=5
Environment=PATH=/usr/local/bin:/usr/bin:/bin

[Install]
WantedBy=multi-user.target
SERVICE

        sudo systemctl daemon-reload
        sudo systemctl enable --now openviking
        log "Linux systemd 服务已配置并启动 ✓"
    else
        warn "未识别的系统服务管理器，请手动启动:"
        echo "  cd $OPENVIKING_DIR && source .venv/bin/activate"
        echo "  python -m openviking serve --port $OPENVIKING_PORT --config $OPENVIKING_CONF"
    fi

    # Wait and verify
    info "等待服务启动..."
    sleep 3
    if curl -s "http://localhost:$OPENVIKING_PORT/health" | grep -q "ok"; then
        log "OpenViking 服务运行正常 ✓"
    else
        warn "服务可能还在启动中，请稍后检查: curl http://localhost:$OPENVIKING_PORT/health"
    fi
}

# ---- Step 5: OpenClaw plugin ----

configure_openclaw() {
    info "Step 5/5: 配置 OpenClaw 插件..."

    if [ ! -f "$OPENCLAW_CONF" ]; then
        warn "OpenClaw 配置文件不存在: $OPENCLAW_CONF"
        warn "请手动在 OpenClaw 配置中添加以下内容:"
        cat << 'HINT'

  "plugins": {
    "entries": {
      "openviking": {
        "enabled": true,
        "url": "http://localhost:1933"
      }
    }
  }

HINT
        return 0
    fi

    # Check if already configured
    if python3 -c "
import json
with open('$OPENCLAW_CONF') as f:
    cfg = json.load(f)
ov = cfg.get('plugins',{}).get('entries',{}).get('openviking',{})
if ov.get('enabled'): exit(0)
exit(1)
" 2>/dev/null; then
        log "OpenClaw 插件已配置 ✓"
        return 0
    fi

    # Add plugin config
    python3 << PYEOF
import json

with open('$OPENCLAW_CONF', 'r') as f:
    cfg = json.load(f)

plugins = cfg.setdefault('plugins', {})
entries = plugins.setdefault('entries', {})
entries['openviking'] = {
    'enabled': True,
    'url': 'http://localhost:$OPENVIKING_PORT'
}

with open('$OPENCLAW_CONF', 'w') as f:
    json.dump(cfg, f, indent=2, ensure_ascii=False)
    f.write('\n')

print('OpenClaw 配置已更新')
PYEOF

    log "OpenClaw 插件已启用 ✓"
    warn "请重启 OpenClaw Gateway 加载插件: openclaw gateway restart"
}

# ---- Main ----

main() {
    echo ""
    echo -e "${BLUE}╔══════════════════════════════════════════╗${NC}"
    echo -e "${BLUE}║  OpenClaw × OpenViking 集成安装脚本     ║${NC}"
    echo -e "${BLUE}╚══════════════════════════════════════════╝${NC}"
    echo ""

    setup_embedding
    echo ""
    install_openviking
    echo ""
    configure_openviking
    echo ""
    setup_service
    echo ""
    configure_openclaw

    echo ""
    echo -e "${GREEN}════════════════════════════════════════════${NC}"
    echo -e "${GREEN}  安装完成！${NC}"
    echo -e "${GREEN}════════════════════════════════════════════${NC}"
    echo ""
    echo "  OpenViking Server: http://localhost:$OPENVIKING_PORT"
    echo "  配置文件: $OPENVIKING_CONF"
    echo "  日志: $OPENVIKING_CONF_DIR/server.log"
    echo ""
    echo "  验证命令:"
    echo "    curl http://localhost:$OPENVIKING_PORT/health"
    echo ""
    echo "  下一步:"
    echo "    1. 重启 OpenClaw Gateway: openclaw gateway restart"
    echo "    2. 和 Agent 对话，compaction 触发后自动同步记忆"
    echo ""
}

main "$@"
