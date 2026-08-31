const SENSITIVE_KEY = /^(?:access[_-]?token|api[_-]?key|token|authorization|x-api-key|password|secret|key)$/i;

/** Return a copy safe to include in structured logs. */
export function sanitizeForLog<T>(value: T): T {
  const seen = new WeakMap<object, unknown>();

  const sanitize = (input: unknown, key?: string): unknown => {
    if (key !== undefined && SENSITIVE_KEY.test(key)) {
      return '[REDACTED]';
    }
    if (input === null || typeof input !== 'object') {
      return input;
    }
    if (seen.has(input)) {
      return '[CIRCULAR]';
    }
    if (input instanceof Error) {
      return { name: input.name, message: sanitizeMessage(input.message) };
    }
    if (Array.isArray(input)) {
      const copy: unknown[] = [];
      seen.set(input, copy);
      input.forEach((item) => copy.push(sanitize(item)));
      return copy;
    }
    const copy: Record<string, unknown> = {};
    seen.set(input, copy);
    for (const [childKey, childValue] of Object.entries(input)) {
      copy[childKey] = sanitize(childValue, childKey);
    }
    return copy;
  };

  return sanitize(value) as T;
}

export function sanitizeMessage(message: string, maxLength = 200): string {
  const redacted = message
    .replace(/(Bearer\s+)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/((["']?)(?:access[_-]?token|api[_-]?key|token|authorization|x-api-key|password|secret|key)\2\s*[:=]\s*["']?)([^\s,;}'"]+)/gi, '$1[REDACTED]');
  return redacted.slice(0, maxLength);
}
