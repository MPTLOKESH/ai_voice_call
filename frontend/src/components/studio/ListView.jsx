import { ArrowDown, ArrowUp, Bot, PhoneOff, GitBranch, Megaphone, MessageCircleQuestion, Phone, Plus, Repeat } from "lucide-react";
import { cn } from "../../lib/cn.js";
import { answerId } from "../../lib/thread.js";

const TYPE_LABELS = { text: "words", number: "a number", date: "a date", time: "a time", yes_no: "yes or no", choice: "one of the options" };

/** A gap between two steps, to put another one in. Quiet until the pointer or keyboard comes near. */
function Gap({ onClick, label }) {
  return (
    <li className="group/gap flex h-6 items-center justify-center">
      <button type="button" onClick={onClick} aria-label={label} title={label}
              className="flex h-6 items-center gap-1 rounded-full px-2.5 text-xs font-semibold text-transparent transition-colors
                         group-hover/gap:text-brand focus-visible:bg-brand-wash focus-visible:text-brand">
        <Plus aria-hidden="true" className="size-3.5" strokeWidth={2.4} />Add a step here
      </button>
    </li>
  );
}

/**
 * The call as a plain list, in the order it will happen. Every step is numbered; the number is the order. This
 * is the way in for most people: the canvas is the same flow drawn freely, for those who want it.
 */
export function ListView({ steps, questions, purpose, selectedId, activeId, onSelect, onMove, onInsert, onAdd, closing }) {
  const rows = steps.filter((step) => step.kind !== "answer");
  const askText = (key) => questions.find((one) => one.save_as === key)?.ask?.trim();

  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-canvas/50">
      <ol aria-label="The call, in order" className="mx-auto max-w-2xl px-4 pt-16 pb-28 sm:pt-20">
        {rows.map((step) => {
          const question = step.question;
          const on = step.id === selectedId;
          const speaking = step.id === activeId;
          const warn = step.flag && !step.flag.ok;
          const why = step.kind === "context";
          const first = step.kind === "open" || why;
          const last = step.kind === "close";
          const Icon = why ? MessageCircleQuestion : first ? Phone : last ? PhoneOff : step.kind === "say" ? Megaphone : step.kind === "end" ? PhoneOff : step.kind === "loop" ? Repeat : Bot;
          const kindLabel = why ? "Why we are calling" : first ? "The call starts" : last ? "It finishes by" : step.kind === "say" ? "It tells them" : step.kind === "end" ? (question.handoff ? "It hands over" : "It ends the call")
            : step.kind === "loop" ? `It goes back to “${askText(question.back_to) || "an earlier question"}” (up to ${question.times || 2}×)` : "It asks";
          const text = why ? purpose.trim() : first ? "The assistant says hello and who is calling" : last ? closing : question.ask.trim();
          const answer = step.kind === "ask" ? steps.find((one) => one.id === answerId(question)) : null;

          return (
            <li key={step.id} className="contents">
              {!first && <Gap label={`Add a step before ${step.title}`} onClick={() => (last ? onAdd() : onInsert(step.index))} />}
              <div className={cn("rounded-2xl border-[1.5px] bg-white transition-shadow",
                                on ? "border-brand shadow-[0_0_0_4px_rgb(110_76_245/0.1)]" : speaking ? "border-brand/60" : "border-line hover:border-edge")}>
                <div className="flex items-start gap-3 p-3.5 sm:p-4">
                  <span className={cn("grid size-8 shrink-0 place-items-center rounded-full text-[13px] font-bold",
                                      on ? "bg-brand text-white" : step.kind === "open" ? "bg-good text-white" : last || step.kind === "end" ? "bg-bad text-white" : "bg-fill text-ink")}>
                    {first || last || (step.kind === "end" && !on) ? <Icon aria-hidden="true" className="size-4" strokeWidth={2.2} /> : step.index + 1}
                  </span>
                  <button type="button" onClick={() => onSelect(step.id)} aria-pressed={on} className="min-w-0 flex-1 text-left">
                    <span className="block text-[12px] font-medium text-faint">{kindLabel}</span>
                    <span className={cn("mt-0.5 block text-[15px] leading-snug break-words", text ? "text-ink" : "text-faint italic")}>
                      {text || (why ? "Say why it is calling" : "Write what it should say")}
                    </span>
                    {question?.only_if && (
                      <span className="mt-1.5 flex items-start gap-1.5 text-[12px] text-loop-ink">
                        <GitBranch aria-hidden="true" className="mt-0.5 size-3 shrink-0" strokeWidth={2.2} />
                        {step.kind === "end" || step.kind === "loop" ? "When" : "Only if"} “{askText(question.only_if) || "an earlier question"}” is {(question.only_if_is || []).join(" or ") || "…"}
                      </span>
                    )}
                    {warn && <span className="mt-1.5 block text-[12px] font-medium text-warn">{step.flag.note}</span>}
                  </button>
                  {question && (
                    <span className="flex shrink-0 flex-col">
                      <button type="button" aria-label="Move earlier" title="Move earlier" disabled={step.index === 0}
                              onClick={() => onMove(question._key, step.index - 1)}
                              className="grid size-7 place-items-center rounded-lg text-muted hover:bg-fill hover:text-ink disabled:opacity-25">
                        <ArrowUp aria-hidden="true" className="size-4" strokeWidth={2} />
                      </button>
                      <button type="button" aria-label="Move later" title="Move later" disabled={step.index === questions.length - 1}
                              onClick={() => onMove(question._key, step.index + 2)}
                              className="grid size-7 place-items-center rounded-lg text-muted hover:bg-fill hover:text-ink disabled:opacity-25">
                        <ArrowDown aria-hidden="true" className="size-4" strokeWidth={2} />
                      </button>
                    </span>
                  )}
                </div>
                {answer && (
                  <button type="button" onClick={() => onSelect(answer.id)}
                          className={cn("flex w-full items-center gap-2 rounded-b-[14px] border-t border-line px-4 py-2.5 text-left text-[13px] transition-colors hover:bg-fill",
                                        answer.id === selectedId ? "bg-brand-wash text-brand-ink" : "bg-canvas/60 text-muted")}>
                    <span className="size-1.5 rounded-full bg-live" />
                    They answer with <span className="font-semibold text-ink">{TYPE_LABELS[question.type] || "words"}</span>
                    {question.required === false && <span className="text-faint">· optional</span>}
                    {question.type === "choice" && (question.options || []).length > 0 && <span className="truncate text-faint">({question.options.join(", ")})</span>}
                  </button>
                )}
              </div>
            </li>
          );
        })}
        <li className="mt-5 flex justify-center">
          <button type="button" onClick={onAdd}
                  className="flex h-10 items-center gap-2 rounded-full bg-brand px-5 text-sm font-semibold text-white shadow-[0_4px_12px_rgb(110_76_245/0.3)] transition-colors hover:bg-brand-hover">
            <Plus aria-hidden="true" className="size-4" strokeWidth={2.4} />{questions.length ? "Add a question" : "Add your first question"}
          </button>
        </li>
      </ol>
    </div>
  );
}

