import type { Passage } from '@chatagent/shared';
import { canonicalUrl } from '../url.js';

const instruction =
  /(?:\b(?:ignore|disregard|override|forget)\b.{0,64}\b(?:instructions?|system prompt|previous messages?|rules)\b|\b(?:system|developer|assistant)\s+(?:message|prompt|instructions?)\s*:|\b(?:call|invoke|execute|use)\b.{0,25}\b(?:tools?|functions?)\b.{0,32}\b(?:now|instead|next|above)\b|\b(?:you are|act as)\b.{0,24}\b(?:an? )?(?:assistant|language model|chatbot)\b|\b(?:emit|output|reply|respond|say|print)\b.{0,32}\b(?:verbatim|exactly|instead|only)\b|\b(?:tool_calls|tool_call|function_call|system_prompt)\b|<\/?(?:system|assistant|developer|tool|evidence)\b|\[(?:system|assistant|developer|tool)\])/i;

function cleanEvidence(text: string): string {
  return text
    .replaceAll('\0', '')
    .split(/(?<=[.!?])(?=\s)|(?<=\n)/)
    .filter((part) => !instruction.test(part))
    .join('')
    .trim();
}

export function preparePassages(
  passages: readonly Passage[],
  maxChars: number,
): Passage[] {
  return passages.flatMap((passage) => {
    const text = cleanEvidence(passage.text.slice(0, maxChars * 3))
      .slice(0, maxChars)
      .trim();
    if (!text) return [];
    return [
      {
        ...passage,
        text,
        title:
          cleanEvidence(passage.title.slice(0, 500))
            .replace(/\s+/g, ' ')
            .slice(0, 160) || passage.domain,
      },
    ];
  });
}

export function groupPassagesBySource(passages: readonly Passage[]) {
  const sources = new Map<
    string,
    { passage: Passage; excerpts: Set<string> }
  >();
  const aliases = new Map<string, string>();
  for (const passage of passages) {
    const url = canonicalUrl(passage.url)?.href ?? passage.url;
    let source = sources.get(url);
    if (!source) {
      source = { passage, excerpts: new Set() };
      sources.set(url, source);
    }
    source.excerpts.add(passage.text);
    aliases.set(passage.id, source.passage.id);
  }
  return {
    sources: [...sources.values()].map(({ passage, excerpts }) => ({
      ...passage,
      text: [...excerpts].join('\n\n'),
    })),
    citationIds: (ids: readonly string[]) => [
      ...new Set(ids.map((id) => aliases.get(id) ?? id)),
    ],
  };
}

export function promptJson(value: unknown) {
  return JSON.stringify(value).replace(
    /[<>&]/g,
    (char) => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0'),
  );
}

export function evidenceBlock(value: unknown) {
  return '<evidence>\n' + promptJson(value) + '\n</evidence>';
}
