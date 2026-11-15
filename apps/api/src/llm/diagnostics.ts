import type { LLMError } from './types.js';

export function modelFailureMessage(error: LLMError): string {
  switch (error) {
    case 'rate_limit':
    case 'quota_exhausted':
      return 'The AI provider reached its request limit. Please try again later.';
    case 'timeout':
    case 'aborted':
      return 'The AI provider did not finish before the time limit.';
    case 'rejected':
      return 'The AI provider rejected the request. Check the configured model and credentials.';
    case 'unconfigured':
      return 'No AI provider is configured.';
    case 'circuit_open':
      return 'The AI providers are temporarily paused after recent failures. Please try again later.';
    case 'invalid_output':
      return 'The AI provider returned a reply the service could not process.';
    default:
      return 'The AI provider is currently unavailable. Please try again later.';
  }
}
