import { CheckCircle2, Download, PhoneCall, Timer, Users } from "lucide-react";
import { useEffect, useState } from "react";
import * as api from "../../lib/api.js";
import { cn } from "../../lib/cn.js";
import { clock, humanize } from "../../lib/thread.js";
import { ago } from "../../lib/time.js";
import { PAGE_FRAME } from "../layout/Page.jsx";
import { Badge } from "../ui/Badge.jsx";
import { Button } from "../ui/Button.jsx";
import { Card } from "../ui/Card.jsx";
import { DayBars, Meter, Ring, StatCard } from "../ui/Insight.jsx";
import { EmptyState, ErrorNote, Skeleton } from "../ui/States.jsx";

const percent = (part, whole) => (whole ? Math.round((part / whole) * 100) : 0);

// Each answer gets its own colour in turn; yes and no are fixed so they read the same on every question.
const SHADES = ["bg-brand", "bg-human", "bg-coral", "bg-end", "bg-amber", "bg-[#0891b2]"];
const shade = (value, at) => (value === "yes" ? "bg-live" : value === "no" ? "bg-coral" : SHADES[at % SHADES.length]);

const initials = (name) => (name || "?").split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase() || "?";

/** A row of bars: what each answer was, and how many gave it. */
function Bars({ counts, total, scale }) {
  const most = Math.max(1, ...counts.map((one) => one.count));
  return (
    <ul className="flex flex-col gap-2.5">
      {counts.map((one, at) => (
        <li key={one.value} className="grid grid-cols-[minmax(0,110px)_1fr_auto] items-center gap-3 text-[13px]">
          <span className="truncate font-medium text-ink capitalize">{one.value}</span>
          <Meter percent={(one.count / most) * 100} tone={scale ? "bg-brand" : shade(one.value, at)} className="h-3" />
          <span className="w-20 text-right font-mono text-xs text-muted tabular-nums">{one.count} · {percent(one.count, total)}%</span>
        </li>
      ))}
    </ul>
  );
}

function QuestionResult({ one }) {
  return (
    <Card className="p-5 transition-shadow hover:shadow-tile">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 className="text-[15px] font-semibold text-ink">{one.ask || humanize(one.save_as)}</h3>
        {one.removed && <Badge tone="warn">No longer asked</Badge>}
        <span className="ml-auto text-xs text-muted">{one.answered} of {one.calls} answered</span>
      </div>

      <div className="mt-4">
        {one.answered === 0 ? (
          <p className="text-[13px] text-faint">No answers yet.</p>
        ) : one.type === "number" ? (
          <>
            <div className="mb-3 flex flex-wrap gap-x-6 gap-y-1 text-[13px]">
              <span><span className="text-muted">Average </span><span className="font-semibold text-ink tabular-nums">{one.average}</span></span>
              <span><span className="text-muted">Lowest </span><span className="font-semibold text-ink tabular-nums">{one.low}</span></span>
              <span><span className="text-muted">Highest </span><span className="font-semibold text-ink tabular-nums">{one.high}</span></span>
            </div>
            {one.counts && <Bars counts={one.counts} total={one.answered} scale />}
          </>
        ) : one.counts ? (
          <Bars counts={one.counts} total={one.answered} />
        ) : (
          <ul className="flex max-h-60 flex-col gap-1.5 overflow-auto">
            {one.values.map((value, at) => (
              <li key={at} className="rounded-xl bg-canvas px-3 py-2 text-[13px] leading-snug text-body">{value}</li>
            ))}
            {one.answered > one.values.length && (
              <li className="px-1 text-xs text-faint">…and {one.answered - one.values.length} more. They are all in the export.</li>
            )}
          </ul>
        )}
      </div>
    </Card>
  );
}

/** The whole page in a sentence: how many finished, and what most people said. */
function Headline({ data }) {
  const rate = percent(data.completed, data.calls);
  const pick = (data.questions || []).find((one) => one.counts?.length && one.answered > 0 && !one.removed && one.type !== "number");
  const best = pick && [...pick.counts].sort((a, b) => b.count - a.count)[0];
  return (
    <p className="mb-5 text-[17px] leading-relaxed text-body">
      <span className="font-bold text-ink">{rate}%</span> of {data.calls} {data.calls === 1 ? "call" : "calls"} got all the way through.
      {best && pick.ask && <> Most said <span className="font-semibold text-ink">“{best.value}”</span> to “{pick.ask}”.</>}
    </p>
  );
}

