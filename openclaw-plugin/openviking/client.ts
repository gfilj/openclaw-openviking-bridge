/**
 * OpenViking HTTP client for OpenClaw integration.
 *
 * OpenViking is an AI Agent context database that provides:
 * - Hierarchical semantic retrieval (L0/L1/L2 layered context)
 * - Automatic memory extraction from sessions
 * - File-system paradigm for context management (viking:// URIs)
 */

// ── Types ──────────────────────────────────────────────────────────

export interface OpenVikingConfig {
  /** Enable OpenViking integration. Default: false */
  enabled?: boolean;
  /** OpenViking server URL. Default: http://localhost:1933 */
  url?: string;
  /** Sync compacted messages to OpenViking sessions. Default: true when enabled */
  syncOnCompaction?: boolean;
  /** Memory search backend: 'local' = existing only, 'openviking' = Viking only, 'both' = merge results */
  searchBackend?: "local" | "openviking" | "both";
}

export interface VikingFindItem {
  context_type: string;
  uri: string;
  level: number;
  score: number;
  category: string;
  match_reason: string;
  abstract: string;
  overview: string | null;
}

export interface VikingFindResult {
  memories: VikingFindItem[];
  resources: VikingFindItem[];
  skills: VikingFindItem[];
}

export interface VikingFsEntry {
  uri: string;
  size: number;
  isDir: boolean;
  modTime: string;
  abstract: string;
}

export interface VikingCommitResult {
  session_id: string;
  status: string;
  memories_extracted: number;
  archived: boolean;
}

interface VikingResponse<T> {
  status: string;
  result: T;
  error: { code: string; message: string; details: unknown } | null;
}

// ── Client ─────────────────────────────────────────────────────────

export class OpenVikingClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(url = "http://localhost:1933", timeoutMs = 120_000) {
    this.baseUrl = url.replace(/\/+$/, "");
    this.timeoutMs = timeoutMs;
  }

  // ── Health ───────────────────────────────────────────────────────

  async health(): Promise<boolean> {
    try {
      const res = await this.get<{ status: string }>("/health");
      return res.status === "ok";
    } catch {
      return false;
    }
  }

  // ── Search ──────────────────────────────────────────────────────

  async find(
    query: string,
    options?: { targetUri?: string; limit?: number },
  ): Promise<VikingFindResult> {
    const body: Record<string, unknown> = { query };
    if (options?.targetUri) {
      body.target_uri = options.targetUri;
    }
    if (options?.limit) {
      body.limit = options.limit;
    }
    return this.post<VikingFindResult>("/api/v1/search/find", body);
  }

  // ── Content ─────────────────────────────────────────────────────

  async read(uri: string): Promise<string> {
    return this.get<string>("/api/v1/content/read", { uri });
  }

  async abstract(uri: string): Promise<string> {
    return this.get<string>("/api/v1/content/abstract", { uri });
  }

  async overview(uri: string): Promise<string> {
    return this.get<string>("/api/v1/content/overview", { uri });
  }

  // ── File System ─────────────────────────────────────────────────

  async ls(uri: string): Promise<VikingFsEntry[]> {
    return this.get<VikingFsEntry[]>("/api/v1/fs/ls", { uri });
  }

  // ── Sessions ────────────────────────────────────────────────────

  async createSession(): Promise<string> {
    const result = await this.post<{ session_id: string }>("/api/v1/sessions", {});
    return result.session_id;
  }

  async addMessage(sessionId: string, role: string, content: string): Promise<void> {
    await this.post(`/api/v1/sessions/${sessionId}/messages`, { role, content });
  }

  async commitSession(
    sessionId: string,
    options?: { wait?: boolean; timeout?: number },
  ): Promise<VikingCommitResult> {
    return this.post<VikingCommitResult>(`/api/v1/sessions/${sessionId}/commit`, {
      wait: options?.wait ?? true,
      timeout: options?.timeout ?? 120,
    });
  }

  // ── HTTP helpers ────────────────────────────────────────────────

  private async get<T>(path: string, params?: Record<string, string>): Promise<T> {
    const url = new URL(path, this.baseUrl);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        url.searchParams.set(k, v);
      }
    }
    const res = await fetch(url.toString(), {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    return this.parseResponse<T>(res);
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const url = new URL(path, this.baseUrl);
    const res = await fetch(url.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    return this.parseResponse<T>(res);
  }

  private async parseResponse<T>(res: Response): Promise<T> {
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`OpenViking HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    const data = (await res.json()) as VikingResponse<T>;
    if (data.status === "error" || data.error) {
      throw new Error(`OpenViking error: ${data.error?.message ?? "unknown"}`);
    }
    return data.result;
  }
}

// ── Singleton ─────────────────────────────────────────────────────

let _client: OpenVikingClient | null = null;

export function getOpenVikingClient(config?: OpenVikingConfig): OpenVikingClient | null {
  if (!config?.enabled) {
    return null;
  }
  if (!_client) {
    _client = new OpenVikingClient(config.url);
  }
  return _client;
}

export function resetOpenVikingClient(): void {
  _client = null;
}
