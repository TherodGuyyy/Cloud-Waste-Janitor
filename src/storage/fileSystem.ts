/**
 * The only code that touches the disk. Everything else talks to this small port,
 * so tests can replace it with an in-memory fake and inject failures.
 */

import { promises as fs } from 'fs';

export interface FileSystemPort {
  readText(path: string): Promise<string>;
  writeText(path: string, content: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  makeDirectory(path: string): Promise<void>;
  remove(path: string): Promise<void>;
}

export const nodeFileSystem: FileSystemPort = {
  readText: (path) => fs.readFile(path, 'utf8'),
  writeText: (path, content) => fs.writeFile(path, content, { encoding: 'utf8', mode: 0o600 }),
  rename: (from, to) => fs.rename(from, to),
  makeDirectory: async (path) => {
    await fs.mkdir(path, { recursive: true });
  },
  remove: (path) => fs.unlink(path),
};
