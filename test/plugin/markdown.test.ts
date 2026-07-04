// test/plugin/markdown.test.ts — unit tests for plugin/markdown.js (zero-dependency MD→DOM/HTML).
// Tests the string-based APIs only (markdownToHtml, escapeHtml, parseInline, stripHtmlTags,
// parseBlocks, blocksToHtml). renderMarkdown needs a DOM and is not tested here.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  escapeHtml,
  parseInline,
  stripHtmlTags,
  parseBlocks,
  blocksToHtml,
  markdownToHtml,
} = require('../../plugin/markdown.js');

// ---------------------------------------------------------------------------
// escapeHtml
// ---------------------------------------------------------------------------
describe('escapeHtml', () => {
  it('escapes all five special chars', () => {
    expect(escapeHtml('<a href="x">&\'</a>')).toBe(
      '&lt;a href=&quot;x&quot;&gt;&amp;&#039;&lt;/a&gt;',
    );
  });

  it('escapes & first (no double-escaping of generated entities)', () => {
    expect(escapeHtml('&')).toBe('&amp;');
    expect(escapeHtml('&amp;')).toBe('&amp;amp;');
  });

  it('empty string → empty string', () => {
    expect(escapeHtml('')).toBe('');
  });

  it('non-string is stringified then escaped', () => {
    expect(escapeHtml(42)).toBe('42');
    expect(escapeHtml(null)).toBe('null');
    expect(escapeHtml(undefined)).toBe('undefined');
  });

  it('leaves plain text unchanged', () => {
    expect(escapeHtml('hello world')).toBe('hello world');
  });
});

