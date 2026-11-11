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

  it('only the front door (cli/main.ts) touches the real process: environment, output and exit code', () => {
    const touching = files.filter((f) => /process\.(env|stdout|stderr|exit|argv)/.test(f.text)).map((f) => f.rel);
    // logger.ts holds the default sink that writes log lines to stdout when none is injected.
    expect(touching.sort()).toEqual(['cli/main.ts', 'logging/logger.ts']);
  });

  it('report code is pure: it imports no AWS, storage, app or CLI code', () => {
    expect(offenders('report', /\.\.\/(adapters|app|storage|cli|resilience)\b/)).toEqual([]);
  });

  it('only the storage layer touches the disk', () => {
    const diskUsers = files.filter((f) => /from\s+['"](fs|node:fs|fs\/promises)['"]/.test(f.text)).map((f) => f.rel);
    expect(diskUsers).toEqual(['storage/fileSystem.ts']);
  });

  it('the app layer never imports the CLI, and core never imports storage or report', () => {
    expect(offenders('app', /\.\.\/cli\b/)).toEqual([]);
    expect(offenders('core', /\.\.\/(storage|report|cli)\b/)).toEqual([]);
  });

  it('storage depends only on core types and the logger', () => {
    expect(offenders('storage', /\.\.\/(adapters|app|collectors|cli|report|config)\b/)).toEqual([]);
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
