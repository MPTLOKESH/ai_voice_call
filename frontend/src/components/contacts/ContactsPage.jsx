import {
  Ban, Database, FileSpreadsheet, MoreHorizontal, Plus, RefreshCw, Search, Trash2, Upload, UserPlus, Users, X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as api from "../../lib/api.js";
import { cn } from "../../lib/cn.js";
import { ago } from "../../lib/time.js";
import { PAGE_FRAME } from "../layout/Page.jsx";
import { Badge } from "../ui/Badge.jsx";
import { Button } from "../ui/Button.jsx";
import { ConfirmDialog, Dialog } from "../ui/Dialog.jsx";
import { Field, Select, TextInput } from "../ui/fields.jsx";
import { Menu } from "../ui/Menu.jsx";
import { EmptyState, ErrorNote, Skeleton, SkeletonRows } from "../ui/States.jsx";
import { useToast } from "../ui/Toasts.jsx";
import { ContactDialog } from "./ContactDialog.jsx";
import { DatabaseDialog } from "./DatabaseDialog.jsx";
import { ImportDialog } from "./ImportDialog.jsx";
import { Footer } from "./shared.jsx";

const PAGE = 50;
const SOURCE_ICON = { manual: Users, file: FileSpreadsheet, database: Database };
const STATUSES = [["", "Everyone"], ["reachable", "Reachable"], ["opted_out", "Opted out"]];

/** A small menu row. */
const Item = ({ icon: Icon, danger, children, ...props }) => (
  <button type="button" {...props}
          className={cn("flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left text-[13px] font-medium transition-colors disabled:opacity-40",
                        danger ? "text-bad hover:bg-bad-soft" : "text-ink hover:bg-fill")}>
    <Icon aria-hidden="true" className="size-4 shrink-0" strokeWidth={1.8} />{children}
  </button>
);

/** Naming a group, new or old. */
function GroupNameDialog({ group, onClose, onSaved }) {
  const toast = useToast();
  const [name, setName] = useState(group?.name || "");
  const [description, setDescription] = useState(group?.description || "");
  async function save(event) {
    event.preventDefault();
    try {
      onSaved(group ? await api.saveGroup(group.id, { name, description }) : await api.createGroup(name, description));
      onClose();
    } catch (failure) {
      toast(failure.message, "bad");
    }
  }
  return (
    <Dialog title={group ? "Rename group" : "New group"} onClose={onClose}>
      <form onSubmit={save}>
        <div className="flex flex-col gap-4 px-6 py-3">
          <Field label="Name"><TextInput value={name} onChange={(event) => setName(event.target.value)} placeholder="Delivered this week" /></Field>
          <Field label="What it is for"><TextInput value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Optional" /></Field>
        </div>
        <Footer>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" disabled={!name.trim()}>{group ? "Save" : "Make group"}</Button>
        </Footer>
      </form>
    </Dialog>
  );
}

/** Where a group's people come from, and for a database group, syncing it again. */
function SourceLine({ group, syncing, onSync }) {
  if (group.source === "database") {
    return (
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-muted">
        <Database aria-hidden="true" className="size-3.5" strokeWidth={2} />
        Read from a database{group.table ? ` · ${group.table}` : " · a query"}
        {group.synced_at && <span>· synced {ago(group.synced_at).toLowerCase()}</span>}
        <button type="button" onClick={onSync} disabled={syncing}
                className="flex items-center gap-1 font-semibold text-brand-ink hover:underline disabled:opacity-50">
          <RefreshCw aria-hidden="true" className={cn("size-3", syncing && "animate-spin")} strokeWidth={2.4} />{syncing ? "Syncing…" : "Sync now"}
        </button>
        {group.sync_problem && <span className="w-full font-medium text-bad">Last sync failed: {group.sync_problem}</span>}
      </p>
    );
  }
  return (
    <p className="text-[13px] text-muted">
      {group.description || (group.source === "file" ? "Imported from a file" : "Added by hand")}
    </p>
  );
}

/**
 * The people flows are sent to, in groups. Groups down the left (and "All contacts"), the chosen group's
 * contacts in the middle. Contacts come in by hand, from a file, or from a database.
 */
export function ContactsPage({ flows = [] }) {
  const toast = useToast();
  const [groupData, setGroupData] = useState(null);   // {groups, all}
  const [groupId, setGroupId] = useState("");         // "" is everyone
  const [search, setSearch] = useState("");
  const [typed, setTyped] = useState("");
  const [status, setStatus] = useState("");
  const [list, setList] = useState(null);             // {contacts, total}
  const [listProblem, setListProblem] = useState("");   // why the list could not be loaded, if it could not
  const [picked, setPicked] = useState(new Set());
  const [dialog, setDialog] = useState(null);         // {kind, …}
  const [syncing, setSyncing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  const groups = useMemo(() => groupData?.groups || [], [groupData]);
  const group = groups.find((one) => one.id === groupId);

  const loadGroups = useCallback(() => api.groups().then(setGroupData).catch((failure) => toast(failure.message, "bad")), [toast]);
  // Answers can come back out of order (a group picked, then a search typed): only the latest request's counts.
  const latest = useRef(0);
  const loadContacts = useCallback(async () => {
    const asked = ++latest.current;
    try {
      const found = await api.contacts({ group: groupId, search, status, limit: PAGE });
      if (asked !== latest.current) return;
      setList(found);
      setListProblem("");
      setPicked(new Set());
    } catch (failure) {
      if (asked !== latest.current) return;
      setListProblem(failure.message);
      setList((now) => now || { contacts: [], total: 0 });
    }
  }, [groupId, search, status]);

  useEffect(() => { loadGroups(); }, [loadGroups]);
  useEffect(() => { loadContacts(); }, [loadContacts]);
  // Searching waits for a pause in typing, so each key doesn't ask the server.
  useEffect(() => { const timer = setTimeout(() => setSearch(typed), 250); return () => clearTimeout(timer); }, [typed]);
  // A group deleted elsewhere (or just now) can't stay chosen.
  useEffect(() => { if (groupData && groupId && !group) setGroupId(""); }, [groupData, groupId, group]);

  const refresh = () => { loadGroups(); loadContacts(); };

  /** Opens a group just made or renamed. It goes into the list at once: the reload may not be back yet. */
  function show(made) {
    setGroupData((now) => ({ ...now, groups: [made, ...(now?.groups || []).filter((one) => one.id !== made.id)] }));
    setGroupId(made.id);
  }

  async function more() {
    setLoadingMore(true);
    try {
      const next = await api.contacts({ group: groupId, search, status, limit: PAGE, offset: list.contacts.length });
      setList((now) => ({ contacts: [...now.contacts, ...next.contacts.filter((one) => !now.contacts.some((other) => other.id === one.id))], total: next.total }));
    } catch (failure) {
      toast(failure.message, "bad");
    } finally {
      setLoadingMore(false);
    }
  }

  async function act(job, message) {
    try {
      await job();
      if (message) toast(message);
      refresh();
    } catch (failure) {
      toast(failure.message, "bad");
    }
  }

  async function sync() {
    setSyncing(true);
    try {
      const done = await api.syncGroup(group.id);
      toast(`Synced: ${done.added} new, ${done.group.count} in the group now.`);
    } catch (failure) {
      toast(failure.message, "bad");
    } finally {
      setSyncing(false);
      refresh();
    }
  }

  async function removeGroup(withContacts, force = false) {
    try {
      await api.deleteGroup(group.id, { withContacts, force });
      toast(`${group.name} deleted.`);
      setGroupId("");
      refresh();
    } catch (failure) {
      if (failure.status === 409) setDialog({ kind: "group-in-use", withContacts, flows: failure.data.flows });
      else toast(failure.message, "bad");
    }
  }

  const ids = [...picked];
  const shown = list?.contacts || [];
  const allPicked = shown.length > 0 && shown.every((one) => picked.has(one.id));
  const togglePick = (id) => setPicked((now) => { const next = new Set(now); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const groupName = (id) => groups.find((one) => one.id === id)?.name;
  const nobodyYet = groupData && groupData.all.count === 0;
  const filtered = Boolean(search || status);

  return (
    <div className={PAGE_FRAME}>
      <header className="mb-7 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[30px] leading-tight font-bold tracking-[-0.025em] text-ink">Contacts</h1>
          <p className="mt-1 text-sm text-muted">The people your flows call, kept in groups.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" icon={Upload} onClick={() => setDialog({ kind: "import" })}>Import</Button>
          <Button variant="secondary" icon={Database} onClick={() => setDialog({ kind: "database" })}>Connect database</Button>
          <Button variant="primary" icon={UserPlus} onClick={() => setDialog({ kind: "contact" })}>Add contact</Button>
        </div>
      </header>

      {nobodyYet ? (
        <div className="rounded-3xl border border-line bg-white px-6 py-14 text-center shadow-card">
          <span className="mx-auto grid size-12 place-items-center rounded-2xl bg-brand-soft text-brand">
            <Users aria-hidden="true" className="size-6" strokeWidth={1.8} />
          </span>
          <h2 className="mt-4 text-lg font-semibold text-ink">No contacts yet</h2>
          <p className="mx-auto mt-1 max-w-md text-sm text-muted">
            Bring in the customers your flows should call. Put them in groups, then pick a group when you publish a flow.
          </p>
          <div className="mx-auto mt-7 grid max-w-2xl gap-3 sm:grid-cols-3">
            {[[Upload, "Import a file", "CSV or Excel", "import"], [Database, "Connect a database", "PostgreSQL, MySQL, SQLite", "database"],
              [UserPlus, "Add by hand", "One at a time", "contact"]].map(([Icon, title, sub, kind]) => (
              <button key={kind} type="button" onClick={() => setDialog({ kind })}
                      className="flex flex-col items-center gap-2 rounded-2xl border border-line px-4 py-5 transition-colors hover:border-brand hover:bg-brand-wash">
                <Icon aria-hidden="true" className="size-5 text-brand" strokeWidth={1.9} />
                <span className="text-sm font-semibold text-ink">{title}</span>
                <span className="text-xs text-muted">{sub}</span>
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div className="grid gap-5 lg:grid-cols-[240px_minmax(0,1fr)]">
          {/* Groups: a list beside the contacts on wide screens, a dropdown above them on narrow ones */}
          <aside className="max-lg:hidden">
            {!groupData && (
              <div role="status" aria-label="Loading groups" className="flex flex-col gap-2 px-3 py-1">
                {[0, 1, 2].map((one) => <Skeleton key={one} className="h-7" />)}
              </div>
            )}
            <nav aria-label="Groups" className={cn("flex flex-col gap-0.5", !groupData && "hidden")}>
              {[{ id: "", name: "All contacts", count: groupData?.all.count ?? 0, source: "manual" }, ...groups].map((one) => {
                const Icon = one.id ? SOURCE_ICON[one.source] : Users;
                const on = one.id === groupId;
                return (
                  <button key={one.id || "all"} type="button" onClick={() => setGroupId(one.id)} aria-current={on ? "true" : undefined}
                          className={cn("flex items-center gap-2.5 rounded-xl px-3 py-2 text-left text-[13px] font-medium transition-colors",
                                        on ? "bg-brand-soft text-brand-ink" : "text-body hover:bg-fill hover:text-ink")}>
                    <Icon aria-hidden="true" className="size-4 shrink-0" strokeWidth={1.8} />
                    <span className="min-w-0 flex-1 truncate">{one.name}</span>
                    {one.sync_problem && <span title="Last sync failed" className="size-1.5 rounded-full bg-bad" />}
                    <span className="font-mono text-xs tabular-nums text-faint">{one.count.toLocaleString()}</span>
                  </button>
                );
              })}
            </nav>
            <button type="button" onClick={() => setDialog({ kind: "group" })}
                    className="mt-2 flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-[13px] font-semibold text-muted hover:bg-fill hover:text-ink">
              <Plus aria-hidden="true" className="size-4" strokeWidth={2.2} />New group
            </button>
          </aside>
          <div className="flex gap-2 lg:hidden">
            <div className="min-w-0 flex-1">
              <Select aria-label="Group" value={groupId} onChange={(event) => setGroupId(event.target.value)}
                      options={[["", `All contacts (${groupData?.all.count ?? 0})`], ...groups.map((one) => [one.id, `${one.name} (${one.count})`])]} />
            </div>
            <Button variant="secondary" icon={Plus} aria-label="New group" onClick={() => setDialog({ kind: "group" })} className="h-10" />
          </div>

          <section className="min-w-0 rounded-3xl border border-line bg-white shadow-card">
            <div className="flex flex-wrap items-start gap-3 border-b border-line px-5 pt-5 pb-4">
              <div className="min-w-0 flex-1">
                <h2 className="truncate text-lg font-semibold text-ink">{group ? group.name : "All contacts"}</h2>
                {group ? <SourceLine group={group} syncing={syncing} onSync={sync} /> : (
                  <p className="text-[13px] text-muted">Everyone, in every group. Each phone number is one contact.</p>
                )}
              </div>
              {group && (
                <Menu label="Group options" trigger={<MoreHorizontal aria-hidden="true" className="size-[18px]" strokeWidth={2} />} className="w-56">
                  <Item icon={UserPlus} onClick={() => setDialog({ kind: "contact" })}>Add a contact</Item>
                  <Item icon={Upload} onClick={() => setDialog({ kind: "import", into: group.id })}>Import into it</Item>
                  <Item icon={FileSpreadsheet} onClick={() => setDialog({ kind: "group", group })}>Rename</Item>
                  <Item icon={Trash2} danger onClick={() => setDialog({ kind: "delete-group" })}>Delete group</Item>
                </Menu>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-2 px-5 py-3">
              <div className="relative min-w-48 flex-1">
                <Search aria-hidden="true" className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-faint" strokeWidth={2} />
                <TextInput aria-label="Search contacts" value={typed} onChange={(event) => setTyped(event.target.value)}
                           placeholder="Search name, phone or email" className="pl-9" />
              </div>
              <Select aria-label="Status" className="w-auto" value={status} onChange={(event) => setStatus(event.target.value)} options={STATUSES} />
              {list && <span className="text-[13px] text-muted tabular-nums">{list.total.toLocaleString()} {list.total === 1 ? "contact" : "contacts"}</span>}
            </div>

            {picked.size > 0 && (
              <div className="mx-3 mb-2 flex flex-wrap items-center gap-1.5 rounded-2xl bg-brand px-3 py-2 text-[13px] text-white">
                <span className="px-1 font-semibold">{picked.size} picked</span>
                <span className="flex-1" />
                {groups.length > 0 && (
                  <select aria-label="Add to group" value="" onChange={(event) => event.target.value && act(() => api.changeMembers(event.target.value, ids, true), `Added to ${groupName(event.target.value)}.`)}
                          className="h-8 cursor-pointer rounded-full bg-white/10 px-3 text-[13px] font-semibold text-white hover:bg-white/20">
                    <option value="">Add to group…</option>
                    {groups.filter((one) => one.id !== groupId).map((one) => <option key={one.id} value={one.id} className="text-ink">{one.name}</option>)}
                  </select>
                )}
                {group && (
                  <button type="button" onClick={() => act(() => api.changeMembers(group.id, ids, false), `Taken out of ${group.name}.`)}
                          className="h-8 rounded-full px-3 font-semibold hover:bg-white/15">Take out of group</button>
                )}
                <button type="button" onClick={() => act(() => api.optOut(ids, true), "Opted out.")} className="h-8 rounded-full px-3 font-semibold hover:bg-white/15">Opt out</button>
                <button type="button" onClick={() => setDialog({ kind: "delete-contacts", ids })} className="h-8 rounded-full px-3 font-semibold text-[#ffb4ab] hover:bg-white/15">Delete</button>
                <button type="button" aria-label="Clear the selection" onClick={() => setPicked(new Set())} className="grid size-8 place-items-center rounded-full hover:bg-white/15">
                  <X aria-hidden="true" className="size-4" strokeWidth={2.2} />
                </button>
              </div>
            )}

            {listProblem && <ErrorNote className="mx-4 mb-3" onRetry={loadContacts}>{listProblem}</ErrorNote>}
            {!list ? <SkeletonRows rows={6} /> : shown.length === 0 && listProblem ? null : shown.length === 0 ? (
              <EmptyState compact icon={Users} title={filtered ? "No one matches" : "No one in this group yet"}
                          action={!filtered && group && (
                            <>
                              <Button variant="secondary" icon={Upload} onClick={() => setDialog({ kind: "import", into: group.id })}>Import into it</Button>
                              <Button variant="secondary" icon={UserPlus} onClick={() => setDialog({ kind: "contact" })}>Add a contact</Button>
                            </>
                          )}>
                {filtered ? "Try another search, or another status." : "Import a file into it, or add people one at a time."}
              </EmptyState>
            ) : (
              <>
                <table className="w-full text-left text-[13px]">
                  <thead className="border-y border-line text-[11px] font-semibold tracking-wide text-muted uppercase">
                    <tr>
                      <th className="w-10 py-2.5 pl-5">
                        <input type="checkbox" aria-label="Pick everyone shown" checked={allPicked}
                               onChange={() => setPicked(allPicked ? new Set() : new Set(shown.map((one) => one.id)))} className="size-4 accent-brand" />
                      </th>
                      <th className="py-2.5 pr-3">Name</th>
                      <th className="py-2.5 pr-3">Phone</th>
                      <th className="py-2.5 pr-3 max-md:hidden">Email</th>
                      {!group && <th className="py-2.5 pr-3 max-lg:hidden">Groups</th>}
                      <th className="py-2.5 pr-5 text-right max-sm:hidden"><span className="sr-only">Status</span></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {shown.map((one) => (
                      <tr key={one.id} onClick={() => setDialog({ kind: "contact", id: one.id })}
                          className={cn("cursor-pointer transition-colors hover:bg-hover", picked.has(one.id) && "bg-brand-wash")}>
                        <td className="py-2.5 pl-5" onClick={(event) => event.stopPropagation()}>
                          <input type="checkbox" aria-label={`Pick ${one.name || one.phone}`} checked={picked.has(one.id)}
                                 onChange={() => togglePick(one.id)} className="size-4 accent-brand" />
                        </td>
                        <td className={cn("max-w-48 truncate py-2.5 pr-3 font-medium", one.name ? "text-ink" : "text-faint")}>{one.name || "No name"}</td>
                        <td className="py-2.5 pr-3 font-mono text-[12px] whitespace-nowrap text-body">{one.phone}</td>
                        <td className="max-w-52 truncate py-2.5 pr-3 text-body max-md:hidden">{one.email}</td>
                        {!group && (
                          <td className="py-2.5 pr-3 max-lg:hidden">
                            <span className="flex max-w-60 flex-wrap gap-1">
                              {one.groups.slice(0, 2).map((id) => <span key={id} className="truncate rounded-full bg-fill px-2 py-px text-[11px] font-medium text-body">{groupName(id)}</span>)}
                              {one.groups.length > 2 && <span className="text-[11px] text-faint">+{one.groups.length - 2}</span>}
                            </span>
                          </td>
                        )}
                        <td className="py-2.5 pr-5 text-right max-sm:hidden">
                          {one.opted_out && <Badge tone="bad"><Ban aria-hidden="true" className="size-3" strokeWidth={2.2} />Opted out</Badge>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {shown.length < list.total && (
                  <div className="flex justify-center border-t border-line p-3">
                    <Button variant="ghost" size="sm" disabled={loadingMore} onClick={more}>
                      {loadingMore ? "Loading…" : `Show more (${(list.total - shown.length).toLocaleString()} left)`}
                    </Button>
                  </div>
                )}
              </>
            )}
          </section>
        </div>
      )}

      {dialog?.kind === "import" && (
        <ImportDialog groups={groups} intoGroup={dialog.into || ""} onClose={() => setDialog(null)}
                      onDone={(made) => { show(made); refresh(); }} />
      )}
      {dialog?.kind === "database" && (
        <DatabaseDialog onClose={() => setDialog(null)} onDone={(made) => { show(made); refresh(); }} />
      )}
      {dialog?.kind === "contact" && (
        <ContactDialog contactId={dialog.id} groups={groups} intoGroup={groupId} flows={flows} onClose={() => setDialog(null)}
                       onSaved={(_, added) => { toast(added ? "Contact added." : "Saved."); refresh(); }}
                       onDelete={(id) => setDialog({ kind: "delete-contacts", ids: [id] })} />
      )}
      {dialog?.kind === "group" && (
        <GroupNameDialog group={dialog.group} onClose={() => setDialog(null)} onSaved={(saved) => { show(saved); loadGroups(); }} />
      )}
      {dialog?.kind === "delete-contacts" && (
        <ConfirmDialog title={dialog.ids.length === 1 ? "Delete this contact?" : `Delete ${dialog.ids.length} contacts?`} confirm="Delete" danger
                       onClose={() => setDialog(null)} onConfirm={() => act(() => api.deleteContacts(dialog.ids), "Deleted.")}>
          They are taken out of every group and can't be brought back, except by adding them again.
          Their past calls stay in History. To stop calling someone but keep them, opt them out instead.
        </ConfirmDialog>
      )}
      {dialog?.kind === "delete-group" && group && (
        <Dialog title={`Delete ${group.name}?`} onClose={() => setDialog(null)}>
          <p className="px-6 py-2 text-sm leading-relaxed text-body">
            The group goes. Its {group.count.toLocaleString()} {group.count === 1 ? "contact stays" : "contacts stay"} in All contacts,
            unless you delete those too (only the ones in no other group).
          </p>
          <Footer>
            <Button variant="secondary" onClick={() => setDialog(null)}>Cancel</Button>
            <Button variant="danger" onClick={() => { setDialog(null); removeGroup(true); }}>Delete with its contacts</Button>
            <Button variant="danger-solid" onClick={() => { setDialog(null); removeGroup(false); }}>Delete group</Button>
          </Footer>
        </Dialog>
      )}
      {dialog?.kind === "group-in-use" && group && (
        <ConfirmDialog title="A live flow is sent to this group" confirm="Delete anyway" danger onClose={() => setDialog(null)}
                       onConfirm={() => removeGroup(dialog.withContacts, true)}>
          {dialog.flows.join(", ")} {dialog.flows.length === 1 ? "is" : "are"} published to {group.name}. Deleting it leaves
          {dialog.flows.length === 1 ? " that flow" : " those flows"} with fewer people to reach until you publish again with another group.
        </ConfirmDialog>
      )}
    </div>
  );
}
