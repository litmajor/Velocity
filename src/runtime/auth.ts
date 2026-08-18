import crypto from 'crypto';

/**
 * Constant-time string comparison (hashes both sides so lengths never leak).
 * Fails closed on empty presented or expected values: an unconfigured token
 * must never match, and an empty credential must never be accepted.
 */
export function timingSafeEqualStr(presented: string | undefined, expected: string | undefined): boolean {
  if (!presented || !expected) return false;
  const a = crypto.createHash('sha256').update(presented, 'utf8').digest();
  const b = crypto.createHash('sha256').update(expected, 'utf8').digest();
  return crypto.timingSafeEqual(a, b);
}
