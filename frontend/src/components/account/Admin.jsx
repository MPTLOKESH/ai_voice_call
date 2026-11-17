import { useCallback, useEffect, useState } from "react";
import * as api from "../../lib/api.js";
import { usd } from "../../lib/money.js";
import { Badge } from "../ui/Badge.jsx";
import { Button } from "../ui/Button.jsx";
import { Card } from "../ui/Card.jsx";
import { Meter } from "../ui/Insight.jsx";
import { ErrorNote, Skeleton } from "../ui/States.jsx";
import { useToast } from "../ui/Toasts.jsx";

function Row({ one, fallback, mine, onChanged }) {
  const toast = useToast();
  const [allowance, setAllowance] = useState(one.allowance ?? "");
  const [busy, setBusy] = useState(false);
  const limit = one.allowance ?? fallback;
  const changed = String(allowance) !== String(one.allowance ?? "");

  async function change(changes, message) {
    setBusy(true);
    try { await api.adminChange(one.id, changes); toast(message); onChanged(); } catch (failure) { toast(failure.message, "bad"); }
    setBusy(false);
  }

  return (
    <li className="grid items-center gap-x-4 gap-y-2 px-5 py-4 md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_auto]">
      <div className="min-w-0">
        <p className="flex items-center gap-2 truncate text-[14px] font-semibold text-ink">
          {one.name || one.email}
          {one.is_admin && <Badge tone="brand">You run this</Badge>}
          {one.disabled && <Badge tone="bad">Off</Badge>}
          {!one.verified && <Badge tone="warn">Email not confirmed</Badge>}
        </p>
        <p className="truncate text-[13px] text-muted">{one.email}</p>
      </div>
      <div>
        <p className="mb-1.5 text-[12px] text-muted tabular-nums">{usd(one.spent)} of {usd(limit)} on our keys this month</p>
        <Meter percent={limit ? (one.spent / limit) * 100 : 100} tone={one.spent >= limit ? "bg-bad" : "bg-brand"} />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <label className="sr-only" htmlFor={`allowance-${one.id}`}>Monthly allowance in dollars</label>
        <input id={`allowance-${one.id}`} type="number" min="0" step="0.5" inputMode="decimal" value={allowance} placeholder={`${fallback} (default)`}
               onChange={(event) => setAllowance(event.target.value)}
               className="h-9 w-28 rounded-xl border border-edge px-3 text-[13px] focus:border-brand focus:ring-3 focus:ring-brand/15 focus:outline-none" />
        <Button size="sm" variant="secondary" disabled={busy || !changed} onClick={() => change({ allowance: allowance === "" ? null : Number(allowance) }, "Allowance saved.")}>Set</Button>
        {!mine && (
          <Button size="sm" variant={one.disabled ? "secondary" : "danger"} disabled={busy}
                  onClick={() => change({ disabled: !one.disabled }, one.disabled ? "Account turned on." : "Account turned off, and signed out.")}>
            {one.disabled ? "Turn on" : "Turn off"}
          </Button>
        )}
      </div>
    </li>
  );
}

/** Only for the person running the server: who is spending the server's keys, and how much each may. */
export function Admin({ me }) {
  const [data, setData] = useState(null);
  const [problem, setProblem] = useState("");
  const load = useCallback(() => {
    api.adminUsers().then((found) => { setData(found); setProblem(""); }).catch((failure) => setProblem(failure.message));
  }, []);
  useEffect(load, [load]);

  if (problem) return <ErrorNote onRetry={load}>{problem}</ErrorNote>;
  if (!data) return <Skeleton className="h-64 rounded-3xl" />;
  const total = data.users.reduce((sum, one) => sum + one.spent, 0);
  return (
    <Card className="overflow-hidden">
      <div className="border-b border-line px-5 py-4">
        <h2 className="text-[16px] font-semibold text-ink">Accounts</h2>
        <p className="mt-0.5 text-[13px] text-muted">
          {data.users.length} {data.users.length === 1 ? "account" : "accounts"}, {usd(total)} spent on the server's keys this month.
          Blank means the default of {usd(data.default_allowance)}.
        </p>
      </div>
      <ul className="divide-y divide-line">
        {data.users.map((one) => <Row key={one.id} one={one} fallback={data.default_allowance} mine={one.id === me.id} onChanged={load} />)}
      </ul>
    </Card>
  );
}
