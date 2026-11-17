import { cn } from "../../lib/cn.js";

/** The frame every page except the Studio sits in: one width, one set of margins, one kind of title. */
export const PAGE_FRAME = "mx-auto w-full max-w-[1120px] px-4 pt-8 pb-10 sm:px-8 lg:pb-16";

export function Page({ title, subtitle, actions, className, children }) {
  return (
    <div className={cn(PAGE_FRAME, className)}>
      <header className="mb-7 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[30px] leading-tight font-bold tracking-[-0.025em] text-ink">{title}</h1>
          {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
        </div>
        {actions}
      </header>
      {children}
    </div>
  );
}
