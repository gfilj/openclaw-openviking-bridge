/**
 * OpenViking integration module for OpenClaw.
 *
 * Provides:
 * - Session offload with concurrency control
 * - Local archiving before Viking push (data safety)
 * - Bootstrap optimization (L0/L1 memory summary)
 * - HTTP client for Viking API
 */

export * from "./client.js";
export * from "./offload-utils.js";
export * from "./session-offload.js";
export * from "./session-archive.js";
export * from "./bootstrap-optimization.js";
