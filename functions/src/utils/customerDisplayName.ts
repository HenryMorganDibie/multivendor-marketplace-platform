/**
 * Truncates a customer's full name to "First L." for anywhere a vendor can
 * see it (phase2-mapping-spec.txt: `customerSnapshot.displayName = "Jane D."`).
 *
 * A customer's full name is collected at registration for account records,
 * support, and dispute resolution — it is never shown to the other side of a
 * conversation. Every call site that puts a customer's name in front of a
 * vendor must go through this, not read profile.fullName directly.
 */
export function toCustomerDisplayName(fullName: string): string {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return fullName;
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${parts[parts.length - 1][0]}.`;
}
