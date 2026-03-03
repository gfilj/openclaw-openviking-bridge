# OpenClaw × OpenViking 集成方案

> 让 OpenClaw 拥有真正的长期记忆 — 基于 OpenViking 上下文数据库

## 这是什么？

[OpenViking](https://github.com/volcengine/OpenViking) 是字节跳动开源的 **Agent 上下文数据库**，采用文件系统范式统一管理 Agent 的记忆、资源和技能。

本方案将 OpenViking 作为 OpenClaw 的 **长期记忆后端**，在每次 compaction（上下文压缩）时自动将对话内容存入 OpenViking，由其提取长期记忆并提供语义检索。

### 架构

```
OpenClaw Agent
  ↓ (compaction hook)
OpenViking Plugin (Node.js)
  ↓ (HTTP API)
OpenViking Server (Python)
  ├── bge-m3 Embedding (Ollama, 本地)
  └── DeepSeek/其他 VLM (用于记忆提取)
```

### 效果

- `memory_search` 工具的检索结果来自 OpenViking 的向量数据库
- Agent 对话被 compaction 时，自动 ingest 到 OpenViking
- OpenViking 自动从对话中提取结构化长期记忆
- L0/L1/L2 三层上下文按需加载，节省 token

---

## 前置要求

| 依赖 | 版本 | 用途 |
|------|------|------|
| OpenClaw | 最新版 | AI Agent 框架 |
| Python | ≥ 3.10 | OpenViking 运行时 |
| Ollama | 最新版 | 本地 embedding 模型 |
| cmake + Rust (可选) | - | OpenViking 编译 C++ 扩展 |
| DeepSeek API Key | - | VLM 记忆提取（可换其他模型） |

---

## 安装步骤

### 方式一：自动安装脚本

```bash
curl -fsSL https://raw.githubusercontent.com/YOUR_REPO/install.sh | bash
```

或者下载后本地执行：

```bash
git clone https://github.com/YOUR_REPO/openclaw-openviking-bridge.git
cd openclaw-openviking-bridge
./install.sh
```

### 方式二：手动安装

按以下步骤逐步操作。

---

### Step 1: 安装 Ollama + bge-m3 embedding 模型

```bash
# 安装 Ollama（如已安装跳过）
curl -fsSL https://ollama.com/install.sh | sh

# 拉取 bge-m3 embedding 模型（约 1.2GB）
ollama pull bge-m3

# 验证
ollama list | grep bge-m3
```

### Step 2: 安装 OpenViking

```bash
# 克隆仓库
git clone https://github.com/volcengine/OpenViking.git
cd OpenViking

# 创建虚拟环境
python3 -m venv .venv
source .venv/bin/activate

# 安装（包含 C++ 扩展编译，需要 cmake）
pip install -e .
```

> ⚠️ 编译需要 cmake。macOS: `brew install cmake`，Ubuntu: `apt install cmake`

### Step 3: 配置 OpenViking

```bash
# 创建配置目录
mkdir -p ~/.openviking

# 写入配置文件
cat > ~/.openviking/ov.conf << 'EOF'
{
  "storage": {
    "workspace": "~/.openviking/workspace"
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
    "api_key": "YOUR_DEEPSEEK_API_KEY",
    "api_base": "https://api.deepseek.com"
  }
}
EOF
```

**替换 `YOUR_DEEPSEEK_API_KEY`** 为你的 DeepSeek API Key。

> 💡 也可以用其他 VLM 提供商（OpenAI、Anthropic、智谱等），参考 [OpenViking 文档](https://github.com/volcengine/OpenViking#supported-vlm-providers)。

### Step 4: 启动 OpenViking Server

#### 手动启动（测试用）

```bash
cd /path/to/OpenViking
source .venv/bin/activate
python -m openviking serve --port 1933 --config ~/.openviking/ov.conf
```

#### macOS launchd 自启（推荐）

```bash
cat > ~/Library/LaunchAgents/dev.openviking.server.plist << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>dev.openviking.server</string>
    <key>ProgramArguments</key>
    <array>
        <string>$(pwd)/.venv/bin/python3</string>
        <string>-m</string>
        <string>openviking</string>
        <string>serve</string>
        <string>--port</string>
        <string>1933</string>
        <string>--config</string>
        <string>$HOME/.openviking/ov.conf</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$(pwd)</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>$HOME/.openviking/server.log</string>
    <key>StandardErrorPath</key>
    <string>$HOME/.openviking/server.err</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    </dict>
</dict>
</plist>
EOF

# 加载并启动
launchctl load ~/Library/LaunchAgents/dev.openviking.server.plist

# 验证
curl -s http://localhost:1933/health
# 应返回: {"status": "ok"}
```

#### Linux systemd 自启

```bash
sudo cat > /etc/systemd/system/openviking.service << EOF
[Unit]
Description=OpenViking Context Database Server
After=network.target

[Service]
Type=simple
User=$USER
WorkingDirectory=/path/to/OpenViking
ExecStart=/path/to/OpenViking/.venv/bin/python3 -m openviking serve --port 1933 --config /home/$USER/.openviking/ov.conf
Restart=always
RestartSec=5
Environment=PATH=/usr/local/bin:/usr/bin:/bin

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now openviking
```

### Step 5: 配置 OpenClaw 插件

在 OpenClaw 配置文件 `~/.openclaw/openclaw.json` 中启用 OpenViking 插件：

```json
{
  "plugins": {
    "entries": {
      "openviking": {
        "enabled": true,
        "url": "http://localhost:1933"
      }
    }
  }
}
```

> 📝 OpenClaw 内置了 OpenViking 插件（`extensions/openviking/`），无需额外安装。只需在配置中启用即可。

### Step 6: 验证集成

```bash
# 1. 检查 OpenViking 健康状态
curl -s http://localhost:1933/health
# → {"status": "ok"}

# 2. 检查 Ollama bge-m3
curl -s http://localhost:11434/api/embeddings -d '{"model":"bge-m3","prompt":"test"}' | head -c 100
# → {"embedding": [0.012, -0.034, ...]}

# 3. 重启 OpenClaw Gateway 加载插件
openclaw gateway restart

# 4. 和 Agent 对话，等待 compaction 触发后查看日志
grep "openviking" /private/tmp/openclaw/openclaw-$(date +%Y-%m-%d).log | tail -5
# → [openviking] Created session xxx
# → [openviking] Ingesting N messages
```

---

## 工作原理

### Compaction Hook

OpenViking 插件监听 OpenClaw 的三个生命周期事件：

| 事件 | 触发时机 | 动作 |
|------|---------|------|
| `before_compaction` | 上下文压缩前 | 将待压缩的消息 ingest 到 OpenViking session |
| `after_compaction` | 压缩完成后 | 记录压缩状态，每 3 次 compaction 自动 commit |
| `before_reset` | 会话重置前 | commit 当前 session，触发记忆提取 |

### 记忆提取流程

```
对话消息 → ingest → OpenViking Session
                         ↓ (commit)
                    VLM 分析 → 提取结构化记忆
                         ↓
                    bge-m3 向量化 → 存入向量数据库
                         ↓
                    memory_search 语义检索
```

---

## 配置参考

### ov.conf 完整配置

```json
{
  "storage": {
    "workspace": "~/.openviking/workspace"
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
    "api_key": "YOUR_API_KEY",
    "api_base": "https://api.deepseek.com"
  }
}
```

### VLM 提供商选项

| 提供商 | provider | 推荐模型 | 备注 |
|--------|----------|---------|------|
| DeepSeek | `deepseek` | `deepseek-chat` | 性价比最高 |
| OpenAI | `openai` | `gpt-4o-mini` | 稳定 |
| Anthropic | `anthropic` | `claude-sonnet` | 质量最好 |
| 智谱 | `zhipu` | `glm-4-plus` | 国内推荐 |
| 通义 | `dashscope` | `qwen-max` | 国内备选 |

---

## 常见问题

### Q: OpenViking 编译失败？
A: 确保安装了 cmake 和 C++ 编译器：
- macOS: `xcode-select --install && brew install cmake`
- Ubuntu: `sudo apt install build-essential cmake`

### Q: bge-m3 embedding 太慢？
A: Ollama 首次加载模型需要时间，后续会缓存。如果 Mac 有 GPU (Apple Silicon)，Ollama 会自动使用 Metal 加速。

### Q: 可以用其他 embedding 模型吗？
A: 可以，修改 `ov.conf` 中 `embedding.dense` 的配置。但 bge-m3 是目前中英文混合检索效果最好的选择。

### Q: 如何查看 OpenViking 存储了哪些记忆？
A: 
```bash
# 查看 workspace 文件结构
ls -la ~/.openviking/workspace/
# 查看向量数据库
ls -la ~/.openviking/workspace/vectordb/
```

### Q: OpenClaw 插件没有加载？
A: 检查 `~/.openclaw/openclaw.json` 中 `plugins.entries.openviking` 配置，确保 `enabled: true`，然后重启 Gateway。

---

## 致谢

- [OpenViking](https://github.com/volcengine/OpenViking) — 字节跳动开源的 Agent 上下文数据库
- [OpenClaw](https://github.com/openclaw/openclaw) — AI Agent 框架
- [Ollama](https://ollama.com) — 本地模型运行时
- [bge-m3](https://huggingface.co/BAAI/bge-m3) — BAAI 开源的多语言 embedding 模型
