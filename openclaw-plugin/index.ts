/**
 * OpenViking Memory Bridge Plugin for OpenClaw
 *
 * Phase 1: Compaction Hook Integration
 *
 * On each compaction event:
 * 1. before_compaction — create/resume OpenViking session, ingest pre-compaction messages
 * 2. after_compaction — notify OpenViking of compaction completion
 *
 * On session end (idle/reset):
 * - commit session → OpenViking extracts long-term memories automatically
 *
 * Architecture:
 *   OpenClaw (Node.js) → HTTP → OpenViking Server (Python) → bge-m3 (Ollama) + DeepSeek
 */

// Plugin definition type - use duck typing to avoid import path issues
type PluginApi = {
  id: string;
  pluginConfig?: Record<string, unknown>;
  logger: { info: (msg: string) => void; warn: (msg: string) => void };
  registerHook: (
    events: string | string[],
    handler: (event: unknown, ctx: unknown) => Promise<void>,
  ) => void;
};

const OPENVIKING_DEFAULT_URL = "http://localhost:1933";
const SESSION_STATE_KEY = "openviking_session_id";

interface OVPluginConfig {
  enabled?: boolean;
  url?: string;
  autoStart?: boolean;
}

interface OVSessionState {
  sessionId: string | null;
  ingestedTurns: number;
  createdAt: number;
}

// In-memory session state (per gateway lifecycle)
const sessionStates = new Map<string, OVSessionState>();

