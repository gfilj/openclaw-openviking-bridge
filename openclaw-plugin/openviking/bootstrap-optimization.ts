/**
 * OpenViking bootstrap optimization.
 *
 * Replaces full MEMORY.md content with OpenViking L0 abstract in system prompt,
 * reducing token consumption by ~90% for this file while preserving context
 * through on-demand retrieval via memory_search.
 */

import type { OpenVikingClient } from "./client.js";

/** Default Viking URI for MEMORY.md resource */
const MEMORY_RESOURCE_URI = "viking://resources/openclaw-memory";

/**
 * Attempt to replace MEMORY.md full content with an OpenViking L0 abstract.
 *
 * Returns the L0 abstract with a note that full content is available via memory_search,
 * or null if OpenViking is unavailable / not configured (caller should fall back to full content).
 */
export async function getMemoryAbstract(
  client: OpenVikingClient,
  log?: { debug: (msg: string) => void },
): Promise<string | null> {
  try {
    // Check if memory resource exists in Viking
    const entries = await client.ls(MEMORY_RESOURCE_URI);
    if (!entries || entries.length === 0) {
      return null;
    }

    // Get L0 abstract of the first (and usually only) child directory
    const firstDir = entries.find((e) => e.isDir);
    if (!firstDir) {
      return null;
    }

    const abstract = await client.abstract(firstDir.uri);
    if (!abstract || abstract.includes("[.abstract.md is not ready]")) {
      return null;
    }

    // Get L1 overview for slightly more detail
    let overview: string | null = null;
    try {
      overview = await client.overview(firstDir.uri);
    } catch {
      // L1 not available, L0 is enough
    }

    const content = overview || abstract;

    return [
      "# MEMORY.md (OpenViking L0/L1 Summary)",
      "",
      content,
      "",
      "---",
      "*Full memory content available via memory_search tool. Use it to retrieve specific details.*",
    ].join("\n");
  } catch (err) {
    log?.debug(
      `Failed to get Viking memory abstract, falling back to full content: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }
}
