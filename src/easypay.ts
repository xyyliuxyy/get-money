import { createHash, timingSafeEqual } from 'node:crypto';

export interface EasyPayConfig {
  enabled: boolean;
  pid: string;
  key: string;
  qrContent: string;
  qrContentsByAmountFen: Record<number, string>;
}

function canonicalParams(params: Record<string, string>): string {
  return Object.keys(params)
    .filter((key) => key !== 'sign' && key !== 'sign_type' && params[key] !== '')
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join('&');
}

export function buildEasyPaySign(params: Record<string, string>, key: string): string {
  return createHash('md5').update(`${canonicalParams(params)}${key}`, 'utf8').digest('hex');
}

export function verifyEasyPaySign(
  params: Record<string, string>,
  signature: string,
  key: string,
): boolean {
  if (!/^[a-f0-9]{32}$/i.test(signature)) return false;
  const expected = Buffer.from(buildEasyPaySign(params, key), 'utf8');
  const actual = Buffer.from(signature.toLowerCase(), 'utf8');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
