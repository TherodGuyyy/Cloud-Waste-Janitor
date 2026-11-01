import * as fs from 'fs';
import * as path from 'path';

export const SRC = path.join(__dirname, '..', 'src');
export const ROOT = path.join(__dirname, '..');

export function listTypeScriptFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTypeScriptFiles(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

export function read(file: string): string {
  return fs.readFileSync(file, 'utf8');
}

/** Path relative to src, always with forward slashes, for readable assertions. */
export function inSrc(file: string): string {
  return path.relative(SRC, file).split(path.sep).join('/');
}
