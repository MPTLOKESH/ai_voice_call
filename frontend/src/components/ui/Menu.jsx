import { useEffect, useRef, useState } from "react";
import { cn } from "../../lib/cn.js";

/** A button that opens a small panel beneath it. Closes on a click elsewhere or Escape. */
export function Menu({ trigger, label, align = "right", side = "below", buttonClassName, className, children }) {
  const [open, setOpen] = useState(false);
  const holder = useRef(null);

  useEffect(() => {
    if (!open) return;
    const away = (event) => { if (!holder.current?.contains(event.target)) setOpen(false); };
    const escape = (event) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  return (
    <div ref={holder} className="relative">
      <button type="button" aria-label={label} aria-expanded={open} onClick={() => setOpen(!open)}
              className={buttonClassName || cn("grid size-9 place-items-center rounded-full text-body transition hover:bg-fill hover:text-ink",
                                        open && "bg-active text-ink")}>
        {trigger}
      </button>
      {open && (
        // Choosing something closes it.
        <div onClick={(event) => { if (event.target.closest("button")) setOpen(false); }}
             className={cn("absolute z-40 w-72 rounded-2xl border border-line bg-white p-1.5 shadow-float",
                           "animate-[toast-in_.16s_ease-out]",
                           // "beside" opens to the right of the button, bottom edges level: for a rail down the left
                           side === "beside" ? "bottom-0 left-full ml-3"
                             : cn("top-11", align === "right" ? "right-0" : "left-0"), className)}>
          {children}
        </div>
      )}
    </div>
  );
}
