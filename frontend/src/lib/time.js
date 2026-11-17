/** When something was last touched, the way a person says it: "2 min ago", "Yesterday", "Oct 5". */
export function ago(iso) {
  const then = new Date(iso);
  if (!iso || Number.isNaN(then.getTime())) return "";
  const minutes = Math.round((Date.now() - then.getTime()) / 60000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} min ago`;
  const now = new Date();
  if (then.toDateString() === now.toDateString()) return `${Math.round(minutes / 60)} h ago`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (then.toDateString() === yesterday.toDateString()) return "Yesterday";
  return then.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** A local date and time as the browser's date box writes it ("2026-10-09T10:00"), said aloud: "Oct 9, 10:00". */
export function dayAndTime(local) {
  const at = new Date(local);
  if (Number.isNaN(at.getTime())) return local;
  return at.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