// ---------------------------------------------------------------------------
// parseInline
// ---------------------------------------------------------------------------
describe('parseInline', () => {
  it('plain text → all text tokens (one per char)', () => {
    const tokens = parseInline('hello');
    expect(tokens).toEqual([{ type: 'text', value: 'hello' }]);
  });

  it('backtick code → code token', () => {
    const tokens = parseInline('foo `bar` baz');
    const codeToken = tokens.find((t: any) => t.type === 'code');
    expect(codeToken).toBeDefined();
    expect(codeToken!.value).toBe('bar');
  });

  it('unclosed backtick → rest becomes text', () => {
    const tokens = parseInline('hello `world');
    const last = tokens[tokens.length - 1];
    expect(last.type).toBe('text');
    expect(last.value).toBe('hello `world');
  });

  it('bold **text** → strong token', () => {
    const tokens = parseInline('**bold**');
    const strong = tokens.find((t: any) => t.type === 'strong');
    expect(strong).toBeDefined();
    expect(strong!.value).toBe('bold');
  });

  it('bold+italic ***text*** → strong token', () => {
    const tokens = parseInline('***text***');
    const strong = tokens.find((t: any) => t.type === 'strong');
    expect(strong).toBeDefined();
    expect(strong!.value).toBe('text');
  });

  it('italic *text* → em token', () => {
    const tokens = parseInline('*italic*');
    const em = tokens.find((t: any) => t.type === 'em');
    expect(em).toBeDefined();
    expect(em!.value).toBe('italic');
  });

  it('link [text](url) → link token with url', () => {
    const tokens = parseInline('[click](http://example.com)');
    const link = tokens.find((t: any) => t.type === 'link');
    expect(link).toBeDefined();
    expect(link!.value).toBe('click');
    expect((link as any).url).toBe('http://example.com');
  });

  it('plain text without markup → all text tokens', () => {
    const tokens = parseInline('just plain text');
    expect(tokens).toHaveLength(1);
    expect(tokens.every((t: any) => t.type === 'text')).toBe(true);
  });

  it('mixed content', () => {
    const tokens = parseInline('see `code` and **bold** end');
    expect(tokens.some((t: any) => t.type === 'code')).toBe(true);
    expect(tokens.some((t: any) => t.type === 'strong')).toBe(true);
    expect(tokens.some((t: any) => t.type === 'text')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// stripHtmlTags
// ---------------------------------------------------------------------------
describe('stripHtmlTags', () => {
  it('removes simple tags', () => {
    expect(stripHtmlTags('<b>hello</b>')).toBe('hello');
  });

  it('removes tags with attributes', () => {
    expect(stripHtmlTags('<a href="x">link</a>')).toBe('link');
  });

  it('removes self-closing tags', () => {
    expect(stripHtmlTags('a<br>b')).toBe('ab');
  });

  it('removes script tags', () => {
    expect(stripHtmlTags('<script>alert(1)</script>')).toBe('alert(1)');
  });

  it('leaves plain text unchanged', () => {
    expect(stripHtmlTags('no tags here')).toBe('no tags here');
  });

  it('non-string is stringified', () => {
    expect(stripHtmlTags(123)).toBe('123');
  });
});

// ---------------------------------------------------------------------------
// parseBlocks
// ---------------------------------------------------------------------------
describe('parseBlocks', () => {
  it('paragraph', () => {
    const blocks = parseBlocks('hello world');
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('paragraph');
    expect(blocks[0].content).toBe('hello world');
  });

  it('fenced code block', () => {
    const md = '```js\nconst x = 1;\n```';
    const blocks = parseBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('code');
    expect(blocks[0].lang).toBe('js');
    expect(blocks[0].content).toBe('const x = 1;');
  });

  it('unclosed fence still produces code block', () => {
    const md = '```\nconst x = 1;';
    const blocks = parseBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('code');
    expect(blocks[0].content).toBe('const x = 1;');
  });

  it('header h1-h4', () => {
    expect(parseBlocks('# H1')[0].type).toBe('header');
    expect(parseBlocks('# H1')[0].level).toBe(1);
    expect(parseBlocks('## H2')[0].level).toBe(2);
    expect(parseBlocks('### H3')[0].level).toBe(3);
    expect(parseBlocks('#### H4')[0].level).toBe(4);
  });

  it('horizontal rule', () => {
    expect(parseBlocks('---')[0].type).toBe('hr');
    expect(parseBlocks('***')[0].type).toBe('hr');
    expect(parseBlocks('___')[0].type).toBe('hr');
  });

  it('blockquote', () => {
    const blocks = parseBlocks('> quote line');
    expect(blocks[0].type).toBe('blockquote');
    expect(blocks[0].content).toBe('quote line');
  });

  it('unordered list', () => {
    const blocks = parseBlocks('- item1\n- item2');
    expect(blocks[0].type).toBe('ul');
    expect(blocks[0].items).toEqual(['item1', 'item2']);
  });

  it('ordered list', () => {
    const blocks = parseBlocks('1. first\n2. second');
    expect(blocks[0].type).toBe('ol');
    expect(blocks[0].items).toEqual(['first', 'second']);
  });

  it('multiple blocks', () => {
    const md = '# Title\n\nparagraph here\n\n- list item';
    const blocks = parseBlocks(md);
    expect(blocks.length).toBeGreaterThanOrEqual(3);
    expect(blocks[0].type).toBe('header');
    expect(blocks.some((b: any) => b.type === 'paragraph')).toBe(true);
    expect(blocks.some((b: any) => b.type === 'ul')).toBe(true);
  });

  it('blank lines are skipped', () => {
    const blocks = parseBlocks('para1\n\n\npara2');
    expect(blocks).toHaveLength(2);
    expect(blocks[0].type).toBe('paragraph');
    expect(blocks[1].type).toBe('paragraph');
  });
});

// ---------------------------------------------------------------------------
// blocksToHtml
// ---------------------------------------------------------------------------
describe('blocksToHtml', () => {
  it('paragraph → <p>', () => {
    const html = blocksToHtml(parseBlocks('hello'));
    expect(html).toContain('<p');
    expect(html).toContain('hello');
    expect(html).toContain('</p>');
  });

  it('code block → <pre><code>', () => {
    const html = blocksToHtml(parseBlocks('```\ncode here\n```'));
    expect(html).toContain('<pre');
    expect(html).toContain('<code>');
    expect(html).toContain('</code></pre>');
    expect(html).toContain('code here');
  });

  it('header h1 capped at h3', () => {
    const html = blocksToHtml(parseBlocks('# Big Title'));
    expect(html).toContain('<h3');
    expect(html).toContain('Big Title');
    expect(html).toContain('</h3>');
  });

  it('header h3 stays h3', () => {
    const html = blocksToHtml(parseBlocks('### Section'));
    expect(html).toContain('<h3');
    expect(html).toContain('Section');
  });

  it('header h4 stays h4', () => {
    const html = blocksToHtml(parseBlocks('#### Sub'));
    expect(html).toContain('<h4');
  });

  it('unordered list → <ul><li>', () => {
    const html = blocksToHtml(parseBlocks('- one\n- two'));
    expect(html).toContain('<ul');
    expect(html).toContain('<li>');
    expect(html).toContain('one');
    expect(html).toContain('two');
    expect(html).toContain('</ul>');
  });

  it('ordered list → <ol><li>', () => {
    const html = blocksToHtml(parseBlocks('1. first\n2. second'));
    expect(html).toContain('<ol');
    expect(html).toContain('<li>');
    expect(html).toContain('</ol>');
  });

  it('blockquote → <blockquote>', () => {
    const html = blocksToHtml(parseBlocks('> quoted'));
    expect(html).toContain('<blockquote');
    expect(html).toContain('quoted');
    expect(html).toContain('</blockquote>');
  });

  it('hr → <hr>', () => {
    const html = blocksToHtml(parseBlocks('---'));
    expect(html).toContain('<hr');
  });

  it('inline code in paragraph', () => {
    const html = blocksToHtml(parseBlocks('use `foo` now'));
    expect(html).toContain('<code');
    expect(html).toContain('foo');
  });

  it('bold in paragraph', () => {
    const html = blocksToHtml(parseBlocks('this is **bold** text'));
    expect(html).toContain('<strong>bold</strong>');
  });

  it('link in paragraph', () => {
    const html = blocksToHtml(parseBlocks('[click](http://x.com)'));
    expect(html).toContain('<a href="http://x.com"');
    expect(html).toContain('click');
    expect(html).toContain('</a>');
  });
});

// ---------------------------------------------------------------------------
// markdownToHtml (full pipeline)
// ---------------------------------------------------------------------------
describe('markdownToHtml', () => {
  it('empty string → empty string (no blocks)', () => {
    expect(markdownToHtml('')).toBe('');
  });

  it('non-string → empty string', () => {
    expect(markdownToHtml(null as any)).toBe('');
    expect(markdownToHtml(undefined as any)).toBe('');
    expect(markdownToHtml(42 as any)).toBe('');
  });

  it('simple paragraph', () => {
    const html = markdownToHtml('hello world');
    expect(html).toContain('<p');
    expect(html).toContain('hello world');
  });

  it('multiple paragraphs separated by blank lines', () => {
    const html = markdownToHtml('para one\n\npara two');
    expect(html).toContain('para one');
    expect(html).toContain('para two');
    // Should have two <p> blocks
    const pCount = (html.match(/<p /g) || []).length;
    expect(pCount).toBe(2);
  });

  it('fenced code block with language', () => {
    const html = markdownToHtml('```gml\nvar x = 10;\n```');
    expect(html).toContain('<pre');
    expect(html).toContain('<code>');
    expect(html).toContain('var x = 10;');
  });

  it('inline code', () => {
    const html = markdownToHtml('use `variable` here');
    expect(html).toContain('<code');
    expect(html).toContain('variable');
  });

  it('bold text', () => {
    const html = markdownToHtml('**bold text**');
    expect(html).toContain('<strong>bold text</strong>');
  });

  it('italic text', () => {
    const html = markdownToHtml('*italic*');
    expect(html).toContain('<em>italic</em>');
  });

  it('header h1', () => {
    const html = markdownToHtml('# Title');
    expect(html).toContain('<h3');
    expect(html).toContain('Title');
  });

  it('header h2', () => {
    const html = markdownToHtml('## Section');
    expect(html).toContain('<h3');
    expect(html).toContain('Section');
  });

  it('unordered list', () => {
    const html = markdownToHtml('- apple\n- banana');
    expect(html).toContain('<ul');
    expect(html).toContain('apple');
    expect(html).toContain('banana');
    expect(html).toContain('</ul>');
  });

  it('ordered list', () => {
    const html = markdownToHtml('1. first\n2. second');
    expect(html).toContain('<ol');
    expect(html).toContain('first');
    expect(html).toContain('second');
    expect(html).toContain('</ol>');
  });

  it('link', () => {
    const html = markdownToHtml('[text](http://url.com)');
    expect(html).toContain('href="http://url.com"');
    expect(html).toContain('>text<');
  });

  it('blockquote', () => {
    const html = markdownToHtml('> quoted text');
    expect(html).toContain('<blockquote');
    expect(html).toContain('quoted text');
  });

  it('horizontal rule', () => {
    const html = markdownToHtml('---');
    expect(html).toContain('<hr');
  });

  it('mixed content: paragraph + code block + list', () => {
    const md = 'Some intro text.\n\n```js\nconst x = 1;\n```\n\n- item one\n- item two';
    const html = markdownToHtml(md);
    expect(html).toContain('Some intro text');
    expect(html).toContain('<pre');
    expect(html).toContain('const x = 1');
    expect(html).toContain('<ul');
    expect(html).toContain('item one');
    expect(html).toContain('item two');
  });

  it('XSS: raw <script> tags are stripped', () => {
    const html = markdownToHtml('<script>alert(1)</script>');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<script>');
    // The content "alert(1)" should survive but as escaped text, not as a tag
    expect(html).toContain('alert(1)');
  });

  it('XSS: raw HTML in paragraph is stripped', () => {
    const html = markdownToHtml('text <img src=x onerror=alert(1)> more');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('onerror');
  });

  it('line breaks within paragraph become <br>', () => {
    const html = markdownToHtml('line one\nline two');
    expect(html).toContain('<br>');
    expect(html).toContain('line one');
    expect(html).toContain('line two');
  });

  it('unclosed bold marker renders as text', () => {
    const html = markdownToHtml('**unclosed bold');
    // Should not crash, should contain the text
    expect(html).toContain('unclosed bold');
    expect(html).not.toContain('<strong>**unclosed bold</strong>');
  });

  it('nested inline: bold inside list item', () => {
    const html = markdownToHtml('- **bold item**');
    expect(html).toContain('<li>');
    expect(html).toContain('<strong>bold item</strong>');
  });

  it('never throws on malformed input', () => {
    expect(() => markdownToHtml('```\n```')).not.toThrow();
    expect(() => markdownToHtml('***\n###')).not.toThrow();
    expect(() => markdownToHtml('[unclosed')).not.toThrow();
    expect(() => markdownToHtml('`')).not.toThrow();
  });

  it('fenced code block content is HTML-escaped', () => {
    const html = markdownToHtml('```\n<x>\n```');
    expect(html).toContain('&lt;x&gt;');
    expect(html).not.toContain('<x>');
  });
});
