/**
 * Architecture rules, enforced by tests so they cannot quietly erode:
 *
 *   core  <-  collectors  <-  adapters  <-  app
 *   (arrows point from the layer that may import to what it may import)
 *
 * and the "read-only" promise: no code that changes anything in a cloud account.
 */

import { inSrc, listTypeScriptFiles, read, SRC } from '../sourceFiles';

const files = listTypeScriptFiles(SRC).map((file) => ({ rel: inSrc(file), text: read(file) }));

function importsOf(text: string): string[] {
  return [...text.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1] as string);
}

function offenders(layer: string, forbidden: RegExp): string[] {
  return files
    .filter((f) => f.rel.startsWith(`${layer}/`))
    .filter((f) => importsOf(f.text).some((spec) => forbidden.test(spec)))
    .map((f) => f.rel);
}

describe('layering', () => {
  it('finds the source files', () => {
    expect(files.length).toBeGreaterThan(25);
  });

  it('core imports nothing from collectors, adapters, the app layer, retry or config', () => {
    expect(offenders('core', /\.\.\/(collectors|adapters|app|resilience|config)\b/)).toEqual([]);
  });

  it('collectors never import the adapters or the app layer', () => {
    expect(offenders('collectors', /\.\.\/(adapters|app)\b/)).toEqual([]);
  });

  it('resilience (retry) knows nothing about AWS, collectors or core', () => {
    expect(offenders('resilience', /\.\.\/(adapters|app|collectors|core|config)\b/)).toEqual([]);
  });

  it('adapters never import the app layer', () => {
    expect(offenders('adapters', /\.\.\/(\.\.\/)?app\b/)).toEqual([]);
  });

  it('only the adapters import the AWS SDK', () => {
    const importers = files.filter((f) => importsOf(f.text).some((spec) => spec.startsWith('@aws-sdk'))).map((f) => f.rel);
    expect(importers.length).toBeGreaterThan(0);
    for (const rel of importers) expect(rel.startsWith('adapters/')).toBe(true);
  });

  it('nothing outside config reads environment variables', () => {
    const readers = files.filter((f) => /process\.env/.test(f.text)).map((f) => f.rel);
    expect(readers).toEqual([]);
  });
});

describe('read-only promise', () => {
  it('no SDK command that changes anything is created anywhere in src', () => {
    const writes =
      /new\s+(Create|Delete|Terminate|Stop|Start|Modify|Run|Put|Allocate|Release|Associate|Disassociate|Attach|Detach|Reboot|Tag|Untag|Copy|Register|Deregister|Revoke|Authorize|Enable|Disable|Update|Reset|Import|Assume)\w*Command\s*\(/;
    const offending = files.filter((f) => writes.test(f.text)).map((f) => f.rel);
    expect(offending).toEqual([]);
  });

  it('every SDK command in src is a Describe or Get', () => {
    const names = files.flatMap((f) => [...f.text.matchAll(/new\s+(\w+)Command\s*\(/g)].map((m) => m[1] as string));
    expect(names.length).toBeGreaterThan(5);
    for (const name of names) expect(name).toMatch(/^(Describe|Get)/);
  });
});
