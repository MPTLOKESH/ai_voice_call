import { Bot, ChevronDown, GitBranch, MessagesSquare, Plus } from "lucide-react";
import { AiIcon } from "../ui/AiIcon.jsx";
import { useEffect, useRef, useState } from "react";
import { cn } from "../../lib/cn.js";
import { QUESTION_PRESETS, STEP_BLOCKS, stepFields } from "../../lib/presets.js";

// One colour to a group, each a pale wash with the icon in its full strength.
const TINT = {
  ai: { wash: "bg-brand-wash", tile: "bg-brand-soft text-brand", label: "text-brand-ink", ring: "hover:border-brand/40" },
  customer: { wash: "bg-good-soft/60", tile: "bg-[#d3efdf] text-good", label: "text-good", ring: "hover:border-good/40" },
  smart: { wash: "bg-loop-soft/70", tile: "bg-loop-soft text-loop", label: "text-loop-ink", ring: "hover:border-loop/40" },
};

// Short names on the bar so all of it fits; the full one is in each block's hint.
const SHORT = { yes_no: "Yes / No", rating: "1–5", nps: "0–10", choice: "Choice", number: "Number", date: "Date", text: "Text" };
const AI_SHORT = { say: "Say" };
// Said in full where there is room for it.
const PLAIN = { ask: "Ask a question", suggest: "Suggest questions", branch: "Only if… (a condition)" };

const AI_BLOCKS = [
  { id: "ask", label: "Ask", hint: "The assistant asks a question", icon: Bot, payload: { kind: "new", fields: {} } },
  ...STEP_BLOCKS.map((block) => ({
    ...block, label: AI_SHORT[block.id] || block.label, payload: { kind: "new", fields: stepFields(block.id) },
  })),
];
const CUSTOMER_BLOCKS = QUESTION_PRESETS.map((preset) => ({
  id: `answer-${preset.id}`, label: SHORT[preset.id] || preset.label, icon: preset.icon, payload: { kind: "answer", fields: preset.question },
  hint: `Customer answers: ${preset.label}. Drop it on a question to set how it is answered, or on empty space to add one.`,
}));
const SMART_BLOCKS = [
  { id: "suggest", label: "Suggest", icon: AiIcon, payload: { kind: "suggest" },
    hint: "Press and the AI suggests questions for you. Drop it on a step for other ways to word it." },
  { id: "branch", label: "Only if…", icon: GitBranch, payload: { kind: "branch" },
    hint: "Drop on a step to ask it only when an earlier answer matches" },
];

/** One block in an open group: pressed to add, or picked up and dropped where it should go. */
function Row({ block, tint, onGrab, onDone, busy }) {
  const Icon = block.icon;
  return (
    <button type="button" disabled={busy}
            onPointerDown={(event) => { if (event.button === 0) { onGrab(event, block, tint); onDone(); } }}
            onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onGrab(null, block, tint); onDone(); } }}
            className="flex w-full cursor-pointer touch-none items-center gap-3 rounded-xl px-2.5 py-2 text-left select-none hover:bg-fill disabled:cursor-wait disabled:opacity-60">
      <span className={cn("grid size-8 shrink-0 place-items-center rounded-[10px]", tint.tile, busy && "motion-safe:animate-pulse")}>
        <Icon aria-hidden="true" className="size-[17px]" strokeWidth={2.1} />
      </span>
      <span className="min-w-0">
        <span className="block text-[13px] font-semibold text-ink">{PLAIN[block.id] || block.label}</span>
        {block.hint && <span className="block text-xs leading-snug text-muted">{block.hint}</span>}
      </span>
    </button>
  );
}

const GROUPS = [
  { id: "ai", label: "Add step", icon: Plus, tint: TINT.ai, blocks: AI_BLOCKS, primary: true },
  { id: "customer", label: "Answer type", icon: MessagesSquare, tint: TINT.customer, blocks: CUSTOMER_BLOCKS },
  { id: "smart", label: "AI help", icon: AiIcon, tint: TINT.smart, blocks: SMART_BLOCKS },
];

/**
 * The bar across the top, kept to three buttons so it reads at a glance: add a step, choose how the
 * customer answers, and the AI helpers. Each opens its blocks, said in full; a block is pressed to add it,
 * or picked up and put down on the canvas, on a line, or on a step.
 *
 *   onGrab(event, block, tint)  a block was pressed; `event` is null when it was activated from the keyboard
 */
export function Toolbar({ onGrab, suggesting }) {
  const [open, setOpen] = useState(null);
  const bar = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const away = (event) => { if (!bar.current?.contains(event.target)) setOpen(null); };
    const escape = (event) => { if (event.key === "Escape") setOpen(null); };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", away); document.removeEventListener("keydown", escape); };
  }, [open]);

  return (
    <div ref={bar} className="relative z-40 flex shrink-0 items-center gap-2 border-b border-line bg-white px-3 py-2 sm:px-4">
      {GROUPS.map((group) => {
        const Icon = group.icon;
        const on = open === group.id;
        return (
          <div key={group.id} className="relative">
            <button type="button" aria-expanded={on} onClick={() => setOpen(on ? null : group.id)}
                    className={cn("flex h-9 items-center gap-1.5 rounded-full pr-2.5 pl-1.5 text-[13px] font-semibold transition-colors",
                                  group.primary ? "bg-brand text-white hover:brightness-110" : "text-ink hover:bg-fill", on && !group.primary && "bg-fill")}>
              <span className={cn("grid size-6 place-items-center rounded-full", group.primary ? "bg-white/20" : group.tint.tile)}>
                <Icon aria-hidden="true" className="size-3.5" strokeWidth={2.4} />
              </span>
              {group.label}
              <ChevronDown aria-hidden="true" className={cn("size-3.5 transition-transform", group.primary ? "text-white/80" : "text-faint", on && "rotate-180")} strokeWidth={2.4} />
            </button>
            {on && (
              <div role="menu" aria-label={group.label}
                   className="absolute top-11 left-0 w-[300px] max-w-[calc(100vw-24px)] animate-[toast-in_.16s_ease-out] rounded-2xl border border-line bg-white p-1.5 shadow-float">
                {group.blocks.map((block) => (
                  <Row key={block.id} block={block} tint={group.tint} onGrab={onGrab} onDone={() => setOpen(null)}
                       busy={block.id === "suggest" && suggesting} />
                ))}
                <p className="px-2.5 pt-1.5 pb-1 text-[11px] text-faint">Click to add, or drag onto the canvas.</p>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
