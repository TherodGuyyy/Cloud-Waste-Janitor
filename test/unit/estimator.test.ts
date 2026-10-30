import { estimateMonthlyCost, toCents } from '../../src/core/cost/estimator';
import { DEFAULT_PRICE_TABLE, PriceTable } from '../../src/core/cost/priceTable';
import { makeInstance, makeIp, makeSnapshot, makeVolume } from '../builders';

function monthly(estimate: ReturnType<typeof estimateMonthlyCost>): number {
  if (!estimate.ok) throw new Error(`expected an estimate, got: ${estimate.reason}`);
  return estimate.monthlyUsd;
}

describe('toCents', () => {
  it('rounds to two decimals', () => {
    expect(toCents(2.345678)).toBe(2.35);
    expect(toCents(30.368)).toBe(30.37);
    expect(toCents(60.736)).toBe(60.74);
    expect(toCents(0)).toBe(0);
  });
});

describe('disk estimates (hand-computed)', () => {
  it.each([
    ['gp3', 500, 40],
    ['gp2', 200, 20],
    ['io1', 100, 12.5],
    ['io2', 100, 12.5],
    ['st1', 1000, 45],
    ['sc1', 1000, 15],
    ['gp3', 0, 0],
  ])('%s %d GB costs %d per month', (volumeType, sizeGb, expected) => {
    expect(monthly(estimateMonthlyCost(makeVolume({ volumeType, sizeGb })))).toBe(expected);
  });

  it('explains how the number was worked out', () => {
    const estimate = estimateMonthlyCost(makeVolume({ volumeType: 'gp3', sizeGb: 500 }));
    expect(estimate).toEqual({ ok: true, monthlyUsd: 40, basis: '500 GB x $0.08/GB-month (gp3 storage only)' });
  });

  it('refuses an unknown volume type instead of guessing zero', () => {
    const estimate = estimateMonthlyCost(makeVolume({ volumeType: 'standard' }));
    expect(estimate).toEqual({ ok: false, reason: 'No price for volume type standard in us-east-1' });
  });

  it('refuses invalid sizes', () => {
    expect(estimateMonthlyCost(makeVolume({ sizeGb: Number.NaN })).ok).toBe(false);
    expect(estimateMonthlyCost(makeVolume({ sizeGb: -5 })).ok).toBe(false);
    expect(estimateMonthlyCost(makeVolume({ sizeGb: Number.POSITIVE_INFINITY })).ok).toBe(false);
  });
});

describe('server estimates (hand-computed, 730 hours)', () => {
  it.each([
    ['t3.nano', 3.8], // 0.0052 x 730 = 3.796
    ['t3.micro', 7.59], // 0.0104 x 730 = 7.592
    ['t3.small', 15.18], // 0.0208 x 730 = 15.184
    ['t3.medium', 30.37], // 0.0416 x 730 = 30.368
    ['t3.large', 60.74], // 0.0832 x 730 = 60.736
    ['m5.large', 70.08], // 0.096 x 730 = 70.08
  ])('%s costs %d per month', (instanceType, expected) => {
    expect(monthly(estimateMonthlyCost(makeInstance({ instanceType })))).toBe(expected);
  });

  it('refuses an unknown server type', () => {
    const estimate = estimateMonthlyCost(makeInstance({ instanceType: 'x9.mega' }));
    expect(estimate).toEqual({ ok: false, reason: 'No price for server type x9.mega in us-east-1' });
  });

  it('explains that only compute is counted', () => {
    const estimate = estimateMonthlyCost(makeInstance({ instanceType: 't3.medium' }));
    expect(estimate.ok && estimate.basis).toContain('compute only');
  });
});

describe('snapshot and IP estimates', () => {
  it('prices a snapshot at the standard rate and labels it an upper bound', () => {
    const estimate = estimateMonthlyCost(makeSnapshot({ sizeGb: 300 }));
    expect(monthly(estimate)).toBe(15);
    expect(estimate.ok && estimate.basis).toContain('upper bound');
  });

  it('refuses an invalid snapshot size', () => {
    expect(estimateMonthlyCost(makeSnapshot({ sizeGb: -1 })).ok).toBe(false);
  });

  it('prices an idle Elastic IP at 3.65 per month (0.005 x 730)', () => {
    expect(monthly(estimateMonthlyCost(makeIp()))).toBe(3.65);
  });
});

describe('regions and custom tables', () => {
  it('refuses a region that has no prices', () => {
    expect(estimateMonthlyCost(makeVolume({ region: 'eu-west-1' }))).toEqual({
      ok: false,
      reason: 'No prices for region eu-west-1',
    });
  });

  it('uses a table passed in', () => {
    const table: PriceTable = {
      version: 'test',
      retrievedOn: '2026-01-01',
      currency: 'USD',
      hoursPerMonth: 100,
      regions: {
        'eu-west-1': {
          ebsVolumePerGbMonth: { gp3: 1 },
          snapshotPerGbMonth: 2,
          elasticIpPerHour: 0.5,
          instancePerHour: { 'z1.test': 2 },
        },
      },
    };
    expect(monthly(estimateMonthlyCost(makeVolume({ region: 'eu-west-1', sizeGb: 10 }), table))).toBe(10);
    expect(monthly(estimateMonthlyCost(makeSnapshot({ region: 'eu-west-1', sizeGb: 10 }), table))).toBe(20);
    expect(monthly(estimateMonthlyCost(makeIp({ region: 'eu-west-1' }), table))).toBe(50);
    expect(monthly(estimateMonthlyCost(makeInstance({ region: 'eu-west-1', instanceType: 'z1.test' }), table))).toBe(200);
  });
});

describe('default price table hygiene', () => {
  it('carries a version and a real date stamp', () => {
    expect(DEFAULT_PRICE_TABLE.version).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(DEFAULT_PRICE_TABLE.retrievedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Number.isNaN(new Date(DEFAULT_PRICE_TABLE.retrievedOn).getTime())).toBe(false);
  });

  it('uses the 730 hour AWS month and USD', () => {
    expect(DEFAULT_PRICE_TABLE.hoursPerMonth).toBe(730);
    expect(DEFAULT_PRICE_TABLE.currency).toBe('USD');
  });

  it('covers us-east-1 and every price is a positive number', () => {
    const region = DEFAULT_PRICE_TABLE.regions['us-east-1'];
    expect(region).toBeDefined();
    if (!region) return;
    const all = [
      ...Object.values(region.ebsVolumePerGbMonth),
      ...Object.values(region.instancePerHour),
      region.snapshotPerGbMonth,
      region.elasticIpPerHour,
    ];
    expect(all.length).toBeGreaterThan(10);
    for (const price of all) {
      expect(Number.isFinite(price)).toBe(true);
      expect(price).toBeGreaterThan(0);
    }
  });
});
