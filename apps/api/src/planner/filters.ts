import { SearchSpecSchema, type SearchSpec } from '@chatagent/shared';
import { trustTiers } from '../config/retrieval.js';

const domainSchema = SearchSpecSchema.shape.includeDomains.element;
const domainPattern =
  /(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z](?:[a-z0-9-]*[a-z0-9])?/i;
const domainsBySubject = [
  [/\bnode(?:\.js|js)\b/i, 'nodejs.org'],
  [/\bpython\b/i, 'docs.python.org'],
  [/\b(?:chromium|chrome)\b/i, 'developer.chrome.com'],
  [/\bdocker\b/i, 'docs.docker.com'],
  [/\bnasa\b/i, 'nasa.gov'],
  [/\b(?:world health organization|WHO)\b/, 'who.int'],
  [/\b(?:securities and exchange commission|SEC)\b/, 'sec.gov'],
] as const;
const namedPublishers = [
  [
    /\bbandai namco\b/i,
    ['bandainamcoent.com', 'bandainamcoent.eu', 'bandainamco.co.jp'],
  ],
  [/\bgolden globes\b/i, ['goldenglobes.com']],
  [/\b(?:recording academy|grammys)\b/i, ['grammy.com']],
  [
    /\b(?:academy|oscars|academy of motion picture arts and sciences)\b/i,
    ['oscars.org', 'oscars.com', 'awardsdatabase.oscars.org'],
  ],
  [/\bfifa\b/i, ['fifa.com']],
  [
    /\b(?:us open tennis|united states tennis association|usta)\b/i,
    ['usopen.org', 'usta.com'],
  ],
  [/\bheathrow express\b/i, ['heathrowexpress.com']],
  [/\bnasa\b/i, ['nasa.gov']],
  [/\b(?:cdc|centers for disease control and prevention)\b/i, ['cdc.gov']],
  [/\b(?:bls|bureau of labor statistics)\b/i, ['bls.gov']],
  [/\b(?:eia|energy information administration)\b/i, ['eia.gov']],
  [/\b(?:wmo|world meteorological organization)\b/i, ['wmo.int']],
  [/\bcopernicus\b/i, ['copernicus.eu']],
  [/\b(?:supreme court opinion|court opinion)\b/i, ['supremecourt.gov']],
  [/\b(?:moma|museum of modern art)\b/i, ['moma.org']],
  [/\btolkien estate\b/i, ['tolkienestate.com']],
  [/\b(?:noaa|global monitoring laboratory)\b/i, ['noaa.gov']],
  [/\b(?:bea|bureau of economic analysis)\b/i, ['bea.gov']],
  [/\buffizi\b/i, ['uffizi.it']],
] as const;

export function cleanDomains(values: readonly string[]): string[] {
  return [
    ...new Set(
      values
        .map((domain) => domain.trim().toLowerCase())
        .filter((domain) => domainSchema.safeParse(domain).success),
    ),
  ].slice(0, 10);
}

const dedupePhrases = (values: readonly string[]) =>
  [...new Set(values)].slice(0, 10);

function asDomain(value: string): string | undefined {
  if (/^wikipedia$/i.test(value)) return 'wikipedia.org';
  if (/^reddit$/i.test(value)) return 'reddit.com';
  return domainSchema.safeParse(value.toLowerCase()).success
    ? value.toLowerCase()
    : undefined;
}

