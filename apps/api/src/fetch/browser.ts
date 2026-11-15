import { Agent, request } from 'undici';
import { FetchFailure, type HtmlRenderer } from './types.js';

export function socketRenderer(
  socketPath: string,
  maxBytes: number,
): HtmlRenderer {
  return async (html, signal) => {
    if (Buffer.byteLength(html) > maxBytes) throw new FetchFailure('too_large');
    const dispatcher = new Agent({ connect: { socketPath } });
    try {
      const response = await request('http://renderer/render', {
        dispatcher,
        signal,
        method: 'POST',
        body: html,
      });
      if (response.statusCode !== 200)
        throw new FetchFailure('extraction_failed');
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      for await (const chunk of response.body) {
        bytes += chunk.length;
        if (bytes > maxBytes) throw new FetchFailure('too_large');
        chunks.push(chunk);
      }
      return Buffer.concat(chunks, bytes).toString('utf8');
    } finally {
      await dispatcher.destroy();
    }
  };
}
