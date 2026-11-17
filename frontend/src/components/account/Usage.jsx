import { useEffect, useState } from "react";
import * as api from "../../lib/api.js";
import { cn } from "../../lib/cn.js";
import { day, short, usd } from "../../lib/money.js";
import { ago } from "../../lib/time.js";
import { Badge } from "../ui/Badge.jsx";
import { Card } from "../ui/Card.jsx";
import { Meter } from "../ui/Insight.jsx";
import { Select } from "../ui/fields.jsx";
import { EmptyState, ErrorNote, Skeleton } from "../ui/States.jsx";

// Two series, two hues: ours is the brand violet, yours is teal. Both pass the colour checks together.
const SERIES = [["ours", "Our keys", "bg-brand"], ["own", "Your keys", "bg-human"]];
const RANGES = [["7", "Last 7 days"], ["30", "Last 30 days"], ["90", "Last 90 days"]];

/** One bar a day, ours stacked on yours, with a 2px gap between the two. Hover (or focus) a day for its figures. */
function DailyBars({ days }) {
  const most = Math.max(1e-9, ...days.map((one) => one.ours + one.own));
  const [at, setAt] = useState(null);
  const shown = at == null ? null : days[at];
  const every = Math.ceil(days.length / 8);
  return (
    <div>
      <div className="relative flex h-44 items-end gap-[3px]" onMouseLeave={() => setAt(null)}
           role="img" aria-label={`Estimated spend per day, ${usd(days.reduce((sum, one) => sum + one.ours + one.own, 0))} in all`}>
        {days.map((one, index) => {
          const tall = ((one.ours + one.own) / most) * 100;
          const ownShare = one.ours + one.own ? (one.own / (one.ours + one.own)) * 100 : 0;
          return (
            <button key={one.day} type="button" tabIndex={0} onMouseEnter={() => setAt(index)} onFocus={() => setAt(index)} onBlur={() => setAt(null)}
                    aria-label={`${day(one.day)}: ${usd(one.ours)} on our keys, ${usd(one.own)} on yours`}
                    className="group flex h-full min-w-0 flex-1 items-end rounded-md outline-none focus-visible:ring-2 focus-visible:ring-brand/40">
              <span className="flex w-full flex-col justify-end gap-[2px] overflow-hidden rounded-t-[4px]"
                    style={{ height: `${Math.max(one.ours + one.own ? 4 : 1, tall)}%` }}>
                {one.own > 0 && <span className="bg-human" style={{ flex: ownShare }} />}
                {one.ours > 0 && <span className="bg-brand" style={{ flex: 100 - ownShare }} />}
                {!one.ours && !one.own && <span className="h-px w-full bg-line" />}
              </span>
            </button>
          );
        })}
        {shown && (
          <div role="status" className="pointer-events-none absolute top-0 left-1/2 z-10 -translate-x-1/2 rounded-xl border border-line bg-white px-3 py-2 text-[12px] shadow-float">
            <p className="font-semibold text-ink">{day(shown.day)}</p>
            <p className="text-muted"><span className="mr-1.5 inline-block size-2 rounded-full bg-brand" />Our keys {usd(shown.ours)}</p>
            <p className="text-muted"><span className="mr-1.5 inline-block size-2 rounded-full bg-human" />Your keys {usd(shown.own)}</p>
          </div>
        )}
      </div>
      <div className="mt-2 flex gap-[3px] text-[11px] text-faint">
        {days.map((one, index) => (
          <span key={one.day} className="min-w-0 flex-1 text-center">{index % every === 0 ? day(one.day) : ""}</span>
        ))}
      </div>
      <ul className="mt-4 flex flex-wrap gap-x-5 gap-y-1 text-[13px] text-body">
        {SERIES.map(([key, label, swatch]) => (
          <li key={key} className="inline-flex items-center gap-2"><span className={cn("size-2.5 rounded-full", swatch)} />{label}</li>
        ))}
      </ul>
    </div>
  );
}

