import { describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config.js';
import { buildEasyPaySign, verifyEasyPaySign } from '../src/easypay.js';

describe('EasyPay signing', () => {
  it('sorts non-empty parameters and excludes sign fields', () => {
    expect(buildEasyPaySign({ b: '2', a: '1', empty: '', sign: 'ignore', sign_type: 'MD5' }, 'secret'))
      .toBe('8d9f51949e440aa629fd1a035708473a');
  });

  it('verifies a valid signature and rejects malformed values', () => {
    const params = { pid: '10001', money: '20.00', out_trade_no: 'ORDER-1' };
    const signature = buildEasyPaySign(params, 'secret');
    expect(verifyEasyPaySign(params, signature, 'secret')).toBe(true);
    expect(verifyEasyPaySign(params, `${signature}x`, 'secret')).toBe(false);
  });
});

describe('EasyPay configuration', () => {
  it('parses the adapter as disabled by default', () => {
    const config = parseConfig({ ...process.env, RECHARGE_AMOUNTS: '10,20' });
    expect(config.easyPay).toEqual({ enabled: false, pid: '', key: '', qrContent: '', qrContentsByAmountFen: {} });
  });

  it('parses enabled adapter settings', () => {
    const config = parseConfig({
      ...process.env,
      RECHARGE_AMOUNTS: '10,20',
      EASYPAY_ENABLED: 'true',
      EASYPAY_PID: '10001',
      EASYPAY_KEY: 'shared-key',
      EASYPAY_QR_CONTENT: 'https://qr.alipay.com/example-content',
      EASYPAY_QR_CONTENTS: '{"10":"https://qr.alipay.com/ten","20.00":"https://qr.alipay.com/twenty"}',
    });
    expect(config.easyPay).toEqual({
      enabled: true,
      pid: '10001',
      key: 'shared-key',
      qrContent: 'https://qr.alipay.com/example-content',
      qrContentsByAmountFen: {
        1000: 'https://qr.alipay.com/ten',
        2000: 'https://qr.alipay.com/twenty',
      },
    });
  });

  it('rejects an EasyPay QR mapping that does not cover every allowed amount', () => {
    expect(() => parseConfig({
      ...process.env,
      RECHARGE_AMOUNTS: '10,20',
      EASYPAY_ENABLED: 'true',
      EASYPAY_PID: '10001',
      EASYPAY_KEY: 'shared-key',
      EASYPAY_QR_CONTENTS: '{"10":"https://qr.alipay.com/ten"}',
    })).toThrowError(/EASYPAY_QR_CONTENTS/i);
  });
});
