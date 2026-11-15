export function fingerprint(text: string) {
  const words = (
    text
      .normalize('NFKC')
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? []
  ).slice(0, 3000);
  const normalized = words.join(' ');
  const markers = (
    text.toLowerCase().match(/\b[\w]+(?:[._:/-][\w]+)*\b/g) ?? []
  )
    .filter(
      (word) =>
        /\d/.test(word) || ['no', 'not', 'never', 'without'].includes(word),
    )
    .join(' ');
  const shingles = new Set<string>();
  if (words.length >= 18) {
    for (let index = 0; index + 4 <= words.length; index++)
      shingles.add(words.slice(index, index + 4).join(' '));
  }
  return { normalized, markers, shingles };
}

export function similar(
  left: ReturnType<typeof fingerprint>,
  right: ReturnType<typeof fingerprint>,
) {
  if (left.markers !== right.markers) return false;
  if (left.normalized && left.normalized === right.normalized) return true;
  const small = Math.min(left.shingles.size, right.shingles.size);
  const large = Math.max(left.shingles.size, right.shingles.size);
  if (!small || small / large < 0.8) return false;
  let matches = 0;
  for (const shingle of left.shingles)
    if (right.shingles.has(shingle)) matches++;
  return matches / (left.shingles.size + right.shingles.size - matches) >= 0.8;
}
