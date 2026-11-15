import type { Passage } from '@chatagent/shared';
import { userFilters } from '../planner/filters.js';
import { matchesSourceDomains } from '../url.js';
import { preparePassages } from './evidence.js';
import { escapeMarkdown } from './shapes.js';
import type { AnswerContext } from './types.js';

const stopWords = new Set(
  'about according and are answer cite could did does for from give had has have how include into its of only on please provide report show state than that the their them this use using was were what when where which who will with would'.split(
    ' ',
  ),
);
const sentence = new Intl.Segmenter('en', { granularity: 'sentence' });
const explicitYear = /\b[12]\d{3}\b/g;
const explicitQuarter =
  /\bQ([1-4])\b|\b(first|second|third|fourth|[1-4](?:st|nd|rd|th))\s+quarter\b/gi;
const dateQuestion =
  /^(?:when\b|(?:on|in)?\s*what\s+(?:day|date|year|month)\b)/i;
const dateEvidence = /\b[12]\d{3}\b/;
const release =
  /\b(?:releases?|released|launched|launch(?:es)?|published|premiered|premiere[sd]?)\b/i;
const discarded =
  /\b(?:sign in|cookie consent|click here|accept cookies|subscribe now)\b/i;
const quarterNumbers: Readonly<Record<string, string>> = {
  first: '1',
  second: '2',
  third: '3',
  fourth: '4',
};

function words(text: string) {
  return new Set(
    (
      text
        .normalize('NFKC')
        .toLowerCase()
        .match(/[\p{L}\p{N}]+/gu) ?? []
    )
      .filter(
        (word) => (word.length >= 2 || /\d/.test(word)) && !stopWords.has(word),
      )
      .map((word) =>
        word.replace(/(?:ing|ed|es|s)$/, (suffix) =>
          word.length - suffix.length >= 4 ? '' : suffix,
        ),
      ),
  );
}

function quarters(text: string) {
  return [...text.matchAll(explicitQuarter)].map(
    ([, abbreviation, ordinal]) =>
      abbreviation ?? quarterNumbers[ordinal!.toLowerCase()] ?? ordinal![0]!,
  );
}

interface Quote {
  id: string;
  title: string;
  excerpt: string;
  score: number;
}

function excerpts(text: string) {
  return text
    .split(/\n+|\s+\[\.\.\.\]\s+/u)
    .flatMap((line) =>
      [...sentence.segment(line)].map(({ segment }) =>
        segment.trim().replace(/\s+/g, ' '),
      ),
    )
    .filter(
      (excerpt) =>
        excerpt.length >= 20 &&
        excerpt.length <= 300 &&
        !discarded.test(excerpt),
    );
}

function matchQuestion(question: string, sources: readonly Passage[]) {
  const subject = question.split(
    /[.!?]\s+(?:cite|use|include|give|only)\b|\s+(?:please\s+)?cite\b/i,
    1,
  )[0]!;
  const terms = [...words(subject)];
  const identifiers = terms.filter((word) => /^\d+$/.test(word));
  const years = [...new Set(subject.match(explicitYear) ?? [])];
  const periods = [...new Set(quarters(subject))];
  const needsYear = dateQuestion.test(subject);
  const needsRelease = needsYear && release.test(subject);
  if (!terms.length) return;
  let best: Quote | undefined;
  for (const source of sources) {
    for (const excerpt of excerpts(source.text)) {
      const scope = source.title + ' ' + excerpt;
      if (years.some((year) => !scope.includes(year))) continue;
      if (periods.some((period) => !quarters(scope).includes(period))) continue;
      if (needsYear && !dateEvidence.test(excerpt)) continue;
      if (needsRelease && !release.test(excerpt)) continue;
      const body = words(excerpt);
      const title = words(source.title);
      if (identifiers.some((word) => !body.has(word) && !title.has(word)))
        continue;
      const direct = terms.filter((term) => body.has(term)).length;
      const contextual = terms.filter(
        (term) => body.has(term) || title.has(term),
      ).length;
      if (
        !direct ||
        contextual <
          Math.min(terms.length, Math.max(2, Math.ceil(terms.length * 0.6)))
      )
        continue;
      const score =
        (direct * 2 + contextual) / terms.length +
        Math.max(0, Math.min(1, source.scores.sourceQuality)) * 0.15;
      if (!best || score > best.score)
        best = { id: source.id, title: source.title, excerpt, score };
    }
  }
  return best;
}

export function extractSourceEvidence(
  context: Pick<AnswerContext, 'message' | 'questions'>,
  sources: readonly Passage[],
): { markdown: string; citedIds: string[] } | undefined {
  const filters = userFilters(context.message);
  const prepared = preparePassages(
    sources
      .filter(({ url }) =>
        matchesSourceDomains(new URL(url), filters.include, filters.exclude),
      )
      .slice(0, 8),
    2100,
  );
  const questions = context.questions.length
    ? context.questions
    : [context.message];
  const quotes = new Map<string, Quote>();
  for (const question of questions.slice(0, 10)) {
    const quote = matchQuestion(question, prepared);
    if (quote) quotes.set(quote.excerpt.toLowerCase(), quote);
    if (quotes.size === 3) break;
  }
  if (!quotes.size) return;
  const selected = [...quotes.values()];
  return {
    markdown:
      '**Source excerpts (verification incomplete)**\n\n' +
      selected
        .map(
          ({ title, excerpt, id }) =>
            '- ' +
            escapeMarkdown(title) +
            ' — “' +
            escapeMarkdown(excerpt) +
            '” [' +
            id +
            ']',
        )
        .join('\n'),
    citedIds: [...new Set(selected.map(({ id }) => id))],
  };
}
