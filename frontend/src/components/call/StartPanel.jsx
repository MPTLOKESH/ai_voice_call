import { Mic, Phone, X } from "lucide-react";
import { useEffect, useState } from "react";
import * as api from "../../lib/api.js";
import { Badge } from "../ui/Badge.jsx";
import { Button } from "../ui/Button.jsx";
import { Card, IconTile } from "../ui/Card.jsx";
import { Field, TextInput, Toggle } from "../ui/fields.jsx";
import { LevelMeter } from "./LevelMeter.jsx";

/** Before a call: who's calling, who the customer is, whether to speak aloud, and a microphone check. */
export function StartPanel({ session, state, setup, flowName }) {
  const [customer, setCustomer] = useState("");      // typed, or the name of the contact picked
  const [contact, setContact] = useState(null);      // a saved contact, so the call is listed against them
  const [matches, setMatches] = useState([]);
  const [speak, setSpeak] = useState(true);
  const [starting, setStarting] = useState(false);
  const questions = (setup?.questions || []).filter((one) => (one.kind || "ask") === "ask").length;
  const name = setup?.assistant_name || "Assistant";

  async function start() {
    setStarting(true);
    try { await session.begin({ customer: contact ? { id: contact.id, name: contact.name, phone: contact.phone } : customer, speak }); }
    finally { setStarting(false); }
  }

  // Saved contacts whose name or number starts to match what is typed.
  useEffect(() => {
    if (contact || customer.trim().length < 2) { setMatches([]); return; }
    let current = true;
    const timer = setTimeout(() => {
      api.contacts({ search: customer.trim(), limit: 5 }).then((found) => { if (current) setMatches(found.contacts); }).catch(() => {});
    }, 200);
    return () => { current = false; clearTimeout(timer); };
  }, [customer, contact]);

  return (
    <Card className="max-w-2xl">
      {/* Who the customer will hear */}
      {flowName && (
        <p className="border-b border-line px-6 py-3 text-[13px] text-muted sm:px-8">
          Testing the flow <span className="font-semibold text-ink">{flowName}</span>
        </p>
      )}
      <div className="flex items-start gap-4 border-b border-line px-6 py-6 sm:px-8">
        <span className="grid size-12 shrink-0 place-items-center rounded-full bg-brand text-[18px] font-medium text-white">
          {name[0].toUpperCase()}
        </span>
        <div className="min-w-0">
          <h2 className="text-[17px] font-semibold text-ink">
            {name} <span className="font-normal text-muted">· {setup?.business_name || "your business"}</span>
          </h2>
          {setup?.purpose && <p className="mt-0.5 text-[14px] text-body">{setup.purpose}</p>}
          <div className="mt-3 flex flex-wrap gap-1.5">
            <Badge tone="brand">{questions} {questions === 1 ? "question" : "questions"}</Badge>
            <Badge tone="brand">Up to {setup?.max_minutes || 4} min</Badge>
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-6 px-6 py-7 sm:px-8">
        <Field label="Who it is calling" hint="A name, or start typing to pick a saved contact. Optional.">
          {contact ? (
            <div className="flex h-10 items-center gap-2 rounded-xl border border-brand bg-brand-wash px-3.5 text-[14px]">
              <span className="font-medium text-ink">{contact.name || "No name"}</span>
              <span className="font-mono text-[12px] text-muted">{contact.phone}</span>
              <span className="flex-1" />
              <button type="button" aria-label="Not this contact" onClick={() => { setContact(null); setCustomer(""); }}
                      className="grid size-7 place-items-center rounded-lg text-muted hover:bg-white hover:text-ink">
                <X aria-hidden="true" className="size-3.5" strokeWidth={2.2} />
              </button>
            </div>
          ) : (
            <div className="relative">
              <TextInput value={customer} onChange={(e) => setCustomer(e.target.value)} placeholder="Priya Sharma" />
              {matches.length > 0 && (
                <ul className="absolute inset-x-0 top-11 z-10 overflow-hidden rounded-xl border border-line bg-white p-1 shadow-float">
                  {matches.map((one) => (
                    <li key={one.id}>
                      <button type="button" onClick={() => { setContact(one); setCustomer(one.name); setMatches([]); }}
                              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] hover:bg-fill">
                        <span className="font-medium text-ink">{one.name || "No name"}</span>
                        <span className="font-mono text-[12px] text-muted">{one.phone}</span>
                        {one.opted_out && <span className="ml-auto text-xs font-medium text-bad">Opted out</span>}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </Field>

        <div className="divide-y divide-line rounded-lg border border-line">
          <Toggle className="px-4 py-3.5" checked={speak} onChange={setSpeak} label="Speak out loud"
                  description="Turn off to test the logic without using speech credits" />
          <div className="flex flex-col gap-3 px-4 py-3.5">
            <div className="flex items-center gap-3">
              <IconTile icon={Mic} tone="rose" size="sm" />
              <div className="min-w-0 flex-1">
                <p className="text-[14px] font-medium text-ink">Microphone</p>
                <p className="text-[13px] text-muted">
                  {state.micOpen ? "Say something and watch the bar." : "Check it before you start."}
                </p>
              </div>
              {!state.micOpen && (
                <Button variant="secondary" size="sm" onClick={() => session.checkMic()}>Check</Button>
              )}
            </div>
            {state.micOpen && <LevelMeter session={session} numbers />}
          </div>
        </div>

        {state.problem && <p role="alert" className="text-sm font-medium text-bad">{state.problem}</p>}

        <div className="flex flex-col-reverse items-stretch gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-[12px] text-muted">It calls the flow as saved, and nobody is actually dialled.</p>
          <Button variant="primary" size="lg" icon={Phone} onClick={start} disabled={starting} className="justify-center">
            {starting ? "Connecting…" : "Start the call"}
          </Button>
        </div>
      </div>
    </Card>
  );
}
