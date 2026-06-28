// plugin/markdown.js — Lightweight zero-dependency markdown-to-DOM renderer for GMEdit's Electron
// renderer (CommonJS + global namespace). Exports `renderMarkdown(text, container)` and
// `markdownToHtml(text)` for use inside ChatGML plugin panels.
//
// GFM subset: fenced code blocks, inline code, bold, italic, headers (h1-h4 capped at h3
// visually), unordered & ordered lists, links, blockquotes, horizontal rules, paragraphs, line
// breaks, and raw-HTML stripping for XSS safety.
//
// Robust by design: never throws on malformed input; partial/streaming markdown still renders.
(function (root) {
  'use strict';

  // --- HTML escaping helper (textContent replacement for raw strings) ---
  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // --- Inline markup parser (bold, italic, inline code, links) ---
  // Returns an array of { type: 'text'|'code'|'strong'|'em'|'link', value: string }
  function parseInline(text) {
    var tokens = [];
    var i = 0;
    var len = text.length;

    while (i < len) {
      // Inline code: `...`
      if (text[i] === '`') {
        var end = text.indexOf('`', i + 1);
        if (end === -1) {
          // Unclosed backtick — treat rest as plain text
          tokens.push({ type: 'text', value: text.slice(i) });
          break;
        }
        tokens.push({ type: 'code', value: text.slice(i + 1, end) });
        i = end + 1;
        continue;
      }

      // Bold+Italic: ***text*** (must check before individual ** and *)
      if (text[i] === '*' && text[i + 1] === '*' && text[i + 2] === '*') {
        var close = text.indexOf('***', i + 3);
        if (close !== -1) {
          tokens.push({ type: 'strong', value: text.slice(i + 3, close) });
          i = close + 3;
          continue;
        }
      }

      // Bold: **text**
      if (text[i] === '*' && text[i + 1] === '*') {
        var closeB = text.indexOf('**', i + 2);
        if (closeB !== -1) {
          tokens.push({ type: 'strong', value: text.slice(i + 2, closeB) });
          i = closeB + 2;
          continue;
        }
      }

      // Italic: *text*
      if (text[i] === '*' && text[i + 1] !== '*') {
        var closeI = text.indexOf('*', i + 1);
        if (closeI !== -1) {
          tokens.push({ type: 'em', value: text.slice(i + 1, closeI) });
          i = closeI + 1;
          continue;
        }
      }

      // Link: [text](url)
      if (text[i] === '[') {
        var closeBracket = text.indexOf(']', i + 1);
        if (closeBracket !== -1 && text[closeBracket + 1] === '(') {
          var closeParen = text.indexOf(')', closeBracket + 2);
          if (closeParen !== -1) {
            var linkText = text.slice(i + 1, closeBracket);
            var linkUrl = text.slice(closeBracket + 2, closeParen);
            tokens.push({ type: 'link', value: linkText, url: linkUrl });
            i = closeParen + 1;
            continue;
          }
        }
      }

      // Plain character
      tokens.push({ type: 'text', value: text[i] });
      i++;
    }

    return tokens;
  }

  // Convert inline tokens to an HTML string fragment
  function inlineToHtml(tokens) {
    var parts = [];
    for (var j = 0; j < tokens.length; j++) {
      var t = tokens[j];
      switch (t.type) {
        case 'text':
          parts.push(escapeHtml(t.value));
          break;
        case 'code':
          parts.push('<code class="chatgml-md-code-inline">' + escapeHtml(t.value) + '</code>');
          break;
        case 'strong':
          parts.push('<strong>' + inlineToHtml(parseInline(t.value)) + '</strong>');
          break;
        case 'em':
          parts.push('<em>' + inlineToHtml(parseInline(t.value)) + '</em>');
          break;
        case 'link':
          parts.push(
            '<a href="' + escapeHtml(t.url) + '" class="chatgml-md-link">' + inlineToHtml(parseInline(t.value)) + '</a>',
          );
          break;
      }
    }
    return parts.join('');
  }

  // Strip raw HTML tags from a string (XSS safety)
  function stripHtmlTags(str) {
    return String(str).replace(/<[^>]*>/g, '');
  }

  // --- Block-level parser ---
  function parseBlocks(text) {
    var blocks = [];
    var lines = text.split('\n');
    var i = 0;

    while (i < lines.length) {
      var line = lines[i];

      // Fenced code block: ```lang ... ```
      if (/^```/.test(line.trim())) {
        var fenceMatch = /^```(\w*)/.exec(line.trim());
        var lang = fenceMatch ? fenceMatch[1] : '';
        var codeLines = [];
        i++;
        while (i < lines.length) {
          if (/^```\s*$/.test(lines[i].trim())) {
            i++;
            break;
          }
          codeLines.push(lines[i]);
          i++;
        }
        // Unclosed fence: render what we have as code block
        blocks.push({
          type: 'code',
          lang: lang,
          content: codeLines.join('\n'),
        });
        continue;
      }

      // Horizontal rule: --- or *** or ___ (at least 3 chars, possibly with spaces)
      if (/^\s*([-*_]\s*){3,}\s*$/.test(line)) {
        blocks.push({ type: 'hr' });
        i++;
        continue;
      }

      // Headers: # H1 through #### H4
      var headerMatch = /^(#{1,4})\s+(.*)/.exec(line);
      if (headerMatch) {
        var level = headerMatch[1].length;
        var headerText = stripHtmlTags(headerMatch[2]);
        blocks.push({
          type: 'header',
          level: level,
          content: headerText,
        });
        i++;
        continue;
      }

      // Blockquote: > text
      if (/^>\s?/.test(line)) {
        var bqLines = [];
        while (i < lines.length && /^>\s?/.test(lines[i])) {
          bqLines.push(lines[i].replace(/^>\s?/, ''));
          i++;
        }
        blocks.push({
          type: 'blockquote',
          content: bqLines.join('\n'),
        });
        continue;
      }

      // Unordered list: - item or * item
      if (/^\s*[-*]\s+/.test(line)) {
        var items = [];
        while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
          items.push(lines[i].replace(/^\s*[-*]\s+/, ''));
          i++;
        }
        blocks.push({ type: 'ul', items: items });
        continue;
      }

      // Ordered list: 1. item
      if (/^\s*\d+\.\s+/.test(line)) {
        var oItems = [];
        while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
          oItems.push(lines[i].replace(/^\s*\d+\.\s+/, ''));
          i++;
        }
        blocks.push({ type: 'ol', items: oItems });
        continue;
      }

      // Blank line — skip (serves as paragraph separator)
      if (line.trim() === '') {
        i++;
        continue;
      }

      // Paragraph: collect consecutive non-blank, non-special lines
      var paraLines = [];
      while (
        i < lines.length &&
        lines[i].trim() !== '' &&
        !/^```/.test(lines[i].trim()) &&
        !/^\s*([-*_]\s*){3,}\s*$/.test(lines[i]) &&
        !/^(#{1,4})\s+/.test(lines[i]) &&
        !/^>\s?/.test(lines[i]) &&
        !/^\s*[-*]\s+/.test(lines[i]) &&
        !/^\s*\d+\.\s+/.test(lines[i])
      ) {
        paraLines.push(lines[i]);
        i++;
      }
      blocks.push({ type: 'paragraph', content: paraLines.join('\n') });
    }

    return blocks;
  }

  // --- Render blocks to HTML string ---
  function blocksToHtml(blocks) {
    var parts = [];
    for (var b = 0; b < blocks.length; b++) {
      var block = blocks[b];
      switch (block.type) {
        case 'code':
          parts.push(
            '<pre class="chatgml-md-code-block"><code>' +
              escapeHtml(block.content) +
              '</code></pre>',
          );
          break;
        case 'hr':
          parts.push('<hr class="chatgml-md-hr">');
          break;
        case 'header': {
          var cls = 'chatgml-md-h' + block.level;
          parts.push('<h' + (block.level >= 3 ? block.level : 3) + ' class="' + cls + '">' + inlineToHtml(parseInline(block.content)) + '</h' + (block.level >= 3 ? block.level : 3) + '>');
          break;
        }
        case 'blockquote': {
          var inner = stripHtmlTags(block.content);
          parts.push('<blockquote class="chatgml-md-blockquote">' + inlineToHtml(parseInline(inner)) + '</blockquote>');
          break;
        }
        case 'ul': {
          var itemHtml = '';
          for (var j = 0; j < block.items.length; j++) {
            itemHtml += '<li>' + inlineToHtml(parseInline(stripHtmlTags(block.items[j]))) + '</li>';
          }
          parts.push('<ul class="chatgml-md-ul">' + itemHtml + '</ul>');
          break;
        }
        case 'ol': {
          var itemHtml2 = '';
          for (var k = 0; k < block.items.length; k++) {
            itemHtml2 += '<li>' + inlineToHtml(parseInline(stripHtmlTags(block.items[k]))) + '</li>';
          }
          parts.push('<ol class="chatgml-md-ol">' + itemHtml2 + '</ol>');
          break;
        }
        case 'paragraph': {
          var paraContent = stripHtmlTags(block.content);
          // Split on single newlines for <br> line breaks (double newlines already separated into blocks)
          var paraLines2 = paraContent.split('\n');
          var paraParts = [];
          for (var p = 0; p < paraLines2.length; p++) {
            if (p > 0) paraParts.push('<br>');
            paraParts.push(inlineToHtml(parseInline(paraLines2[p])));
          }
          parts.push('<p class="chatgml-md-p">' + paraParts.join('') + '</p>');
          break;
        }
      }
    }
    return parts.join('\n');
  }

  // --- Public API ---

  /**
   * Parse markdown text and return an HTML string.
   * @param {string} text - Markdown input
   * @returns {string} HTML string
   */
  function markdownToHtml(text) {
    try {
      if (typeof text !== 'string') return '';
      var blocks = parseBlocks(text);
      return blocksToHtml(blocks);
    } catch (e) {
      // Never throw — return safe fallback
      return '<p class="chatgml-md-p">' + escapeHtml(String(text)) + '</p>';
    }
  }

  /**
   * Render markdown text into a DOM container element.
   * Clears the container first, then appends rendered DOM nodes.
   * @param {string} text - Markdown input
   * @param {HTMLElement} container - Target DOM element
   */
  function renderMarkdown(text, container) {
    try {
      if (typeof text !== 'string' || !container) return;
      container.innerHTML = '';
      var blocks = parseBlocks(text);
      var domNodes = blocksToDom(blocks);
      for (var i = 0; i < domNodes.length; i++) {
        container.appendChild(domNodes[i]);
      }
    } catch (e) {
      // Never throw — render raw text as a fallback paragraph
      if (container) {
        container.innerHTML = '';
        var p = document.createElement('p');
        p.className = 'chatgml-md-p';
        p.textContent = String(text);
        container.appendChild(p);
      }
    }
  }

  /**
   * Convert parsed blocks to an array of DOM nodes.
   * @param {Array} blocks - Parsed block objects
   * @returns {Array<HTMLElement>}
   */
  function blocksToDom(blocks) {
    var nodes = [];
    for (var b = 0; b < blocks.length; b++) {
      var block = blocks[b];
      switch (block.type) {
        case 'code': {
          var pre = document.createElement('pre');
          pre.className = 'chatgml-md-code-block';
          var code = document.createElement('code');
          code.textContent = block.content;
          pre.appendChild(code);
          nodes.push(pre);
          break;
        }
        case 'hr': {
          var hr = document.createElement('hr');
          hr.className = 'chatgml-md-hr';
          nodes.push(hr);
          break;
        }
        case 'header': {
          var tag = block.level >= 3 ? block.level : 3;
          var h = document.createElement('h' + tag);
          h.className = 'chatgml-md-h' + block.level;
          appendInlineToDom(h, block.content);
          nodes.push(h);
          break;
        }
        case 'blockquote': {
          var bq = document.createElement('blockquote');
          bq.className = 'chatgml-md-blockquote';
          appendInlineToDom(bq, stripHtmlTags(block.content));
          nodes.push(bq);
          break;
        }
        case 'ul': {
          var ul = document.createElement('ul');
          ul.className = 'chatgml-md-ul';
          for (var j = 0; j < block.items.length; j++) {
            var li = document.createElement('li');
            appendInlineToDom(li, stripHtmlTags(block.items[j]));
            ul.appendChild(li);
          }
          nodes.push(ul);
          break;
        }
        case 'ol': {
          var ol = document.createElement('ol');
          ol.className = 'chatgml-md-ol';
          for (var k = 0; k < block.items.length; k++) {
            var li2 = document.createElement('li');
            appendInlineToDom(li2, stripHtmlTags(block.items[k]));
            ol.appendChild(li2);
          }
          nodes.push(ol);
          break;
        }
        case 'paragraph': {
          var p = document.createElement('p');
          p.className = 'chatgml-md-p';
          var paraContent = stripHtmlTags(block.content);
          var paraLines3 = paraContent.split('\n');
          for (var p2 = 0; p2 < paraLines3.length; p2++) {
            if (p2 > 0) {
              p.appendChild(document.createElement('br'));
            }
            appendInlineToDom(p, paraLines3[p2]);
          }
          nodes.push(p);
          break;
        }
      }
    }
    return nodes;
  }

  /**
   * Append inline-parsed content as DOM nodes to a parent element.
   * @param {HTMLElement} parent
   * @param {string} text
   */
  function appendInlineToDom(parent, text) {
    var tokens = parseInline(text);
    for (var j = 0; j < tokens.length; j++) {
      var t = tokens[j];
      switch (t.type) {
        case 'text': {
          parent.appendChild(document.createTextNode(escapeHtml(t.value)));
          break;
        }
        case 'code': {
          var code = document.createElement('code');
          code.className = 'chatgml-md-code-inline';
          code.textContent = t.value;
          parent.appendChild(code);
          break;
        }
        case 'strong': {
          var strong = document.createElement('strong');
          appendInlineToDom(strong, t.value);
          parent.appendChild(strong);
          break;
        }
        case 'em': {
          var em = document.createElement('em');
          appendInlineToDom(em, t.value);
          parent.appendChild(em);
          break;
        }
        case 'link': {
          var a = document.createElement('a');
          a.href = t.url;
          a.className = 'chatgml-md-link';
          appendInlineToDom(a, t.value);
          parent.appendChild(a);
          break;
        }
      }
    }
  }

  var api = {
    escapeHtml: escapeHtml,
    parseInline: parseInline,
    stripHtmlTags: stripHtmlTags,
    parseBlocks: parseBlocks,
    blocksToHtml: blocksToHtml,
    markdownToHtml: markdownToHtml,
    renderMarkdown: renderMarkdown,
  };

  root.ChatGmlMarkdown = api;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
