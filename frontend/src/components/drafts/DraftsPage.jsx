import {
  ArrowRight, BarChart3, CalendarClock, CheckCircle2, Copy, FilePenLine, Filter, Flag, LayoutGrid, List, MessageSquare, MoreHorizontal, Pencil,
  Phone, PhoneCall, PhoneOff, Plus, Radio, Search, Timer, Trash2, Undo2, Users, Workflow,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import * as api from "../../lib/api.js";
import { cn } from "../../lib/cn.js";
import { clock, estimateSeconds } from "../../lib/thread.js";
import { ago, dayAndTime } from "../../lib/time.js";
import { TEMPLATES } from "../../lib/templates.js";
import { PAGE_FRAME } from "../layout/Page.jsx";
import { Button } from "../ui/Button.jsx";
import { Card, IconTile } from "../ui/Card.jsx";
import { ConfirmDialog, Dialog } from "../ui/Dialog.jsx";
import { Select, TextInput } from "../ui/fields.jsx";
import { DayBars, Meter, StatCard } from "../ui/Insight.jsx";
import { Menu } from "../ui/Menu.jsx";
import { RowBox, SelectAll, SelectionBar } from "../ui/SelectionBar.jsx";
import { useSelection } from "../../lib/useSelection.js";
import { EmptyState, ErrorNote, Skeleton } from "../ui/States.jsx";
import { GettingStarted } from "./GettingStarted.jsx";
import { useToast } from "../ui/Toasts.jsx";

const TABS = ["All", "Draft", "Live", "Scheduled"];
const STATUS = {
  Live: "bg-good-soft text-good",
  Draft: "bg-fill text-body",
  Scheduled: "bg-warn-soft text-warn",
};
// The wash behind a flow's picture says where it stands before the badge is read.
const PREVIEW = {
  Live: "bg-[linear-gradient(135deg,#eafaf1,#f6fdf9)]",
  Draft: "bg-[linear-gradient(135deg,#f3f1ff,#faf9ff)]",
  Scheduled: "bg-[linear-gradient(135deg,#fff4e6,#fffaf4)]",
  Due: "bg-[linear-gradient(135deg,#ffeceb,#fff8f7)]",
};
const SORTS = [["edited", "Recently edited"], ["name", "Name"], ["calls", "Most calls"]];
const MAX_NODES = 4;

// How the flows are laid out is remembered, but only as a convenience: storage can be off.
const VIEW_KEY = "voice-call-drafts-view";
const savedView = () => { try { return localStorage.getItem(VIEW_KEY) === "list" ? "list" : "grid"; } catch { return "grid"; } };

/** A scheduled flow whose time has come and gone: nothing sends it yet, so it is due rather than scheduled. */
const isDue = (flow) => flow.status === "Scheduled" && flow.scheduled_for && new Date(flow.scheduled_for) < new Date();

const percent = (part, whole) => (whole ? `${Math.round((part / whole) * 100)}%` : "—");

/** How many of a flow's steps are questions (the rest are messages and ends). */
const askCount = (flow) => flow.setup.questions.filter((one) => (one.kind || "ask") === "ask").length;

/** A flow drawn small: where the call starts, its steps (questions numbered), and where it ends. */
function MiniFlow({ steps }) {
  const shown = steps.slice(0, MAX_NODES);
  const hidden = steps.length - shown.length;
  let asked = 0;
  const nodes = [
    { id: "start", icon: Phone, className: "bg-good text-white" },
    ...shown.map((step, at) => {
      const kind = step.kind || "ask";
      if (kind === "ask") { asked += 1; return { id: at, label: asked, className: "bg-[#d3efdf] text-good ring-1 ring-good/15" }; }
      if (kind === "say") return { id: at, icon: MessageSquare, className: "bg-brand-soft text-brand ring-1 ring-brand/15" };
      return { id: at, icon: Flag, className: "bg-loop-soft text-loop ring-1 ring-loop/15" };
    }),
    ...(hidden > 0 ? [{ id: "more", label: `+${hidden}`, className: "bg-fill text-muted" }] : []),
    { id: "end", icon: PhoneOff, className: "bg-bad text-white" },
  ];
  return (
    <div aria-hidden="true" className="flex h-full items-center px-5 pt-5">
      {nodes.map((node, at) => (
        <div key={node.id} className={cn("flex items-center", at > 0 && "min-w-0 flex-1")}>
          {at > 0 && <span className="h-0.5 min-w-1 flex-1 bg-edge" />}
          <span className={cn("grid size-7 shrink-0 place-items-center rounded-[9px] text-xs font-bold shadow-[0_1px_2px_rgb(17_17_20/0.08)]", node.className)}>
            {node.icon ? <node.icon className="size-3.5" strokeWidth={2.2} /> : node.label}
          </span>
        </div>
      ))}
    </div>
  );
}

function StatusBadges({ flow }) {
  const live = flow.status !== "Draft";
  return (
    <span className="flex flex-wrap gap-1.5">
      <span className={cn("rounded-full px-[9px] py-[3px] text-[11px] font-semibold", isDue(flow) ? "bg-bad-soft text-bad" : STATUS[flow.status])}>
        {isDue(flow) ? "Due" : flow.status}
      </span>
      {live && flow.unpublished_changes && (
        <span title="Edited since it was published. Customers still get the published version."
              className="rounded-full bg-white px-[9px] py-[3px] text-[11px] font-semibold text-warn ring-1 ring-line">Unpublished changes</span>
      )}
    </span>
  );
}

const greeting = () => {
  const hour = new Date().getHours();
  return hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
};

/** What needs a person: flows past their time, flows edited since they were published, and drafts not yet sent. */
function attentionList(flows) {
  const items = [];
  flows.filter(isDue).forEach((flow) => items.push({
    id: `due-${flow.id}`, flow, tone: "rose", icon: CalendarClock, act: "publish",
    title: `${flow.name} is due`, note: `It was set for ${dayAndTime(flow.scheduled_for)} and has not gone out.`,
  }));
  flows.filter((flow) => flow.status !== "Draft" && flow.unpublished_changes).forEach((flow) => items.push({
    id: `changes-${flow.id}`, flow, tone: "amber", icon: FilePenLine, act: "publish",
    title: `${flow.name} has unpublished changes`, note: "Customers still get the version you published.",
  }));
  flows.filter((flow) => flow.status === "Draft").slice(0, 3).forEach((flow) => items.push({
    id: `draft-${flow.id}`, flow, tone: "violet", icon: Workflow, act: "edit",
    title: `Finish ${flow.name}`, note: `A draft, last edited ${ago(flow.edited).toLowerCase()}.`,
  }));
  return items;
}

/** The week at a glance: calls per day, and what to do next. */
function Overview({ days, items, onAct }) {
  const total = days.reduce((sum, one) => sum + one.calls, 0);
  return (
    <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
      <Card className="p-5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-ink">Calls this week</h2>
            <p className="mt-0.5 text-[13px] text-muted">
              {total ? `${total} ${total === 1 ? "call" : "calls"} in the last 7 days` : "Nothing yet. Calls show up here as they are made."}
            </p>
          </div>
          <div className="flex items-center gap-3 text-xs text-muted">
            <span className="flex items-center gap-1.5"><span className="size-2.5 rounded-full bg-brand" />Completed</span>
            <span className="flex items-center gap-1.5"><span className="size-2.5 rounded-full bg-brand-soft ring-1 ring-brand/20" />Not finished</span>
          </div>
        </div>
        <div className="mt-5"><DayBars days={days} /></div>
      </Card>

      <Card className="flex flex-col p-5 sm:p-6">
        <h2 className="text-base font-semibold text-ink">Needs your attention</h2>
        {items.length === 0 ? (
          <div className="grid flex-1 place-items-center py-6 text-center">
            <div>
              <span className="mx-auto mb-3 grid size-11 place-items-center rounded-full bg-good-soft text-good"><CheckCircle2 aria-hidden="true" className="size-5" strokeWidth={1.8} /></span>
              <p className="text-sm font-semibold text-ink">All caught up</p>
              <p className="mt-0.5 text-[13px] text-muted">Nothing is waiting on you.</p>
            </div>
          </div>
        ) : (
          <ul className="mt-3 -mx-2 flex flex-col">
            {items.slice(0, 4).map((one) => (
              <li key={one.id}>
                <button type="button" onClick={() => onAct(one)}
                        className="group flex w-full items-center gap-3 rounded-2xl px-2 py-2.5 text-left transition-colors hover:bg-hover">
                  <IconTile icon={one.icon} tone={one.tone} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-semibold text-ink">{one.title}</span>
                    <span className="block truncate text-xs text-muted">{one.note}</span>
                  </span>
                  <ArrowRight aria-hidden="true" className="size-4 shrink-0 text-faint transition-transform group-hover:translate-x-0.5 group-hover:text-ink" strokeWidth={2} />
                </button>
              </li>
            ))}
          </ul>
        )}
        {items.length > 4 && <p className="mt-2 text-xs text-faint">and {items.length - 4} more</p>}
      </Card>
    </div>
  );
}

/** Naming (or renaming) a flow. */
function RenameDialog({ flow, onClose, onRename }) {
  const [name, setName] = useState(flow.name);
  return (
    <Dialog title="Rename flow" onClose={onClose}>
      <form onSubmit={(event) => { event.preventDefault(); onRename(name.trim()); onClose(); }}>
        <div className="px-6 py-3">
          <TextInput aria-label="Flow name" value={name} onChange={(event) => setName(event.target.value)} />
        </div>
        <div className="flex justify-end gap-2 px-6 pt-2 pb-[22px]">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" disabled={!name.trim() || name.trim() === flow.name}>Rename</Button>
        </div>
      </form>
    </Dialog>
  );
}

/** Where a new flow starts: nothing, or something close to what is usually asked. */
function NewFlowDialog({ onClose, onPick }) {
  return (
    <Dialog title="New flow" subtitle="Start from a template, or a blank page." onClose={onClose} className="w-[620px]">
      <div className="grid gap-2.5 px-6 pt-3 pb-6 sm:grid-cols-2">
        {TEMPLATES.map((one) => (
          <button key={one.id} type="button" onClick={() => { onPick(one); onClose(); }}
                  className="flex flex-col gap-1 rounded-2xl border border-line p-4 text-left transition-colors hover:border-brand hover:bg-brand-wash">
            <span className="text-sm font-semibold text-ink">{one.name}</span>
            <span className="text-[13px] leading-snug text-muted">{one.blurb}</span>
            <span className="mt-1 text-xs text-faint">
              {one.questions.length ? `${one.questions.length} questions` : "No questions yet"}
            </span>
          </button>
        ))}
      </div>
    </Dialog>
  );
}

/**
 * Every flow: how it is doing, who it goes to, and what can be done with it. A flow is a setup with a name.
 * `onEdit(id)`, `onPublish(id)`, `onResults(id)` open the flow elsewhere; the rest is done here.
 */
export function DraftsPage({ flows, voices, activeBusiness, onEdit, onNew, onPublish, onDelete, onDeleteMany, onResults, onStored, onNavigate }) {
  const toast = useToast();
  const [tab, setTab] = useState("All");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState("edited");
  const [view, setView] = useState(savedView);
  const [numbers, setNumbers] = useState(null);     // {flows, week}
  const [statsProblem, setStatsProblem] = useState("");
  const [groups, setGroups] = useState([]);
  const [dialog, setDialog] = useState(null);       // {kind: "new" | "rename" | "delete", flow}

  useEffect(() => {
    loadNumbers();
    api.groups().then((found) => setGroups(found.groups)).catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /** The calls made, for the numbers on top and the line on each flow. A failure says so rather than showing zeros. */
  function loadNumbers() {
    setStatsProblem("");
    api.stats().then(setNumbers).catch((failure) => setStatsProblem(failure.message));
  }

  const chooseView = (next) => {
    setView(next);
    try { localStorage.setItem(VIEW_KEY, next); } catch { /* not worth a message */ }
  };

  const of = (flow) => numbers?.flows[flow.id] || { calls: 0, completed: 0, average_seconds: 0 };
  const voiceOf = (flow) => {
    const found = voices.find((voice) => voice.id === flow.setup.voice_id)?.name;
    return found ? found.split(" - ")[0] : flow.setup.assistant_name;
  };
  const groupNames = (flow) => (flow.groups || []).map((id) => groups.find((group) => group.id === id)?.name).filter(Boolean);

  const shown = useMemo(() => {
    const term = search.trim().toLowerCase();
    const list = flows.filter((flow) => (tab === "All" || flow.status === tab) && (!term || flow.name.toLowerCase().includes(term)));
    const by = {
      edited: (a, b) => (b.edited || "").localeCompare(a.edited || ""),
      name: (a, b) => a.name.localeCompare(b.name),
      calls: (a, b) => (numbers?.flows[b.id]?.calls || 0) - (numbers?.flows[a.id]?.calls || 0),
    }[sort];
    return [...list].sort(by);
  }, [flows, tab, search, sort, numbers]);

  const shownIds = useMemo(() => shown.map((flow) => flow.id), [shown]);
  const selection = useSelection(shownIds, "flows");

  const counts = useMemo(() => ({
    live: flows.filter((flow) => flow.status === "Live").length,
    scheduled: flows.filter((flow) => flow.status === "Scheduled").length,
    draft: flows.filter((flow) => flow.status === "Draft").length,
  }), [flows]);

  async function run(job, message) {
    try {
      const result = await job();
      if (message) toast(message);
      return result;
    } catch (failure) {
      toast(failure.message, "bad");
      return null;
    }
  }

  const duplicate = (flow) => run(async () => onStored(await api.duplicateFlow(flow.id)), `Duplicated as “${flow.name} (copy)”.`);
  const unpublish = (flow) => run(async () => onStored(await api.unpublishFlow(flow.id)), `${flow.name} is a draft again.`);
  const rename = (flow, name) => run(async () => {
    onStored(await api.saveFlow(flow.id, { name, setup: flow.setup, version: flow.version }));
  }, "Renamed.");

  const week = numbers?.week;
  const days = numbers?.daily;
  const attention = useMemo(() => attentionList(flows), [flows]);
  // While the numbers are on their way a grey block stands in; if they could not come, a dash.
  const waiting = statsProblem ? "—" : <Skeleton className="my-1 h-6 w-14" />;
  const Item = ({ icon: Icon, danger, children, ...props }) => (
    <button type="button" {...props}
            className={cn("flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left text-[13px] font-medium transition-colors",
                          danger ? "text-bad hover:bg-bad-soft" : "text-ink hover:bg-fill")}>
      <Icon aria-hidden="true" className="size-4 shrink-0" strokeWidth={1.8} />{children}
    </button>
  );

  const menu = (flow) => (
    <Menu label={`More for ${flow.name}`} className="w-52"
          trigger={<MoreHorizontal aria-hidden="true" className="size-[18px]" strokeWidth={2} />}
          buttonClassName="grid size-8 place-items-center rounded-full text-faint transition hover:bg-fill hover:text-ink">
      <Item icon={Pencil} onClick={() => setDialog({ kind: "rename", flow })}>Rename</Item>
      <Item icon={Copy} onClick={() => duplicate(flow)}>Duplicate</Item>
      {flow.status !== "Draft" && <Item icon={Undo2} onClick={() => unpublish(flow)}>Back to draft</Item>}
      <Item icon={Trash2} danger onClick={() => setDialog({ kind: "delete", flow })}>Delete</Item>
    </Menu>
  );

  /** Calls made, and how many were finished, in a line. */
  const callsLine = (flow) => {
    const one = of(flow);
    if (!numbers) return "";
    return one.calls ? `${one.calls} ${one.calls === 1 ? "call" : "calls"} · ${percent(one.completed, one.calls)} completed` : "No calls yet";
  };

  const chips = (flow) => {
    const names = groupNames(flow);
    return (
      <div className="flex min-h-[22px] flex-wrap gap-1.5">
        {flow.channels.map((channel) => (
          <span key={channel} className="rounded-full bg-fill px-[9px] py-0.5 text-xs font-medium text-body">{channel}</span>
        ))}
        {names.slice(0, 2).map((name) => (
          <span key={name} className="flex items-center gap-1 rounded-full bg-brand-soft px-[9px] py-0.5 text-xs font-medium text-brand-ink">
            <Users aria-hidden="true" className="size-3" strokeWidth={2} />{name}
          </span>
        ))}
        {names.length > 2 && <span className="py-0.5 text-xs text-faint">+{names.length - 2}</span>}
        {flow.status === "Scheduled" && flow.scheduled_for && (
          <span className={cn("rounded-full px-[9px] py-0.5 text-xs font-medium", isDue(flow) ? "bg-bad-soft text-bad" : "bg-warn-soft text-warn")}>
            {dayAndTime(flow.scheduled_for)}
          </span>
        )}
      </div>
    );
  };

  return (
    <div className={PAGE_FRAME}>
      <div className="relative isolate overflow-hidden rounded-[28px] bg-[linear-gradient(120deg,#ebe5ff_0%,#f5f2ff_50%,#fff0e8_100%)] p-6 sm:p-9">
        <div aria-hidden="true" className="pointer-events-none absolute -top-24 -right-16 -z-10 size-72 rounded-full bg-brand/10 blur-3xl" />
        <div aria-hidden="true" className="pointer-events-none absolute -bottom-28 right-1/3 -z-10 size-64 rounded-full bg-coral/10 blur-3xl" />
        <div className="flex flex-wrap items-end justify-between gap-6">
          <div className="max-w-[580px]">
            <p className="inline-flex items-center gap-2 rounded-full bg-white/70 py-1 pr-3 pl-1.5 text-xs font-semibold text-brand-ink ring-1 ring-brand/10">
              <span className="grid size-5 place-items-center rounded-full bg-brand text-white"><Radio aria-hidden="true" className="size-3" strokeWidth={2.4} /></span>
              {activeBusiness || "Your business"} · {counts.live} live
            </p>
            <h1 className="mt-4 text-[28px] leading-[1.12] font-bold tracking-[-0.03em] text-balance text-ink sm:text-[36px]">
              {greeting()}. What do you want to ask your customers?
            </h1>
          </div>
          <button type="button" onClick={() => setDialog({ kind: "new" })}
                  className="flex items-center gap-2 rounded-full bg-brand px-5 py-3 text-sm font-semibold text-white shadow-[0_10px_24px_rgb(110_76_245/0.35)] transition hover:-translate-y-0.5 hover:bg-brand-hover">
            <Plus aria-hidden="true" className="size-4" strokeWidth={2.4} />New flow
          </button>
        </div>
      </div>

      <GettingStarted flows={flows} groups={groups}
                      onBuild={() => onEdit((flows.find((flow) => flow.status === "Draft") || flows[0]).id)}
                      onTest={() => onEdit((flows.find((flow) => flow.setup.questions.length) || flows[0]).id, "call")}
                      onContacts={() => onNavigate("contacts")}
                      onSend={() => onPublish((flows.find((flow) => flow.setup.questions.length) || flows[0]).id)} />

      {statsProblem && (
        <ErrorNote className="mt-5" onRetry={loadNumbers}>Couldn’t load the call numbers. {statsProblem}</ErrorNote>
      )}
      <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard icon={Radio} tone="violet" label="Live now" value={counts.live}
                  sub={`${counts.scheduled} scheduled · ${counts.draft} ${counts.draft === 1 ? "draft" : "drafts"}`} />
        <StatCard icon={PhoneCall} tone="blue" label="Calls this week" value={week ? week.calls : waiting}
                  sub="across every flow" trend={days?.map((one) => one.calls)} trendColor="#2563eb" />
        <StatCard icon={CheckCircle2} tone="green" label="Completed" value={week ? percent(week.completed, week.calls) : waiting}
                  sub={week?.calls ? `${week.completed} of ${week.calls} calls` : "this week"}
                  valueClass={week?.calls ? "text-good" : undefined} trend={days?.map((one) => one.completed)} trendColor="#059669" />
        <StatCard icon={Timer} tone="amber" label="Average call" value={week?.calls ? clock(week.average_seconds) : week ? "—" : waiting}
                  sub="minutes : seconds" />
      </div>

      {days && <Overview days={days} items={attention}
                         onAct={(one) => (one.act === "publish" ? onPublish(one.flow.id) : onEdit(one.flow.id))} />}

      <div className="mt-9 mb-4 flex flex-wrap items-center gap-2.5">
        <h2 className="mr-auto text-xl font-semibold tracking-[-0.01em] text-ink">Your flows
          <span className="ml-2 align-middle text-[13px] font-medium text-faint tabular-nums">{flows.length}</span>
        </h2>
        <div className="relative min-w-40 max-sm:order-last max-sm:w-full">
          <Search aria-hidden="true" className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-faint" strokeWidth={2} />
          <TextInput aria-label="Search flows" value={search} onChange={(event) => setSearch(event.target.value)}
                     placeholder="Search" className="h-9 rounded-full pl-9" />
        </div>
        <Select aria-label="Sort by" className="h-9 w-auto rounded-full" value={sort} onChange={(event) => setSort(event.target.value)} options={SORTS} />
        <div role="tablist" className="flex rounded-full bg-active p-[3px]">
          {TABS.map((one) => (
            <button key={one} type="button" role="tab" aria-selected={tab === one} onClick={() => setTab(one)}
                    className={cn("rounded-full px-3.5 py-1.5 text-[13px] font-semibold transition-colors",
                                  tab === one ? "bg-white text-ink shadow-[0_1px_2px_rgb(17_17_20/0.1)]" : "text-muted hover:text-ink")}>
              {one}
            </button>
          ))}
        </div>
        <div className="flex rounded-full bg-active p-[3px]" role="group" aria-label="Layout">
          {[["grid", LayoutGrid, "Cards"], ["list", List, "List"]].map(([id, Icon, label]) => (
            <button key={id} type="button" aria-pressed={view === id} aria-label={label} title={label} onClick={() => chooseView(id)}
                    className={cn("grid size-[30px] place-items-center rounded-full transition-colors",
                                  view === id ? "bg-white text-ink shadow-[0_1px_2px_rgb(17_17_20/0.1)]" : "text-muted hover:text-ink")}>
              <Icon aria-hidden="true" className="size-4" strokeWidth={2} />
            </button>
          ))}
        </div>
      </div>

      {shown.length > 0 && (
        <div className="mb-3 flex min-h-9 flex-wrap items-center gap-3">
          <label className="flex cursor-pointer items-center gap-2 text-[13px] font-medium text-muted">
            <SelectAll selection={selection} label="Pick every flow shown" />
            {selection.count ? "" : "Pick several"}
          </label>
          <SelectionBar selection={selection} noun={selection.count === 1 ? "flow picked" : "flows picked"}
                        className="flex-1" onDelete={() => setDialog({ kind: "delete-many", ids: selection.ids })} />
        </div>
      )}

      {shown.length === 0 && (flows.length === 0 ? (
        <EmptyState icon={Workflow} title="No flows yet"
                    action={<Button variant="primary" icon={Plus} onClick={() => setDialog({ kind: "new" })}>New flow</Button>}>
          A flow is the call you want made: why it is calling and the questions it asks.
        </EmptyState>
      ) : (
        <EmptyState icon={Filter} title={search.trim() ? `No flow is called “${search.trim()}”` : `Nothing is ${tab.toLowerCase()} right now`}
                    action={<Button variant="secondary" onClick={() => { setSearch(""); setTab("All"); }}>Show every flow</Button>}>
          Try a different search, or look at every flow.
        </EmptyState>
      ))}

      {view === "grid" ? (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(270px,1fr))] gap-4">
          {shown.map((flow) => {
            const questions = askCount(flow);
            const meta = [`${questions} ${questions === 1 ? "question" : "questions"}`,
                          clock(estimateSeconds(flow.setup.questions)), voiceOf(flow)].join(" · ");
            const live = flow.status !== "Draft";
            return (
              <article key={flow.id}
                       className="group/card flex flex-col overflow-hidden rounded-3xl border border-line bg-white shadow-card transition duration-200 hover:-translate-y-0.5 hover:shadow-[0_16px_36px_rgb(17_17_20/0.1)]">
                <div role="button" tabIndex={0} onClick={() => onEdit(flow.id)} aria-label={`Open ${flow.name}`}
                     onKeyDown={(event) => { if (event.key === "Enter") onEdit(flow.id); }}
                     className={cn("relative h-[112px] cursor-pointer border-b border-line", PREVIEW[isDue(flow) ? "Due" : flow.status])}>
                  <MiniFlow steps={flow.setup.questions} />
                  <span className="absolute top-3 left-3.5"><StatusBadges flow={flow} /></span>
                  <span onClick={(event) => event.stopPropagation()}
                        className={cn("absolute top-2.5 right-3 grid size-7 place-items-center rounded-full bg-white/90 shadow-sm transition-opacity",
                                      selection.count || selection.has(flow.id) ? "opacity-100" : "opacity-0 focus-within:opacity-100 group-hover/card:opacity-100 max-md:opacity-100")}>
                    <RowBox selection={selection} id={flow.id} label={`Pick ${flow.name}`} />
                  </span>
                </div>

                <div className="flex flex-1 flex-col gap-2.5 px-3.5 pt-3 pb-3.5">
                  <div className="flex items-start gap-1">
                    <div className="min-w-0 flex-1">
                      <button type="button" onClick={() => onEdit(flow.id)}
                              className="block max-w-full truncate text-left text-[15px] font-semibold text-ink hover:text-brand-ink">
                        {flow.name}
                      </button>
                      <p className="mt-0.5 text-xs text-faint">{meta} · {ago(flow.edited)}</p>
                    </div>
                    <div className="-mt-1 -mr-1.5">{menu(flow)}</div>
                  </div>
                  <div>
                    <p className={cn("text-[13px]", of(flow).calls ? "font-medium text-body" : "text-faint")}>{callsLine(flow)}</p>
                    {of(flow).calls > 0 && (
                      <Meter className="mt-1.5 h-1.5" tone="bg-live"
                             percent={Math.round((of(flow).completed / of(flow).calls) * 100)} />
                    )}
                  </div>
                  {chips(flow)}
                  <div className="mt-auto flex gap-2">
                    <button type="button" onClick={() => onEdit(flow.id)}
                            className="flex-1 rounded-full border border-edge bg-white px-3 py-2 text-[13px] font-semibold text-ink transition-colors hover:bg-hover">
                      Edit
                    </button>
                    {of(flow).calls > 0 && (
                      <button type="button" onClick={() => onResults(flow.id)} aria-label={`Results of ${flow.name}`} title="Results"
                              className="grid w-10 place-items-center rounded-full border border-edge bg-white text-ink transition-colors hover:bg-hover">
                        <BarChart3 aria-hidden="true" className="size-4" strokeWidth={2} />
                      </button>
                    )}
                    <button type="button" onClick={() => onPublish(flow.id)}
                            className={cn("flex-1 rounded-full px-3 py-2 text-[13px] font-semibold transition-opacity hover:opacity-90",
                                          live && !flow.unpublished_changes ? "bg-fill text-ink" : "bg-brand text-white")}>
                      {live ? (flow.unpublished_changes ? "Publish changes" : "Update") : "Publish"}
                    </button>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-white">
          {shown.map((flow) => {
            const questions = askCount(flow);
            return (
              <li key={flow.id} className={cn("flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 hover:bg-hover/60", selection.has(flow.id) && "bg-brand-wash")}>
                <RowBox selection={selection} id={flow.id} label={`Pick ${flow.name}`} />
                <div className="min-w-0 flex-[2_1_220px]">
                  <button type="button" onClick={() => onEdit(flow.id)}
                          className="block max-w-full truncate text-left text-[15px] font-semibold text-ink hover:text-brand-ink">{flow.name}</button>
                  <p className="text-xs text-faint">
                    {questions} {questions === 1 ? "question" : "questions"} · {clock(estimateSeconds(flow.setup.questions))} · {ago(flow.edited)}
                  </p>
                </div>
                <StatusBadges flow={flow} />
                <p className={cn("flex-[1_1_150px] text-[13px]", of(flow).calls ? "text-body" : "text-faint")}>{callsLine(flow)}</p>
                <div className="flex-[1_1_180px]">{chips(flow)}</div>
                <div className="ml-auto flex items-center gap-1.5">
                  {of(flow).calls > 0 && (
                    <Button variant="ghost" size="sm" icon={BarChart3} onClick={() => onResults(flow.id)}>Results</Button>
                  )}
                  <Button variant="secondary" size="sm" onClick={() => onEdit(flow.id)}>Edit</Button>
                  <Button variant={flow.status !== "Draft" && !flow.unpublished_changes ? "subtle" : "primary"} size="sm" onClick={() => onPublish(flow.id)}>
                    {flow.status !== "Draft" ? (flow.unpublished_changes ? "Publish changes" : "Update") : "Publish"}
                  </Button>
                  {menu(flow)}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {dialog?.kind === "new" && <NewFlowDialog onClose={() => setDialog(null)} onPick={onNew} />}
      {dialog?.kind === "rename" && (
        <RenameDialog flow={dialog.flow} onClose={() => setDialog(null)} onRename={(name) => rename(dialog.flow, name)} />
      )}
      {dialog?.kind === "delete-many" && (() => {
        const chosen = flows.filter((flow) => dialog.ids.includes(flow.id));
        const going = chosen.filter((flow) => flow.status !== "Draft").length;
        return (
          <ConfirmDialog title={`Delete ${chosen.length} ${chosen.length === 1 ? "flow" : "flows"}?`} confirm={`Delete ${chosen.length}`} danger
                         onClose={() => setDialog(null)} onConfirm={() => { onDeleteMany(chosen.map((flow) => flow.id)); selection.clear(); }}>
            {going > 0 && <>{going} of them {going === 1 ? "is" : "are"} live or scheduled right now. </>}
            The flows and their questions are removed for good. Calls already made stay in History.
          </ConfirmDialog>
        );
      })()}
      {dialog?.kind === "delete" && (
        <ConfirmDialog title={`Delete “${dialog.flow.name}”?`} confirm="Delete flow" danger onClose={() => setDialog(null)}
                       onConfirm={() => onDelete(dialog.flow.id)}>
          {dialog.flow.status !== "Draft" && <>It is {dialog.flow.status.toLowerCase()} right now. </>}
          The flow and its questions are removed for good. Calls already made stay in History.
        </ConfirmDialog>
      )}
    </div>
  );
}
