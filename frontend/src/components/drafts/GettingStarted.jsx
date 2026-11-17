import { Check, X } from "lucide-react";
import { useState } from "react";
import { cn } from "../../lib/cn.js";
import { Card } from "../ui/Card.jsx";

const KEY = "voice-call-start-hidden";
const stored = () => { try { return localStorage.getItem(KEY) === "1"; } catch { return false; } };

/** The four things to do, in order, for someone who has just arrived. Goes away once they are done, or on request. */
export function GettingStarted({ flows, groups, onBuild, onTest, onContacts, onSend }) {
  const [hidden, setHidden] = useState(stored);
  const tested = (() => { try { return localStorage.getItem("voice-call-tested") === "1"; } catch { return false; } })();
  const first = flows.find((flow) => flow.setup.questions.some((one) => (one.kind || "ask") === "ask"));

  const steps = [
    { done: Boolean(first), title: "Write your questions", note: "Say why it is calling and what to ask.", action: "Open a flow", run: onBuild },
    { done: tested || flows.some((flow) => flow.status !== "Draft"), title: "Try it yourself", note: "Talk to it like a customer would.", action: "Test it", run: onTest },
    { done: groups.length > 0, title: "Add your contacts", note: "Upload a file, or connect your database.", action: "Add contacts", run: onContacts },
    { done: flows.some((flow) => flow.status !== "Draft"), title: "Send it", note: "Choose who gets the call.", action: "Send", run: onSend },
  ];
  const left = steps.filter((step) => !step.done).length;
  if (hidden || left === 0) return null;
  const next = steps.findIndex((step) => !step.done);

  return (
    <Card className="mt-5 p-5 sm:p-6">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-[16px] font-semibold text-ink">Getting started</h2>
          <p className="mt-0.5 text-[13px] text-muted">{left === 4 ? "Four steps, and your first customers are being asked." : `${4 - left} of 4 done.`}</p>
        </div>
        <button type="button" aria-label="Hide this" title="Hide this"
                onClick={() => { setHidden(true); try { localStorage.setItem(KEY, "1"); } catch { /* optional */ } }}
                className="grid size-8 place-items-center rounded-lg text-muted hover:bg-fill hover:text-ink">
          <X aria-hidden="true" className="size-4" strokeWidth={2.2} />
        </button>
      </div>
      <ol className="mt-4 grid gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
        {steps.map((step, at) => (
          <li key={step.title} className={cn("flex flex-col gap-1 rounded-2xl border p-3.5", at === next ? "border-brand bg-brand-wash" : "border-line")}>
            <span className="flex items-center gap-2">
              <span className={cn("grid size-6 shrink-0 place-items-center rounded-full text-[12px] font-bold",
                                  step.done ? "bg-good-soft text-good" : at === next ? "bg-brand text-white" : "bg-fill text-muted")}>
                {step.done ? <Check aria-hidden="true" className="size-3.5" strokeWidth={3} /> : at + 1}
              </span>
              <span className="text-[14px] font-semibold text-ink">{step.title}</span>
            </span>
            <span className="text-[13px] leading-snug text-muted">{step.note}</span>
            {at === next && (
              <button type="button" onClick={step.run}
                      className="mt-2 self-start rounded-full bg-brand px-3.5 py-1.5 text-[13px] font-semibold text-white hover:bg-brand-hover">
                {step.action}
              </button>
            )}
          </li>
        ))}
      </ol>
    </Card>
  );
}
