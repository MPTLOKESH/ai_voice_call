import { ArrowLeft, Check } from "lucide-react";
import { cn } from "../../lib/cn.js";

const STEPS = [
  { id: "studio", label: "Build", hint: "Write the questions" },
  { id: "call", label: "Test", hint: "Try it yourself" },
  { id: "send", label: "Send", hint: "Choose who it goes to" },
  { id: "results", label: "Results", hint: "See the answers" },
];

/**
 * The path through one flow: build it, test it, send it, read the results. Always visible while a flow is open,
 * so it is never unclear what comes next or which flow a test or a result belongs to.
 *
 * `done` says which steps have been reached; `note` is a few words under a step (how many questions, its status).
 */
export function FlowTabs({ page, flowName, status, questions, tested, onNavigate, onSend, onBack }) {
  const done = { studio: questions > 0, call: tested, send: status !== "Draft", results: false };
  const note = {
    studio: questions ? `${questions} ${questions === 1 ? "question" : "questions"}` : "Add a question",
    call: tested ? "Tried" : "Not tried yet",
    send: status === "Live" ? "Live" : status === "Scheduled" ? "Scheduled" : "Not sent",
    results: "",
  };

  return (
    <div className="flex shrink-0 items-center gap-3 overflow-x-auto border-b border-line bg-white px-3 sm:px-5">
      <button type="button" onClick={onBack}
              className="flex shrink-0 items-center gap-1.5 rounded-lg px-2 py-2 text-[13px] font-medium text-muted transition-colors hover:text-ink">
        <ArrowLeft aria-hidden="true" className="size-4" strokeWidth={2} />
        <span className="max-sm:sr-only">All flows</span>
      </button>
      <p className="hidden max-w-[200px] shrink-0 truncate text-[13px] font-semibold text-ink md:block" title={flowName}>{flowName}</p>

      <ol className="mx-auto flex">
        {STEPS.map((step, at) => {
          const active = step.id === page;
          return (
            <li key={step.id}>
              <button type="button" aria-current={active ? "step" : undefined} title={step.hint}
                      onClick={() => (step.id === "send" ? onSend() : onNavigate(step.id))}
                      className={cn("relative flex items-center gap-2.5 px-3.5 py-2.5 text-left transition-colors sm:px-5",
                                    active ? "text-ink" : "text-muted hover:text-ink")}>
                <span className={cn("grid size-6 shrink-0 place-items-center rounded-full text-[12px] font-semibold",
                                    active ? "bg-brand text-white" : done[step.id] ? "bg-good-soft text-good" : "bg-fill text-muted")}>
                  {done[step.id] && !active ? <Check aria-hidden="true" className="size-3.5" strokeWidth={3} /> : at + 1}
                </span>
                <span className="leading-tight">
                  <span className="block text-[14px] font-semibold">{step.label}</span>
                  {note[step.id] && <span className="hidden text-[11px] text-muted sm:block">{note[step.id]}</span>}
                </span>
                {active && <span aria-hidden="true" className="absolute inset-x-3 bottom-0 h-0.5 rounded-full bg-brand" />}
              </button>
            </li>
          );
        })}
      </ol>
      <span className="hidden w-24 shrink-0 lg:block" aria-hidden="true" />
    </div>
  );
}
