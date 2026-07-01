import { vi } from "vitest";

/** Build a JSON `Response` (Node global). */
export function jsonResponse(
  data: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(JSON.stringify(data), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

/** Build a text/plain `Response`. */
export function textResponse(
  text: string,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(text, {
    status: init.status ?? 200,
    headers: { "content-type": "text/plain", ...(init.headers ?? {}) },
  });
}

export interface RecordedCall {
  url: string;
  headers: Record<string, string>;
}

export interface FakeFetch {
  impl: typeof fetch;
  calls: RecordedCall[];
}

function recordHeaders(init?: RequestInit): Record<string, string> {
  const out: Record<string, string> = {};
  if (init?.headers) {
    new Headers(init.headers).forEach((value, key) => {
      out[key] = value;
    });
  }
  return out;
}

function urlOf(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

/**
 * A `fetch` that walks `steps` in order (repeating the last once exhausted).
 * Each step is a thunk so it can throw (network error) or return a fresh
 * `Response` (bodies are single-use).
 */
export function queuedFetch(steps: Array<() => Promise<Response>>): FakeFetch {
  const calls: RecordedCall[] = [];
  let i = 0;
  const impl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: urlOf(input), headers: recordHeaders(init) });
    const step = steps[Math.min(i, steps.length - 1)]!;
    i++;
    return step();
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

/** A `fetch` routed by request URL + `Accept` header (order-independent). */
export function routedFetch(
  handler: (url: string, accept: string) => Promise<Response>,
): typeof fetch {
  const impl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const accept = new Headers(init?.headers ?? {}).get("accept") ?? "";
    return handler(urlOf(input), accept);
  });
  return impl as unknown as typeof fetch;
}
