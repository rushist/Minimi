import { describe, expect, it } from 'vitest';
import { extractPdf } from './extract-pdf.js';

function samplePdf(): Uint8Array {
  const stream = 'BT /F1 12 Tf 50 120 Td (PDF evidence text) Tj ET\n';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Length ' + stream.length + ' >>\nstream\n' + stream + 'endstream',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = objects.map((body, index) => {
    const offset = pdf.length;
    pdf += index + 1 + ' 0 obj\n' + body + '\nendobj\n';
    return String(offset).padStart(10, '0') + ' 00000 n \n';
  });
  const start = pdf.length;
  pdf +=
    'xref\n0 6\n0000000000 65535 f \n' +
    offsets.join('') +
    'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n' +
    start +
    '\n%%EOF\n';
  return new TextEncoder().encode(pdf);
}

describe('PDF extraction', () => {
  it('extracts text from a real one-page PDF and respects the text limit', async () => {
    await expect(extractPdf(samplePdf(), 1, 100)).resolves.toMatchObject({
      text: 'PDF evidence text',
    });
    await expect(extractPdf(samplePdf(), 1, 12)).resolves.toMatchObject({
      text: 'PDF evidence',
    });
  });
});
