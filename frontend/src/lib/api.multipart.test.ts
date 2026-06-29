import type { AxiosAdapter, InternalAxiosRequestConfig } from 'axios';
import { afterEach, describe, expect, it } from 'vitest';
import { api, http, hasSessionBearerToken, setSessionBearerToken } from './api';
import { uploadAttachment } from './chat-api';

function headerValue(config: InternalAxiosRequestConfig, name: string): string | undefined {
  const headers = config.headers;
  const get = (headers as { get?: (key: string) => unknown }).get;
  if (typeof get === 'function') {
    const value = get.call(headers, name);
    return typeof value === 'string' ? value : undefined;
  }
  const record = headers as unknown as Record<string, unknown>;
  const value = record[name] ?? record[name.toLowerCase()];
  return typeof value === 'string' ? value : undefined;
}

const originalAdapter = http.defaults.adapter;

afterEach(() => {
  setSessionBearerToken(null);
  if (originalAdapter === undefined) {
    delete http.defaults.adapter;
    return;
  }
  http.defaults.adapter = originalAdapter;
});

describe('api multipart requests', () => {
  it('removes JSON content type for FormData uploads', async () => {
    let captured: InternalAxiosRequestConfig | null = null;
    const adapter: AxiosAdapter = async (config) => {
      captured = config;
      return {
        data: { ok: true },
        status: 200,
        statusText: 'OK',
        headers: {},
        config,
        request: {},
      };
    };
    http.defaults.adapter = adapter;

    const form = new FormData();
    form.append('file', new Blob(['content'], { type: 'text/plain' }), 'report.txt');

    await api.post('/tasks/task-1/attachments', form);

    if (captured === null) {
      throw new Error('Request was not captured');
    }
    expect(headerValue(captured, 'Content-Type')).toBeUndefined();
  });

  it('allows slow mobile attachment uploads to run for two minutes', async () => {
    const captured: { config?: InternalAxiosRequestConfig } = {};
    const adapter: AxiosAdapter = async (config) => {
      captured.config = config;
      return {
        data: { id: 'attachment-1' },
        status: 200,
        statusText: 'OK',
        headers: {},
        config,
        request: {},
      };
    };
    http.defaults.adapter = adapter;

    await uploadAttachment(
      'task-1',
      new File(['content'], 'archive.custom', { type: 'application/x-custom' }),
    );

    if (captured.config === undefined) {
      throw new Error('Request was not captured');
    }
    expect(captured.config.timeout).toBe(120_000);
    expect(headerValue(captured.config, 'Content-Type')).toBeUndefined();
  });
});

describe('api query params', () => {
  it('serializes arrays as repeated keys without [] suffix', async () => {
    let captured: InternalAxiosRequestConfig | null = null;
    const adapter: AxiosAdapter = async (config) => {
      captured = config;
      return {
        data: { ok: true },
        status: 200,
        statusText: 'OK',
        headers: {},
        config,
        request: {},
      };
    };
    http.defaults.adapter = adapter;

    await api.get('/tasks', { statuses: ['CANCELLED'] });

    if (captured === null) {
      throw new Error('Request was not captured');
    }
    const uri = http.getUri(captured);
    expect(uri).toContain('statuses=CANCELLED');
    expect(uri).not.toContain('statuses%5B%5D=');
    expect(uri).not.toContain('statuses[]=');
  });
});

describe('api bearer session transport', () => {
  it('adds an in-memory Authorization header for mini-app sessions', async () => {
    let captured: InternalAxiosRequestConfig | null = null;
    const adapter: AxiosAdapter = async (config) => {
      captured = config;
      return {
        data: { ok: true },
        status: 200,
        statusText: 'OK',
        headers: {},
        config,
        request: {},
      };
    };
    http.defaults.adapter = adapter;

    setSessionBearerToken('mini-token');
    expect(hasSessionBearerToken()).toBe(true);

    await api.get('/tasks');

    if (captured === null) {
      throw new Error('Request was not captured');
    }
    expect(headerValue(captured, 'Authorization')).toBe('Bearer mini-token');
  });
});
