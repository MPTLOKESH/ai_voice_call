import { TriangleAlert } from "lucide-react";
import { cn } from "../../lib/cn.js";
import { Button } from "./Button.jsx";

/** A grey block standing where something is still on its way. It only moves for people who allow motion. */
export function Skeleton({ className }) {
  return <span aria-hidden="true" className={cn("block rounded-lg bg-fill motion-safe:animate-pulse", className)} />;
}

/** A column of rows that will be a list, so the page holds its shape while it loads. */
export function SkeletonRows({ rows = 5, className, rowClassName }) {
  return (
    <div role="status" aria-label="Loading" className={cn("divide-y divide-line", className)}>
      {Array.from({ length: rows }, (_, at) => (
        <div key={at} className={cn("flex items-center gap-4 px-5 py-4", rowClassName)}>
          <Skeleton className="h-4 w-28 shrink-0" />
          <Skeleton className="h-4 flex-1" />
          <Skeleton className="h-4 w-16 shrink-0 max-sm:hidden" />
        </div>
      ))}
      <span className="sr-only">Loading…</span>
    </div>
  );
}

/**
 * Nothing here yet, and what to do about it: an icon, a title, a line of help, and the action that fills it.
 * `compact` is for inside a panel that already has its own frame.
 */
export function EmptyState({ icon: Icon, title, children, action, compact = false, className }) {
  return (
    <div className={cn("flex flex-col items-center text-center", compact ? "px-5 pt-8 pb-10" : "rounded-3xl border border-line bg-white px-6 py-14 shadow-card", className)}>
      {Icon && (
        <span className="grid size-11 place-items-center rounded-2xl bg-brand-soft text-brand">
          <Icon aria-hidden="true" className="size-5" strokeWidth={1.8} />
        </span>
      )}
      <p className="mt-4 text-[15px] font-semibold text-ink">{title}</p>
      {children && <p className="mt-1 max-w-sm text-[13px] leading-relaxed text-muted">{children}</p>}
      {action && <div className="mt-5 flex flex-wrap justify-center gap-2">{action}</div>}
    </div>
  );
}

/** Something that did not load, said plainly, with a way to try again. */
export function ErrorNote({ children, onRetry, className }) {
  return (
    <div role="alert" className={cn("flex flex-wrap items-center gap-x-3 gap-y-2 rounded-2xl bg-bad-soft px-4 py-3 text-[13px] text-ink", className)}>
      <TriangleAlert aria-hidden="true" className="size-4 shrink-0 text-bad" strokeWidth={2} />
      <span className="min-w-0 flex-1 font-medium">{children}</span>
      {onRetry && <Button size="sm" variant="secondary" onClick={onRetry}>Try again</Button>}
    </div>
  );
}
