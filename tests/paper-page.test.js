import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectPaperPage } from '../content.js';

function element(attrs = {}, textContent = '') {
  return { textContent, getAttribute: name => attrs[name] ?? null };
}
function page({ meta = [], links = [], json = [], title = '', heading = '', contentType = 'text/html' } = {}) {
  return { title, contentType,
    querySelectorAll: selector => selector === 'meta' ? meta.map(([name, content]) => element({ name, content }))
      : selector.startsWith('script') ? json.map(text => element({}, text))
      : selector.startsWith('a[') ? links.map(([href, label]) => element({ href }, label)) : [],
    querySelector: selector => selector.startsWith('h1') && heading ? element({}, heading) : null,
  };
}

test('scholarly title and extensionless citation PDF take priority over other links', () => {
  const result = inspectPaperPage(page({ meta: [['citation_title', 'A useful paper title'], ['og:title', 'Social title'],
    ['citation_pdf_url', '/article/file?id=123&type=printable']], links: [['/supplement.pdf', 'Supplement PDF']] }), 'https://journals.plos.org/article?id=123');
  assert.equal(result.sourceTitle, 'A useful paper title');
  assert.equal(result.pdfUrl, 'https://journals.plos.org/article/file?id=123&type=printable');
  assert.equal(result.pdfEvidence, 'citation_pdf_url');
});

test('Dublin Core is case insensitive and precedes structured article and social titles', () => {
  const result = inspectPaperPage(page({ meta: [['DC.Title', 'Dublin Core paper title'], ['og:title', 'Social title']],
    json: [JSON.stringify({ '@type': 'ScholarlyArticle', headline: 'Structured title' })] }), 'https://example.org/article');
  assert.equal(result.sourceTitle, 'Dublin Core paper title');
});

test('article JSON-LD precedes Open Graph and headings, while malformed data is ignored', () => {
  const result = inspectPaperPage(page({ meta: [['og:title', 'Social title']], heading: 'Heading',
    json: ['bad JSON', JSON.stringify({ '@graph': [{ '@type': 'WebSite', name: 'Not the article' },
      { '@type': ['Article'], headline: 'The structured paper title' }] })] }), 'https://example.org/article');
  assert.equal(result.sourceTitle, 'The structured paper title');
});

test('eLife selects the full paper and preserves its selected version', () => {
  const result = inspectPaperPage(page({ meta: [['dc.title', 'Continuous endosomes form functional subdomains']],
    links: [['https://elifesciences.org/download/token/elife-91194-figures-v1.pdf?_hash=a', 'Download figures PDF'],
      ['https://elifesciences.org/download/token/elife-91194-v1.pdf?_hash=b', 'Download PDF']] }), 'https://elifesciences.org/articles/91194');
  assert.equal(result.pdfUrl, 'https://elifesciences.org/download/token/elife-91194-v1.pdf?_hash=b');
  assert.equal(result.sourceTitle, 'Continuous endosomes form functional subdomains');
});

test('arXiv PDF URL preserves explicit versions, including legacy identifiers', () => {
  for (const id of ['1706.03762v2', 'hep-th/9901001v1']) {
    const result = inspectPaperPage(page(), `https://arxiv.org/abs/${id}`);
    assert.equal(result.pdfUrl, `https://arxiv.org/pdf/${id}`);
    assert.equal(result.pdfEvidence, 'arxiv_abstract');
  }
});

test('missing titles, browser challenges, filenames and empty PDF metadata do not become article metadata', () => {
  for (const title of ['', 'Client Challenge', 'Checking your browser - reCAPTCHA', 'Sign in - Google', '1706.03762.pdf', 'https://example.org/a']) {
    const result = inspectPaperPage(page({ title, meta: [['citation_pdf_url', '']] }), 'https://example.org/article');
    assert.equal(result.sourceTitle, null, title);
    assert.equal(result.pdfUrl, null);
  }
});

test('BMJ metadata and Frontiers download endpoints work without a PDF extension', () => {
  assert.equal(inspectPaperPage(page({ meta: [['citation_pdf_url', '/content/article.full.pdf']] }),
    'https://www.bmj.com/content/article').pdfUrl, 'https://www.bmj.com/content/article.full.pdf');
  assert.equal(inspectPaperPage(page({ links: [['/journals/ai/articles/10.3389/test/pdf', 'Download PDF']] }),
    'https://www.frontiersin.org/journals/ai/articles/10.3389/test/full').pdfEvidence, 'pdf_link');
});
