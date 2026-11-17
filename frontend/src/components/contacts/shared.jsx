import { Check, Plus, X } from "lucide-react";
import { cn } from "../../lib/cn.js";
import { cell, unusedColumns } from "../../lib/columns.js";
import { Select, TextInput } from "../ui/fields.jsx";

/** Where a wizard is: numbered steps, the done ones ticked. */
export function Steps({ steps, at }) {
  return (
    <ol className="flex flex-wrap items-center gap-x-2 gap-y-1 px-6 pb-2 text-[12px] font-medium">
      {steps.map((label, index) => (
        <li key={label} className={cn("flex items-center gap-1.5", index === at ? "text-ink" : index < at ? "text-brand-ink" : "text-faint")}>
          <span className={cn("grid size-5 place-items-center rounded-full text-[11px] font-semibold",
                              index < at ? "bg-brand text-white" : index === at ? "bg-brand-soft text-brand-ink ring-2 ring-brand" : "bg-fill text-faint")}>
            {index < at ? <Check aria-hidden="true" className="size-3" strokeWidth={3} /> : index + 1}
          </span>
          {label}
          {index < steps.length - 1 && <span aria-hidden="true" className="ml-0.5 h-px w-4 bg-edge" />}
        </li>
      ))}
    </ol>
  );
}

/** The buttons along the bottom of a wizard. */
export function Footer({ children, note }) {
  return (
    <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line px-6 pt-3.5 pb-[18px]">
      {note && <p className="mr-auto text-xs text-muted">{note}</p>}
      {children}
    </div>
  );
}

