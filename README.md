# OpenClaw × OpenViking 集成方案

> 让 OpenClaw 拥有真正的长期记忆 — 基于 OpenViking 上下文数据库

## 这是什么？

[OpenViking](https://github.com/volcengine/OpenViking) 是字节跳动开源的 **Agent 上下文数据库**，采用文件系统范式统一管理 Agent 的记忆、资源和技能。

本方案将 OpenViking 作为 OpenClaw 的 **长期记忆后端**，在每次 compaction（上下文压缩）时自动将对话内容存入 OpenViking，由其提取长期记忆并提供语义检索。

## 项目结构

```
openclaw-openviking-bridge/
├── README.md                 # 本文档
├── CLAUDE.md                 # AI coding agent 任务说明（Claude Code / Codex）
├── install.sh                # 一键安装脚本（macOS / Linux）
├── openclaw-plugin/          # OpenClaw 插件源码（核心集成代码）
│   ├── index.ts              # 插件主逻辑（compaction hook）
│   ├── openclaw.plugin.json  # 插件元数据
│   └── package.json          # 包配置
└── templates/                # 配置模板
    ├── ov.conf.template               # OpenViking 服务配置
    ├── agfs-config.yaml.template      # AGFS 文件系统配置
    ├── dev.openviking.server.plist.template  # macOS launchd 服务
    └── openviking.service.template    # Linux systemd 服务
```

## 架构

```
OpenClaw Agent
  │
  ├─ compaction 触发 ──→ OpenViking Plugin (openclaw-plugin/index.ts)
  │                         │
  │                         ├─ before_compaction: ingest 待压缩消息
  │                         ├─ after_compaction:  每3次自动 commit
  │                         └─ before_reset:     commit + 提取记忆
  │                         │
  │                         ▼ (HTTP API, port 1933)
  │                    OpenViking Server (Python)
  │                         │
  │                         ├─ bge-m3 Embedding (Ollama 本地, port 11434)
  │                         ├─ DeepSeek VLM (记忆提取 + L0/L1 摘要)
  │                         └─ AGFS 文件系统 (port 1833)
  │                              │
  │                              ├─ /viking/resources/  资源文件
  │                              ├─ /viking/session/    会话记录
  │                              ├─ /viking/agent/      Agent 记忆/技能
  │                              └─ /viking/user/       用户记忆
  │
  └─ memory_search 调用 ──→ OpenViking 向量检索 (vectordb/)
```

### 数据流

```
对话消息 → compaction hook → ingest → OpenViking Session
                                           ↓ (commit)
                                      VLM 分析提取结构化记忆
                                           ↓
                                      bge-m3 向量化 → vectordb
                                           ↓
                                      memory_search 语义检索
```

### OpenViking 存储结构

安装后 `~/.openviking/workspace/` 会自动生成以下结构：

```
workspace/
├── .agfs/              # AGFS 文件系统配置
│   └── config.yaml
├── vectordb/           # 向量数据库（语义检索）
│   └── context/
├── temp/               # 临时文件
│   └── upload/
└── viking/             # 核心数据
    ├── resources/      # 资源（日志、配置、文档等）
    │   ├── daily-logs/ # 每日对话日志（按日期分目录）
    │   ├── config/     # 配置快照
    │   └── openclaw-memory/  # OpenClaw 记忆文件
    ├── session/        # 会话记录（每个 compaction session）
    ├── agent/          # Agent 维度
    │   ├── instructions/
    │   ├── memories/   # Agent 提取的长期记忆
    │   └── skills/
    └── user/           # 用户维度
        └── memories/   # 用户相关记忆
```

---

## 前置要求

| 依赖 | 版本 | 用途 |
|------|------|------|
| [OpenClaw](https://github.com/openclaw/openclaw) | 最新版 | AI Agent 框架 |
| Python | ≥ 3.10 | OpenViking 运行时 |
| [Ollama](https://ollama.com) | 最新版 | 本地 embedding 模型 |
| cmake + C++ 编译器 | - | OpenViking 编译 C++ 扩展 |
| VLM API Key | - | 记忆提取（DeepSeek/OpenAI/Anthropic 等） |

---

## 安装

### 方式一：一键安装

```bash
git clone https://github.com/gfilj/openclaw-openviking-bridge.git
cd openclaw-openviking-bridge
./install.sh
```

脚本会自动完成：
1. ✅ 检测/安装 Ollama + bge-m3
2. ✅ 克隆编译 OpenViking
3. ✅ 生成配置文件（交互式输入 API Key）
4. ✅ 配置系统服务（macOS launchd / Linux systemd）
5. ✅ 注入 OpenClaw 插件配置

### 方式二：交给 AI Agent

把 `CLAUDE.md` 的内容作为 prompt 丢给 Claude Code / Codex：

```bash
claude "$(cat CLAUDE.md)"
```

### 方式三：手动安装

<details>
<summary>展开手动步骤</summary>

#### Step 1: Ollama + bge-m3

```bash
# 安装 Ollama
# macOS: brew install ollama
# Linux: curl -fsSL https://ollama.com/install.sh | sh

# 拉取 embedding 模型（约 1.2GB）
ollama pull bge-m3
```

#### Step 2: 安装 OpenViking

```bash
git clone https://github.com/volcengine/OpenViking.git ~/OpenViking
cd ~/OpenViking
python3 -m venv .venv
source .venv/bin/activate
pip install -e .
```

> ⚠️ 需要 cmake：macOS `brew install cmake`，Ubuntu `apt install cmake build-essential`

#### Step 3: 配置

```bash
mkdir -p ~/.openviking

# 复制并编辑配置模板
cp templates/ov.conf.template ~/.openviking/ov.conf
# 编辑 ~/.openviking/ov.conf，替换：
#   - YOUR_DEEPSEEK_API_KEY → 你的 API Key
#   - OPENVIKING_CONF_DIR → ~/.openviking
```

**ov.conf 配置说明：**

```jsonc
{
  "storage": {
    "workspace": "~/.openviking/workspace"   // 数据存储目录
  },
  "embedding": {
    "dense": {
      "provider": "openai",     // Ollama 兼容 OpenAI 接口
      "model": "bge-m3",        // 中英文混合检索最佳
      "dimension": 1024,
      "api_key": "ollama",      // Ollama 不需要真实 key
      "api_base": "http://localhost:11434/v1"
    }
  },
  "vlm": {
    "provider": "deepseek",     // 用于记忆提取的 VLM
    "model": "deepseek-chat",
    "api_key": "YOUR_KEY",
    "api_base": "https://api.deepseek.com"
  }
}
```

#### Step 4: 启动服务

**macOS:**
```bash
# 用模板生成 plist，替换路径后：
cp templates/dev.openviking.server.plist.template ~/Library/LaunchAgents/dev.openviking.server.plist
# 编辑替换 OPENVIKING_DIR, OPENVIKING_PORT, OPENVIKING_CONF, OPENVIKING_CONF_DIR
launchctl load ~/Library/LaunchAgents/dev.openviking.server.plist
```

**Linux:**
```bash
sudo cp templates/openviking.service.template /etc/systemd/system/openviking.service
# 编辑替换路径
sudo systemctl daemon-reload
sudo systemctl enable --now openviking
```

#### Step 5: 配置 OpenClaw 插件

OpenClaw 已内置 OpenViking 插件。在 `~/.openclaw/openclaw.json` 中启用：

```json
{
  "plugins": {
    "entries": {
      "openviking": {
        "enabled": true,
        "config": {
          "url": "http://localhost:1933",
          "enabled": true
        }
      }
    }
  }
}
```

如果你的 OpenClaw 版本不含内置插件，将 `openclaw-plugin/` 目录复制到 OpenClaw 的 `extensions/` 下：

```bash
cp -r openclaw-plugin/ /path/to/openclaw/extensions/openviking/
```

#### Step 6: 验证

```bash
# OpenViking 健康检查
curl http://localhost:1933/health
# → {"status": "ok"}

# Ollama embedding
curl http://localhost:11434/api/embeddings -d '{"model":"bge-m3","prompt":"test"}' | head -c 50
# → {"embedding": [0.012, ...]}

# 重启 OpenClaw Gateway
openclaw gateway restart

# 查看插件加载日志
grep "openviking" /private/tmp/openclaw/openclaw-$(date +%Y-%m-%d).log | tail -5
```

</details>

---

## OpenClaw 插件详解

### 插件代码 (`openclaw-plugin/index.ts`)

插件监听 OpenClaw 的三个生命周期事件：

| Hook | 触发时机 | 行为 |
|------|---------|------|
| `before_compaction` | 上下文压缩前 | 创建/恢复 OpenViking session，ingest 待压缩消息 |
| `after_compaction` | 压缩完成后 | 累计 3 次 compaction 后自动 commit，触发记忆提取 |
| `before_reset` | 会话重置/清空前 | commit 当前 session，确保记忆不丢失 |

### 关键设计

- **Session 管理**：每个 OpenClaw session 对应一个 OpenViking session，在内存中维护映射
- **消息截断**：超过 4000 字符的单条消息会被截断，避免过载
- **Fail-safe**：OpenViking 不可用时静默失败，不影响 OpenClaw 正常运行
- **Auto-commit**：每 3 次 compaction 自动 commit，平衡时效性和 API 调用量

---

## VLM 提供商

OpenViking 用 VLM 从对话中提取结构化记忆。支持的提供商：

| 提供商 | provider 值 | 推荐模型 | 备注 |
|--------|------------|---------|------|
| DeepSeek | `deepseek` | `deepseek-chat` | **推荐**，性价比最高 |
| OpenAI | `openai` | `gpt-4o-mini` | 稳定可靠 |
| Anthropic | `anthropic` | `claude-sonnet` | 质量最好 |
| 智谱 | `zhipu` | `glm-4-plus` | 国内推荐 |
| 通义千问 | `dashscope` | `qwen-max` | 国内备选 |
| MiniMax | `minimax` | `abab6.5s-chat` | 国内备选 |
| Gemini | `gemini` | `gemini-pro` | Google |
| vLLM | `vllm` | 任意本地模型 | 完全本地 |

修改 `~/.openviking/ov.conf` 中的 `vlm` 部分即可切换。

---

## 端口说明

| 服务 | 默认端口 | 用途 |
|------|---------|------|
| OpenViking Server | 1933 | HTTP API（OpenClaw 插件 → OpenViking） |
| AGFS Server | 1833 | 文件系统接口（内部使用） |
| Ollama | 11434 | Embedding API（OpenViking → bge-m3） |

---

## 常见问题

### Q: OpenViking 编译失败？
确保安装了 cmake 和 C++ 编译器：
- macOS: `xcode-select --install && brew install cmake`
- Ubuntu: `sudo apt install build-essential cmake`

### Q: bge-m3 太慢？
首次加载需要时间。Apple Silicon Mac 会自动使用 Metal GPU 加速。

### Q: 可以不用 Ollama，用远程 embedding 吗？
可以，修改 `ov.conf` 的 `embedding.dense` 部分指向任何兼容 OpenAI embedding API 的服务。

### Q: OpenClaw 插件没加载？
1. 检查 `~/.openclaw/openclaw.json` 中 `plugins.entries.openviking.enabled` 为 `true`
2. 确保插件路径在 OpenClaw 的 plugins 搜索路径中
3. 重启 Gateway: `openclaw gateway restart`
4. 查看日志: `grep openviking /private/tmp/openclaw/openclaw-$(date +%Y-%m-%d).log`

### Q: 记忆没有被提取？
1. 检查 OpenViking 日志: `cat ~/.openviking/server.log | tail -20`
2. 确认 VLM API Key 有效
3. 至少需要 3 次 compaction 才会触发 auto-commit
4. 或手动触发: 重置 session 会立即 commit

### Q: 如何查看已提取的记忆？
```bash
# Agent 记忆
ls ~/.openviking/workspace/viking/agent/memories/

# 用户记忆
ls ~/.openviking/workspace/viking/user/memories/

# 日志
ls ~/.openviking/workspace/viking/resources/daily-logs/
```

---

## 致谢

- [OpenViking](https://github.com/volcengine/OpenViking) — 字节跳动开源的 Agent 上下文数据库
- [OpenClaw](https://github.com/openclaw/openclaw) — AI Agent 框架
- [Ollama](https://ollama.com) — 本地模型运行时
- [bge-m3](https://huggingface.co/BAAI/bge-m3) — BAAI 开源的多语言 embedding 模型
