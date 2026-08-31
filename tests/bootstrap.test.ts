import { describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config.js';

describe('configuration bootstrap', () => {
  it('parses fixed recharge amounts into integer fen', () => {
    const config = parseConfig({ ...process.env, RECHARGE_AMOUNTS: '10,20,50' });
    expect(config.rechargeAmountsFen).toEqual([1000, 2000, 5000]);
  });

  it('parses only a non-negative number of trusted proxy hops', () => {
    const env = { ...process.env, RECHARGE_AMOUNTS: '10,20,50' };
    expect(parseConfig({ ...env, TRUST_PROXY_HOPS: '1' }).trustProxyHops).toBe(1);
    expect(() => parseConfig({ ...env, TRUST_PROXY_HOPS: '-1' })).toThrow();
  });
});
