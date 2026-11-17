import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import { cn } from "../../lib/cn.js";

const ToastContext = createContext(() => {});

/** `toast(message, kind)` from anywhere below. Problems stay up longer than notes. */
export const useToast = () => useContext(ToastContext);

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const next = useRef(0);

  const toast = useCallback((message, kind = "note") => {
    const id = ++next.current;
    setToasts((all) => [...all, { id, message, kind }]);
    setTimeout(() => setToasts((all) => all.filter((one) => one.id !== id)), kind === "bad" ? 6000 : 3000);
  }, []);

  const value = useMemo(() => toast, [toast]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      {/* A dark pill at the bottom middle, with a green dot for a note and a red one for a problem */}
      <div aria-live="polite"
           className="pointer-events-none fixed inset-x-0 bottom-20 z-[60] flex flex-col items-center gap-2 px-4 lg:bottom-7">
        {toasts.map(({ id, message, kind }) => (
          <div key={id} role={kind === "bad" ? "alert" : "status"}
               className="pointer-events-auto flex max-w-[min(560px,100%)] animate-[toast-in_.18s_ease-out] items-center gap-2.5 rounded-full bg-ink px-4 py-2.5 text-[13px] font-medium text-white shadow-[0_10px_30px_rgb(17_17_20/0.25)]">
            <span className={cn("size-2 shrink-0 rounded-full", kind === "bad" ? "bg-[#ff6b5e]" : "bg-live")} />
            <span className="leading-snug">{message}</span>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
