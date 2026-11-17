import { useCallback, useEffect, useState } from "react";

// Ticks outlive the page: open a flow, come back, and the same rows are still ticked. Kept by name, in memory only.
const kept = new Map();

/**
 * Which rows are ticked. `visible` is the ids on screen: anything ticked that has gone from the list
 * (filtered away, deleted) stops counting, so a bulk action never reaches a row nobody can see.
 * Shift-click ticks everything between the last row ticked and this one.
 */
export function useSelection(visible, name = "") {
  const [picked, setPicked] = useState(() => new Set(name ? kept.get(name) : []));
  const [last, setLast] = useState(null);

  useEffect(() => { if (name) kept.set(name, [...picked]); }, [name, picked]);

  useEffect(() => {
    setPicked((now) => {
      const keep = [...now].filter((id) => visible.includes(id));
      return keep.length === now.size ? now : new Set(keep);
    });
  }, [visible]);

  const toggle = useCallback((id, event) => {
    setPicked((now) => {
      const next = new Set(now);
      const adding = !now.has(id);
      if (event?.shiftKey && last !== null && visible.includes(last)) {
        const [from, to] = [visible.indexOf(last), visible.indexOf(id)].sort((a, b) => a - b);
        visible.slice(from, to + 1).forEach((one) => (adding ? next.add(one) : next.delete(one)));
      } else if (adding) next.add(id);
      else next.delete(id);
      return next;
    });
    setLast(id);
  }, [last, visible]);

  const all = visible.length > 0 && visible.every((id) => picked.has(id));
  const toggleAll = () => setPicked(all ? new Set() : new Set(visible));
  const clear = () => setPicked(new Set());

  return { picked, ids: [...picked], count: picked.size, all, some: picked.size > 0 && !all, toggle, toggleAll, clear, has: (id) => picked.has(id) };
}
