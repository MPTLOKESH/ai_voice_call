import { AudioWaveform, BarChart3, Cpu, History, LayoutGrid, LogOut, Mic, Phone, Plus, UserRound, Users, Volume2 } from "lucide-react";
import { cn } from "../../lib/cn.js";
import { Menu } from "../ui/Menu.jsx";

export const PAGES = [
  { id: "drafts", path: "/", label: "Flows", icon: LayoutGrid },
  { id: "contacts", path: "/contacts", label: "Contacts", icon: Users },
  { id: "history", path: "/history", label: "History", icon: History },
  // The pages of one flow (Build, Test, Send, Results) are reached from the bar across the top of a flow, and
  // the voices from its settings: none has a place of its own in the rail.
  { id: "studio", path: "/studio", label: "Build", icon: AudioWaveform, hidden: true },
  { id: "call", path: "/call", label: "Test", icon: Phone, hidden: true },
  { id: "results", path: "/results", label: "Results", icon: BarChart3, hidden: true },
  { id: "voices", path: "/voices", label: "Voices", icon: Mic, hidden: true },
  { id: "account", path: "/account", label: "Account", icon: UserRound, hidden: true },
];

/** Which rail item a page belongs under: every page of a flow sits under Flows. */
export const railItem = (page) => (["studio", "call", "results", "voices"].includes(page) ? "drafts" : page);

function PageLink({ page, active, callLive, onNavigate, className, children }) {
  return (
    <a href={page.path} onClick={(event) => { event.preventDefault(); onNavigate(page.id); }}
       aria-current={active ? "page" : undefined} className={className}>
      {children}
      {page.id === "drafts" && callLive && <span className="sr-only">(call in progress)</span>}
    </a>
  );
}

const LiveDot = ({ className }) => (
  <span className={cn("relative flex size-2", className)}>
    <span className="absolute inset-0 rounded-full bg-live motion-safe:animate-pulse-ring" />
    <span className="relative size-2 rounded-full bg-live ring-2 ring-white" />
  </span>
);

/** The mark at the top of the rail: a dot and a line, the start of a thread. */
const Mark = () => (
  <div className="mb-2.5 flex size-[38px] items-center justify-center gap-[3px] rounded-xl bg-ink">
    <span className="size-[7px] rounded-full bg-white" />
    <span className="h-[3px] w-3.5 rounded-sm bg-white" />
  </div>
);

/**
 * The rail down the left on wide screens: the mark, the add button, the pages, and who is calling with the
 * services in use behind them. On phones the pages move to a tab bar along the bottom.
 */
export function Rail({ page, onNavigate, assistant, callLive, onNewFlow, model, speech, user, onSignOut, onAccount }) {
  const initial = ((user?.name || user?.email || assistant || "A")[0]).toUpperCase();

  return (
    <>
      <nav aria-label="Pages"
           className="hidden w-[76px] shrink-0 flex-col items-center gap-1 border-r border-line bg-white py-3 lg:flex">
        <Mark />
        <button type="button" onClick={onNewFlow} aria-label="New flow" title="Start a new flow"
                className="mb-3 grid size-10 place-items-center rounded-full bg-brand text-white shadow-[0_4px_12px_rgb(110_76_245/0.35)] transition-colors hover:bg-brand-hover">
          <Plus aria-hidden="true" className="size-[18px]" strokeWidth={2.4} />
        </button>

        {PAGES.filter((one) => !one.hidden).map((one) => {
          const active = page === one.id;
          const Icon = one.icon;
          return (
            <PageLink key={one.id} page={one} active={active} callLive={callLive} onNavigate={onNavigate}
                      className={cn("group flex w-16 flex-col items-center gap-1 py-1.5 text-[11px] font-medium transition-colors",
                                    active ? "text-brand" : "text-muted hover:text-ink")}>
              <span className={cn("relative grid h-8 w-10 place-items-center rounded-[10px] transition-colors",
                                  active ? "bg-brand-soft" : "group-hover:bg-fill")}>
                <Icon aria-hidden="true" className="size-5" strokeWidth={1.8} />
                {one.id === "drafts" && callLive && <LiveDot className="absolute top-0 right-0.5" />}
              </span>
              {one.label}
            </PageLink>
          );
        })}

        <div className="flex-1" />

        <Menu label="Who is calling, and the services in use" side="beside"
              buttonClassName="grid size-[34px] place-items-center rounded-full bg-gradient-to-br from-[#f3dcc4] to-[#e8805c] text-[12px] font-semibold text-ink"
              trigger={initial}>
          {user && (
            <div className="border-b border-line px-2.5 pt-1.5 pb-2.5">
              {user.name && <p className="truncate text-[14px] font-semibold text-ink">{user.name}</p>}
              <p className="truncate text-[13px] text-muted">{user.email}</p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                <button type="button" onClick={onAccount}
                        className="inline-flex items-center gap-1.5 rounded-full bg-brand-soft px-3 py-1.5 text-[13px] font-medium text-brand-ink transition-colors hover:bg-[#e6dfff]">
                  <UserRound aria-hidden="true" className="size-3.5" strokeWidth={2} /> Account
                </button>
                <button type="button" onClick={onSignOut}
                        className="inline-flex items-center gap-1.5 rounded-full bg-fill px-3 py-1.5 text-[13px] font-medium text-ink transition-colors hover:bg-active">
                  <LogOut aria-hidden="true" className="size-3.5" strokeWidth={2} /> Sign out
                </button>
              </div>
            </div>
          )}
          <p className="px-2.5 pt-2 pb-1 text-[11px] font-medium tracking-wide text-faint uppercase">Services in use</p>
          <dl>
            {[[Cpu, "Thinking", model || "—"], [Volume2, "Hearing · speaking", speech || "Shown once a call starts"]]
              .map(([Icon, label, value]) => (
                <div key={label} className="flex items-start gap-2.5 px-2.5 py-2">
                  <Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted" strokeWidth={1.75} />
                  <div className="min-w-0">
                    <dt className="text-xs text-muted">{label}</dt>
                    <dd className="truncate font-mono text-[13px] text-ink">{value}</dd>
                  </div>
                </div>
              ))}
          </dl>
        </Menu>
      </nav>

      <nav aria-label="Pages"
           className="glass fixed inset-x-0 bottom-0 z-30 border-t border-line pb-[env(safe-area-inset-bottom)] lg:hidden">
        <ul className="mx-auto grid h-14 max-w-lg grid-cols-3">
          {PAGES.filter((one) => !one.hidden).map((one) => {
            const active = page === one.id;
            const Icon = one.icon;
            return (
              <li key={one.id}>
                <PageLink page={one} active={active} callLive={callLive} onNavigate={onNavigate}
                          className={cn("flex h-full flex-col items-center justify-center gap-1 text-[11px] font-medium transition-colors",
                                        active ? "text-brand" : "text-muted hover:text-ink")}>
                  <span className="relative">
                    <Icon aria-hidden="true" className="size-5" strokeWidth={active ? 2 : 1.6} />
                    {one.id === "drafts" && callLive && <LiveDot className="absolute -top-0.5 -right-1" />}
                  </span>
                  {one.label}
                </PageLink>
              </li>
            );
          })}
        </ul>
      </nav>
    </>
  );
}
