import { AuthError, NotFoundError, RateLimitError, ServerError, ValidationError } from './errors.js';
import { DEFAULT_API_BASE_URL } from './auth.js';

import { version } from './version.js';

const API_PATH_PREFIX = '/api/v1';
const DEFAULT_TIMEOUT = 30_000;
const WRITE_TIMEOUT = 15_000;
const MAX_RETRIES = 3;
const USER_AGENT = `carly-ai/${version}`;

export interface CarlyClientOptions {
  apiKey: string;
  baseUrl?: string;
  maxRetries?: number;
  timeout?: number;
}

export class CarlyClient {
  private apiKey: string;
  private baseUrl: string;
  private maxRetries: number;
  private timeout: number;

  constructor(opts: CarlyClientOptions) {
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_API_BASE_URL).replace(/\/+$/, '');
    this.maxRetries = opts.maxRetries ?? MAX_RETRIES;
    this.timeout = opts.timeout ?? DEFAULT_TIMEOUT;
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': USER_AGENT,
    };
  }

  private async request<T>(
    method: string,
    path: string,
    opts: { query?: Record<string, unknown>; body?: unknown; form?: FormData } = {},
    attempt = 0,
  ): Promise<T> {
    const isWrite = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method.toUpperCase());
    const timeout = isWrite ? WRITE_TIMEOUT : this.timeout;

    // Allow callers to pass either an absolute path (starts with /) or one
    // already prefixed with /api/v1; the prefix is added if missing.
    const apiPath = path.startsWith(API_PATH_PREFIX) ? path : `${API_PATH_PREFIX}${path}`;
    let url = `${this.baseUrl}${apiPath}`;

    if (opts.query) {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(opts.query)) {
        if (v === undefined || v === null || v === '') continue;
        if (Array.isArray(v)) {
          for (const item of v) params.append(k, String(item));
        } else {
          params.set(k, String(v));
        }
      }
      const qs = params.toString();
      if (qs) url += `?${qs}`;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
      const headers = this.headers();
      if (opts.form) delete headers['Content-Type'];
      const res = await fetch(url, {
        method: method.toUpperCase(),
        headers,
        body: opts.form ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined),
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (res.status === 204) return {} as T;

      const text = await res.text();
      let data: any;
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        data = { message: text };
      }

      if (!res.ok) {
        const msg =
          data?.message ??
          data?.error ??
          (data?.errors && Array.isArray(data.errors)
            ? data.errors.map((d: any) => d.message ?? String(d)).join('; ')
            : undefined) ??
          res.statusText;

        if (res.status === 401 || res.status === 403) throw new AuthError(msg);
        if (res.status === 404) throw new NotFoundError(msg);
        if (res.status === 400 || res.status === 422) throw new ValidationError(msg);
        if (res.status === 429) {
          const retryAfter = Number(res.headers.get('retry-after') ?? 60);
          if (!isWrite && attempt < this.maxRetries) {
            await sleep(retryAfter * 1000);
            return this.request<T>(method, path, opts, attempt + 1);
          }
          throw new RateLimitError(msg, retryAfter);
        }
        if (res.status >= 500) {
          if (!isWrite && attempt < this.maxRetries) {
            await sleep(Math.pow(2, attempt) * 1000);
            return this.request<T>(method, path, opts, attempt + 1);
          }
          throw new ServerError(msg, res.status);
        }
        throw new Error(msg);
      }

      return data as T;
    } catch (err: any) {
      clearTimeout(timer);
      if (err.name === 'AbortError') {
        if (!isWrite && attempt < this.maxRetries) {
          await sleep(1000 * (attempt + 1));
          return this.request<T>(method, path, opts, attempt + 1);
        }
        throw new Error(`Request to ${url} timed out`);
      }
      // Network-level failure (DNS, TLS, connection refused). Node's
      // default "fetch failed" message hides the URL, which makes stale
      // ~/.carly-cli/config.json pointing at localhost very hard to
      // diagnose. Surface the URL + underlying cause.
      if (err?.message === 'fetch failed' || err instanceof TypeError) {
        const causeCode = err?.cause?.code ? ` (${err.cause.code})` : '';
        const causeMsg = err?.cause?.message ? `: ${err.cause.message}` : '';
        throw new Error(`Request to ${this.baseUrl} failed${causeCode}${causeMsg}`);
      }
      throw err;
    }
  }

  get<T>(path: string, query?: Record<string, unknown>): Promise<T> {
    return this.request<T>('GET', path, { query });
  }

  post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('POST', path, { body });
  }

  upload<T>(path: string, content: Uint8Array, mimeType: string): Promise<T> {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(content)], { type: mimeType }), 'logo');
    return this.request<T>('POST', path, { form });
  }

  patch<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('PATCH', path, { body });
  }

  put<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('PUT', path, { body });
  }

  delete<T>(path: string, query?: Record<string, unknown>): Promise<T> {
    return this.request<T>('DELETE', path, { query });
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
