# CLAUDE.md — OpenClaw × OpenViking 集成安装

> 这是给 Claude Code / Codex 等 AI 编程 Agent 的任务说明。
> 目标：在当前机器上安装并配置 OpenViking 作为 OpenClaw 的长期记忆后端。

## 背景

OpenViking 是字节跳动开源的 Agent 上下文数据库（https://github.com/volcengine/OpenViking）。
OpenClaw 内置了 OpenViking 插件，在 compaction 时自动将对话同步到 OpenViking，由其提取长期记忆。

## 你需要做的

### 1. 安装依赖

```bash
# Ollama（本地 embedding）
# macOS:
brew install ollama
# Linux:
curl -fsSL https://ollama.com/install.sh | sh

# 拉取 bge-m3 embedding 模型
ollama pull bge-m3

# 确保 cmake 已安装
# macOS: brew install cmake
# Ubuntu: sudo apt install cmake build-essential
```

### 2. 安装 OpenViking

```bash
git clone https://github.com/volcengine/OpenViking.git ~/OpenViking
cd ~/OpenViking
python3 -m venv .venv
source .venv/bin/activate
pip install -e .
```

### 3. 配置 OpenViking

创建 `~/.openviking/ov.conf`：

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
    "api_key": "<用户需要提供 DeepSeek API Key>",
    "api_base": "https://api.deepseek.com"
  }
}
```

⚠️ VLM 的 API Key 需要用户提供。如果用户没有 DeepSeek，也支持 OpenAI、Anthropic、智谱等。

### 4. 设置系统服务

**macOS (launchd):**

创建 `~/Library/LaunchAgents/dev.openviking.server.plist`，内容参考 install.sh 中的模板。
关键参数：
- ProgramArguments: `~/OpenViking/.venv/bin/python3 -m openviking serve --port 1933 --config ~/.openviking/ov.conf`
- WorkingDirectory: `~/OpenViking`
- KeepAlive: true
- RunAtLoad: true

```bash
launchctl load ~/Library/LaunchAgents/dev.openviking.server.plist
```

**Linux (systemd):**

创建 `/etc/systemd/system/openviking.service`，然后 `systemctl enable --now openviking`

### 5. 配置 OpenClaw 插件

在 `~/.openclaw/openclaw.json` 的 `plugins.entries` 中添加：

```json
"openviking": {
  "enabled": true,
  "url": "http://localhost:1933"
}
```

然后重启 Gateway: `openclaw gateway restart`

### 6. 验证

```bash
# OpenViking 健康检查
curl http://localhost:1933/health
# → {"status": "ok"}

# 检查 OpenClaw 日志中的插件加载
grep "openviking" /private/tmp/openclaw/openclaw-$(date +%Y-%m-%d).log | tail -5
```

## 注意事项

- OpenViking 编译需要 cmake 和 C++ 编译器
- Ollama 需要先启动（macOS 上是一个 app，Linux 上是 systemd 服务）
- bge-m3 模型约 1.2GB，首次加载较慢
- 端口 1933 是默认端口，可通过环境变量 OPENVIKING_PORT 修改
- VLM API Key 必须有效，否则记忆提取会失败（但不影响基础运行）
