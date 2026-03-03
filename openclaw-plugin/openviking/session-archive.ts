/**
 * OpenViking session archive utilities.
 *
 * When offloading old messages to Viking, archive them locally first
 * to prevent data loss if Viking fails.
 */

import fs from "node:fs/promises";
import path from "node:path";

/**
 * Archive offloaded messages to a local file before removing from session.
 *
 * @param sessionFile Path to the session .jsonl file
 * @param keepCount Number of recent entries to keep (others are archived)
 * @param log Optional logger
 * @returns Number of entries archived, or null if nothing archived
 */
export async function archiveAndTruncateSession(
  sessionFile: string,
  keepCount: number,
  log?: { warn: (msg: string) => void; info: (msg: string) => void },
): Promise<{ archived: number; kept: number } | null> {
  try {
    const content = await fs.readFile(sessionFile, "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);

    if (lines.length === 0) {
      return null;
    }

    // First line is header
    const header = lines[0];
    const entries = lines.slice(1);

    // Find message entries (type: "message")
    const messageIndices: number[] = [];
    for (let i = 0; i < entries.length; i++) {
      try {
        const entry = JSON.parse(entries[i]);
        if (entry.type === "message") {
          messageIndices.push(i);
        }
      } catch {
        // Skip malformed entries
      }
    }

    if (messageIndices.length <= keepCount) {
      // Not enough messages to archive
      return null;
    }

    // Calculate split point: keep last N message entries
    // But we need to keep all non-message entries that come after the first kept message
    const firstKeptMessageIdx = messageIndices[messageIndices.length - keepCount];

    // Archive entries before the first kept message
    const toArchive = entries.slice(0, firstKeptMessageIdx);
    const toKeep = entries.slice(firstKeptMessageIdx);

    if (toArchive.length === 0) {
      return null;
    }

    // Create archive file
    const sessionDir = path.dirname(sessionFile);
    const sessionName = path.basename(sessionFile, ".jsonl");
    const archiveDir = path.join(sessionDir, ".archive");
    await fs.mkdir(archiveDir, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const archiveFile = path.join(archiveDir, `${sessionName}_${timestamp}.jsonl`);

    // Write archive with header for context
    const archiveContent = [header, ...toArchive].join("\n") + "\n";
    await fs.writeFile(archiveFile, archiveContent, "utf-8");

    // Rebuild session file with kept entries
    // Need to fix parentId chain: first kept entry should have parentId = null or point to header
    const rebuiltEntries: string[] = [];
    let prevId: string | null = null;

    for (const entryStr of toKeep) {
      try {
        const entry = JSON.parse(entryStr);
        // Update parentId to maintain chain
        if (rebuiltEntries.length === 0) {
          // First entry after archive - reset parentId
          entry.parentId = null;
        } else if (entry.parentId && !toKeep.some((e) => {
          try {
            return JSON.parse(e).id === entry.parentId;
          } catch {
            return false;
          }
        })) {
          // parentId points to archived entry - update to previous kept entry
          entry.parentId = prevId;
        }
        prevId = entry.id;
        rebuiltEntries.push(JSON.stringify(entry));
      } catch {
        // Keep malformed entries as-is
        rebuiltEntries.push(entryStr);
      }
    }

    // Write truncated session file
    const newContent = [header, ...rebuiltEntries].join("\n") + "\n";
    await fs.writeFile(sessionFile, newContent, "utf-8");

    log?.info(
      `Archived ${toArchive.length} entries from ${sessionFile} to ${archiveFile}, kept ${toKeep.length}`,
    );

    return { archived: toArchive.length, kept: toKeep.length };
  } catch (err) {
    log?.warn(
      `Failed to archive session ${sessionFile}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}
