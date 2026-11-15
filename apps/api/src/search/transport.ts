import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { captureArtifact } from '../telemetry/scope.js';
import { SearchFailure, type SearchTransport } from './types.js';

export function httpTransport(fetcher: typeof fetch = fetch): SearchTransport {
  return {
    async send(request, signal) {
      const response = await fetcher(request.url, {
        method: request.body ? 'POST' : 'GET',
        headers: {
          ...request.headers,
          ...(request.body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(request.body ? { body: JSON.stringify(request.body) } : {}),
        redirect: 'error',
        signal,
      });
      const body = await response.text();
      captureArtifact('search_response', {
        provider: request.provider,
        url: request.url,
        request: request.body,
        status: response.status,
        body,
      });
      return {
        status: response.status,
        body,
        retryAfter: response.headers.get('retry-after'),
      };
    },
  };
}

export function jsonTransport(transport: SearchTransport): SearchTransport {
  return {
    async send(request, signal) {
      const response = await transport.send(request, signal);
      if (
        response.status < 200 ||
        response.status >= 300 ||
        typeof response.body !== 'string'
      )
        return response;
      try {
        return { ...response, body: JSON.parse(response.body) as unknown };
      } catch {
        throw new SearchFailure('invalid_response');
      }
    },
  };
}

const recordedResponse = z.object({
  status: z.number().int().min(100).max(599),
  body: z.string(),
  retryAfter: z.string().nullish(),
});

export function fixtureTransport(
  options:
    | { mode: 'replay'; directory: string }
    | {
        mode: 'record';
        directory: string;
        upstream: SearchTransport;
        redact?: (text: string) => string;
      },
): SearchTransport {
  return {
    async send(request, signal) {
      const key = createHash('sha256')
        .update(JSON.stringify([request.provider, request.url, request.body]))
        .digest('hex');
      const path = join(options.directory, key + '.json');
      if (options.mode === 'replay') {
        try {
          const file = await readFile(path, { encoding: 'utf8', signal });
          const fixture = recordedResponse.parse(JSON.parse(file));
          return {
            status: fixture.status,
            body: fixture.body,
            retryAfter: fixture.retryAfter ?? null,
          };
        } catch (cause) {
          if (
            cause &&
            typeof cause === 'object' &&
            'code' in cause &&
            cause.code === 'ENOENT'
          )
            throw new SearchFailure('fixture_missing');
          throw new SearchFailure('fixture_io');
        }
      }

      const response = await options.upstream.send(request, signal);
      if (response.status < 200 || response.status >= 300) return response;
      const fixture = recordedResponse.safeParse(response);
      if (!fixture.success) throw new SearchFailure('fixture_io');
      const temporary = path + '.' + randomUUID() + '.tmp';
      try {
        await mkdir(options.directory, { recursive: true });
        await writeFile(
          temporary,
          JSON.stringify(fixture.data, (_key, value: unknown) =>
            typeof value === 'string'
              ? (options.redact?.(value) ?? value)
              : value,
          ),
          { signal },
        );
        await rename(temporary, path);
      } catch {
        throw new SearchFailure('fixture_io');
      } finally {
        await rm(temporary, { force: true }).catch(() => {});
      }
      return response;
    },
  };
}
