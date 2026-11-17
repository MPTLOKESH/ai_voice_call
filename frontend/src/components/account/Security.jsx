import { useEffect, useState } from "react";
import * as api from "../../lib/api.js";
import { ago } from "../../lib/time.js";
import { Button } from "../ui/Button.jsx";
import { Card } from "../ui/Card.jsx";
import { Dialog } from "../ui/Dialog.jsx";
import { Field, TextInput } from "../ui/fields.jsx";
import { useToast } from "../ui/Toasts.jsx";

function Profile({ user, onReload }) {
  const toast = useToast();
  const [name, setName] = useState(user.name);
  const [busy, setBusy] = useState(false);
  async function save(event) {
    event.preventDefault();
    setBusy(true);
    try { await api.saveProfile(name); onReload(); toast("Saved."); } catch (failure) { toast(failure.message, "bad"); }
    setBusy(false);
  }
  return (
    <Card className="p-6">
      <h2 className="text-[16px] font-semibold text-ink">Profile</h2>
      <form onSubmit={save} className="mt-4 grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
        <Field label="Name"><TextInput value={name} onChange={(event) => setName(event.target.value)} maxLength={80} autoComplete="name" /></Field>
        <Field label="Email" hint={user.verified ? "Confirmed" : "Not confirmed yet"}><TextInput value={user.email} readOnly disabled /></Field>
        <Button type="submit" variant="primary" disabled={busy || name.trim() === user.name}>Save</Button>
      </form>
    </Card>
  );
}

function Password() {
  const toast = useToast();
  const [form, setForm] = useState({ current: "", next: "" });
  const [busy, setBusy] = useState(false);
  async function save(event) {
    event.preventDefault();
    setBusy(true);
    try {
      await api.changePassword(form.current, form.next);
      setForm({ current: "", next: "" });
      toast("Password changed. Your other devices were signed out.");
    } catch (failure) { toast(failure.message, "bad"); }
    setBusy(false);
  }
  return (
    <Card className="p-6">
      <h2 className="text-[16px] font-semibold text-ink">Password</h2>
      <form onSubmit={save} className="mt-4 grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
        <Field label="Current password">
          <TextInput type="password" autoComplete="current-password" value={form.current} onChange={(event) => setForm({ ...form, current: event.target.value })} required />
        </Field>
        <Field label="New password" hint="At least 10 characters.">
          <TextInput type="password" autoComplete="new-password" minLength={10} value={form.next} onChange={(event) => setForm({ ...form, next: event.target.value })} required />
        </Field>
        <Button type="submit" variant="primary" disabled={busy}>Change</Button>
      </form>
    </Card>
  );
}

function Activity() {
  const [events, setEvents] = useState(null);
  useEffect(() => { api.accountActivity().then((found) => setEvents(found.events)).catch(() => setEvents([])); }, []);
  return (
    <Card className="p-6">
      <h2 className="text-[16px] font-semibold text-ink">Recent activity</h2>
      <p className="mt-0.5 text-[13px] text-muted">Sign-ins and changes to this account. If something here is not you, change your password.</p>
      <ul className="mt-3 divide-y divide-line">
        {(events || []).map((one, at) => (
          <li key={at} className="flex flex-wrap items-baseline gap-x-3 py-2.5 text-[13px]">
            <span className="font-medium text-ink">{one.event}</span>
            {one.detail && <span className="text-muted">{one.detail}</span>}
            <span className="ml-auto font-mono text-xs text-faint">{one.address && `${one.address} · `}{ago(one.at)}</span>
          </li>
        ))}
        {events && events.length === 0 && <li className="py-3 text-[13px] text-faint">Nothing yet.</li>}
      </ul>
    </Card>
  );
}

function Delete({ onSignedOut }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  async function go(event) {
    event.preventDefault();
    setBusy(true);
    try { await api.deleteAccount(password); onSignedOut(); } catch (failure) { toast(failure.message, "bad"); setBusy(false); }
  }
  return (
    <Card className="p-6">
      <h2 className="text-[16px] font-semibold text-ink">Delete your account</h2>
      <p className="mt-1 text-[13px] leading-relaxed text-muted">
        Removes your flows, contacts, calls and results, your saved keys and your usage history. It cannot be undone.
      </p>
      <Button variant="danger" className="mt-4" onClick={() => setOpen(true)}>Delete my account…</Button>
      {open && (
        <Dialog title="Delete your account?" subtitle="Type your password to confirm." onClose={() => setOpen(false)}>
          <form onSubmit={go} className="px-6 pt-3 pb-[22px]">
            <Field label="Password"><TextInput type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required /></Field>
            <div className="mt-5 flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
              <Button type="submit" variant="danger-solid" disabled={busy || !password}>Delete everything</Button>
            </div>
          </form>
        </Dialog>
      )}
    </Card>
  );
}

export function Security({ data, onReload, onSignedOut }) {
  const toast = useToast();
  async function everywhere() {
    try { await api.signOutEverywhere(); onSignedOut(); } catch (failure) { toast(failure.message, "bad"); }
  }
  return (
    <div className="grid gap-5">
      <Profile user={data.user} onReload={onReload} />
      <Password />
      <Card className="flex flex-wrap items-center gap-4 p-6">
        <div className="min-w-0 flex-1">
          <h2 className="text-[16px] font-semibold text-ink">Signed in on other devices?</h2>
          <p className="mt-0.5 text-[13px] text-muted">Sign out everywhere, this device included.</p>
        </div>
        <Button variant="secondary" onClick={everywhere}>Sign out everywhere</Button>
      </Card>
      <Activity />
      <Delete onSignedOut={onSignedOut} />
    </div>
  );
}
