// Unit tests for the SSRF guard (lib/ssrf.ts). Pure — no DB, no network:
// every URL here uses a literal IP host, so net.isIP short-circuits the check
// before any dns.lookup. We assert blocked ranges throw and public IPs pass.

import { describe, expect, it } from 'bun:test';
import { assertSafeWebhookUrl } from './lib/ssrf.js';

describe('assertSafeWebhookUrl', () => {
  const blocked = [
    'http://127.0.0.1/',
    'http://127.0.0.1:8080/admin',
    'http://169.254.169.254/latest/meta-data/',           // cloud metadata
    'http://10.0.0.1/',
    'http://172.16.0.5/',
    'http://192.168.1.1/',
    'http://0.0.0.0/',
    'http://[::1]/',
    'http://[fc00::1]/',                                   // IPv6 ULA
    'http://[fe80::1]/',                                   // IPv6 link-local
    'http://[febf::1]/',                                   // fe80::/10 upper edge (not just fe80 prefix)
    'http://[::ffff:127.0.0.1]/',                          // IPv4-mapped loopback (dotted)
    'http://[::ffff:0a00:0001]/',                          // IPv4-mapped 10.0.0.1 (HEX form — the bypass)
    'http://[::ffff:a9fe:a9fe]/',                          // IPv4-mapped 169.254.169.254 (hex)
    'http://[::7f00:1]/',                                  // IPv4-compatible ::127.0.0.1
    'http://[ff02::1]/',                                   // IPv6 multicast
    'http://[2002:7f00:1::]/',                             // 6to4 wrapping 127.0.0.1
    'http://[64:ff9b::a00:1]/',                            // NAT64 wrapping 10.0.0.1
    'http://100.64.0.1/',                                  // CGNAT
  ];
  for (const url of blocked) {
    it(`rejects ${url}`, async () => {
      await expect(assertSafeWebhookUrl(url)).rejects.toThrow();
    });
  }

  const badScheme = ['ftp://example.com/', 'file:///etc/passwd', 'gopher://127.0.0.1/'];
  for (const url of badScheme) {
    it(`rejects scheme ${url}`, async () => {
      await expect(assertSafeWebhookUrl(url)).rejects.toThrow();
    });
  }

  it('rejects a malformed URL', async () => {
    await expect(assertSafeWebhookUrl('not a url')).rejects.toThrow();
  });

  const allowed = [
    'http://1.1.1.1/',
    'https://8.8.8.8/hook',
    'https://[2606:4700:4700::1111]/hook',                 // public IPv6 (Cloudflare)
  ];
  for (const url of allowed) {
    it(`allows ${url}`, async () => {
      await expect(assertSafeWebhookUrl(url)).resolves.toBeUndefined();
    });
  }
});
