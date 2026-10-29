import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function classifyAudit(result) {
  if (result.error || result.signal || ![0, 1].includes(result.status)) return 'error';
  try {
    const report = JSON.parse(result.stdout);
    if (!report || typeof report !== 'object' || Array.isArray(report)) return 'error';
    const groups = Object.values(report);
    if (groups.some(items => !Array.isArray(items) || items.length === 0 || items.some(item =>
      !item || !Number.isSafeInteger(item.id) || item.id <= 0 ||
      !['low', 'moderate', 'high', 'critical'].includes(item.severity)))) return 'error';
    const findings = groups.flat().some(item => item.severity !== 'low');
    return findings && result.status === 1 ? 'findings' : !findings && result.status === 0 ? 'clean' : 'error';
  } catch { return 'error'; }
}

export function severityCounts(result) {
  if (classifyAudit(result) !== 'findings') return null;
  const advisories = new Map();
  for (const item of Object.values(JSON.parse(result.stdout)).flat()) {
    if (advisories.has(item.id) && advisories.get(item.id) !== item.severity) return null;
    advisories.set(item.id, item.severity);
  }
  const counts = { critical: 0, high: 0, moderate: 0 };
  for (const severity of advisories.values()) if (Object.hasOwn(counts, severity)) counts[severity]++;
  return counts;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = spawnSync('bun', ['audit', '--json', '--audit-level=moderate'], {
    encoding: 'utf8', timeout: 120_000, maxBuffer: 5 * 1024 * 1024,
  });
  const outcome = classifyAudit(result);
  console.log(`Dependency audit result: ${outcome}`);
  if (outcome === 'findings') {
    for (const item of Object.values(JSON.parse(result.stdout)).flat().filter(item => item.severity !== 'low')) {
      const link = /^https:\/\/github\.com\/advisories\/GHSA-[a-z0-9-]+$/.test(item.url) ? ` ${item.url}` : '';
      console.log(`${item.severity}: advisory ${item.id}${link}`);
    }
  }
  appendFileSync(process.env.GITHUB_OUTPUT, `outcome=${outcome}\n`);
  const counts = severityCounts(result);
  if (counts) appendFileSync(process.env.GITHUB_OUTPUT, `counts=critical=${counts.critical} high=${counts.high} moderate=${counts.moderate}\n`);
}
