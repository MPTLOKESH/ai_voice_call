import { cn } from "../../lib/cn.js";

const TONES = {
  neutral: "bg-fill text-body",
  good: "bg-good-soft text-good",
  bad: "bg-bad-soft text-bad",
  warn: "bg-warn-soft text-warn",
  brand: "bg-brand-soft text-brand-ink",
  outline: "border border-line text-body",
};

export function Badge({ tone = "neutral", className, children }) {
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium",
                        TONES[tone], className)}>
      {children}
    </span>
  );
}
