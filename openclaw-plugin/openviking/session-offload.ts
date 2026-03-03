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

import { shouldOffload, splitForOffload } from "./offload-utils.js";
import type { OffloadConfig } from "./offload-utils.js";
import type { OpenVikingClient } from "./client.js";

export { shouldOffload, splitForOffload } from "./offload-utils.js";
export type { OffloadConfig } from "./offload-utils.js";

/** Max concurrent requests to OpenViking to avoid overloading the server */
const MAX_CONCURRENCY = 40;

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

export interface OffloadResult {
  offloaded: number;
  kept: number;
  vikingSessionId?: string;
  memoriesExtracted?: number;
}

export interface AgentMessage {
  role?: string;
  content?: unknown;
}

function messageRole(msg: AgentMessage): string {
  return msg.role ?? "unknown";
}

function messageContent(msg: AgentMessage): string {
  const content = msg.content;
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
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
  }
  return JSON.stringify(content ?? "");
}

export interface OpenVikingConfig {
  enabled?: boolean;
  url?: string;
}

/**
 * Offload older messages to OpenViking.
 * Returns offload result or null if nothing was offloaded.
 */
export async function offloadToViking(
  sessionKey: string,
  messages: AgentMessage[],
  client: OpenVikingClient,
  offloadConfig?: OffloadConfig,
  log?: { warn: (msg: string) => void; info: (msg: string) => void },
): Promise<OffloadResult | null> {
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
    }

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
      else log?.warn(`Failed to push offload message: ${r.reason}`);
    }

    // Commit for memory extraction
    let memoriesExtracted = 0;
    if (pushed > 0) {
      try {
        const result = await client.commitSession(vikingSessionId, { wait: false });
        memoriesExtracted = result.memories_extracted;
      } catch (err) {
        log?.warn(`Viking commit failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      // Reset session mapping (next offload creates new session)
      offloadSessionMap.delete(sessionKey);
    }

    log?.info(
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
    log?.warn(
      `Offload failed for ${sessionKey}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}
