import test from 'node:test';
import assert from 'node:assert/strict';

import {
  choosePdfTitle,
  extractPdfMetadataTitle,
  isUsefulTitle,
  titleFromFilename,
  choosePdfFileTitle,
  PDF_METADATA_WINDOW_BYTES,
} from '../pdf-metadata.js';

const bytes = text => new TextEncoder().encode(text);

test('extracts an XMP Dublin Core title from PDF bytes', () => {
  const payload = bytes(`%PDF-1.4
    <x:xmpmeta><rdf:RDF><rdf:Description>
      <dc:title><rdf:Alt><rdf:li xml:lang="x-default">Large language models &amp; discovery</rdf:li></rdf:Alt></dc:title>
    </rdf:Description></rdf:RDF></x:xmpmeta>
  %%EOF`);
  assert.equal(extractPdfMetadataTitle(payload), 'Large language models & discovery');
});

test('falls back to the PDF Info Title literal', () => {
  const payload = bytes('%PDF-1.4\n1 0 obj << /Title (A useful \\(paper\\) title) >> endobj\n%%EOF');
  assert.equal(extractPdfMetadataTitle(payload), 'A useful (paper) title');
});

test('prefers PDF metadata over a URL-shaped page title', () => {
  const payload = bytes('<dc:title><rdf:Alt><rdf:li>Proper paper title</rdf:li></rdf:Alt></dc:title>');
  assert.deepEqual(choosePdfTitle({
    payload,
    pageTitle: 'https://example.org/paper.pdf',
    filename: 'paper.pdf',
  }), { title: 'Proper paper title', source: 'pdf_metadata' });
});

test('rejects generic titles and opaque article identifiers', () => {
  assert.equal(isUsefulTitle('https://example.org/paper.pdf'), false);
  assert.equal(titleFromFilename('s42256-026-01283-z.pdf'), null);
  assert.equal(titleFromFilename('large_language_models_for_discovery.pdf'), 'large language models for discovery');
});

test('allows NotebookLM to name the notebook when no trustworthy title exists', () => {
  assert.deepEqual(choosePdfTitle({
    payload: bytes('%PDF-1.4\n%%EOF'),
    pageTitle: 'https://example.org/s42256-026-01283-z.pdf',
    filename: 's42256-026-01283-z.pdf',
  }), { title: null, source: 'notebooklm' });
});

test('a useful HTML title avoids inspecting PDF bytes', () => {
  assert.deepEqual(choosePdfTitle({ pageTitle: 'The actual article title', payload: 'not valid base64' }),
    { title: 'The actual article title', source: 'page_metadata' });
});

test('bounded metadata preserves tail XMP precedence and normalizes Base64 input', () => {
  const payload = new Uint8Array(PDF_METADATA_WINDOW_BYTES * 4).fill(32);
  payload.set(bytes('/Title (Head Info title)'));
  payload.set(bytes('<dc:title>Tail XMP title</dc:title>'), payload.length - 100);
  assert.equal(extractPdfMetadataTitle(payload), 'Tail XMP title');
  assert.equal(extractPdfMetadataTitle(payload.buffer), 'Tail XMP title');
  const base64 = Buffer.from(payload).toString('base64');
  assert.equal(extractPdfMetadataTitle(`data:application/pdf;base64,\n${base64}\n`), 'Tail XMP title');
});

test('metadata outside the windows or crossing a cut uses fallback naming', async () => {
  for (const offset of [PDF_METADATA_WINDOW_BYTES * 2, PDF_METADATA_WINDOW_BYTES - 10]) {
    const payload = new Uint8Array(PDF_METADATA_WINDOW_BYTES * 4).fill(32);
    payload.set(bytes('/Title (Outside scanned region)\n'), offset);
    assert.equal(extractPdfMetadataTitle(payload), null);
    assert.equal(extractPdfMetadataTitle(Buffer.from(payload).toString('base64')), null);
    assert.deepEqual(await choosePdfFileTitle({ file: new File([payload], 'paper.pdf') }),
      { title: null, source: 'notebooklm' });
  }
});

test('large local file metadata reads only two bounded slices', async () => {
  const reads = [];
  const file = {
    size: 40 * 1024 * 1024, name: 'paper.pdf',
    arrayBuffer() { throw new Error('Full-file metadata read'); },
    slice(start, end) {
      const length = start < 0 ? -start : end - start;
      reads.push(length);
      return new Blob([new Uint8Array(length)]);
    },
  };
  assert.deepEqual(await choosePdfFileTitle({ file }), { title: null, source: 'notebooklm' });
  assert.deepEqual(reads, [PDF_METADATA_WINDOW_BYTES, PDF_METADATA_WINDOW_BYTES]);
  reads.length = 0;
  assert.equal((await choosePdfFileTitle({ file, pageTitle: 'Useful HTML title' })).source, 'page_metadata');
  assert.equal(reads.length, 0);
});

test('Base64 metadata decoding is bounded before allocating decoded bytes', () => {
  const original = globalThis.atob;
  const lengths = [];
  globalThis.atob = value => { lengths.push(value.length); return original(value); };
  try {
    const payload = Buffer.alloc(4 * PDF_METADATA_WINDOW_BYTES, 32).toString('base64');
    assert.equal(extractPdfMetadataTitle(payload), null);
    assert.equal(lengths.length, 2);
    assert.ok(lengths.every(length => length <= Math.ceil(PDF_METADATA_WINDOW_BYTES / 3) * 4));
  } finally { globalThis.atob = original; }
});
