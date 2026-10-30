import * as fs from 'fs';
import * as path from 'path';
import { createEvaluator, Evaluator } from '../src/core/evaluator';
import { DEFAULT_RULES } from '../src/core/rules';
import { estimateMonthlyCost } from '../src/core/cost/estimator';
import { DEFAULT_RULE_CONFIG } from '../src/config/config';
import { createLogger, Logger } from '../src/logging/logger';
import { ObservationHistory } from '../src/core/types';

export interface Fixture {
  description: string;
  now: string;
  resources: unknown[];
  history: ObservationHistory;
}

export function loadFixture(name: string): Fixture {
  const file = path.join(__dirname, 'fixtures', `${name}.json`);
  return JSON.parse(fs.readFileSync(file, 'utf8')) as Fixture;
}

export interface CapturedLogger {
  logger: Logger;
  lines: string[];
  records: Array<Record<string, unknown>>;
}

/** A logger that stores lines in memory so tests can inspect them. */
export function captureLogger(level: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' = 'DEBUG'): CapturedLogger {
  // Both arrays are filled as lines arrive, so destructuring them early still gives live views.
  const lines: string[] = [];
  const records: Array<Record<string, unknown>> = [];
  const logger = createLogger({
    level,
    sink: (line) => {
      lines.push(line);
      records.push(JSON.parse(line) as Record<string, unknown>);
    },
    now: () => new Date('2026-10-28T12:00:00.000Z'),
  });
  return { logger, lines, records };
}

export function buildEvaluator(logger: Logger): Evaluator {
  return createEvaluator({
    rules: DEFAULT_RULES,
    estimate: (resource) => estimateMonthlyCost(resource),
    logger,
  });
}

export function runFixture(name: string, logger: Logger) {
  const fixture = loadFixture(name);
  return buildEvaluator(logger).evaluate({
    resources: fixture.resources,
    history: fixture.history,
    now: new Date(fixture.now),
    config: DEFAULT_RULE_CONFIG,
  });
}
