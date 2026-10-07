import type {
  CheckConnectionResult,
  CreateEvidenceInputArg,
  CreateEngagementInput,
  CreateTagInput,
  Evidence,
  Engagement,
  Tag,
} from '@reporter/shared';
import { buildAuthHeaders } from './sign.js';
import { buildMultipart, type MultipartFile } from './multipart.js';

export interface ReporterClientOptions {
  /** Base server URL, e.g. `http://reporter.lan:8080` (no trailing slash needed). */
  baseUrl: string;
  accessKey: string;
  /** Secret key, base64-encoded, exactly as issued by the server. */
  secretKey: string;
  /** Optional fetch override (for tests). Defaults to global `fetch`. */
  fetch?: typeof fetch;
}

export class ReporterApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`reporter API error ${status}: ${body.slice(0, 200)}`);
    this.name = 'ReporterApiError';
  }
}

/** One page of evidence — matches the server's timeline list envelope. */
export interface EvidencePage {
  items: Evidence[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * Typed client for the reporter HMAC client API (`/api/*`). Used by the desktop
 * app and the terminal recorder. Signs every request with {@link buildAuthHeaders}.
 */
export class ReporterClient {
  private readonly baseUrl: string;
  private readonly accessKey: string;
  private readonly secretKey: string;
  private readonly doFetch: typeof fetch;

  constructor(opts: ReporterClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.accessKey = opts.accessKey;
    this.secretKey = opts.secretKey;
    this.doFetch = opts.fetch ?? globalThis.fetch;
  }

  private async request<T>(
    method: string,
    path: string,
    opts: { body?: Buffer; contentType?: string } = {},
  ): Promise<T> {
    const body = opts.body ?? Buffer.alloc(0);
    const auth = buildAuthHeaders(method, path, body, this.accessKey, this.secretKey);
    const headers: Record<string, string> = { ...auth };
    if (opts.contentType) headers['Content-Type'] = opts.contentType;

    const res = await this.doFetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body.length > 0 ? new Uint8Array(body) : undefined,
    });

    const text = await res.text();
    if (!res.ok) throw new ReporterApiError(res.status, text);
    return (text ? JSON.parse(text) : undefined) as T;
  }

  /** Verify the server is reachable and the credentials are valid. */
  checkConnection(): Promise<CheckConnectionResult> {
    return this.request<CheckConnectionResult>('GET', '/api/checkconnection');
  }

  /** List the engagements this API key's user can access. */
  listEngagements(): Promise<Engagement[]> {
    return this.request<Engagement[]>('GET', '/api/engagements');
  }

  createEngagement(input: CreateEngagementInput): Promise<Engagement> {
    const body = Buffer.from(JSON.stringify(input), 'utf8');
    return this.request<Engagement>('POST', '/api/engagements', {
      body,
      contentType: 'application/json',
    });
  }

  listTags(engagementSlug: string): Promise<Tag[]> {
    return this.request<Tag[]>(
      'GET',
      `/api/engagements/${encodeURIComponent(engagementSlug)}/tags`,
    );
  }

  createTag(engagementSlug: string, input: CreateTagInput): Promise<Tag> {
    const body = Buffer.from(JSON.stringify(input), 'utf8');
    return this.request<Tag>(
      'POST',
      `/api/engagements/${encodeURIComponent(engagementSlug)}/tags`,
      {
        body,
        contentType: 'application/json',
      },
    );
  }

  /**
   * List evidence in an engagement, newest first — optionally filtered by a
   * timeline query string and paginated. Handy for picking a piece of evidence
   * to link a new capture to.
   */
  listEvidence(
    engagementSlug: string,
    opts: { q?: string; page?: number; pageSize?: number } = {},
  ): Promise<EvidencePage> {
    const params = new URLSearchParams();
    if (opts.q) params.set('q', opts.q);
    if (opts.page) params.set('page', String(opts.page));
    if (opts.pageSize) params.set('pageSize', String(opts.pageSize));
    const qs = params.toString();
    return this.request<EvidencePage>(
      'GET',
      `/api/engagements/${encodeURIComponent(engagementSlug)}/evidence${qs ? `?${qs}` : ''}`,
    );
  }

  /**
   * Create a piece of evidence. `metadata` is sent as the JSON `notes` part;
   * `file` (when present) is the binary blob part (screenshot PNG, asciicast, …).
   * Set `metadata.parentEvidenceUuid` to file it as linked evidence on an existing item.
   */
  createEvidence(
    engagementSlug: string,
    metadata: CreateEvidenceInputArg,
    file?: { filename: string; contentType: string; data: Buffer },
  ): Promise<Evidence> {
    const files: MultipartFile[] = file
      ? [{ field: 'file', filename: file.filename, contentType: file.contentType, data: file.data }]
      : [];
    const { body, contentType } = buildMultipart({ notes: JSON.stringify(metadata) }, files);
    return this.request<Evidence>(
      'POST',
      `/api/engagements/${encodeURIComponent(engagementSlug)}/evidence`,
      { body, contentType },
    );
  }
}
