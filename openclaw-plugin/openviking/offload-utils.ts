/**
 * Pure utility functions for session offload logic.
 * Separated from session-offload.ts to allow unit testing without runtime dependencies.
 */

/** Default: keep last 10 turns (20 messages: 10 user + 10 assistant) in context */
const DEFAULT_KEEP_TURNS = 10;
/** Minimum messages before offloading kicks in */
const MIN_MESSAGES_FOR_OFFLOAD = 24;

export interface OffloadConfig {
  keepTurns?: number;
  minMessages?: number;
}

/**
 * Determine if offloading should occur based on message count.
 */
export function shouldOffload(messages: { length: number }, config?: OffloadConfig): boolean {
  const minMessages = config?.minMessages ?? MIN_MESSAGES_FOR_OFFLOAD;
  return messages.length >= minMessages;
}

/**
 * Split messages into those to offload and those to keep.
 */
export function splitForOffload<T>(
  messages: T[],
  config?: OffloadConfig,
): { toOffload: T[]; toKeep: T[] } {
  const keepTurns = config?.keepTurns ?? DEFAULT_KEEP_TURNS;
  const keepMessages = keepTurns * 2;

  if (messages.length <= keepMessages) {
    return { toOffload: [], toKeep: messages };
  }

  const splitIndex = messages.length - keepMessages;
  return {
    toOffload: messages.slice(0, splitIndex),
    toKeep: messages.slice(splitIndex),
  };
}