/** What the calls of one flow said: how they went, who is still to call, and every question's answers. */
export function ResultsPage({ flow, onBack, onTest }) {
  const [data, setData] = useState(null);
  const [problem, setProblem] = useState("");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let current = true;
    setData(null);
    setProblem("");
    api.flowResults(flow.id).then((found) => { if (current) setData(found); })
      .catch((failure) => { if (current) setProblem(failure.message); });
    return () => { current = false; };
  }, [flow.id, attempt]);

  const when = (iso) => new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

  return (
    <div className={PAGE_FRAME}>
      <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2.5">
            <Badge tone={flow.status === "Live" ? "good" : flow.status === "Scheduled" ? "warn" : "neutral"}>{flow.status}</Badge>
            <span className="text-sm text-muted">Results</span>
          </div>
          <h1 className="mt-2 truncate text-[30px] leading-tight font-bold tracking-[-0.03em] text-ink">{flow.name}</h1>
        </div>
        {data?.calls > 0 && (
          <a href={api.exportUrl(flow.id)} download
             className="inline-flex h-10 items-center gap-2 rounded-full border border-edge bg-white px-4 text-[14px] font-semibold text-ink hover:bg-hover">
            <Download aria-hidden="true" className="size-4" strokeWidth={2} />Export CSV
          </a>
        )}
      </header>

      {problem && <ErrorNote onRetry={() => setAttempt((now) => now + 1)}>{problem}</ErrorNote>}
      {!data && !problem && (
        <div role="status" aria-label="Loading the results">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {[0, 1, 2, 3].map((one) => <Skeleton key={one} className="h-[136px] rounded-3xl" />)}
          </div>
          <div className="mt-8 grid gap-4 lg:grid-cols-2">
            {[0, 1].map((one) => <Skeleton key={one} className="h-44 rounded-3xl" />)}
          </div>
        </div>
      )}

      {data && data.calls === 0 && (
        <EmptyState icon={PhoneCall} title="No real calls yet"
                    action={<Button variant="secondary" onClick={onTest}>Try it yourself</Button>}>
          Answers from real calls appear here. Calls you make while testing are kept in History and don’t count.
        </EmptyState>
      )}

      {data && data.calls > 0 && (
        <>
          <Headline data={data} />
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard icon={PhoneCall} tone="blue" label="Calls" value={data.calls}
                      sub={data.last_call ? `last ${ago(data.last_call).toLowerCase()}` : ""}
                      trend={data.daily?.map((one) => one.calls)} trendColor="#2563eb" />
            <StatCard icon={CheckCircle2} tone="green" label="Completed" value={`${percent(data.completed, data.calls)}%`}
                      sub={`${data.completed} of ${data.calls}`} valueClass="text-good"
                      trend={data.daily?.map((one) => one.completed)} trendColor="#059669" />
            <StatCard icon={Timer} tone="amber" label="Average call" value={clock(data.average_seconds)} sub="minutes : seconds" />
            <StatCard icon={Users} tone="violet" label="Still to call"
                      value={data.audience?.people ? data.audience.waiting : "—"}
                      sub={data.audience?.people ? `of ${data.audience.people} in its groups` : "no groups picked"} />
          </div>

          <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
            <Card className="p-5 sm:p-6">
              <h2 className="text-base font-semibold text-ink">Calls, last 14 days</h2>
              <p className="mt-0.5 text-[13px] text-muted">The solid part of each bar is the calls that were completed.</p>
              <div className="mt-5"><DayBars days={data.daily} height={132} /></div>
            </Card>
            <Card className="flex flex-col justify-center gap-5 p-5 sm:p-6">
              <div className="flex items-center gap-5">
                <Ring percent={percent(data.completed, data.calls)} label="completed" />
                <div className="text-[13px] leading-snug">
                  <p className="font-semibold text-ink">{data.completed} of {data.calls} calls reached the end</p>
                  <p className="mt-1 text-muted">{data.calls - data.completed} ended early.</p>
                </div>
              </div>
              {data.audience?.people > 0 && (
                <div>
                  <p className="mb-2 flex items-center justify-between text-[13px] font-semibold text-ink">
                    <span>{data.audience.called} of {data.audience.people} people called</span>
                    <span className="font-mono text-xs font-medium text-muted tabular-nums">{percent(data.audience.called, data.audience.people)}%</span>
                  </p>
                  <Meter percent={percent(data.audience.called, data.audience.people)} tone="bg-brand" />
                </div>
              )}
            </Card>
          </div>

          <h2 className="mt-9 mb-3 text-lg font-semibold tracking-[-0.01em] text-ink">Answers</h2>
          <div className="grid gap-4 lg:grid-cols-2">
            {data.questions.map((one) => <QuestionResult key={one.save_as} one={one} />)}
          </div>

          <h2 className="mt-9 mb-3 text-lg font-semibold tracking-[-0.01em] text-ink">Recent calls</h2>
          <Card as="div" className="overflow-hidden">
            <ul className="divide-y divide-line">
              {data.recent.map((call) => (
                <li key={call.call} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3.5 text-[13px] transition-colors hover:bg-hover/70">
                  <span aria-hidden="true" className="grid size-8 shrink-0 place-items-center rounded-full bg-brand-soft text-[11px] font-bold text-brand-ink">
                    {initials(call.customer?.name)}
                  </span>
                  <span className="w-36 shrink-0 truncate font-semibold text-ink">{call.customer?.name || "Unknown"}</span>
                  <span className="w-28 shrink-0 text-muted">{when(call.at)}</span>
                  <Badge tone={call.outcome === "completed" ? "good" : "warn"}>{call.outcome === "completed" ? "Completed" : "Incomplete"}</Badge>
                  <span className={cn("min-w-0 flex-[1_1_220px] truncate", call.summary ? "text-body" : "text-faint")}>
                    {call.summary || "No summary"}
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        </>
      )}
    </div>
  );
}
