import * as fs from 'fs';
import * as path from 'path';

/**
 * Guards for the project's coding standards, so they cannot silently regress:
 *  - no console.* output anywhere in src (use the structured logger)
 *  - no hardcoded cloud or Slack secrets in src
 *  - no generic catch-all that swallows errors without handling
 */

const SRC = path.join(__dirname, '..', '..', 'src');

function listTypeScriptFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTypeScriptFiles(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

const files = listTypeScriptFiles(SRC);

describe('coding standards', () => {
  it('finds the source files', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it('uses no console output in src', () => {
    const offenders = files.filter((f) => /\bconsole\s*\./.test(fs.readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('contains no hardcoded AWS keys or Slack tokens in src', () => {
    const pattern = /\b(AKIA|ASIA)[0-9A-Z]{16}\b|\bxox[abprs]-[A-Za-z0-9-]{10,}\b/;
    const offenders = files.filter((f) => pattern.test(fs.readFileSync(f, 'utf8')));
    // logger.ts only holds the patterns used to detect secrets, written as regular expressions,
    // so no literal key appears even there.
    expect(offenders).toEqual([]);
  });

  it('has no empty catch blocks', () => {
    const offenders = files.filter((f) => /catch\s*(\([^)]*\))?\s*\{\s*\}/.test(fs.readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('core logic does not import the cloud, HTTP or database layers', () => {
    const core = files.filter((f) => f.includes(`${path.sep}core${path.sep}`));
    const forbidden = /from\s+['"](aws-sdk|@aws-sdk|express|http|https|fastify|sqlite3|better-sqlite3|pg|@slack)/;
    const offenders = core.filter((f) => forbidden.test(fs.readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
