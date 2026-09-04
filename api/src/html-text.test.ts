// Unit tests for htmlToText (lib/html-text.ts). Pure — no DB, no network, no env.

import { describe, expect, it } from 'bun:test';
import { htmlToText } from './lib/html-text.js';

describe('htmlToText', () => {
  it('returns empty string for a wrapper-only Gmail body', () => {
    expect(htmlToText('<div dir="auto"></div>')).toBe('');
    expect(htmlToText('<div dir="auto"><br></div>')).toBe('');
    expect(htmlToText('')).toBe('');
  });

  it('turns Gmail line wrappers and <br> into line breaks', () => {
    const html = '<div dir="auto">Hola<br>no llegó mi retiro</div><div dir="auto">Gracias</div>';
    expect(htmlToText(html)).toBe('Hola\nno llegó mi retiro\nGracias');
  });

  it('drops <head>/<style>/<script> blocks WITH their contents', () => {
    const html = [
      '<html><head><title>Msg</title><style>p { color: red; } .x{margin:0}</style></head>',
      '<body><p>Hello from Outlook</p><script>alert(1)</script><!-- tracking --></body></html>',
    ].join('');
    const out = htmlToText(html);
    expect(out).toBe('Hello from Outlook');
    expect(out).not.toContain('color');
    expect(out).not.toContain('alert');
    expect(out).not.toContain('Msg');
  });

  it('drops an unclosed <style> or comment to the end instead of leaking it', () => {
    expect(htmlToText('<p>Visible</p><style>.leak { color: red }')).toBe('Visible');
    expect(htmlToText('<p>Visible</p><!-- never closed <b>x</b>')).toBe('Visible');
  });

  it('decodes named, decimal and hex entities', () => {
    expect(htmlToText('a&nbsp;b &amp; c&#39;s &#8217;quote&#8217; &#x1F600; &lt;tag&gt;'))
      .toBe("a b & c's ’quote’ 😀 <tag>");
  });

  it('leaves invalid or unknown entities as literal text without throwing', () => {
    expect(htmlToText('&#xFFFFFFFF; &#0; &#55296; &bogus; &amp;lt;')).toBe('&#xFFFFFFFF; &#0; &#55296; &bogus; &lt;');
  });

  it('caps blank-line runs at one', () => {
    const html = '<div><p>One</p></div><div><br><br></div><ul><li>a</li><li>b</li></ul><p>Two</p>';
    expect(htmlToText(html)).toBe('One\n\na\nb\n\nTwo');
  });

  it('joins table cells with spaces and rows with newlines', () => {
    expect(htmlToText('<table><tr><td>Amount</td><td>100</td></tr><tr><td>Status</td><td>Pending</td></tr></table>'))
      .toBe('Amount 100\nStatus Pending');
  });

  it('passes plain text through unchanged apart from trimming', () => {
    expect(htmlToText('  just text\nwith two lines  ')).toBe('just text\nwith two lines');
  });

  it('normalises CRLF and collapses runs of spaces/tabs', () => {
    expect(htmlToText('a \t b\r\n\r\n\r\nc')).toBe('a b\n\nc');
  });
});
