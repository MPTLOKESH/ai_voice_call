import { X } from "lucide-react";
import { useEffect, useRef } from "react";
import { cn } from "../../lib/cn.js";
import { Button } from "./Button.jsx";

/** A window over the page. Closes on Escape or a click outside it; focus starts inside and goes back after. */
export function Dialog({ title, subtitle, onClose, className, children }) {
  const box = useRef(null);
  // The latest onClose, so a parent drawing a new one each render doesn't move focus back to the start.
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    const before = document.activeElement;
    const escape = (event) => { if (event.key === "Escape") { event.stopPropagation(); close.current(); } };
    document.addEventListener("keydown", escape, true);
    // The first control that isn't the close button: the one a person most likely wants.
    const controls = box.current?.querySelectorAll("button, input, select, textarea, [tabindex]:not([tabindex='-1'])");
    ([...(controls || [])].find((one) => !one.dataset.close) || box.current)?.focus();
    return () => {
      document.removeEventListener("keydown", escape, true);
      before?.focus?.();
    };
  }, []);

  return (
    <div onClick={onClose} className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-ink/30 p-4 backdrop-blur-[4px] sm:p-6">
      <div ref={box} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} onClick={(event) => event.stopPropagation()}
           className={cn("w-[440px] max-w-full rounded-3xl bg-white shadow-[0_24px_64px_rgb(17_17_20/0.24)] focus:outline-none", className)}>
        <div className="flex items-start gap-3 px-6 pt-[22px] pb-1.5">
          <div className="min-w-0 flex-1">
            <h2 className="text-lg font-bold tracking-[-0.015em] text-ink">{title}</h2>
            {subtitle && <p className="mt-0.5 text-[13px] text-muted">{subtitle}</p>}
          </div>
          <button type="button" onClick={onClose} aria-label="Close" data-close="true"
                  className="grid size-8 shrink-0 place-items-center rounded-[10px] text-muted hover:bg-fill">
            <X aria-hidden="true" className="size-4" strokeWidth={2.2} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

/** Are you sure? `danger` paints the confirm button red, for what can't be undone. */
export function ConfirmDialog({ title, children, confirm = "Confirm", danger = false, onConfirm, onClose }) {
  return (
    <Dialog title={title} onClose={onClose}>
      <div className="px-6 py-2 text-sm leading-relaxed text-body">{children}</div>
      <div className="flex justify-end gap-2 px-6 pt-3.5 pb-[22px]">
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button variant={danger ? "danger-solid" : "primary"} onClick={() => { onConfirm(); onClose(); }}>{confirm}</Button>
      </div>
    </Dialog>
  );
}
