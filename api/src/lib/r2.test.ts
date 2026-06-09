import { test, expect, describe } from 'bun:test';
import { encodeKey, parseListKeysXml } from './r2.ts';

describe('encodeKey', () => {
  test('preserves slashes between segments but encodes within them', () => {
    expect(encodeKey('ws-1/logo-123.png')).toBe('ws-1/logo-123.png');
  });

  test('encodes spaces and special characters per segment', () => {
    expect(encodeKey('a b/c+d')).toBe('a%20b/c%2Bd');
  });

  test('does not encode the path separator itself', () => {
    expect(encodeKey('x/y/z')).toBe('x/y/z');
    expect(encodeKey('x/y/z').split('/')).toHaveLength(3);
  });
});

describe('parseListKeysXml', () => {
  test('extracts every <Key> from a ListObjectsV2 response', () => {
    const xml = `<?xml version="1.0"?><ListBucketResult>
      <Contents><Key>ws-1/logo-1.png</Key><Size>10</Size></Contents>
      <Contents><Key>ws-1/logo-2.webp</Key><Size>20</Size></Contents>
    </ListBucketResult>`;
    expect(parseListKeysXml(xml)).toEqual(['ws-1/logo-1.png', 'ws-1/logo-2.webp']);
  });

  test('returns [] when there are no keys', () => {
    expect(parseListKeysXml('<ListBucketResult></ListBucketResult>')).toEqual([]);
  });

  test('decodes XML entities in keys', () => {
    const xml = '<Contents><Key>a&amp;b/c&lt;d&gt;.png</Key></Contents>';
    expect(parseListKeysXml(xml)).toEqual(['a&b/c<d>.png']);
  });
});
