import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('deployment artifacts', () => {
  it('uses a persistent data mount and health endpoint', () => {
    const compose = readFileSync('docker-compose.yml', 'utf8');
    expect(compose).toContain('./data:/app/data');
    expect(compose).toContain('/health');
  });

  it('keeps environment secrets out of Git and Docker context', () => {
    expect(readFileSync('.gitignore', 'utf8')).toContain('.env');
    expect(readFileSync('.dockerignore', 'utf8')).toContain('.env');
  });
});
