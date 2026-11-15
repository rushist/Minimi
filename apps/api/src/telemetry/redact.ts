export function createRedactor(env: Record<string, string | undefined>) {
  const secrets = [
    ...new Set(
      Object.entries(env).flatMap(([key, value]) => {
        if (!value) return [];
        if (
          /^(?:.*_)?(?:KEY|TOKEN|SECRET|PASSWORD)$/.test(key) &&
          value.length >= 8
        )
          return [value];
        if (key === 'REDIS_URL') {
          try {
            return [new URL(value).password].filter(Boolean);
          } catch {
            return [];
          }
        }
        return [];
      }),
    ),
  ].sort((a, b) => b.length - a.length);
  return (text: string) => {
    for (const secret of secrets) text = text.replaceAll(secret, '[REDACTED]');
    return text
      .replace(
        /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
        '[REDACTED AUTH]',
      )
      .replace(/\b(?:gsk_|tvly-|sk-lf-|sk-)[A-Za-z0-9_-]{8,}/g, '[REDACTED]')
      .replace(
        /("(?:[\w-]+[_-])?(?:api[_-]?key|authorization|cookie|token|secret|password)"\s*:\s*")(?:[^"\\]|\\.)*"/gi,
        '$1[REDACTED]"',
      )
      .replace(
        /([?&](?:api[_-]?key|token|access[_-]?token|password|secret)=)[^&#\s"\\]+/gi,
        '$1[REDACTED]',
      );
  };
}
