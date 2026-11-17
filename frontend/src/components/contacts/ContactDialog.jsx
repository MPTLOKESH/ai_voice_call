import { Check, PhoneCall, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import * as api from "../../lib/api.js";
import { cn } from "../../lib/cn.js";
import { Badge } from "../ui/Badge.jsx";
import { Button } from "../ui/Button.jsx";
import { Dialog } from "../ui/Dialog.jsx";
import { Field, TextInput, Toggle } from "../ui/fields.jsx";
import { Skeleton } from "../ui/States.jsx";
import { useToast } from "../ui/Toasts.jsx";
import { Footer } from "./shared.jsx";

const when = (iso) => new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

/**
 * One contact: their details, the groups they are in, whether they opted out, and the calls made to them.
 * With no `contactId` it adds a new one, into `intoGroup` if given.
 */
export function ContactDialog({ contactId = "", groups, intoGroup = "", flows = [], onClose, onSaved, onDelete }) {
  const toast = useToast();
  const [loaded, setLoaded] = useState(!contactId);
  const [form, setForm] = useState({ name: "", phone: "", email: "", opted_out: false, fields: {}, groups: intoGroup ? [intoGroup] : [] });
  const [calls, setCalls] = useState([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!contactId) return;
    api.contact(contactId).then((found) => {
      setForm({ name: found.name, phone: found.phone, email: found.email, opted_out: found.opted_out, fields: found.fields, groups: found.groups });
      setCalls(found.calls);
      setLoaded(true);
    }).catch((failure) => { toast(failure.message, "bad"); onClose(); });
  }, [contactId]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = (patch) => setForm((current) => ({ ...current, ...patch }));
  const toggleGroup = (id) => set({ groups: form.groups.includes(id) ? form.groups.filter((one) => one !== id) : [...form.groups, id] });

  async function save(event) {
    event.preventDefault();
    setSaving(true);
    try {
      const stored = await api.saveContact(form, contactId);
      onSaved(stored, !contactId);
      onClose();
    } catch (failure) {
      toast(failure.message, "bad");
    } finally {
      setSaving(false);
    }
  }

  const extras = Object.entries(form.fields);
  const flowName = (id) => flows.find((flow) => flow.id === id)?.name || "A flow";

  return (
    <Dialog title={contactId ? form.name || form.phone || "Contact" : "Add a contact"} onClose={onClose} className="w-[560px]">
      {!loaded ? (
        <div role="status" aria-label="Loading" className="flex flex-col gap-3 px-6 py-5">
          <Skeleton className="h-10" /><Skeleton className="h-10" /><Skeleton className="h-24" />
        </div>
      ) : (
        <form onSubmit={save}>
          <div className="flex flex-col gap-4 px-6 py-3">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Name">
                <TextInput value={form.name} onChange={(event) => set({ name: event.target.value })} placeholder="Asha Rao" />
              </Field>
              <Field label="Phone" hint="With the country code, or it is taken as +91.">
                <TextInput value={form.phone} onChange={(event) => set({ phone: event.target.value })} placeholder="+91 98765 43210"
                           inputMode="tel" required className="font-mono" />
              </Field>
            </div>
            <Field label="Email">
              <TextInput type="email" value={form.email} onChange={(event) => set({ email: event.target.value })} placeholder="Optional" />
            </Field>

            {extras.length > 0 && (
              <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {extras.map(([key, value]) => (
                  <div key={key} className="rounded-xl bg-canvas px-3 py-2">
                    <dt className="truncate text-[11px] text-muted">{key}</dt>
                    <dd className="truncate text-[13px] font-medium text-ink">{value}</dd>
                  </div>
                ))}
              </dl>
            )}

            {groups.length > 0 && (
              <div className="flex flex-col gap-2">
                <span className="text-[13px] font-medium text-ink">Groups</span>
                <div className="flex flex-wrap gap-1.5">
                  {groups.map((group) => {
                    const on = form.groups.includes(group.id);
                    return (
                      <button key={group.id} type="button" role="checkbox" aria-checked={on} onClick={() => toggleGroup(group.id)}
                              className={cn("flex h-8 items-center gap-1.5 rounded-full border px-3 text-[12px] font-semibold transition-colors",
                                            on ? "border-brand bg-brand-wash text-brand-ink" : "border-edge bg-white text-body hover:bg-hover")}>
                        {on && <Check aria-hidden="true" className="size-3" strokeWidth={3} />}{group.name}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            <div className="rounded-2xl border border-line px-4 py-3">
              <Toggle checked={form.opted_out} onChange={(value) => set({ opted_out: value })} label="Opted out"
                      description="Never called or messaged, whichever group they are in." />
            </div>

            {contactId && (
              <div className="flex flex-col gap-2">
                <span className="text-[13px] font-medium text-ink">Calls</span>
                {calls.length === 0 ? (
                  <p className="flex items-center gap-2 text-[13px] text-muted">
                    <PhoneCall aria-hidden="true" className="size-4" strokeWidth={1.75} />No calls yet.
                  </p>
                ) : (
                  <ul className="divide-y divide-line rounded-2xl border border-line">
                    {calls.map((call) => (
                      <li key={call.call} className="flex items-center gap-3 px-3.5 py-2.5 text-[13px]">
                        <span className="w-28 shrink-0 font-medium text-ink">{when(call.at)}</span>
                        <span className="min-w-0 flex-1 truncate text-muted">{flowName(call.flow)}</span>
                        <Badge tone={call.outcome === "completed" ? "good" : "warn"}>{call.outcome === "completed" ? "Completed" : "Incomplete"}</Badge>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
          <Footer>
            {contactId && (
              <Button variant="ghost" icon={Trash2} className="mr-auto text-bad hover:bg-bad-soft hover:text-bad"
                      onClick={() => onDelete(contactId)}>Delete</Button>
            )}
            <Button variant="secondary" onClick={onClose}>Cancel</Button>
            <Button variant="primary" type="submit" disabled={saving || !form.phone.trim()}>{saving ? "Saving…" : contactId ? "Save" : "Add contact"}</Button>
          </Footer>
        </form>
      )}
    </Dialog>
  );
}
