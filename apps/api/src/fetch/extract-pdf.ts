import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

export async function extractPdf(
  data: Uint8Array,
  maxPages: number,
  maxTextChars: number,
) {
  const require = createRequire(import.meta.url);
  const assets = dirname(require.resolve('pdfjs-dist/package.json'));
  const task = getDocument({
    standardFontDataUrl: join(assets, 'standard_fonts') + '/',
    cMapUrl: join(assets, 'cmaps') + '/',
    data,
    useSystemFonts: false,
    disableFontFace: true,
    useWasm: false,
  });
  try {
    const pdf = await task.promise;
    const paragraphs: string[] = [];
    let remaining = maxTextChars;
    for (
      let pageNumber = 1;
      pageNumber <= Math.min(pdf.numPages, maxPages) && remaining > 0;
      pageNumber++
    ) {
      const page = await pdf.getPage(pageNumber);
      try {
        const content = await page.getTextContent();
        const text = content.items
          .flatMap((item) =>
            'str' in item ? [item.str + (item.hasEOL ? '\n' : ' ')] : [],
          )
          .join('')
          .slice(0, remaining);
        paragraphs.push(text);
        remaining -= text.length + 2;
      } finally {
        page.cleanup();
      }
    }
    return { title: '', text: paragraphs.join('\n\n').trim() };
  } finally {
    await task.destroy();
  }
}
