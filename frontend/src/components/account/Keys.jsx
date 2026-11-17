import { Cpu, ExternalLink, Lock, Volume2 } from "lucide-react";
import { useState } from "react";
import * as api from "../../lib/api.js";
import { cn } from "../../lib/cn.js";
import { Badge } from "../ui/Badge.jsx";
import { Button } from "../ui/Button.jsx";
import { Card, IconTile } from "../ui/Card.jsx";
import { ConfirmDialog } from "../ui/Dialog.jsx";
import { Field, TextInput } from "../ui/fields.jsx";
import { useToast } from "../ui/Toasts.jsx";

const ICONS = { gemini: [Cpu, "blue"], elevenlabs: [Volume2, "green"] };

function KeyCard({ service, one, onChange }) {
  const toast = useToast();
  const [Icon, tone] = ICONS[service];
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false);
  const own = one.mode === "own";

  async function run(job, done) {
    setBusy(true);
    try { const result = await job(); onChange(result.keys); done?.(result); } catch (failure) { toast(failure.message, "bad"); }
    setBusy(false);
  }

  const save = (event) => {
    event.preventDefault();
    run(() => api.saveKey(service, key.trim()), (result) => { setKey(""); toast(result.note || `${one.label} key saved and in use.`); });
  };

  return (
    <Card className="p-6">
      <div className="flex flex-wrap items-center gap-3">
        <IconTile icon={Icon} tone={tone} />
        <div className="min-w-0 flex-1">
          <h2 className="text-[16px] font-semibold text-ink">{one.label}</h2>
          <p className="text-[13px] text-muted">{one.does}</p>
        </div>
        <Badge tone={own ? "good" : "brand"}>{own ? "Using your key" : "Using our key"}</Badge>
      </div>

      {/* Which key pays. Switching never loses a saved key. */}
      <div role="group" aria-label={`Which ${one.label} key to use`} className="mt-5 inline-flex rounded-full bg-fill p-1">
        {[["ours", "Our key"], ["own", "My own key"]].map(([mode, label]) => (
          <button key={mode} type="button" aria-pressed={one.mode === mode} disabled={busy || (mode === "own" && !one.has_own)}
                  onClick={() => one.mode !== mode && run(() => api.setKeyMode(service, mode))}
                  className={cn("h-9 rounded-full px-4 text-[13px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50",
                                one.mode === mode ? "bg-white text-ink shadow-tile" : "text-muted hover:text-ink")}>
            {label}
          </button>
        ))}
      </div>
      <p className="mt-2 text-[13px] text-muted">
        {own ? "Your key pays for this. Nothing is taken from your free allowance."
          : one.ours_available ? "Our key pays for this, from your free allowance each month." : "We have no key set up for this, so add your own."}
      </p>

      <form onSubmit={save} className="mt-5 grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
        <Field label={one.has_own ? "Replace your key" : "Your key"}
               hint={one.has_own ? <>Saved: <span className="font-mono">····{one.last4}</span>. It is stored encrypted and cannot be shown again.</> : undefined}>
          <TextInput type="password" value={key} onChange={(event) => setKey(event.target.value)} autoComplete="off" spellCheck="false"
                     placeholder={one.has_own ? "Paste a new key" : "Paste your key"} />
        </Field>
        <Button type="submit" variant="brand" disabled={busy || key.trim().length < 16}>{busy ? "Checking…" : "Check and save"}</Button>
      </form>

      <p className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-[13px] text-muted">
        <a href={one.where} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 font-medium text-brand-ink hover:underline">
          Get a key <ExternalLink aria-hidden="true" className="size-3.5" />
        </a>
        {one.has_own && <button type="button" onClick={() => setAsking(true)} className="font-medium text-bad hover:underline">Remove my key</button>}
      </p>

      {asking && (
        <ConfirmDialog title={`Remove your ${one.label} key?`} confirm="Remove it" danger onClose={() => setAsking(false)}
                       onConfirm={() => run(() => api.removeKey(service), () => toast("Key removed."))}>
          It is deleted from here. {own && "Calls will use our key again, from your free allowance."}
        </ConfirmDialog>
      )}
    </Card>
  );
}

export function Keys({ data, onChange }) {
  return (
    <div className="grid gap-5">
      <Card className="flex gap-3 bg-brand-wash p-5">
        <Lock aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-brand" />
        <div className="text-[13px] leading-relaxed text-body">
          <p className="font-semibold text-ink">Your keys stay safe</p>
          <p>
            A key is checked once with the provider, then stored encrypted. It is never shown again and never leaves the server, and only
            your own calls can use it. Make a key just for this app and set a spending limit at the provider, so you can switch it off
            without touching anything else. If your key stops working, calls say so instead of quietly using ours.
          </p>
        </div>
      </Card>
      {Object.entries(data.keys).map(([service, one]) => <KeyCard key={service} service={service} one={one} onChange={onChange} />)}
    </div>
  );
}
