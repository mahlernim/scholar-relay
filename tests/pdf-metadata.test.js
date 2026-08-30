import test from 'node:test';
import assert from 'node:assert/strict';

import {
  choosePdfTitle,
  extractPdfMetadataTitle,
  isUsefulTitle,
  titleFromFilename,
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
