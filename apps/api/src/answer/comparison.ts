import type { Passage, Plan } from '@chatagent/shared';

const tableRequest =
  /\b(?:in|as|into|using)\s+(?:(?:a|the)\s+)?(?:markdown\s+)?(?:table|tabular|tablur)\b(?:\s+format\w*)?/i;
const columnRequest =
  /\s+(?:in|with|using)\s+(?:(?:their|its|a)\s+)?(?:own\s+|separate\s+|individual\s+|side[- ]by[- ]side\s+)?(?:columns?|colunmns?)\s*[.!?]*$/i;

export function requestsTable(message: string) {
  return tableRequest.test(message) || columnRequest.test(message);
}

export function withoutTableRequest(message: string) {
  return message.replace(tableRequest, '').replace(columnRequest, '').trim();
}

export function comparisonRequest(
  message: string,
):
  | { subjects: NonNullable<Plan['comparisonSubjects']>; focus?: string }
  | undefined {
  const cleaned = withoutTableRequest(message).replace(/[.!?]+$/, '');
  const focusStart =
    /\s+(?:in terms of|with respect to|focusing on|specifically for|based on)\s+/i.exec(
      cleaned,
    );
  const names = focusStart ? cleaned.slice(0, focusStart.index) : cleaned;
  const focus = focusStart
    ? cleaned.slice(focusStart.index + focusStart[0].length).trim()
    : undefined;
  const compare = /^compare\s+/i.test(names);
  if (!compare && !/\s(?:versus|vs\.?)\s/i.test(names)) return;
  const subjects = [
    ...new Set(
      names
        .replace(/^compare\s+/i, '')
        .split(
          compare
            ? /,\s*(?:and\s+)?|\s+(?:versus|vs\.?|with|to|and)\s+/i
            : /\s+(?:versus|vs\.?)\s+/i,
        )
        .map((part) => part.trim())
        .filter(Boolean),
    ),
  ];
  if (
    subjects.length >= 2 &&
    subjects.length <= 8 &&
    subjects.every((subject) => subject.length <= 160)
  )
    return { subjects, ...(focus ? { focus } : {}) };
}

export const comparisonSubjects = (message: string) =>
  comparisonRequest(message)?.subjects;

const words = (text: string) =>
  text
    .normalize('NFKC')
    .toLowerCase()
    .match(/[\p{L}\p{N}]+/gu)
    ?.join(' ') ?? '';

export function mentionsSubject(text: string, subject: string) {
  const name = words(subject);
  return Boolean(name) && (' ' + words(text) + ' ').includes(' ' + name + ' ');
}

export function balanceComparisonPassages(
  passages: Passage[],
  subjects: NonNullable<Plan['comparisonSubjects']>,
) {
  const sides = subjects.map((subject) =>
    passages.filter(({ title, text }) =>
      mentionsSubject(title + '\n' + text, subject),
    ),
  );
  const balanced = new Set<Passage>();
  for (let i = 0; i < Math.max(...sides.map(({ length }) => length)); i++) {
    for (const side of sides) if (side[i]) balanced.add(side[i]!);
  }
  return [...new Set([...balanced, ...passages])];
}
