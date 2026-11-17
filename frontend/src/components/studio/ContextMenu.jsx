import { ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { cn } from "../../lib/cn.js";
import { AiIcon } from "../ui/AiIcon.jsx";

/**
 * The menu a right-click brings up, at the pointer. It shuts when something is chosen, on a press anywhere
 * else, on Escape, and when the view under it moves.
 *
 *   at      {x, y} in the window
 *   items   [{label, icon, hint, danger, disabled, onPick}], with `null` for a dividing line. One with
 *           `items` of its own opens that list in place, with a way back.
 */
export function ContextMenu({ at, items: all, onClose }) {
  const box = useRef(null);
  const [inside, setInside] = useState(null);      // the item whose own list is showing
  const items = inside ? inside.items : all;
  const [place, setPlace] = useState({ left: at.x, top: at.y });

  // Kept inside the window: near the right or bottom edge it opens the other way.
  useLayoutEffect(() => {
    const size = box.current.getBoundingClientRect();
    setPlace({
      left: Math.max(8, Math.min(at.x, window.innerWidth - size.width - 8)),
      top: Math.max(8, Math.min(at.y, window.innerHeight - size.height - 8)),
    });
  }, [at.x, at.y, inside]);

  useEffect(() => {
    const away = (event) => { if (!box.current?.contains(event.target)) onClose(); };
    const escape = (event) => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } };
    document.addEventListener("pointerdown", away, true);
    document.addEventListener("keydown", escape, true);
    window.addEventListener("wheel", onClose, { passive: true });
    window.addEventListener("resize", onClose);
    window.addEventListener("blur", onClose);
    return () => {
      document.removeEventListener("pointerdown", away, true);
      document.removeEventListener("keydown", escape, true);
      window.removeEventListener("wheel", onClose);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  useEffect(() => { box.current?.querySelector("button:not(:disabled)")?.focus({ preventScroll: true }); }, [inside]);

  /** Up and down go through the choices. */
  function arrows(event) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    event.stopPropagation();
    const all = [...box.current.querySelectorAll("button:not(:disabled)")];
    const now = all.indexOf(document.activeElement);
    all[(now + (event.key === "ArrowDown" ? 1 : -1) + all.length) % all.length]?.focus();
  }

  return (
    <div ref={box} role="menu" style={place} onKeyDown={arrows} onContextMenu={(event) => event.preventDefault()}
         className="fixed z-[80] w-64 animate-[toast-in_.12s_ease-out] rounded-2xl border border-line bg-white p-1.5 shadow-float">
      {inside && (
        <button type="button" onClick={() => setInside(null)}
                className="mb-1 flex w-full items-center gap-1.5 rounded-xl border-b border-line px-2 py-2 text-left text-xs font-semibold text-muted outline-none hover:bg-fill hover:text-ink focus-visible:bg-fill">
          <ChevronLeft aria-hidden="true" className="size-3.5" strokeWidth={2.4} />{inside.label}
        </button>
      )}
      {items.map((item, index) => {
        if (!item) return <div key={`line-${index}`} className="mx-2 my-1 h-px bg-line" />;
        const Icon = item.icon;
        const ai = Icon === AiIcon;                       // the AI's own choices wear the AI's colour
        return (
          <button key={item.label} type="button" role="menuitem" disabled={item.disabled}
                  onClick={() => { if (item.items) setInside(item); else { onClose(); item.onPick(); } }}
                  className={cn("flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left text-[13px] font-medium outline-none",
                                "disabled:opacity-40 disabled:hover:bg-transparent",
                                ai ? "text-brand-ink hover:bg-brand-wash focus-visible:bg-brand-wash"
                                  : item.danger ? "text-bad hover:bg-bad-soft focus-visible:bg-bad-soft" : "text-ink hover:bg-fill focus-visible:bg-fill")}>
            {Icon && <Icon aria-hidden="true" className={cn("size-4 shrink-0", ai ? "text-brand" : item.danger ? "text-bad" : "text-muted")} strokeWidth={2} />}
            <span className="min-w-0 flex-1 leading-snug">{item.label}</span>
            {item.hint && <span className="shrink-0 font-mono text-[11px] text-faint">{item.hint}</span>}
            {item.items && <ChevronRight aria-hidden="true" className="size-3.5 shrink-0 text-faint" strokeWidth={2.4} />}
          </button>
        );
      })}
    </div>
  );
}
