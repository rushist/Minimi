import type { Chunk } from './types.js';

export const chunkFormat = 'paragraphs-v1';
const targetTokens = 280;
const maxTokens = 360;
const overlapTokens = 32;
const maxChunks = 16;

function tokens(text: string) {
  return [
    ...text.matchAll(
      /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]|[\p{L}\p{N}]+|[^\s\p{L}\p{N}]/gu,
    ),
  ];
}

function tail(text: string) {
  const matches = tokens(text);
  return text.slice(
    matches[Math.max(0, matches.length - overlapTokens)]?.index ?? 0,
  );
}

export function chunkText(text: string): Chunk[] {
  const chunks: Chunk[] = [];
  let heading: string | undefined;
  let parts: string[] = [];
  let count = 0;
  let hasNewText = false;

  function flush() {
    if (hasNewText && chunks.length < maxChunks) {
      chunks.push({
        text: parts.join('\n\n'),
        ...(heading ? { heading } : {}),
      });
    }
    hasNewText = false;
  }

  function add(part: string, length: number) {
    if (count + length > maxTokens && hasNewText) {
      flush();
      const overlap = tail(parts.at(-1)!);
      parts = [overlap];
      count = tokens(overlap).length;
    }
    if (count + length > maxTokens && !hasNewText) {
      parts = [];
      count = 0;
    }
    parts.push(part);
    count += length;
    hasNewText = true;
  }

  for (const block of text.split(/\r?\n\s*\r?\n|\r?\n(?=\s*#{1,6}\s)/)) {
    if (chunks.length >= maxChunks) break;
    let paragraph = block.trim();
    const match = /^#{1,6}\s+([^\n]+)(?:\n|$)/.exec(paragraph);
    if (match) {
      flush();
      heading = match[1]!.trim();
      parts = [];
      count = 0;
      paragraph = paragraph.slice(match[0].length).trim();
    }
    if (!paragraph) continue;
    const matches = tokens(paragraph);
    if (matches.length <= 320) {
      add(paragraph, matches.length);
      continue;
    }
    for (
      let start = 0;
      start < matches.length && chunks.length < maxChunks;
      start += targetTokens
    ) {
      const end = Math.min(start + targetTokens, matches.length);
      const from = start === 0 ? 0 : matches[start]!.index!;
      const to =
        end === matches.length ? paragraph.length : matches[end]!.index!;
      add(paragraph.slice(from, to).trim(), end - start);
    }
  }
  flush();
  return chunks;
}
