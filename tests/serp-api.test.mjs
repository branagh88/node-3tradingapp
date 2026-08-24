// tests/serp-api.test.mjs — SerpAPI provider (serp-api.js).
// OFFLINE: stubbed fetch; sentinel key; redaction asserted.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const KEY = 'test-sentinel-serp-abc123';

let logLines;
beforeEach(() => {
  vi.restoreAllMocks();
  logLines = [];
  for (const m of ['debug', 'info', 'warn', 'error']) {
    vi.spyOn(console, m).mockImplementation((...a) => logLines.push(a.map(String).join(' ')));
  }
});
afterEach(() => {
  delete globalThis.fetch;
  vi.restoreAllMocks();
});

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body), json: async () => body };
}

describe('fetchResearch', () => {
  it('empty key → NotConfiguredError and fetch is NEVER called', async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy;
    const { fetchResearch } = await import('../serp-api.js');
    await expect(fetchResearch('', 'query')).rejects.toMatchObject({ name: 'NotConfiguredError' });
    await expect(fetchResearch('   ', 'query')).rejects.toMatchObject({ name: 'NotConfiguredError' });
    await expect(fetchResearch(undefined, 'query')).rejects.toMatchObject({ name: 'NotConfiguredError' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('normalizes organic_results to {title, link, snippet}', async () => {
    const calls = [];
    globalThis.fetch = vi.fn(async (url) => { calls.push(String(url)); return jsonResponse({
      search_metadata: { id: 'x' }, // ignored
      organic_results: [
        { position: 1, title: 'Preview', link: 'https://example.test/a', snippet: 'Team news and odds.' },
        { title: '', link: '', snippet: '' }, // filtered out (all-empty)
      ],
      related_searches: [], // ignored
    }); });
    const { fetchResearch } = await import('../serp-api.js');
    const results = await fetchResearch(KEY, 'Arsenal vs Chelsea preview odds');
    expect(results).toEqual([{ title: 'Preview', link: 'https://example.test/a', snippet: 'Team news and odds.' }]);
    const u = new URL(calls[0]);
    expect(u.hostname).toBe('serpapi.com');
    expect(u.searchParams.get('q')).toBe('Arsenal vs Chelsea preview odds');
    expect(u.searchParams.get('api_key')).toBe(KEY);
  });

  it('missing/absent organic_results → []', async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse({}));
    const { fetchResearch } = await import('../serp-api.js');
    expect(await fetchResearch(KEY, 'q')).toEqual([]);
  });

  it('HTTP error → ApiError with kind; network failure → TransportError; key never leaks', async () => {
    let mode = 'http';
    globalThis.fetch = vi.fn(async () => { if (mode === 'net') throw new Error('offline'); return jsonResponse({}, 403); });
    const { fetchResearch } = await import('../serp-api.js');
    const e1 = await fetchResearch(KEY, 'q').catch((e) => e);
    expect(e1.name).toBe('ApiError');
    expect(e1.kind).toBe('unconfigured-or-invalid-key');
    mode = 'net';
    const e2 = await fetchResearch(KEY, 'q').catch((e) => e);
    expect(e2.name).toBe('TransportError');
    const allText = [e1.message, e2.message].concat(logLines).join('\n');
    expect(allText.includes(KEY)).toBe(false);
  });
});
