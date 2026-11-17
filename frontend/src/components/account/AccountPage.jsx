import { Gauge, KeyRound, LineChart, ShieldCheck, Users } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import * as api from "../../lib/api.js";
import { cn } from "../../lib/cn.js";
import { Page } from "../layout/Page.jsx";
import { ErrorNote, Skeleton } from "../ui/States.jsx";
import { Admin } from "./Admin.jsx";
import { Keys } from "./Keys.jsx";
import { Overview } from "./Overview.jsx";
import { Security } from "./Security.jsx";
import { Usage } from "./Usage.jsx";

const TABS = [
  ["overview", "Overview", Gauge],
  ["usage", "Usage", LineChart],
  ["keys", "API keys", KeyRound],
  ["security", "Security", ShieldCheck],
];

/** Who you are, what you have used, and whose keys pay for it. One section at a time. */
export function AccountPage({ flows, onUser, onSignedOut }) {
  const [tab, setTab] = useState("overview");
  const [data, setData] = useState(null);
  const [problem, setProblem] = useState("");

  const load = useCallback(() => {
    api.account().then((found) => { setData(found); onUser?.(found.user); setProblem(""); })
      .catch((failure) => setProblem(failure.message));
  }, [onUser]);
  useEffect(load, [load]);

  const tabs = data?.user.is_admin ? [...TABS, ["admin", "Accounts", Users]] : TABS;

  return (
    <Page title="Account" subtitle={data ? `${data.user.name || data.user.email}${data.user.name ? ` · ${data.user.email}` : ""}` : " "}>
      {problem ? (
        <ErrorNote onRetry={load}>{problem}</ErrorNote>
      ) : !data ? (
        <div role="status" aria-label="Loading" className="grid gap-4"><Skeleton className="h-12 w-80" /><Skeleton className="h-48 rounded-3xl" /></div>
      ) : (
        <>
          <nav aria-label="Account sections" className="mb-6 flex flex-wrap gap-1.5">
            {tabs.map(([id, label, Icon]) => (
              <button key={id} type="button" onClick={() => setTab(id)} aria-current={tab === id ? "page" : undefined}
                      className={cn("inline-flex h-10 items-center gap-2 rounded-full px-4 text-[14px] font-semibold transition-colors",
                                    tab === id ? "bg-brand-soft text-brand-ink" : "text-muted hover:bg-fill hover:text-ink")}>
                <Icon aria-hidden="true" className="size-4" strokeWidth={2} /> {label}
              </button>
            ))}
          </nav>
          {tab === "overview" && <Overview data={data} onGo={setTab} />}
          {tab === "usage" && <Usage flows={flows} />}
          {tab === "keys" && <Keys data={data} onChange={(keys) => setData((now) => ({ ...now, keys }))} />}
          {tab === "security" && <Security data={data} onReload={load} onSignedOut={onSignedOut} />}
          {tab === "admin" && <Admin me={data.user} />}
        </>
      )}
    </Page>
  );
}
