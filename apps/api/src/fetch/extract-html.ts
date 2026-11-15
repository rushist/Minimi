import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';
import { FetchFailure } from './types.js';

function paywalled(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(paywalled);
  if (value && typeof value === 'object') {
    if (
      'isAccessibleForFree' in value &&
      (value.isAccessibleForFree === false ||
        value.isAccessibleForFree === 'false')
    )
      return true;
    if ('@graph' in value) return paywalled(value['@graph']);
  }
  return false;
}

const paragraphTags = new Set([
  'article',
  'section',
  'div',
  'p',
  'li',
  'blockquote',
  'pre',
  'tr',
  'dl',
  'dt',
  'dd',
]);

function structuredText(root: Node): string {
  const output: string[] = [];
  function visit(node: Node, depth: number) {
    if (node.nodeType === 3 || depth >= 128) {
      output.push((node.textContent ?? '').replace(/\s+/g, ' '));
      return;
    }
    const tag = node.nodeName.toLowerCase();
    const heading = /^h([1-6])$/.exec(tag)?.[1];
    if (heading) output.push('\n\n', '#'.repeat(Number(heading)), ' ');
    else if (paragraphTags.has(tag)) output.push('\n\n');
    else if (tag === 'br') output.push('\n');
    for (const child of node.childNodes) visit(child, depth + 1);
    if (heading || paragraphTags.has(tag)) output.push('\n\n');
  }
  visit(root, 0);
  return output
    .join('')
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter(Boolean)
    .join('\n\n');
}

export function extractHtml(
  input: Uint8Array | string,
  url: string,
  contentType: string,
) {
  const dom = new JSDOM(
    typeof input === 'string' ? input : Buffer.from(input),
    { url, contentType },
  );
  try {
    const { document } = dom.window;
    for (const script of document.querySelectorAll(
      'script[type="application/ld+json"]',
    )) {
      let metadata: unknown;
      try {
        metadata = JSON.parse(script.textContent ?? '');
      } catch {
        continue;
      }
      if (paywalled(metadata)) throw new FetchFailure('paywall');
    }
    const body = document.body;
    for (const element of document.querySelectorAll(
      'script, style, template, noscript, iframe, svg, [hidden]',
    ))
      element.remove();
    const title = document.title;
    const fallback = body ? structuredText(body) : '';
    const article = new Readability(document, {
      serializer: structuredText,
    }).parse();
    return {
      title: article?.title || title,
      text: article?.content?.trim() || fallback,
    };
  } finally {
    dom.window.close();
  }
}
