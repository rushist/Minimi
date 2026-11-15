import type { TraceEvent } from '@chatagent/shared';

export type LogWriter = (line: string) => void;

export interface Tracer {
  emit(event: TraceEvent, progress?: boolean): void;
}

export function createTracer(write: LogWriter): Tracer {
  return { emit: (event) => write(JSON.stringify(event)) };
}