async function ovFetch(
  baseUrl: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  try {
    const url = `${baseUrl.replace(/\/$/, "")}${path}`;
    const resp = await fetch(url, {
      method: body ? "POST" : "GET",
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) {
      return null;
    }
    return (await resp.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function ensureOVServer(
  url: string,
  logger: { warn: (msg: string) => void },
): Promise<boolean> {
  const health = await ovFetch(url, "/health");
  if (health && health.status === "ok") {
    return true;
  }
  logger.warn("[openviking] Server not reachable at " + url);
  return false;
}

async function getOrCreateSession(
  url: string,
  sessionKey: string,
  logger: { info: (msg: string) => void; warn: (msg: string) => void },
): Promise<string | null> {
  const existing = sessionStates.get(sessionKey);
  if (existing?.sessionId) {
    return existing.sessionId;
  }

  const result = await ovFetch(url, "/api/v1/sessions", {
    metadata: { source: "openclaw", session_key: sessionKey },
  });
  if (!result?.session_id) {
    logger.warn("[openviking] Failed to create session");
    return null;
  }

  const sessionId = String(result.session_id);
  sessionStates.set(sessionKey, {
    sessionId,
    ingestedTurns: 0,
    createdAt: Date.now(),
  });
  logger.info(`[openviking] Created session ${sessionId} for ${sessionKey}`);
  return sessionId;
}

async function ingestMessages(
  url: string,
  sessionId: string,
  messages: unknown[],
  logger: { info: (msg: string) => void; warn: (msg: string) => void },
): Promise<void> {
  // Extract text content from messages for OpenViking ingestion
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    const m = msg as Record<string, unknown>;
    const role = String(m.role ?? "user");
    let content = "";

    if (typeof m.content === "string") {
      content = m.content;
    } else if (Array.isArray(m.content)) {
      content = (m.content as Array<Record<string, unknown>>)
        .filter((b) => b.type === "text")
        .map((b) => String(b.text ?? ""))
        .join("\n");
    }

    if (!content.trim()) continue;

    // Truncate very long messages to avoid overwhelming the session
    const truncated = content.length > 4000 ? content.slice(0, 4000) + "\n[...truncated]" : content;

    await ovFetch(url, `/api/v1/sessions/${sessionId}/messages`, {
      role: role === "assistant" ? "assistant" : "user",
      content: truncated,
    });
  }
}

async function commitSession(
  url: string,
  sessionId: string,
  logger: { info: (msg: string) => void; warn: (msg: string) => void },
): Promise<void> {
  const result = await ovFetch(url, `/api/v1/sessions/${sessionId}/commit`, {});
  const extracted = (result as Record<string, unknown>)?.memories_extracted ?? 0;
  logger.info(`[openviking] Session ${sessionId} committed, memories extracted: ${extracted}`);
}

const plugin = {
  id: "openviking",
  name: "OpenViking Memory Bridge",
  description: "Syncs compaction data to OpenViking for automatic long-term memory extraction",
  version: "0.1.0",

  register(api: PluginApi) {
    const pluginCfg = (api.pluginConfig ?? {}) as OVPluginConfig;
    const ovUrl = pluginCfg.url ?? OPENVIKING_DEFAULT_URL;
    const enabled = pluginCfg.enabled !== false;

    if (!enabled) {
      api.logger.info("[openviking] Plugin disabled via config");
      return;
    }

    api.logger.info(`[openviking] Registering hooks, server: ${ovUrl}`);

    // Hook: before_compaction
    // Ingest pre-compaction messages into OpenViking session
    api.registerHook("before_compaction", async (_event, ctx) => {
      const event = _event as {
        messageCount: number;
        compactingCount?: number;
        messages?: unknown[];
        sessionFile?: string;
      };

      const sessionKey = ((ctx as Record<string, unknown>).sessionKey as string) ?? "main";

      // Check server availability (non-blocking, fail gracefully)
      const serverOk = await ensureOVServer(ovUrl, api.logger);
      if (!serverOk) return;

      const ovSessionId = await getOrCreateSession(ovUrl, sessionKey, api.logger);
      if (!ovSessionId) return;

      // Ingest messages if available
      if (event.messages && event.messages.length > 0) {
        api.logger.info(
          `[openviking] Ingesting ${event.messages.length} messages into session ${ovSessionId}`,
        );
        await ingestMessages(ovUrl, ovSessionId, event.messages, api.logger);

        const state = sessionStates.get(sessionKey);
        if (state) {
          state.ingestedTurns += 1;
        }
      }
    });

    // Hook: after_compaction
    // Log compaction completion; optionally commit if turn count is high
    api.registerHook("after_compaction", async (_event, ctx) => {
      const event = _event as {
        messageCount: number;
        tokenCount?: number;
        compactedCount: number;
        sessionFile?: string;
      };

      const sessionKey = ((ctx as Record<string, unknown>).sessionKey as string) ?? "main";
      const state = sessionStates.get(sessionKey);

      api.logger.info(
        `[openviking] Compaction complete: ${event.compactedCount} messages compacted, ` +
          `${event.messageCount} remaining. Ingested turns: ${state?.ingestedTurns ?? 0}`,
      );

      // Auto-commit after N compaction cycles to extract memories periodically
      if (state && state.ingestedTurns >= 3) {
        const serverOk = await ensureOVServer(ovUrl, api.logger);
        if (serverOk && state.sessionId) {
          api.logger.info(
            `[openviking] Auto-committing session after ${state.ingestedTurns} turns`,
          );
          await commitSession(ovUrl, state.sessionId, api.logger);

          // Reset: create new session for next batch
          sessionStates.delete(sessionKey);
        }
      }
    });

    // Hook: before_reset (session clear)
    // Commit any pending session data before reset
    api.registerHook("before_reset", async (_event, ctx) => {
      const sessionKey = ((ctx as Record<string, unknown>).sessionKey as string) ?? "main";
      const state = sessionStates.get(sessionKey);

      if (state?.sessionId && state.ingestedTurns > 0) {
        const serverOk = await ensureOVServer(ovUrl, api.logger);
        if (serverOk) {
          api.logger.info(`[openviking] Committing session before reset`);
          await commitSession(ovUrl, state.sessionId, api.logger);
        }
        sessionStates.delete(sessionKey);
      }
    });
  },
};

export default plugin;
