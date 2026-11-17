import { Trash2, X } from "lucide-react";
import { useEffect, useRef } from "react";

/** The tick box in a list's header: all, some or none of the rows shown. */
export function SelectAll({ selection, label = "Pick everything shown" }) {
  const box = useRef(null);
  useEffect(() => { if (box.current) box.current.indeterminate = selection.some; }, [selection.some]);
  return (
    <input ref={box} type="checkbox" aria-label={label} checked={selection.all} onChange={selection.toggleAll}
           className="size-4 cursor-pointer accent-brand" />
  );
}

/** A row's tick box. Shift-click ticks a run of rows. */
export function RowBox({ selection, id, label }) {
  return (
    <input type="checkbox" aria-label={label} checked={selection.has(id)} onChange={() => {}}
           onClick={(event) => { event.stopPropagation(); selection.toggle(id, event); }}
           className="size-4 cursor-pointer accent-brand" />
  );
}

/** What can be done to the rows ticked. Shown only while some are. `children` are extra actions, before Delete. */
export function SelectionBar({ selection, noun = "picked", onDelete, children, className = "" }) {
  if (!selection.count) return null;
  return (
    <div role="toolbar" aria-label="Actions for the picked rows"
         className={`flex flex-wrap items-center gap-1.5 rounded-2xl bg-brand px-3 py-2 text-[13px] text-white ${className}`}>
      <span className="px-1 font-semibold">{selection.count} {noun}</span>
      <button type="button" onClick={selection.toggleAll} className="h-8 rounded-full px-3 font-semibold hover:bg-white/15">
        {selection.all ? "Pick none" : "Pick all shown"}
      </button>
      <span className="flex-1" />
      {children}
      <button type="button" onClick={onDelete}
              className="flex h-8 items-center gap-1.5 rounded-full px-3 font-semibold text-[#ffb4ab] hover:bg-white/15">
        <Trash2 aria-hidden="true" className="size-3.5" strokeWidth={2} />Delete
      </button>
      <button type="button" aria-label="Clear the selection" onClick={selection.clear}
              className="grid size-8 place-items-center rounded-full hover:bg-white/15">
        <X aria-hidden="true" className="size-4" strokeWidth={2.2} />
      </button>
    </div>
  );
}
