import type {
  BackendRequest,
  LLMPurpose,
  LLMRequest,
  ModelTier,
} from './types.js';

export function modelTier(purpose: LLMPurpose): ModelTier {
  return purpose === 'synthesis' || purpose === 'deep_verification'
    ? 'strong'
    : 'small';
}

export function assemblePrompt(
  request: LLMRequest,
  contextSuffix?: string,
): BackendRequest['messages'] {
  const prefix = [request.system, ...(request.toolDefinitions ?? [])].join(
    '\n\n',
  );
  const context = contextSuffix
    ? request.context + '\n\n' + contextSuffix
    : request.context;
  return [
    { role: 'system', content: prefix },
    { role: 'user', content: context },
  ];
}
