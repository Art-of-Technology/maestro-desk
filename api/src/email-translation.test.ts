import { expect, test } from 'bun:test';

process.env.DATABASE_URL ||= 'postgresql://u:p@localhost:5432/test?sslmode=disable';
process.env.BETTER_AUTH_SECRET ||= 'test-better-auth-secret-0123456789abcdef';
process.env.ANTHROPIC_API_KEY ||= 'anthropic-key-placeholder-0123456789';
process.env.POSTMARK_INBOUND_SECRET ||= 'inbound-secret-0123456789';
const { translateEmailParts } = await import('./lib/email-translation.js');

test('translates subject and branding text together, preserving logo, names and links', async () => {
  let seen: string[] = [];
  const result = await translateEmailParts(['Account update', '<img src="https://brand.test/logo.png" alt="Brand"><b>Hello</b>',
    '<p>Regards, Jodi</p>', '<a href="https://brand.test/help">Contact us</a>'], 'Spanish', async texts => {
    seen=texts;
    return ['Actualización de cuenta', 'Hola', 'Saludos, Jodi', 'Contáctenos'];
  });
  expect(seen).toEqual(['Account update','Hello','Regards, Jodi','Contact us']);
  expect(result[0]).toBe('Actualización de cuenta');
  expect(result[1]).toContain('src="https://brand.test/logo.png"');
  expect(result[1]).toContain('alt="Brand"');
  expect(result[1]).toContain('<b>Hola</b>');
  expect(result[3]).toContain('href="https://brand.test/help"');
  expect(result[3]).toContain('>Contáctenos</a>');
});

test('rejects incomplete output and escapes model markup', async () => {
  await expect(translateEmailParts(['Hello'], 'Spanish', async () => [])).rejects.toThrow('Incomplete');
  await expect(translateEmailParts(['Hello'], 'Spanish', async () => [''])).rejects.toThrow('Incomplete');
  const result=await translateEmailParts(['<b>Hello</b>'], 'Spanish', async () => ['<script>bad</script>']);
  expect(result[0]).toBe('<b>&lt;script&gt;bad&lt;/script&gt;</b>');
  let calls=0;
  await translateEmailParts(['<img src="https://brand.test/logo.png">',''], 'Spanish', async () => { calls++; return []; });
  expect(calls).toBe(0);
});
