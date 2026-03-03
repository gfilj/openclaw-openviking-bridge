/**
 * OpenViking memory search integration.
 *
 * Provides a function to search OpenViking and return results
 * in the same format as the built-in memory search.
 */

import { createSubsystemLogger } from "../logging/subsystem.js";
import type { MemorySearchResult } from "../memory/types.js";
import type { OpenVikingConfig, VikingFindItem } from "./client.js";
import { getOpenVikingClient } from "./client.js";

const log = createSubsystemLogger("openviking:search");

function vikingItemToMemoryResult(item: VikingFindItem): MemorySearchResult {
  const snippet = item.abstract || item.overview || item.uri;
  return {
    path: item.uri,
    startLine: 0,
    endLine: 0,
    snippet,
    score: item.score,
    source: "memory" as const,
  };
}

/**
 * Search OpenViking and return results compatible with OpenClaw's MemorySearchResult format.
 */
export async function searchOpenViking(
  query: string,
  config?: OpenVikingConfig,
  options?: { maxResults?: number; minScore?: number },
): Promise<MemorySearchResult[]> {
  const client = getOpenVikingClient(config);
  if (!client) {
    return [];
  }

  try {
    const result = await client.find(query, { limit: options?.maxResults ?? 10 });

    // Merge all result types (memories, resources, skills)
    const allItems: VikingFindItem[] = [...result.memories, ...result.resources, ...result.skills];

    // Sort by score descending
    allItems.sort((a, b) => b.score - a.score);

    // Apply minScore filter
    const minScore = options?.minScore ?? 0;
    const filtered = allItems.filter((item) => item.score >= minScore);

    // Limit results
    const limited = filtered.slice(0, options?.maxResults ?? 10);

    return limited.map(vikingItemToMemoryResult);
  } catch (err) {
    log.warn(`OpenViking search failed: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/**
 * Merge OpenViking results with local memory search results.
 * Deduplicates by path/uri, preferring higher scores.
 */
export function mergeSearchResults(
  local: MemorySearchResult[],
  viking: MemorySearchResult[],
): MemorySearchResult[] {
  const seen = new Map<string, MemorySearchResult>();

  // Local results first
  for (const r of local) {
    const key = r.path;
    const existing = seen.get(key);
    if (!existing || (r.score ?? 0) > (existing.score ?? 0)) {
      seen.set(key, r);
    }
  }

  // Viking results (add if not duplicate or higher score)
  for (const r of viking) {
    const key = r.path;
    const existing = seen.get(key);
    if (!existing || (r.score ?? 0) > (existing.score ?? 0)) {
      seen.set(key, r);
    }
  }

  // Sort by score descending
  return Array.from(seen.values()).toSorted((a, b) => (b.score ?? 0) - (a.score ?? 0));
}
