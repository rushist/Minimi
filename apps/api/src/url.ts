export function canonicalUrl(input: string): URL | undefined {
  try {
    const url = new URL(input);
    if (
      !['https:', 'http:'].includes(url.protocol) ||
      url.username ||
      url.password
    )
      return;
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (
        /^(utm_.+|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|igshid)$/i.test(key)
      )
        url.searchParams.delete(key);
    }
    url.searchParams.sort();
    return url;
  } catch {
    return;
  }
}

export function matchesSourceDomains(
  url: URL,
  include: readonly string[],
  exclude: readonly string[],
): boolean {
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  const matches = (domain: string) => {
    const root = domain.toLowerCase();
    return host === root || host.endsWith('.' + root);
  };
  return (!include.length || include.some(matches)) && !exclude.some(matches);
}