function DayTable({ days }) {
  return (
    <div className="max-h-72 overflow-auto rounded-2xl border border-line">
      <table className="w-full text-left text-[13px]">
        <thead className="sticky top-0 bg-fill text-muted"><tr><th className="px-4 py-2 font-medium">Day</th><th className="px-4 py-2 font-medium">Our keys</th><th className="px-4 py-2 font-medium">Your keys</th></tr></thead>
        <tbody className="divide-y divide-line">
          {days.slice().reverse().map((one) => (
            <tr key={one.day}><td className="px-4 py-2 text-ink">{day(one.day)}</td><td className="px-4 py-2 tabular-nums">{usd(one.ours)}</td><td className="px-4 py-2 tabular-nums">{usd(one.own)}</td></tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The biggest spenders first, each with a bar scaled to the biggest. */
function Split({ title, rows, label }) {
  const most = Math.max(1e-9, ...rows.map((one) => one.cost));
  return (
    <Card className="p-5">
      <h3 className="text-[15px] font-semibold text-ink">{title}</h3>
      {rows.length === 0 ? <p className="mt-3 text-[13px] text-faint">Nothing yet.</p> : (
        <ul className="mt-4 flex flex-col gap-3">
          {rows.slice(0, 6).map((one) => (
            <li key={one.key} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1.5 text-[13px]">
              <span className="truncate font-medium text-ink">{label(one.key)}</span>
              <span className="font-mono text-xs text-muted tabular-nums">{usd(one.cost)} · {short(one.requests)} req</span>
              <Meter percent={(one.cost / most) * 100} className="col-span-2 h-2" />
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export function Usage({ flows }) {
  const [days, setDays] = useState("30");
  const [data, setData] = useState(null);
  const [problem, setProblem] = useState("");
  const [table, setTable] = useState(false);
  const [again, setAgain] = useState(0);

  useEffect(() => {
    setData(null);
    api.accountUsage(days).then((found) => { setData(found); setProblem(""); }).catch((failure) => setProblem(failure.message));
  }, [days, again]);

  if (problem) return <ErrorNote onRetry={() => setAgain((now) => now + 1)}>{problem}</ErrorNote>;
  const flowName = (id) => (id === "—" ? "Not tied to a flow" : flows.find((one) => one.id === id)?.name || "A deleted flow");

  return (
    <div className="grid gap-5">
      <Card className="p-6">
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-[16px] font-semibold text-ink">Estimated spend per day</h2>
            <p className="mt-0.5 text-[13px] text-muted">From what the providers reported for each request. An estimate, not a bill.</p>
          </div>
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => setTable((now) => !now)} className="h-9 rounded-full px-3.5 text-[13px] font-medium text-muted hover:bg-fill hover:text-ink">
              {table ? "Show chart" : "Show as table"}
            </button>
            <div className="w-40"><Select value={days} onChange={(event) => setDays(event.target.value)} options={RANGES} aria-label="Period" /></div>
          </div>
        </div>
        {!data ? <Skeleton className="h-52 rounded-2xl" />
          : data.totals.requests === 0 ? (
            <EmptyState compact title="Nothing used in this period" >Make a test call and it will show up here.</EmptyState>
          ) : table ? <DayTable days={data.daily} /> : <DailyBars days={data.daily} />}
      </Card>

      {data && data.totals.requests > 0 && (
        <>
          <div className="grid gap-4 lg:grid-cols-3">
            <Split title="By service" rows={data.by_service} label={(key) => data.names.service[key] || key} />
            <Split title="By what it was for" rows={data.by_kind} label={(key) => data.names.kind[key] || key} />
            <Split title="By flow" rows={data.by_flow} label={flowName} />
          </div>

          <Card className="overflow-hidden">
            <h3 className="px-5 pt-5 pb-3 text-[15px] font-semibold text-ink">Recent requests</h3>
            <div className="overflow-auto">
              <table className="w-full min-w-[620px] text-left text-[13px]">
                <thead className="bg-fill text-muted"><tr>
                  {["When", "Service", "For", "Used", "Cost", "Paid by"].map((head) => <th key={head} className="px-5 py-2 font-medium">{head}</th>)}
                </tr></thead>
                <tbody className="divide-y divide-line">
                  {data.recent.map((one, at) => (
                    <tr key={at}>
                      <td className="px-5 py-2.5 text-muted">{ago(one.at)}</td>
                      <td className="px-5 py-2.5 text-ink">{data.names.service[one.service] || one.service}</td>
                      <td className="px-5 py-2.5 text-body">{data.names.kind[one.kind] || one.kind}</td>
                      <td className="px-5 py-2.5 font-mono text-xs text-muted">
                        {one.service === "gemini" ? `${short(one.units_in + one.units_out)} tokens` : one.service === "speak" ? `${short(one.units_in)} chars` : `${one.units_in.toFixed(1)} s`}
                      </td>
                      <td className="px-5 py-2.5 tabular-nums">{usd(one.cost)}</td>
                      <td className="px-5 py-2.5"><Badge tone={one.source === "own" ? "good" : "brand"}>{one.source === "own" ? "Your key" : "Our key"}</Badge></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}
    </div>
  );
}
