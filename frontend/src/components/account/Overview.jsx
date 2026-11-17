import { Cpu, Mail, Mic, Receipt, Volume2 } from "lucide-react";
import { useEffect, useState } from "react";
import * as api from "../../lib/api.js";
import { minutes, short, usd } from "../../lib/money.js";
import { Button } from "../ui/Button.jsx";
import { Card } from "../ui/Card.jsx";
import { Meter, StatCard } from "../ui/Insight.jsx";
import { useToast } from "../ui/Toasts.jsx";

const WHEN = new Intl.DateTimeFormat(undefined, { month: "long", day: "numeric" });

export function Overview({ data, onGo }) {
  const toast = useToast();
  const { user, plan, keys } = data;
  const [month, setMonth] = useState(null);
  const [sending, setSending] = useState(false);

  useEffect(() => { api.accountUsage(30).then(setMonth).catch(() => setMonth(false)); }, []);

  const share = plan.allowance ? Math.min(100, (plan.used / plan.allowance) * 100) : 100;
  const tone = share >= 100 ? "bg-bad" : share >= 80 ? "bg-amber" : "bg-brand";
  const totals = month?.totals;

  async function resend() {
    setSending(true);
    try { await api.resendVerification(); toast("Sent. Check your email."); } catch (failure) { toast(failure.message, "bad"); }
    setSending(false);
  }

  return (
    <div className="grid gap-5">
      {!user.verified && (
        <Card className="flex flex-wrap items-center gap-4 border-amber/40 bg-[#fff9ec] p-5">
          <Mail aria-hidden="true" className="size-5 text-amber" />
          <p className="min-w-0 flex-1 text-[14px] text-ink">
            <strong>Confirm your email</strong> to use our keys. We sent a link to {user.email}. Your own keys work meanwhile.
          </p>
          <Button variant="secondary" size="sm" onClick={resend} disabled={sending}>Send it again</Button>
        </Card>
      )}

      <Card className="p-6">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-[16px] font-semibold text-ink">Free allowance this month</h2>
          <span className="text-[13px] text-muted">Resets {WHEN.format(new Date(plan.resets))}</span>
        </div>
        <p className="mt-4 text-[32px] leading-none font-bold tracking-[-0.03em] tabular-nums text-ink">
          {usd(plan.left)} <span className="text-[15px] font-medium tracking-normal text-muted">left of {usd(plan.allowance)}</span>
        </p>
        <Meter percent={share} tone={tone} className="mt-4 h-3" />
        <p className="mt-3 text-[13px] leading-relaxed text-muted">
          {share >= 100
            ? "You have used it all. Add your own keys to carry on, or wait for it to reset."
            : share >= 80 ? "Nearly used up. Your own keys have no allowance to run out of."
              : "This counts only what runs on our keys, and is estimated from the providers' prices. Using your own keys is not counted."}
        </p>
        {share >= 80 && <Button variant="brand" size="sm" className="mt-4" onClick={() => onGo("keys")}>Add your own keys</Button>}
      </Card>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard icon={Receipt} tone="violet" label="Spend, 30 days" value={totals ? usd(totals.cost) : "…"}
                  sub={totals ? `${usd(totals.ours)} ours · ${usd(totals.own)} yours` : ""} trend={month?.daily?.map((one) => one.ours + one.own)} />
        <StatCard icon={Cpu} tone="blue" label="Thinking" value={totals ? short(totals.tokens) : "…"} sub="tokens" />
        <StatCard icon={Volume2} tone="green" label="Speaking" value={totals ? short(totals.characters) : "…"} sub="characters" />
        <StatCard icon={Mic} tone="amber" label="Hearing" value={totals ? minutes(totals.seconds) : "…"} sub="of audio" />
      </div>

      <Card className="p-6">
        <h2 className="text-[16px] font-semibold text-ink">Whose keys are paying</h2>
        <ul className="mt-3 divide-y divide-line">
          {Object.entries(keys).map(([service, one]) => (
            <li key={service} className="flex flex-wrap items-center gap-3 py-3">
              <span className="w-28 text-[14px] font-semibold text-ink">{one.label}</span>
              <span className="min-w-0 flex-1 text-[14px] text-body">
                {one.mode === "own" ? <>Your own key <span className="font-mono text-muted">····{one.last4}</span></> : "Our key, from your allowance"}
              </span>
              <Button variant="ghost" size="sm" onClick={() => onGo("keys")}>Change</Button>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
