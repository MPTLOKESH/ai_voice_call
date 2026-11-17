import { Check, Globe, Info, MessageCircle, Phone, Users } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "../../lib/cn.js";
import * as api from "../../lib/api.js";
import { dayAndTime } from "../../lib/time.js";
import { Dialog } from "../ui/Dialog.jsx";
import { Pills } from "../ui/fields.jsx";
import { useToast } from "../ui/Toasts.jsx";

// Only what really exists can be picked. The others are shown, so people know what is coming, but not offered.
const CHANNELS = [
  { name: "Call", icon: Phone, desc: "A phone call to each person", ready: true },
  { name: "WhatsApp", icon: MessageCircle, desc: "A voice note to their number", ready: false },
  { name: "Website", icon: Globe, desc: "A voice widget for your site", ready: false },
];

const people = (count) => `${count.toLocaleString()} ${count === 1 ? "person" : "people"}`;

/** Who a flow goes to, and when. Saying yes is a separate, second press, so nobody sends by accident. */
export function PublishDialog({ flow, onClose, onPublished, onContacts }) {
  const toast = useToast();
  const [picked, setPicked] = useState(flow.groups || []);
  const [groups, setGroups] = useState(null);
  const [reach, setReach] = useState(null);
  const [when, setWhen] = useState(flow.when);
  const [at, setAt] = useState(flow.scheduled_for);
  const [sending, setSending] = useState(false);
  const [sure, setSure] = useState(false);              // the first press asks; the second sends

  useEffect(() => {
    api.groups().then((found) => {
      setGroups(found.groups);
      // A group deleted since it was last published can't still be picked.
      setPicked((now) => now.filter((id) => found.groups.some((group) => group.id === id)));
    }).catch(() => setGroups([]));
  }, []);

  // Who the picked groups reach: each number once, without anyone who opted out.
  useEffect(() => {
    setSure(false);
    if (!picked.length) { setReach(null); return; }
    let current = true;
    api.reach(picked).then((found) => { if (current) setReach(found); }).catch(() => {});
    return () => { current = false; };
  }, [picked]);

  const pick = (id) => setPicked((all) => (all.includes(id) ? all.filter((one) => one !== id) : [...all, id]));

  // The earliest a schedule can be: now, as the date box writes it (local time, to the minute).
  const now = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16);

  const chosen = (groups || []).filter((group) => picked.includes(group.id));
  const who = reach ? people(reach.people) : "everyone in them";

  /** The first press checks and asks; the second one sends. */
  async function send() {
    if (when === "Schedule" && (!at || at < now)) {
      toast(at ? "That time has already passed. Pick one in the future." : "Pick a date and time to schedule it for.", "bad");
      return;
    }
    if (!picked.length) {
      toast("Pick who it goes to first.", "bad");
      return;
    }
    if (!sure) { setSure(true); return; }
    setSending(true);
    try {
      const stored = await api.publishFlow(flow.id, { channels: ["Call"], groups: picked, audience: flow.audience, when, scheduled_for: at });
      onPublished(stored);
      toast(when === "Schedule" ? `Scheduled for ${dayAndTime(at)}` : "Saved as live");
      onClose();
    } catch (failure) {
      toast(failure.message, "bad");
      setSure(false);
    } finally {
      setSending(false);
    }
  }

  return (
    <Dialog title="Send this flow" subtitle={flow.name} onClose={onClose} className="w-[560px]">
      <div className="flex flex-col gap-[18px] px-6 py-3.5">
        <div>
          <p className="mb-2 text-[13px] font-semibold text-ink">How should it reach them?</p>
          <div className="grid grid-cols-3 gap-2 max-sm:grid-cols-1">
            {CHANNELS.map(({ name, icon: Icon, desc, ready }) => (
              <div key={name} aria-disabled={!ready}
                   className={cn("relative flex flex-col gap-2.5 rounded-2xl border-[1.5px] p-3.5 text-left",
                                 ready ? "border-brand bg-brand-wash" : "border-line bg-white opacity-60")}>
                <span className="grid size-[34px] place-items-center rounded-[10px] bg-fill text-ink">
                  <Icon aria-hidden="true" className="size-[18px]" strokeWidth={1.8} />
                </span>
                <span>
                  <span className="block text-sm font-semibold text-ink">{name === "Call" ? "Phone call" : name}</span>
                  <span className="mt-0.5 block text-xs leading-snug text-muted">{desc}</span>
                </span>
                {ready ? (
                  <span className="absolute top-3 right-3 grid size-[18px] place-items-center rounded-full bg-brand text-white">
                    <Check aria-hidden="true" className="size-2.5" strokeWidth={4} />
                  </span>
                ) : (
                  <span className="absolute top-3 right-3 rounded-full bg-fill px-2 py-0.5 text-[10px] font-semibold text-muted">Coming soon</span>
                )}
              </div>
            ))}
          </div>
        </div>

        <div>
          <p className="mb-2 text-[13px] font-semibold text-ink">Who should get it?</p>
          {groups === null ? <p className="text-[13px] text-muted">Loading your contact groups…</p> : groups.length === 0 ? (
            <div className="flex items-center gap-3 rounded-2xl border border-dashed border-edge px-4 py-3.5">
              <Users aria-hidden="true" className="size-5 shrink-0 text-muted" strokeWidth={1.8} />
              <p className="min-w-0 flex-1 text-[13px] text-muted">You have no contact groups yet. Add the people it should call first.</p>
              {onContacts && (
                <button type="button" onClick={onContacts} className="shrink-0 text-[13px] font-semibold text-brand-ink hover:underline">
                  Add contacts
                </button>
              )}
            </div>
          ) : (
            <div className="flex max-h-40 flex-wrap gap-1.5 overflow-y-auto">
              {groups.map((group) => {
                const on = picked.includes(group.id);
                return (
                  <button key={group.id} type="button" role="checkbox" aria-checked={on} onClick={() => pick(group.id)}
                          className={cn("flex h-9 items-center gap-1.5 rounded-full border px-3.5 text-[13px] font-semibold transition-colors",
                                        on ? "border-brand bg-brand-wash text-brand-ink" : "border-edge bg-white text-ink hover:bg-hover")}>
                    {on && <Check aria-hidden="true" className="size-3.5" strokeWidth={3} />}
                    {group.name}
                    <span className={cn("font-mono text-xs font-normal", on ? "text-brand-ink/70" : "text-faint")}>{group.count}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <span className="text-[13px] font-semibold text-ink">When?</span>
          <Pills label="When" options={[["Now", "Now"], ["Schedule", "Pick a time"]]} value={when} onChange={setWhen} />
          {when === "Schedule" && (
            <input type="datetime-local" aria-label="Date and time" value={at} min={now} onChange={(event) => setAt(event.target.value)}
                   className="rounded-xl border border-edge bg-white px-3 py-1.5 text-[13px] text-ink focus:border-brand focus:ring-3 focus:ring-brand/15 focus:outline-none" />
          )}
        </div>

        {/* In words: exactly what pressing the button does */}
        {chosen.length > 0 && (
          <div className="rounded-xl border border-line bg-canvas px-4 py-3 text-[13px] leading-relaxed text-body">
            Will phone <span className="font-semibold text-ink">{who}</span> from{" "}
            <span className="font-semibold text-ink">{chosen.map((group) => group.name).join(", ")}</span>,{" "}
            {when === "Schedule" && at ? <>on <span className="font-semibold text-ink">{dayAndTime(at)}</span></> : "as soon as you send it"}.
            {reach?.opted_out > 0 && ` ${people(reach.opted_out)} who opted out will be skipped.`}
            {reach?.in_several > 0 && ` Anyone in more than one group is called once.`}
          </div>
        )}

        <p className="flex items-start gap-2 rounded-xl bg-warn-soft px-3.5 py-2.5 text-xs leading-relaxed text-warn">
          <Info aria-hidden="true" className="mt-px size-3.5 shrink-0" strokeWidth={2} />
          Phone calls are not connected yet. Sending saves who it is for and marks the flow live, but nobody is dialled.
        </p>
      </div>

      <div className="flex items-center justify-end gap-2 px-6 pt-3.5 pb-[22px]">
        {sure && <p className="mr-auto text-[13px] font-medium text-ink">Sure? This goes to {who}.</p>}
        <button type="button" onClick={sure ? () => setSure(false) : onClose}
                className="rounded-full border border-edge bg-white px-[18px] py-2.5 text-sm font-semibold text-ink hover:bg-hover">
          {sure ? "Go back" : "Cancel"}
        </button>
        <button type="button" onClick={send} disabled={sending}
                className="rounded-full bg-brand px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-brand-hover disabled:opacity-60">
          {sending ? "Sending…" : sure ? `Yes, ${when === "Schedule" ? "schedule it" : "send it"}` : when === "Schedule" ? "Schedule it" : flow.status === "Live" ? "Update" : "Send it"}
        </button>
      </div>
    </Dialog>
  );
}
