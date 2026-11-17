import { cn } from "../../lib/cn.js";

const VARIANTS = {
  // The brand violet, for the one action that matters on a screen.
  primary: "bg-brand text-white hover:bg-brand-hover disabled:opacity-50",
  // The brand violet, for adding and for anything the AI does.
  brand: "bg-brand text-white shadow-[0_4px_12px_rgb(110_76_245/0.3)] hover:bg-brand-hover disabled:opacity-50",
  tinted: "bg-brand-soft text-brand-ink hover:bg-[#e6dfff]",
  secondary: "border border-edge bg-white text-ink hover:bg-hover",
  subtle: "bg-fill text-ink hover:bg-active",
  ghost: "text-muted hover:bg-fill hover:text-ink",
  danger: "border border-edge bg-white text-bad hover:bg-bad-soft",
  "danger-solid": "bg-bad text-white hover:brightness-110",
};

const SIZES = {
  sm: "h-8 px-3.5 text-[13px] gap-1.5",
  md: "h-10 px-4.5 text-[14px] gap-2",
  lg: "h-12 px-6 text-[15px] gap-2",
  icon: "size-9 justify-center",
};

/** A pill button. `icon` sits before the label; with size "icon" it is the whole button. */
export function Button({ variant = "secondary", size = "md", icon: Icon, className, children, ...props }) {
  return (
    <button
      type="button"
      className={cn(
        "inline-flex shrink-0 items-center rounded-full font-semibold whitespace-nowrap transition-colors",
        "disabled:cursor-not-allowed",
        VARIANTS[variant], SIZES[size], className,
      )}
      {...props}
    >
      {Icon && <Icon aria-hidden="true" className="size-4" strokeWidth={2} />}
      {children}
    </button>
  );
}
