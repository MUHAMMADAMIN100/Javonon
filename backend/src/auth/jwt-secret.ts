/**
 * Resolve a JWT secret from env. In production we REFUSE to fall back to a
 * hard-coded value — if JWT_SECRET (or the named override) isn't set, the
 * process dies loudly. Allowing a known fallback in prod would let anyone
 * who reads the open-source repo forge tokens for any user including
 * FOUNDER (CWE-798 «hard-coded credentials»).
 *
 * In non-production (NODE_ENV !== 'production') we tolerate a missing
 * value but only after a console.warn, so local dev isn't blocked.
 *
 * Use this in every JWT strategy/guard/gateway that previously did
 * `config.get('JWT_SECRET') || 'fallback-secret'`.
 */
export function requireJwtSecret(value: string | undefined, envName = 'JWT_SECRET'): string {
  if (value && value.length > 0) return value;
  const isProd = process.env.NODE_ENV === 'production';
  if (isProd) {
    throw new Error(
      `Fatal: ${envName} is not set in production. Refusing to start — using a hard-coded secret would let anyone forge JWTs. Set ${envName} on the host (Railway / .env / k8s secret) and redeploy.`,
    );
  }
  console.warn(
    `[security] ${envName} not set — using a dev fallback. NEVER deploy this build to production without setting ${envName}.`,
  );
  return 'dev-only-fallback-do-not-use-in-prod';
}
