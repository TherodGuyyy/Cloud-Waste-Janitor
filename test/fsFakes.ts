/** An in-memory disk for tests, with the ability to make any operation fail on demand. */

import { FileSystemPort } from '../src/storage/fileSystem';

export type FsOperation = 'readText' | 'writeText' | 'rename' | 'makeDirectory' | 'remove';

export interface FakeFileSystem extends FileSystemPort {
  files: Map<string, string>;
  directories: string[];
  /** Makes the named operation throw this error (every time) until cleared. */
  failOn: Partial<Record<FsOperation, unknown>>;
  calls: Array<{ op: FsOperation; path: string }>;
}

export function fsError(code: string, message = `${code} (fake)`): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error(message);
  error.code = code;
  return error;
}

export function fakeFileSystem(initial: Record<string, string> = {}): FakeFileSystem {
  const files = new Map(Object.entries(initial));
  const fake: FakeFileSystem = {
    files,
    directories: [],
    failOn: {},
    calls: [],
    async readText(path) {
      fake.calls.push({ op: 'readText', path });
      if (fake.failOn.readText !== undefined) throw fake.failOn.readText;
      const content = files.get(path);
      if (content === undefined) throw fsError('ENOENT');
      return content;
    },
    async writeText(path, content) {
      fake.calls.push({ op: 'writeText', path });
      if (fake.failOn.writeText !== undefined) throw fake.failOn.writeText;
      files.set(path, content);
    },
    async rename(from, to) {
      fake.calls.push({ op: 'rename', path: from });
      if (fake.failOn.rename !== undefined) throw fake.failOn.rename;
      const content = files.get(from);
      if (content === undefined) throw fsError('ENOENT');
      files.set(to, content);
      files.delete(from);
    },
    async makeDirectory(path) {
      fake.calls.push({ op: 'makeDirectory', path });
      if (fake.failOn.makeDirectory !== undefined) throw fake.failOn.makeDirectory;
      fake.directories.push(path);
    },
    async remove(path) {
      fake.calls.push({ op: 'remove', path });
      if (fake.failOn.remove !== undefined) throw fake.failOn.remove;
      if (!files.delete(path)) throw fsError('ENOENT');
    },
  };
  return fake;
}