/** The first rows of a table, as they are. */
export function PreviewTable({ columns, rows, highlight = [] }) {
  return (
    <div className="max-h-56 overflow-auto rounded-xl border border-line">
      <table className="w-full text-left text-[12px]">
        <thead className="sticky top-0 bg-canvas">
          <tr>
            {columns.map((column) => (
              <th key={column} className={cn("px-3 py-2 font-semibold whitespace-nowrap", highlight.includes(column) ? "text-brand-ink" : "text-muted")}>
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {rows.map((row, at) => (
            <tr key={at}>
              {columns.map((column, index) => (
                <td key={column} className="max-w-48 truncate px-3 py-1.5 text-body">{row[index]}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** One field to match to a column, with what the first row has there. */
function Row({ label, required, children, sample }) {
  return (
    <div className="grid items-center gap-x-3 gap-y-1 sm:grid-cols-[110px_minmax(0,1fr)_minmax(0,150px)]">
      <span className="text-[13px] font-medium text-ink">{label}{required && <span className="text-bad"> *</span>}</span>
      {children}
      <span className="truncate text-xs text-faint max-sm:hidden" title={sample}>{sample ? `e.g. ${sample}` : ""}</span>
    </div>
  );
}

/**
 * Which column is which. Name can take a second column (a last name), and any column left over can be
 * kept with each contact. `country` goes in front of numbers written without one.
 */
export function ColumnMatch({ columns, rows, mapping, onChange, country, onCountry }) {
  const first = rows[0] || [];
  const choices = (none) => [["", none], ...columns.map((column) => [column, column])];
  const set = (patch) => onChange({ ...mapping, ...patch });
  const nameJoined = mapping.name.map((column) => cell(columns, first, column)).filter(Boolean).join(" ");
  const spare = unusedColumns(columns, mapping);

  return (
    <div className="flex flex-col gap-3">
      <Row label="Phone" required sample={cell(columns, first, mapping.phone)}>
        <Select aria-label="Phone column" value={mapping.phone} options={choices("Pick a column")}
                onChange={(event) => set({ phone: event.target.value, extra: mapping.extra.filter((one) => one !== event.target.value) })} />
      </Row>
      <Row label="Name" sample={nameJoined}>
        <div className="flex min-w-0 items-center gap-2">
          <div className="min-w-0 flex-1">
            <Select aria-label="Name column" value={mapping.name[0] || ""} options={choices("No name")}
                    onChange={(event) => set({ name: [event.target.value, ...mapping.name.slice(1)].filter(Boolean) })} />
          </div>
          {mapping.name[0] && mapping.name.length < 2 && (
            <button type="button" onClick={() => set({ name: [...mapping.name, spare.find((one) => one !== mapping.name[0]) || columns[0]] })}
                    title="Join another column on, like a last name"
                    className="flex h-10 shrink-0 items-center gap-1 rounded-xl px-2.5 text-[12px] font-semibold text-muted hover:bg-fill hover:text-ink">
              <Plus aria-hidden="true" className="size-3.5" strokeWidth={2.4} />Last name
            </button>
          )}
          {mapping.name.length > 1 && (
            <>
              <span className="text-xs text-faint">+</span>
              <div className="min-w-0 flex-1">
                <Select aria-label="Second name column" value={mapping.name[1]} options={choices("Nothing")}
                        onChange={(event) => set({ name: [mapping.name[0], event.target.value].filter(Boolean) })} />
              </div>
              <button type="button" aria-label="Don't join a second column" onClick={() => set({ name: mapping.name.slice(0, 1) })}
                      className="grid size-8 shrink-0 place-items-center rounded-lg text-muted hover:bg-fill hover:text-ink">
                <X aria-hidden="true" className="size-3.5" strokeWidth={2.2} />
              </button>
            </>
          )}
        </div>
      </Row>
      <Row label="Email" sample={cell(columns, first, mapping.email)}>
        <Select aria-label="Email column" value={mapping.email} options={choices("No email")}
                onChange={(event) => set({ email: event.target.value, extra: mapping.extra.filter((one) => one !== event.target.value) })} />
      </Row>
      <Row label="Country code" sample="for numbers without one">
        <TextInput aria-label="Country code" value={country} onChange={(event) => onCountry(event.target.value)} className="w-28 font-mono" placeholder="+91" />
      </Row>

      {spare.length > 0 && (
        <div className="mt-1 flex flex-col gap-2">
          <span className="text-[13px] font-medium text-ink">Also keep <span className="font-normal text-muted">(shown on each contact)</span></span>
          <div className="flex flex-wrap gap-1.5">
            {spare.map((column) => {
              const on = mapping.extra.includes(column);
              return (
                <button key={column} type="button" role="checkbox" aria-checked={on}
                        onClick={() => set({ extra: on ? mapping.extra.filter((one) => one !== column) : [...mapping.extra, column] })}
                        className={cn("flex h-8 items-center gap-1.5 rounded-full border px-3 text-[12px] font-semibold transition-colors",
                                      on ? "border-brand bg-brand-wash text-brand-ink" : "border-edge bg-white text-body hover:bg-hover")}>
                  {on && <Check aria-hidden="true" className="size-3" strokeWidth={3} />}{column}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

/** What an import did, or would do: four numbers, and the rows that couldn't come in. */
export function ImportSummary({ result, done }) {
  const tiles = [
    [done ? "Added" : "New", result.added, "text-good"],
    [done ? "Updated" : "Already saved", result.updated, "text-ink"],
    ["Repeated in the file", result.duplicates, "text-muted"],
    ["Skipped", result.skipped, result.skipped ? "text-bad" : "text-muted"],
  ];
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {tiles.map(([label, value, tone]) => (
          <div key={label} className="rounded-2xl bg-canvas px-3.5 py-3">
            <p className={cn("text-xl font-bold tabular-nums", tone)}>{value.toLocaleString()}</p>
            <p className="text-xs text-muted">{label}</p>
          </div>
        ))}
      </div>
      {result.updated > 0 && (
        <p className="text-xs leading-relaxed text-muted">
          Numbers already saved keep one contact: {done ? "their" : "the"} details are filled in from the file, and nothing already there is blanked.
          {result.opted_out > 0 && ` ${result.opted_out} of them opted out, and stay opted out.`}
        </p>
      )}
      {result.problems.length > 0 && (
        <details className="rounded-xl border border-line px-3.5 py-2.5 text-[13px]">
          <summary className="cursor-pointer font-medium text-ink">Rows skipped ({result.skipped.toLocaleString()})</summary>
          <ul className="mt-2 max-h-36 overflow-auto text-xs text-body">
            {result.problems.map((problem) => (
              <li key={problem.row} className="flex gap-3 py-0.5">
                <span className="w-14 shrink-0 font-mono text-faint">Row {problem.row + 1}</span>
                <span className="w-32 shrink-0 truncate font-mono">{problem.value || "—"}</span>
                <span className="text-muted">{problem.reason}</span>
              </li>
            ))}
            {result.skipped > result.problems.length && <li className="py-0.5 text-faint">…and {result.skipped - result.problems.length} more</li>}
          </ul>
        </details>
      )}
    </div>
  );
}
