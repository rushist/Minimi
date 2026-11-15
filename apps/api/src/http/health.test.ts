import { describe, expect, it, vi } from 'vitest';
import { createApp } from './app.js';

describe('GET /health', () => {
  it('returns the liveness status and emits a structured request event', async () => {
    const write = vi.fn<(event: string) => void>();
    const response = await createApp(write).request('/health');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
    expect(write).toHaveBeenCalledWith(expect.any(String));
    expect(JSON.parse(write.mock.calls[0]![0])).toMatchObject({
      stage: 'http',
      type: 'request',
      attrs: { method: 'GET', status: 200 },
    });
  });
});
