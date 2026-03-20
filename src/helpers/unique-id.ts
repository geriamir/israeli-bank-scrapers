import { createHash } from 'crypto';

/**
 * Generate a stable unique ID by hashing multiple transaction fields together.
 * Used when the bank does not provide a single reliable unique identifier.
 */
export function generateTransactionUniqueId(...fields: (string | number | null | undefined)[]): string {
  const input = fields.map(f => (f !== null && f !== undefined ? String(f) : '')).join('|');

  return createHash('sha256').update(input).digest('hex').substring(0, 32);
}