export function userFilters(message: string) {
  const include: string[] = [];
  const exclude: string[] = [];
  const hostname = domainPattern.source;
  for (const match of message.matchAll(
    new RegExp(
      '(?:^|\\s)(-?)site:(' + hostname + ')(?=\\.(?:\\s|$)|[\\s/),;!?]|$)',
      'gi',
    ),
  )) {
    (match[1] ? exclude : include).push(match[2]!);
  }
  for (const match of message.matchAll(
    new RegExp(
      '\\b(?:skip|exclude|avoid|without|ignore|no)\\s+(?:(?:results|sources)\\s+from\\s+)?(wikipedia\\b|reddit\\b(?!\\.)|' +
        hostname +
        ')',
      'gi',
    ),
  )) {
    const domain = asDomain(match[1]!);
    if (domain) exclude.push(domain);
  }
  const onlyFrom = new RegExp(
    '\\bonly\\s+(?:(?:use|search)\\s+)?(?:(?:official\\s+(?:docs|documentation|sources)|sources)\\s+from\\s+|from\\s+)?(' +
      hostname +
      ')',
    'gi',
  );
  const fromOnly = new RegExp(
    '\\b(?:from|use|search)\\s+(' + hostname + ')\\s+only\\b',
    'gi',
  );
  for (const pattern of [onlyFrom, fromOnly]) {
    for (const match of message.matchAll(pattern)) include.push(match[1]!);
  }
  for (const match of message.matchAll(
    new RegExp(
      '\\b(?:cite|according to)\\s+(?:the\\s+)?(' +
        hostname +
        ')(?=[\\s/),;!?]|\\.(?:\\s|$)|$)',
      'gi',
    ),
  )) {
    include.push(match[1]!);
  }
  const requestedPublishers = [
    ...message.matchAll(
      /\b(?:cite|according to|use (?:the )?original)\s+([^.!?;:\n]{1,140})/gi,
    ),
  ].flatMap(([, requested]) => {
    const primary = requested?.split(
      /\b(?:and explain|and state|and include|and give|for each)\b/i,
    )[0];
    if (!primary) return [];
    // The specific academy takes precedence over the generic name.
    const withoutRecordingAcademy = /\brecording academy\b/i.test(primary)
      ? primary.replace(/\brecording academy\b/gi, '')
      : primary;
    return namedPublishers.flatMap(([name, domains]) =>
      (
        domains[0] === 'oscars.org'
          ? name.test(withoutRecordingAcademy)
          : name.test(primary)
      )
        ? [domains]
        : [],
    );
  });
  if (!include.length) include.push(...requestedPublishers.flat());
  if (
    !include.length &&
    /\b(?:tennis|singles|doubles|set score)\b/i.test(message) &&
    /\bU\.?S\.? Open\b/i.test(message) &&
    /\b(?:cite|use)\s+(?:the\s+)?(?:official\s+)?(?:tournament|event|organizer)\b/i.test(
      message,
    )
  )
    include.push('usopen.org', 'usta.com');
  if (
    !include.length &&
    /\bUS Supreme Court\b/i.test(message) &&
    /\bcite (?:the|its) opinion\b/i.test(message)
  )
    include.push('supremecourt.gov');
  if (
    !include.length &&
    !exclude.some((domain) => /^(?:www\.)?reddit\.com$/i.test(domain)) &&
    /\b(?:search|check|browse|use|consult|on|from|only)\s+(?:only\s+)?reddit\b|\breddit\s+only\b|(?:^|\s)r\/[a-z0-9_]+\b/i.test(
      message,
    )
  )
    include.push('reddit.com');
  const exactPhrases = [
    ...message.matchAll(/"([^"\n]{1,300})"|“([^”\n]{1,300})”/g),
  ]
    .map((match) => (match[1] ?? match[2])!.trim())
    .filter(Boolean);
  const verifyTitle =
    /\b(?:verify|confirm|check|determine)\b[^?!.\n]{0,130}\b(?:title|book|novel|story)\b[^?!.\n]{0,110}\b(?:exists|was published|was released)\b/i.test(
      message,
    )
      ? (exactPhrases[0] ??
        /\b(?:titled|called|named)\s+([^?!.\n]{2,130}?)(?=\s+(?:was published|was released|exists)\b)/i
          .exec(message)?.[1]
          ?.trim() ??
        /\b(?:novel|book|story)\s+([A-Z][\p{L}\p{M}'’:-]*(?:\s+[\p{L}\p{M}'’:-]+){1,10})(?=[?.!\n]|$)/u.exec(
          message,
        )?.[1])
      : undefined;
  if (verifyTitle) exactPhrases.push(verifyTitle);
  const relative = /\b(?:last|past|previous)\s+(day|week|month|year)\b/i
    .exec(message)?.[1]
    ?.toLowerCase();
  const range =
    /\b(?:from|between)\s+(\d{4}-\d{2}-\d{2})\s+(?:to|through|and)\s+(\d{4}-\d{2}-\d{2})\b/i.exec(
      message,
    );
  const dateRange = range
    ? SearchSpecSchema.shape.dateRange.safeParse({
        start: range[1],
        end: range[2],
      })
    : undefined;
  return {
    include: cleanDomains(include),
    verifyTitle,
    subjects: subjectDomains(message),
    exclude: cleanDomains(exclude),
    exactPhrases: dedupePhrases(exactPhrases),
    recency: relative as SearchSpec['recency'],
    dateRange: dateRange?.success ? dateRange.data : undefined,
    officialOnly:
      /\b(?:only|exclusively)\s+(?:from\s+|use\s+)?(?:the\s+)?official\s+(?:docs|documentation|sources)\b|\bofficial\s+(?:docs|documentation|sources)\s+only\b/i.test(
        message,
      ),
    fresh:
      /\b(?:latest|breaking|today|tomorrow|this week|right now|current(?:ly)?|recent)\b/i.test(
        message,
      ),
    news: /\b(?:news|headlines|breaking)\b/i.test(message),
  };
}

