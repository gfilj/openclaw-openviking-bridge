# CLAUDE.md — OpenClaw × OpenViking 集成安装

> 给 Claude Code / Codex 等 AI 编程 Agent 的任务说明。
> 目标：在当前机器上安装并配置 OpenViking 作为 OpenClaw 的长期记忆后端。

## 项目结构

```
openclaw-openviking-bridge/
├── openclaw-plugin/          # OpenClaw 插件源码 → 复制到 extensions/openviking/
│   ├── index.ts              # compaction hook 逻辑
│   ├── openclaw.plugin.json
│   └── package.json
├── templates/                # 配置模板（占位符需替换）
│   ├── ov.conf.template
│   ├── agfs-config.yaml.template
│   ├── dev.openviking.server.plist.template  (macOS)
│   └── openviking.service.template           (Linux)
└── install.sh                # 或者直接执行这个脚本
```

## 执行计划

### Phase 1: 依赖安装

```bash
# 1. Ollama
# macOS:
brew install ollama
# Linux:
curl -fsSL https://ollama.com/install.sh | sh

# 2. 拉取 bge-m3 embedding 模型（~1.2GB）
ollama pull bge-m3

# 3. cmake（编译需要）
# macOS: brew install cmake
# Ubuntu: sudo apt install cmake build-essential
```

### Phase 2: OpenViking 安装

```bash
git clone https://github.com/volcengine/OpenViking.git ~/OpenViking
cd ~/OpenViking
python3 -m venv .venv
source .venv/bin/activate
pip install -e .
```

### Phase 3: 配置文件

1. 创建 `~/.openviking/` 目录
2. 从 `templates/ov.conf.template` 生成 `~/.openviking/ov.conf`：
   - 替换 `OPENVIKING_CONF_DIR` → `~/.openviking` 的绝对路径
   - 替换 `YOUR_DEEPSEEK_API_KEY` → 用户提供的 API Key（必须向用户询问）
3. 从 `templates/agfs-config.yaml.template` 生成 `~/.openviking/workspace/.agfs/config.yaml`：
   - 替换 `OPENVIKING_CONF_DIR` → 绝对路径

### Phase 4: 系统服务

**macOS:**
- 从 `templates/dev.openviking.server.plist.template` 生成 plist
- 替换所有占位符：`OPENVIKING_DIR`, `OPENVIKING_PORT`(默认1933), `OPENVIKING_CONF`, `OPENVIKING_CONF_DIR`
- `launchctl load ~/Library/LaunchAgents/dev.openviking.server.plist`

**Linux:**
- 从 `templates/openviking.service.template` 生成 service 文件
- 替换占位符 + `CURRENT_USER`
- `sudo systemctl daemon-reload && sudo systemctl enable --now openviking`

### Phase 5: OpenClaw 插件

1. **如果 OpenClaw 已内置插件**（检查 `extensions/openviking/` 是否存在）：
   - 只需在 `~/.openclaw/openclaw.json` 中启用
   
2. **如果没有内置插件**：
   - 复制 `openclaw-plugin/` → OpenClaw 的 `extensions/openviking/`

3. 在 `~/.openclaw/openclaw.json` 的 `plugins.entries` 中添加：
```json
"openviking": {
  "enabled": true,
  "config": {
    "url": "http://localhost:1933",
    "enabled": true
  }
}
```

4. 重启 Gateway: `openclaw gateway restart`

### Phase 6: 验证

```bash
# OpenViking 健康检查
curl http://localhost:1933/health
# 期望: {"status": "ok"}

# Ollama embedding 验证
curl http://localhost:11434/api/embeddings -d '{"model":"bge-m3","prompt":"test"}' | head -c 50
# 期望: {"embedding": [0.01...

# OpenClaw 插件加载日志
grep "openviking" /private/tmp/openclaw/openclaw-$(date +%Y-%m-%d).log | tail -5
# 期望: [openviking] Registering hooks, server: http://localhost:1933
```

## 注意事项

- VLM API Key **必须**向用户询问，不要跳过
- OpenViking 编译需要 cmake 和 C++ 编译器
- Ollama 需要先启动（macOS 是 App，Linux 是 systemd service）
- 端口：OpenViking 1933, AGFS 1833, Ollama 11434
- 插件是 fail-safe 的：OpenViking 挂了不影响 OpenClaw 正常运行
