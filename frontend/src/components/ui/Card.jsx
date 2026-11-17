import { cn } from "../../lib/cn.js";

// Soft tiles: a pale wash of a colour with the icon in its full strength. Colourful, never loud.
const TONES = {
  blue: "bg-[#eaf2ff] text-[#2563eb]",
  violet: "bg-[#f3edff] text-[#7c3aed]",
  rose: "bg-[#ffedf1] text-[#e11d48]",
  green: "bg-[#e7f8ef] text-[#059669]",
  amber: "bg-[#fff4e0] text-[#d97706]",
  cyan: "bg-[#e3f7fb] text-[#0891b2]",
  brand: "bg-brand-soft text-brand",
};

/** An icon on a soft coloured tile, like the ones beside each section. */
export function IconTile({ icon: Icon, tone = "brand", size = "md", className }) {
  return (
    <span className={cn("grid shrink-0 place-items-center", TONES[tone],
                        size === "sm" ? "size-7 rounded-md" : "size-9 rounded-lg", className)}>
      <Icon aria-hidden="true" className={size === "sm" ? "size-4" : "size-[18px]"} strokeWidth={1.75} />
    </span>
  );
}

/** A white panel on the canvas: a hairline edge, and barely any shadow. */
export function Card({ as: Tag = "section", className, children, ...props }) {
  return (
    <Tag className={cn("rounded-3xl border border-line bg-white shadow-card", className)} {...props}>
      {children}
    </Tag>
  );
}
