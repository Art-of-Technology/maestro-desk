import { describe, expect, it } from 'bun:test';
import { templateBody } from './lib/template-body.js';

describe('rich response templates', () => {
  it('preserves old plain text literally', () => {
    expect(templateBody('Hello <name>\n{name}')).toEqual({ body: 'Hello <name>\n{name}', body_html: null });
  });
  it('stores safe formatting and derives its own plain fallback', () => {
    const result = templateBody('untrusted fallback', '<p>Hello <strong>{name}</strong></p><ul><li>One</li></ul>');
    expect(result.body_html).toContain('<strong>{name}</strong>');
    expect(result.body_html).toContain('<li>One</li>');
    expect(result.body).toContain('Hello {name}');
    expect(result.body).toContain('One');
    expect(result.body).not.toContain('untrusted');
  });
  it('removes executable markup, CSS and unsafe image/link schemes', () => {
    const result = templateBody('', '<p style="position:fixed" onclick="x()">Safe</p><script>bad()</script><svg onload="x()"></svg><a href="javascript:alert(1)">Link</a><img src="data:image/svg+xml;base64,PHN2Zz4=" onerror="x()">');
    expect(result.body_html).toBe('<p>Safe</p><a target="_blank" rel="noopener noreferrer">Link</a>');
  });
  it('preserves embedded raster images without expiring attachment URLs', () => {
    const result = templateBody('', '<p><img src="data:image/png;base64,aGVsbG8="></p>');
    expect(result.body_html).toContain('data:image/png;base64,aGVsbG8=');
    expect(result.body.trim()).not.toBe('');
  });
  it('rejects wrapper-only or stripped bodies and clears obsolete HTML on plain edits', () => {
    expect(templateBody('fake', '<script>bad()</script><p><br></p>').body).toBe('');
    expect(templateBody('New plain body')).toEqual({ body: 'New plain body', body_html: null });
  });
});
