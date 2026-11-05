/** Audit-only allowance; this never changes writer validation, deadlines or leases. */
export const VERIFY_CLOCK_SKEW_MS = 5 * 60_000;

/** Both values must use the same unit. Work receipts use seconds; other rows use ms. */
export function exceedsClockSkew(later: unknown, earlier: unknown, unitMs = 1): boolean {
  return typeof later === "number" && Number.isFinite(later)
    && typeof earlier === "number" && Number.isFinite(earlier)
    && later - earlier > VERIFY_CLOCK_SKEW_MS / unitMs;
}
