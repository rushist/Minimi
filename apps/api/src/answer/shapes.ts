import type { Passage } from '@chatagent/shared';
import type { AnswerShape, Draft } from './types.js';

export function escapeMarkdown(text: string) {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replace(/[\\`*_{}[\]#!|~:]/g, '\\$&')
    .replace(/^[-+]/, '\\$&');
}

export const claimText = ({ label, text }: Draft) =>
  label ? label + ' — ' + text : text;
const header = '| Aspect | Evidence |\n| --- | --- |\n';

export function comparisonTable(
  drafts: readonly Draft[],
  subjects: readonly string[],
) {
  const rows = new Map<string, { label: string; cells: Map<number, string> }>();
  const covered = new Set<number>();
  for (const draft of drafts) {
    if (!draft.label || draft.column === undefined || !draft.cellValue)
      continue;
    const key = draft.label.toLowerCase();
    const row = rows.get(key) ?? {
      label: draft.label,
      cells: new Map<number, string>(),
    };
    const value = escapeMarkdown(draft.cellValue);
    const citations = draft.citedIds.map((id) => '[' + id + ']').join(' ');
    const cell =
      (draft.kind === 'conflict' ? '**Sources disagree.** ' : '') +
      value +
      ' ' +
      citations;
    row.cells.set(
      draft.column,
      [row.cells.get(draft.column), cell].filter(Boolean).join(' / '),
    );
    rows.set(key, row);
    covered.add(draft.column);
  }
  const line = (cells: string[]) => '| ' + cells.join(' | ') + ' |';
  return {
    covered,
    hasMatchedRow: [...rows.values()].some(
      ({ cells }) => cells.size === subjects.length,
    ),
    hasMissingCells: [...rows.values()].some(
      ({ cells }) => cells.size < subjects.length,
    ),
    markdown: [
      line(['Aspect', ...subjects.map(escapeMarkdown)]),
      line(subjects.map(() => '---').concat('---')),
      ...[...rows.values()].map(({ label, cells }) =>
        line([
          escapeMarkdown(label),
          ...subjects.map((_, i) => cells.get(i + 1) ?? 'Unverified'),
        ]),
      ),
    ].join('\n'),
  };
}

export function renderClaim(
  draft: Draft,
  shape: AnswerShape,
  index: number,
): string {
  const citations = draft.citedIds.map((id) => '[' + id + ']').join(' ');
  const text =
    (draft.kind === 'conflict' ? '**Sources disagree.** ' : '') +
    escapeMarkdown(draft.text) +
    ' ' +
    citations;
  if (shape === 'comparison') {
    return (
      (index === 0 ? header : '') +
      '| ' +
      escapeMarkdown(draft.label ?? 'Finding') +
      ' | ' +
      text +
      ' |\n'
    );
  }
  if (shape === 'timeline')
    return (
      '- **' +
      escapeMarkdown(draft.label ?? 'Date unavailable') +
      '** — ' +
      text +
      '\n'
    );
  if (shape === 'howto') return index + 1 + '. ' + text + '\n';
  if (shape === 'list') return '- ' + text + '\n';
  return text + '\n\n';
}

export function renderAbstention(sources: readonly Passage[], message: string) {
  if (!sources.length) return message;
  return (
    message +
    '\n\nSources reviewed:\n' +
    sources
      .slice(0, 3)
      .map(({ title, id }) => '- ' + escapeMarkdown(title) + ' [' + id + ']')
      .join('\n')
  );
}
