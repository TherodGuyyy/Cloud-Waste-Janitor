import { ConfigError, DEFAULT_RULE_CONFIG, loadConfig } from '../../src/config/config';

describe('loadConfig defaults', () => {
  it('uses safe defaults when nothing is set', () => {
    const config = loadConfig({});
    expect(config.rules).toEqual({
      unattachedDiskDays: 14,
      idleWindowDays: 14,
      idleCpuPercent: 5,
      idleNetworkBytesPerDay: 5_000_000,
      snapshotMaxAgeDays: 90,
    });
    expect(config.rules).toEqual(DEFAULT_RULE_CONFIG);
    expect(config.actionsEnabled).toBe(false);
    expect(config.logLevel).toBe('INFO');
  });

  it('treats empty or blank values as not set', () => {
    const config = loadConfig({ JANITOR_UNATTACHED_DAYS: '', JANITOR_LOG_LEVEL: '  ', JANITOR_ACTIONS_ENABLED: ' ' });
    expect(config.rules.unattachedDiskDays).toBe(14);
    expect(config.logLevel).toBe('INFO');
    expect(config.actionsEnabled).toBe(false);
  });
});

describe('loadConfig overrides', () => {
  it('reads every setting from the environment', () => {
    const config = loadConfig({
      JANITOR_UNATTACHED_DAYS: '30',
      JANITOR_IDLE_WINDOW_DAYS: ' 7 ',
      JANITOR_IDLE_CPU_PERCENT: '2.5',
      JANITOR_IDLE_NETWORK_BYTES_PER_DAY: '1000',
      JANITOR_SNAPSHOT_MAX_AGE_DAYS: '180',
      JANITOR_ACTIONS_ENABLED: 'TRUE',
      JANITOR_LOG_LEVEL: 'debug',
    });
    expect(config.rules).toEqual({
      unattachedDiskDays: 30,
      idleWindowDays: 7,
      idleCpuPercent: 2.5,
      idleNetworkBytesPerDay: 1000,
      snapshotMaxAgeDays: 180,
    });
    expect(config.actionsEnabled).toBe(true);
    expect(config.logLevel).toBe('DEBUG');
  });

  it('only the exact word true turns actions on; false turns them off', () => {
    expect(loadConfig({ JANITOR_ACTIONS_ENABLED: 'true' }).actionsEnabled).toBe(true);
    expect(loadConfig({ JANITOR_ACTIONS_ENABLED: 'false' }).actionsEnabled).toBe(false);
  });
});

describe('loadConfig validation', () => {
  function problemsFor(env: Record<string, string>): string[] {
    try {
      loadConfig(env);
    } catch (error) {
      if (error instanceof ConfigError) return error.problems;
      throw error;
    }
    return [];
  }

  it.each([
    ['not a number', { JANITOR_UNATTACHED_DAYS: 'abc' }, 'JANITOR_UNATTACHED_DAYS must be a number'],
    ['infinity', { JANITOR_UNATTACHED_DAYS: 'Infinity' }, 'JANITOR_UNATTACHED_DAYS must be a number'],
    ['fraction where whole number needed', { JANITOR_UNATTACHED_DAYS: '3.5' }, 'must be a whole number'],
    ['below minimum', { JANITOR_UNATTACHED_DAYS: '0' }, 'must be between 1 and 365'],
    ['above maximum', { JANITOR_UNATTACHED_DAYS: '366' }, 'must be between 1 and 365'],
    ['cpu too low', { JANITOR_IDLE_CPU_PERCENT: '0' }, 'JANITOR_IDLE_CPU_PERCENT must be between 0.1 and 50'],
    ['cpu too high', { JANITOR_IDLE_CPU_PERCENT: '80' }, 'JANITOR_IDLE_CPU_PERCENT must be between 0.1 and 50'],
    ['negative network', { JANITOR_IDLE_NETWORK_BYTES_PER_DAY: '-1' }, 'JANITOR_IDLE_NETWORK_BYTES_PER_DAY must be between'],
    ['snapshot age zero', { JANITOR_SNAPSHOT_MAX_AGE_DAYS: '0' }, 'JANITOR_SNAPSHOT_MAX_AGE_DAYS must be between'],
    ['idle window too big', { JANITOR_IDLE_WINDOW_DAYS: '91' }, 'JANITOR_IDLE_WINDOW_DAYS must be between'],
    ['bad boolean', { JANITOR_ACTIONS_ENABLED: 'yes' }, 'JANITOR_ACTIONS_ENABLED must be "true" or "false"'],
    ['bad log level', { JANITOR_LOG_LEVEL: 'loud' }, 'JANITOR_LOG_LEVEL must be DEBUG, INFO, WARN or ERROR'],
  ])('rejects %s', (_label, env, expected) => {
    const problems = problemsFor(env);
    expect(problems.some((p) => p.includes(expected))).toBe(true);
  });

  it('reports every problem at once, not just the first', () => {
    const problems = problemsFor({
      JANITOR_UNATTACHED_DAYS: 'x',
      JANITOR_ACTIONS_ENABLED: 'maybe',
      JANITOR_LOG_LEVEL: 'loud',
    });
    expect(problems).toHaveLength(3);
  });

  it('throws a ConfigError whose message lists the problems', () => {
    expect(() => loadConfig({ JANITOR_ACTIONS_ENABLED: 'maybe' })).toThrow(ConfigError);
    expect(() => loadConfig({ JANITOR_ACTIONS_ENABLED: 'maybe' })).toThrow(/Invalid configuration/);
  });

  it('ConfigError has the right name', () => {
    expect(new ConfigError(['x']).name).toBe('ConfigError');
  });
});
