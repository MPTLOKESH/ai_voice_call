/** Estimated dollars, the way they are shown: tiny amounts say "under a cent" instead of a misleading $0.00. */
export function usd(amount) {
  if (!amount) return "$0.00";
  if (amount < 0.01) return "<$0.01";
  return amount.toLocaleString(undefined, { style: "currency", currency: "USD", minimumFractionDigits: 2 });
}

/** A count with a short unit: 12,400 → "12.4k". */
export function short(count) {
  if (count >= 1e6) return `${(count / 1e6).toFixed(1).replace(/\.0$/, "")}M`;
  if (count >= 1e3) return `${(count / 1e3).toFixed(1).replace(/\.0$/, "")}k`;
  return String(Math.round(count));
}

export const minutes = (seconds) => (seconds < 90 ? `${Math.round(seconds)} s` : `${Math.round(seconds / 60)} min`);

export const day = (iso) => new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" });
