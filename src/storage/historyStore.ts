/**
 * The Janitor's memory: what it has seen on earlier runs.
 *
 * `HistoryStore` is the port the rest of the program uses. This file also holds the
 * implementation that keeps the history in one JSON file. A database version can replace it later
 * without touching any other code.
 *
 * Safety choices:
 *  - Saving is atomic: write a temporary file, then rename it over the real one, so a crash can
 *    never leave a half-written history.
 *  - A missing file is a normal first run. An unreadable or damaged file is an error and is
 *    never overwritten, because starting again from nothing would silently reset every disk's age.
 *  - The file is created with owner-only permissions.
 */

import * as path from 'path';
import { ObservationHistory } from '../core/types';
import { Logger } from '../logging/logger';
import { FileSystemPort } from './fileSystem';

export const HISTORY_FILE_VERSION = 1;
export const MAX_HISTORY_FILE_CHARS = 20_000_000;

export type HistoryStoreErrorKind = 'invalid_path' | 'unreadable' | 'corrupt' | 'unwritable';

export class HistoryStoreError extends Error {
  readonly kind: HistoryStoreErrorKind;
  readonly filePath: string;

  constructor(kind: HistoryStoreErrorKind, filePath: string, detail: string, cause?: unknown) {
    super(`History file problem (${kind}) for "${filePath}": ${detail}`, cause === undefined ? undefined : { cause });
    this.name = 'HistoryStoreError';
    this.kind = kind;
    this.filePath = filePath;
  }
}

export interface HistoryStore {
  load(): Promise<ObservationHistory>;
  save(history: ObservationHistory): Promise<void>;
}

export interface FileHistoryStoreOptions {
  path: string;
  fileSystem: FileSystemPort;
  logger: Logger;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

function describe(error: unknown): string {
  const code = errorCode(error);
  if (code !== undefined) return code;
  return error instanceof Error ? error.message : String(error);
}

/** Checks the shape of a parsed history file. Returns the history, or a plain-words reason. */
export function parseHistoryFile(raw: unknown): { ok: true; history: ObservationHistory } | { ok: false; reason: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: 'the file does not hold a JSON object' };
  }
  const file = raw as Record<string, unknown>;
  if (file.version !== HISTORY_FILE_VERSION) {
    return { ok: false, reason: `unsupported version ${JSON.stringify(file.version)} (expected ${HISTORY_FILE_VERSION})` };
  }
  const entries = file.history;
  if (typeof entries !== 'object' || entries === null || Array.isArray(entries)) {
    return { ok: false, reason: 'the "history" part is missing or is not an object' };
  }

  const history: ObservationHistory = {};
  for (const [id, observations] of Object.entries(entries as Record<string, unknown>)) {
    if (id === '__proto__') return { ok: false, reason: 'a resource has the forbidden id "__proto__"' };
    if (!Array.isArray(observations)) return { ok: false, reason: `the entry for "${id}" is not a list` };
    const clean = [];
    for (const item of observations) {
      if (
        typeof item !== 'object' ||
        item === null ||
        typeof (item as Record<string, unknown>).observedAt !== 'string' ||
        typeof (item as Record<string, unknown>).state !== 'string'
      ) {
        return { ok: false, reason: `an observation of "${id}" is missing observedAt or state` };
      }
      const { observedAt, state } = item as { observedAt: string; state: string };
      clean.push({ observedAt, state });
    }
    history[id] = clean;
  }
  return { ok: true, history };
}

export function createFileHistoryStore(options: FileHistoryStoreOptions): HistoryStore {
  const { path: filePath, fileSystem, logger } = options;
  if (filePath.trim() === '') {
    throw new HistoryStoreError('invalid_path', filePath, 'the path is empty');
  }
  const tempPath = `${filePath}.tmp`;

  return {
    async load(): Promise<ObservationHistory> {
      let text: string;
      try {
        text = await fileSystem.readText(filePath);
      } catch (error) {
        if (errorCode(error) === 'ENOENT') {
          logger.info('No history file yet, starting a new one', { path: filePath });
          return {};
        }
        throw new HistoryStoreError('unreadable', filePath, describe(error), error);
      }

      if (text.length > MAX_HISTORY_FILE_CHARS) {
        throw new HistoryStoreError('corrupt', filePath, 'the file is far larger than any real history');
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch (error) {
        throw new HistoryStoreError('corrupt', filePath, 'the file is not valid JSON', error);
      }
      const result = parseHistoryFile(parsed);
      if (!result.ok) throw new HistoryStoreError('corrupt', filePath, result.reason);

      logger.info('History loaded', { path: filePath, resources: Object.keys(result.history).length });
      return result.history;
    },

    async save(history: ObservationHistory): Promise<void> {
      const content = `${JSON.stringify({ version: HISTORY_FILE_VERSION, history }, null, 2)}\n`;
      try {
        await fileSystem.makeDirectory(path.dirname(filePath));
        await fileSystem.writeText(tempPath, content);
        await fileSystem.rename(tempPath, filePath);
      } catch (error) {
        try {
          await fileSystem.remove(tempPath);
        } catch (cleanupError) {
          // Only "there was nothing to remove" is harmless. Anything else is worth a warning.
          if (errorCode(cleanupError) !== 'ENOENT') {
            logger.warn('Could not remove the temporary history file', { path: tempPath, error: cleanupError });
          }
        }
        throw new HistoryStoreError('unwritable', filePath, describe(error), error);
      }
      logger.info('History saved', { path: filePath, resources: Object.keys(history).length });
    },
  };
}
