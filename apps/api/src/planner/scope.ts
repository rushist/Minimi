const year = '(?:18|19|20)\\d{2}';
const ordinalQuarter = '(first|second|third|fourth|[1-4](?:st|nd|rd|th))';
const quarter =
  '(?:q(?:uarter\\s*)?\\s*([1-4])|' + ordinalQuarter + '\\s+quarter)';
const period = new RegExp(
  '\\b(?:' +
    quarter +
    '[\\s,/-]*(?:(?:of|and\\s+year)\\s+)?(' +
    year +
    ')|(' +
    year +
    ')[\\s,/-]*' +
    quarter +
    ')\\b',
  'gi',
);
const ordinals = ['first', 'second', 'third', 'fourth'];

function reportingPeriods(text: string) {
  return [...text.matchAll(period)].map(
    ([, short, word, trailingYear, leadingYear, reverseShort, reverseWord]) => {
      const ordinal = (word ?? reverseWord ?? '').toLowerCase();
      const quarter =
        short ??
        reverseShort ??
        (/^\d/.test(ordinal)
          ? Number(ordinal[0])
          : ordinals.indexOf(ordinal) + 1);
      return {
        quarter: Number(quarter),
        year: Number(trailingYear ?? leadingYear),
      };
    },
  );
}

function publicationVintage(text: string) {
  const match =
    /\b(advance|initial|first|second|third|final|revised|preliminary)\s+(?:estimate|release)\b/i.exec(
      text,
    );
  const label = match?.[1]?.toLowerCase();
  return {
    label,
    group:
      label && ['advance', 'initial', 'first', 'preliminary'].includes(label)
        ? 'first'
        : label,
  };
}

const isFinalScore = (text: string) =>
  /\b(?:final score|set score|score in the final|score of the final)\b/i.test(
    text,
  );

export function requestedScope(message: string) {
  const periods = reportingPeriods(message);
  const years = [
    ...new Set(message.match(new RegExp('\\b' + year + '\\b', 'g'))),
  ];
  const event =
    years.length === 1 && isFinalScore(message)
      ? /\bwho won (?:the )?(.+?)(?=\s+(?:and|with)\b|[?.!]|$)/i
          .exec(message)?.[1]
          ?.trim()
      : undefined;
  return {
    period: periods.length === 1 ? periods[0] : undefined,
    vintage: periods.length === 1 ? publicationVintage(message) : undefined,
    event,
    eventYear: event ? years[0] : undefined,
  };
}

export function scopedQuery(
  query: string,
  message: string,
  scope = requestedScope(message),
) {
  if (scope.event)
    return scope.event + ' final result score match report highlights';
  if (!scope.period) return query;
  const { quarter: number, year: value } = scope.period;
  const mentions = reportingPeriods(query);
  const conflictingPeriod = mentions.some(
    (item) => item.quarter !== number || item.year !== value,
  );
  const vintage = publicationVintage(query);
  const conflictingVintage =
    scope.vintage?.group &&
    vintage.group &&
    vintage.group !== scope.vintage.group;
  const subject =
    conflictingPeriod || conflictingVintage
      ? message.replace(/[?.!]\s+(?:use|cite)\b.*$/i, '').replace(/[?.!]$/u, '')
      : query;
  return [
    subject
      .replace(period, ' ')
      .replace(
        /\b(?:advance|initial|first|second|third|final|revised|preliminary)\s+(?:estimate|release)\b/gi,
        ' ',
      )
      .replace(/\s+/g, ' ')
      .trim(),
    ordinals[number - 1] + ' quarter ' + value,
    ...(scope.vintage?.label ? [scope.vintage.label + ' estimate'] : []),
  ]
    .join(' ')
    .slice(0, 4000);
}

export function sourceScopePriority(
  scope: ReturnType<typeof requestedScope>,
  title: string,
  url: string,
  excerpt = '',
): number {
  // A title or URL identifying a different issue takes precedence over an incidental body mention.
  const path = new URL(url).pathname.replace(/[._/-]+/g, ' ');
  // A site banner often markets this year's event on every archived article.
  const headline = title.split(/\s+\|\s+/, 1)[0]!;
  if (scope.period) {
    const identified = reportingPeriods(headline);
    const metadata = identified.length ? identified : reportingPeriods(path);
    const matches = (item: { quarter: number; year: number }) =>
      item.quarter === scope.period!.quarter &&
      item.year === scope.period!.year;
    if (metadata.length && !metadata.some(matches)) return -1;
    const vintage = publicationVintage(headline);
    const requested = scope.vintage?.group;
    // Revisions and final estimates are separate releases even for the same quarter.
    if (requested && vintage.group && vintage.group !== requested) return -1;
    return (
      (metadata.some(matches)
        ? 2
        : Number(reportingPeriods(excerpt).some(matches))) +
      Number(Boolean(requested && vintage.group === requested))
    );
  }
  if (scope.eventYear) {
    const years: string[] =
      headline.match(new RegExp('\\b' + year + '\\b', 'g')) ?? [];
    if (years.length && !years.includes(scope.eventYear)) return -1;
    const label = headline + ' ' + path;
    return (
      Number(new RegExp('\\b' + scope.eventYear + '\\b').test(label)) +
      Number(/\b(?:final|finals)\b/i.test(label)) +
      2 *
        Number(
          /\b(?:report|results?|highlights|title|champion)\b|\d\s*[-–:]\s*\d/i.test(
            headline,
          ),
        ) -
      Number(/\b(?:preview|predictions?|schedule)\b/i.test(headline)) +
      1
    );
  }
  return 0;
}
