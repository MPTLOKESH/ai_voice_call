import { ChevronRight, Filter, PhoneCall, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as api from "../../lib/api.js";
import { cn } from "../../lib/cn.js";
import { Badge } from "../ui/Badge.jsx";
import { Button } from "../ui/Button.jsx";
import { Card } from "../ui/Card.jsx";
import { ConfirmDialog } from "../ui/Dialog.jsx";
import { RowBox, SelectAll, SelectionBar } from "../ui/SelectionBar.jsx";
import { useToast } from "../ui/Toasts.jsx";
import { useSelection } from "../../lib/useSelection.js";
import { Select } from "../ui/fields.jsx";
import { EmptyState, ErrorNote, SkeletonRows } from "../ui/States.jsx";

const PAGE = 20;
const OUTCOMES = [["", "Any outcome"], ["completed", "Completed"], ["incomplete", "Incomplete"]];

const when = (iso) => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso || "—"
    : date.toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
};

/**
 * Finished calls, newest first, as saved in data/calls/, a page at a time. A row opens to show its answers.
 * `flows` names the flow each call came from, and lets the list be narrowed to one.
 */
export function HistoryPage({ flows = [], onCall }) {
  const [calls, setCalls] = useState(null);
  const [total, setTotal] = useState(0);
  const [problem, setProblem] = useState("");
  const [open, setOpen] = useState(null);
  const [flow, setFlow] = useState("");
  const [outcome, setOutcome] = useState("");
  const [more, setMore] = useState(false);
  const [confirming, setConfirming] = useState(null);   // ids waiting on "are you sure"
  const toast = useToast();
  const ids = useMemo(() => (calls || []).map((one) => one.call), [calls]);
  const selection = useSelection(ids);

  // A filter changed twice quickly: only the answer to the last one counts.
  const latest = useRef(0);
  const load = useCallback(async () => {
    const asked = ++latest.current;
    setProblem("");
    try {
      const found = await api.recentCalls({ flow, outcome, limit: PAGE });
      if (asked !== latest.current) return;
      setCalls(found.calls);
      setTotal(found.total);
    } catch (failure) {
      setProblem(failure.message);
      setCalls([]);
      setTotal(0);
    }
  }, [flow, outcome]);

  useEffect(() => { load(); }, [load]);

  async function loadMore() {
    setMore(true);
    try {
      const found = await api.recentCalls({ flow, outcome, limit: PAGE, offset: calls.length });
      // A call that finished since the first page pushes the rest along: don't show one twice.
      setCalls((shown) => [...shown, ...found.calls.filter((one) => !shown.some((other) => other.call === one.call))]);
      setTotal(found.total);
    } catch (failure) {
      setProblem(failure.message);
    } finally {
      setMore(false);
    }
  }

  async function removeCalls(gone) {
    try {
      const { deleted } = await api.deleteCalls(gone);
      setCalls((shown) => shown.filter((one) => !gone.includes(one.call)));
      setTotal((now) => Math.max(0, now - deleted));
      if (gone.includes(open)) setOpen(null);
      selection.clear();
      toast(deleted === 1 ? "Call deleted." : `${deleted} calls deleted.`);
    } catch (failure) {
      toast(failure.message, "bad");
    }
  }

  const flowName = (id) => flows.find((one) => one.id === id)?.name;
  const filtered = Boolean(flow || outcome);

  return (
    <>
      <div>
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <Select aria-label="Flow" className="w-auto min-w-44" value={flow} onChange={(event) => setFlow(event.target.value)}
                  options={[["", "All flows"], ...flows.map((one) => [one.id, one.name])]} />
          <Select aria-label="Outcome" className="w-auto" value={outcome} onChange={(event) => setOutcome(event.target.value)}
                  options={OUTCOMES} />
          {calls && <span className="text-[13px] text-muted">{total} {total === 1 ? "call" : "calls"}</span>}
          <span className="flex-1" />
          {calls?.length > 0 && (
            <label className="flex cursor-pointer items-center gap-2 text-[13px] font-medium text-muted">
              <SelectAll selection={selection} label="Pick every call shown" />Pick several
            </label>
          )}
          <Button variant="secondary" size="sm" icon={RefreshCw} onClick={load}>Refresh</Button>
        </div>

        <SelectionBar selection={selection} noun={selection.count === 1 ? "call picked" : "calls picked"} className="mb-4"
                      onDelete={() => setConfirming(selection.ids)} />

        {problem && <ErrorNote className="mb-5" onRetry={load}>{problem}</ErrorNote>}

        {calls === null ? (
          <Card as="div" className="overflow-hidden"><SkeletonRows rows={6} /></Card>
        ) : calls.length === 0 && problem ? null : calls.length === 0 && filtered ? (
          <EmptyState icon={Filter} title="No calls match"
                      action={<Button variant="secondary" onClick={() => { setFlow(""); setOutcome(""); }}>Show all calls</Button>}>
            Try another flow or outcome.
          </EmptyState>
        ) : calls.length === 0 ? (
          <EmptyState icon={PhoneCall} title="No calls yet"
                      action={<Button variant="secondary" onClick={onCall}>Make a test call</Button>}>
            Finished calls, test calls included, are saved and listed here with what was answered.
          </EmptyState>
        ) : (
          <Card as="div" className="overflow-hidden">
            <div className="hidden grid-cols-[150px_120px_80px_minmax(0,1fr)_24px] gap-4 border-b border-line pr-6 pl-12 pt-4 pb-3 text-[11px] font-semibold tracking-wide text-muted uppercase md:grid">
              <span>When</span><span>Outcome</span><span>Length</span><span>Summary</span><span />
            </div>
            <ul className="divide-y divide-line">
              {calls.map((call) => {
                const expanded = open === call.call;
                const answers = Object.entries(call.answers || {});
                return (
                  <li key={call.call} className={cn("flex flex-wrap", selection.has(call.call) && "bg-brand-wash")}>
                    <span className="grid w-12 shrink-0 place-items-center pl-3 md:pl-4">
                      <RowBox selection={selection} id={call.call} label={`Pick the call from ${when(call.at)}`} />
                    </span>
                    <button type="button" onClick={() => setOpen(expanded ? null : call.call)} aria-expanded={expanded}
                            className="grid min-w-0 flex-1 grid-cols-[1fr_auto] gap-x-4 gap-y-1.5 px-5 py-4 text-left transition hover:bg-fill/60 md:grid-cols-[150px_120px_80px_minmax(0,1fr)_24px] md:items-center md:pr-6">
                      <span className="min-w-0">
                        <span className="block text-sm font-semibold text-ink">{when(call.at)}</span>
                        {!flow && (
                          <span className="block truncate text-xs text-muted">{flowName(call.flow) || (call.flow ? "Deleted flow" : "Before flows")}</span>
                        )}
                      </span>
                      <span className="justify-self-end md:justify-self-start">
                        <Badge tone={call.outcome === "completed" ? "good" : "warn"}>
                          {call.outcome === "completed" ? "Completed" : "Incomplete"}
                        </Badge>
                      </span>
                      <span className="font-mono text-[13px] text-body tabular-nums">
                        {call.seconds != null ? `${Math.round(call.seconds)}s` : "—"}
                      </span>
                      <span className="col-span-2 line-clamp-2 text-[13px] text-body md:col-span-1 md:line-clamp-1">
                        {call.summary || <span className="text-muted">No summary</span>}
                      </span>
                      <ChevronRight aria-hidden="true" strokeWidth={1.75}
                                    className={cn("hidden size-4 text-muted transition md:block", expanded && "rotate-90")} />
                    </button>

                    {expanded && (
                      <div className="w-full border-t border-line bg-canvas px-5 py-5 md:px-6">
                        {call.summary && <p className="max-w-3xl text-sm leading-relaxed text-body">{call.summary}</p>}
                        {answers.length ? (
                          <dl className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                            {answers.map(([name, value]) => (
                              <div key={name} className="rounded-lg border border-line bg-white px-4 py-3">
                                <dt className="text-xs text-muted">{name.replace(/_/g, " ")}</dt>
                                <dd className="mt-0.5 text-sm font-semibold text-ink">{value}</dd>
                              </div>
                            ))}
                          </dl>
                        ) : (
                          <p className="mt-3 text-[13px] text-muted">No answers were saved on this call.</p>
                        )}
                        <div className="mt-4 flex items-center gap-3">
                          <p className="font-mono text-[11px] text-muted">data/calls/{call.call}.json</p>
                          <Button variant="ghost" size="sm" onClick={() => setConfirming([call.call])}>Delete</Button>
                        </div>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
            {calls.length < total && (
              <div className="flex justify-center border-t border-line p-3">
                <Button variant="ghost" size="sm" disabled={more} onClick={loadMore}>
                  {more ? "Loading…" : `Show more (${total - calls.length} left)`}
                </Button>
              </div>
            )}
          </Card>
        )}
      </div>
      {confirming && (
        <ConfirmDialog title={`Delete ${confirming.length === 1 ? "this call" : `${confirming.length} calls`}?`} confirm="Delete" danger
                       onClose={() => setConfirming(null)} onConfirm={() => removeCalls(confirming)}>
          The recording of what was said and the answers it saved are removed for good. Results and the numbers on the Flows page will no longer count {confirming.length === 1 ? "it" : "them"}.
        </ConfirmDialog>
      )}
    </>
  );
}
