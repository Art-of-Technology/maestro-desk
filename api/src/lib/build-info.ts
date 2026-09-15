import { readFileSync } from 'node:fs';

export function readBuildFingerprint(path: URL): string | null {
  let contents: string;
  try {
    contents = readFileSync(path, 'utf8');
  } catch (error) {
    // Development and legacy preview hosts have no Docker-generated marker.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const info = JSON.parse(contents);
  if (typeof info.buildFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(info.buildFingerprint)) {
    throw new Error('Invalid API build fingerprint');
  }
  return info.buildFingerprint;
}

export const BUILD_FINGERPRINT = readBuildFingerprint(new URL('../../build-info.json', import.meta.url));
