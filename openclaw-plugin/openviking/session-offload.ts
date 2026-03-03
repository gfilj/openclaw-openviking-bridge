/**
 * OpenViking proactive session offload.
 *
 * Instead of waiting for compaction (when context is nearly full),
 * proactively offload older conversation turns to OpenViking.
 * This keeps the active context window small and reduces per-request token cost.
 *
 * Strategy:
 * - After each agent response, check how many turns are in context
 * - If turns exceed a threshold, offload the oldest turns to Viking
 * - Keep only the most recent N turns + Viking summary in context
 * - Offloaded turns are committed to Viking for memory extraction
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { OpenVikingConfig } from "./client.js";
import { getOpenVikingClient } from "./client.js";
import { shouldOffload, splitForOffload } from "./offload-utils.js";
import type { OffloadConfig } from "./offload-utils.js";

export { shouldOffload, splitForOffload } from "./offload-utils.js";
export type { OffloadConfig } from "./offload-utils.js";

const log = createSubsystemLogger("openviking:offload");

/** Max concurrent requests to OpenViking to avoid overloading the server */
const MAX_CONCURRENCY = 40;

/** Max content length before truncation (20k chars) */
const MAX_CONTENT_LENGTH = 20000;

/** Force commit interval (4 hours in ms) */
const FORCE_COMMIT_INTERVAL_MS = 4 * 60 * 60 * 1000;

/**
 * Run async tasks with limited concurrency.
 */
async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = [];
  let index = 0;

  async function worker(): Promise<void> {
    while (index < items.length) {
      const currentIndex = index++;
      const item = items[currentIndex];
      try {
        const result = await fn(item);
        results[currentIndex] = { status: "fulfilled", value: result };
      } catch (err) {
        results[currentIndex] = { status: "rejected", reason: err };
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

/** Map session keys to their Viking session IDs for offloading */
const offloadSessionMap = new Map<string, string>();

/** Track last commit time per session for force-commit logic */
const lastCommitTime = new Map<string, number>();

/** Session map persistence file */
const SESSION_MAP_FILE = ".openclaw/openviking-sessions.json";

/** Load persisted session map on startup */
async function loadSessionMap(): Promise<void> {
  try {
    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const file = path.join(os.default.homedir(), SESSION_MAP_FILE);
    const data = JSON.parse(await fs.default.readFile(file, "utf-8"));
    for (const [k, v] of Object.entries(data.sessions || {})) {
      offloadSessionMap.set(k, v as string);
    }
    for (const [k, v] of Object.entries(data.lastCommit || {})) {
      lastCommitTime.set(k, v as number);
    }
    log.info(`Loaded ${offloadSessionMap.size} persisted Viking sessions`);
  } catch {
    // File doesn't exist or invalid, start fresh
  }
}

/** Persist session map to disk */
async function saveSessionMap(): Promise<void> {
  try {
    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const file = path.join(os.default.homedir(), SESSION_MAP_FILE);
    await fs.default.mkdir(path.dirname(file), { recursive: true });
    await fs.default.writeFile(file, JSON.stringify({
      sessions: Object.fromEntries(offloadSessionMap),
      lastCommit: Object.fromEntries(lastCommitTime),
    }), "utf-8");
  } catch (err) {
    log.warn(`Failed to persist session map: ${err}`);
  }
}

// Load on module init
void loadSessionMap();

export interface OffloadResult {
  offloaded: number;
  kept: number;
  vikingSessionId?: string;
  memoriesExtracted?: number;
}

function messageRole(msg: AgentMessage): string {
  return (msg as { role?: string }).role ?? "unknown";
}

function messageContent(msg: AgentMessage): string {
  let text: string;
  const content = (msg as { content?: unknown }).content;
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    text = content
      .map((block: unknown) => {
        if (typeof block === "string") {
          return block;
        }
        if (block && typeof block === "object" && "text" in block) {
          return (block as { text: string }).text;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  } else {
    text = JSON.stringify(content ?? "");
  }
  // Truncate with completeness marker if too long
  if (text.length > MAX_CONTENT_LENGTH) {
    return text.slice(0, MAX_CONTENT_LENGTH) + "\n\n[...TRUNCATED, original length: " + text.length + " chars]";
  }
  return text;
}

/**
 * Offload older messages to OpenViking.
 * Returns offload result or null if nothing was offloaded.
 */
export async function offloadToViking(
  sessionKey: string,
  messages: AgentMessage[],
  ovConfig?: OpenVikingConfig,
  offloadConfig?: OffloadConfig,
): Promise<OffloadResult | null> {
  if (!ovConfig?.enabled) {
    return null;
  }

  const client = getOpenVikingClient(ovConfig);
  if (!client) {
    return null;
  }

  if (!shouldOffload(messages, offloadConfig)) {
    return null;
  }

  const { toOffload, toKeep } = splitForOffload(messages, offloadConfig);
  if (toOffload.length === 0) {
    return null;
  }

  try {
    // Get or create Viking session for offloading
    let vikingSessionId = offloadSessionMap.get(sessionKey);
    if (!vikingSessionId) {
      vikingSessionId = await client.createSession();
      offloadSessionMap.set(sessionKey, vikingSessionId);
      lastCommitTime.set(sessionKey, Date.now()); // Initialize commit time for new session
      void saveSessionMap();
    }

    // Check if force commit is needed (4+ hours since last commit)
    const lastCommit = lastCommitTime.get(sessionKey) ?? 0;
    const shouldForceCommit = Date.now() - lastCommit > FORCE_COMMIT_INTERVAL_MS;

    // Push messages to Viking with limited concurrency to avoid overloading the server
    const pushTasks = toOffload
      .map((msg) => ({ role: messageRole(msg), content: messageContent(msg) }))
      .filter(({ content }) => content && content.length >= 5);

    const results = await runWithConcurrency(pushTasks, MAX_CONCURRENCY, ({ role, content }) =>
      client.addMessage(vikingSessionId!, role, content!),
    );
    let pushed = 0;
    for (const r of results) {
      if (r.status === "fulfilled") pushed++;
      else log.warn(`Failed to push offload message: ${r.reason}`);
    }

    // Commit for memory extraction (either when messages pushed or force commit triggered)
    let memoriesExtracted = 0;
    const shouldCommit = pushed > 0 || shouldForceCommit;
    if (shouldCommit) {
      try {
        const result = await client.commitSession(vikingSessionId, { wait: false });
        memoriesExtracted = result.memories_extracted;
        lastCommitTime.set(sessionKey, Date.now());
        log.info(`Viking commit successful${shouldForceCommit ? " (force commit)" : ""}`);
      } catch (err) {
        log.warn(`Viking commit failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      // Reset session mapping (next offload creates new session)
      offloadSessionMap.delete(sessionKey);
      void saveSessionMap();
    }

    log.info(
      `Offloaded ${pushed} messages for ${sessionKey}, keeping ${toKeep.length}. ` +
        `Memories extracted: ${memoriesExtracted}`,
    );

    return {
      offloaded: pushed,
      kept: toKeep.length,
      vikingSessionId,
      memoriesExtracted,
    };
  } catch (err) {
    log.warn(
      `Offload failed for ${sessionKey}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}