export type UserFilters = ReturnType<typeof userFilters>;
const subjectDomains = (text: string) =>
  domainsBySubject
    .filter(
      ([pattern, domain]) =>
        pattern.test(text) && trustTiers.primary.includes(domain),
    )
    .map(([, domain]) => domain);
const within = (domain: string, root: string) =>
  domain === root || domain.endsWith('.' + root);

export function applyFilters(
  spec: SearchSpec,
  filters: UserFilters,
  subject: string,
): SearchSpec | undefined {
  const redditOnly =
    filters.include.length > 0 &&
    filters.include.every((domain) => within(domain, 'reddit.com'));
  const intent = redditOnly
    ? 'discussion'
    : filters.officialOnly || filters.include.length
      ? 'official_docs'
      : spec.intent;
  const topic = redditOnly
    ? 'general'
    : filters.news || intent === 'news'
      ? 'news'
      : spec.topic;
  const excluded = cleanDomains([
    ...filters.exclude,
    ...(filters.officialOnly || filters.include.length
      ? []
      : spec.excludeDomains),
  ]);
  const candidates = cleanDomains(spec.includeDomains);
  const trustedSubject = filters.subjects.length
    ? filters.subjects
    : subjectDomains(subject);
  const relevantSubject = subjectDomains(spec.query).filter((domain) =>
    trustedSubject.includes(domain),
  );
  const official = relevantSubject.length ? relevantSubject : trustedSubject;

  let include = filters.include.length ? filters.include : candidates;
  if (filters.officialOnly) {
    include = filters.include.length ? filters.include : official;
    if (!include.length) return;
  } else if (!include.length) {
    if (intent === 'official_docs' || intent === 'primary_source')
      include = official;
    else if (intent === 'news') include = [...trustTiers.news];
    else if (intent === 'discussion') include = [...trustTiers.forum];
  }
  const includeDomains = include.filter(
    (domain) => !excluded.some((root) => within(domain, root)),
  );
  if (include.length && !includeDomains.length) return;

  const dateRange =
    filters.dateRange ?? (filters.recency ? undefined : spec.dateRange);
  const recency = dateRange ? undefined : (filters.recency ?? spec.recency);
  const result = SearchSpecSchema.safeParse({
    ...spec,
    includeDomains,
    excludeDomains: excluded,
    exactPhrases: dedupePhrases([
      ...filters.exactPhrases,
      ...spec.exactPhrases,
    ]),
    intent,
    topic,
    volatility:
      topic === 'news' ||
      filters.fresh ||
      recency === 'day' ||
      recency === 'week'
        ? 'fast'
        : spec.volatility,
    ...(dateRange
      ? { dateRange, recency: undefined }
      : { dateRange: undefined, recency }),
  });
  return result.success ? result.data : undefined;
}
