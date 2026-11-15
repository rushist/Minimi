import MiniSearch from 'minisearch';

// Keep versions and identifiers such as 24.7.0, ERR_TLS_CERT_ALTNAME_INVALID and node:test intact.
function terms(text: string): string[] {
  return text.match(/[\p{L}\p{N}]+(?:[._:/-][\p{L}\p{N}]+)*/gu) ?? [];
}

export function lexicalRank(
  query: string,
  records: { id: number; title: string; heading: string; text: string }[],
) {
  if (!records.length) return [];
  const index = new MiniSearch({
    fields: ['title', 'heading', 'text'],
    tokenize: terms,
  });
  index.addAll(records);
  return index
    .search(query, { boost: { title: 2, heading: 1.5 } })
    .map((result) => ({ id: Number(result.id), score: result.score }))
    .sort((a, b) => b.score - a.score || a.id - b.id);
}
