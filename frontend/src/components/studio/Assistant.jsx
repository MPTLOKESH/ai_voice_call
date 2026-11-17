import { ArrowUp, Bot, Phone, Square, Check, ChevronDown, Loader2, Megaphone, MessagesSquare, PanelBottomClose, PanelRightOpen, PhoneForwarded, PhoneOff, Repeat, RotateCcw, Undo2, X } from "lucide-react";
import { AiIcon } from "../ui/AiIcon.jsx";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { cn } from "../../lib/cn.js";
import { RewriteButton } from "./RewriteButton.jsx";

// What a step is, compared: where it sits on the canvas is not part of it.
const PARTS = ["kind", "ask", "type", "options", "rule", "required", "only_if", "only_if_is", "handoff", "back_to", "times"];
const partsOf = (question) => JSON.stringify(PARTS.map((part) => question[part] ?? null));

/** The steps as one string: two lists that say the same thing give the same one. */
export const signature = (questions) => JSON.stringify(questions.map((question) => [question.save_as, partsOf(question)]));

/** What a proposed list of steps would do to the one there is: {added, edited, removed}, each a list of steps. */
export function diffSteps(before, after) {
  const was = Object.fromEntries(before.map((question) => [question.save_as, question]));
  const now = new Set(after.map((question) => question.save_as));
  const order = (list) => list.map((question) => question.save_as).filter((name) => was[name] && now.has(name)).join(",");
  return {
    added: after.filter((question) => !was[question.save_as]),
    edited: after.filter((question) => was[question.save_as] && partsOf(was[question.save_as]) !== partsOf(question)),
    removed: before.filter((question) => !now.has(question.save_as)),
    reordered: order(before) !== order(after),
  };
}

const KIND = { ask: "Question", say: "Message", end: "End call", loop: "Go back" };
// How each kind of step looks as a small badge: an icon tile in its colour.
const LOOK = {
  ask: { icon: Bot, tile: "bg-brand-soft text-brand" },
  say: { icon: Megaphone, tile: "bg-[#0891b2]/12 text-[#0e7490]" },
  end: { icon: PhoneOff, tile: "bg-bad text-white" },
  handoff: { icon: PhoneForwarded, tile: "bg-[#0d9488]/12 text-[#0f766e]" },
  loop: { icon: Repeat, tile: "bg-loop-soft text-loop-ink" },
};
const lookOf = (step) => LOOK[step.kind === "end" && step.handoff ? "handoff" : step.kind || "ask"];

/** The small round mark the AI wears wherever it speaks. */
const Mark = ({ className = "size-6", spin = false }) => (
  <span aria-hidden="true" className={cn("grid shrink-0 place-items-center rounded-full bg-linear-to-br from-brand to-[#b07cff] text-white shadow-[0_2px_8px_rgb(110_76_245/0.35)]", className)}>
    <AiIcon spin={spin} className="size-[55%]" />
  </span>
);

const STARTERS = ["Show me the whole call flow", "Suggest the questions to ask", "Add a thank-you message at the end", "Make every question shorter"];

/** The steps the next message is about, as chips that can be let go of. */
function Refs({ refs, onDrop }) {
  if (!refs.length) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {refs.map((ref) => (
        <span key={ref.id} className="flex max-w-[190px] items-center gap-1 rounded-full bg-brand-soft py-0.5 pr-1 pl-2.5 text-xs font-semibold text-brand-ink">
          <span className="truncate">{ref.label}</span>
          <button type="button" aria-label={`Stop pointing at ${ref.label}`} onClick={() => onDrop(ref.id)}
                  className="grid size-4 shrink-0 place-items-center rounded-full hover:bg-brand/15">
            <X aria-hidden="true" className="size-3" strokeWidth={2.6} />
          </button>
        </span>
      ))}
    </div>
  );
}

/** Where a message is typed: Enter sends it, Shift+Enter starts a new line. */
function Composer({ inputRef, busy, onSend, onStop, placeholder, rows = 1 }) {
  const [text, setText] = useState("");
  const send = () => { if (text.trim() && !busy) { onSend(text); setText(""); } };
  return (
    <div className="flex items-end gap-2">
      <textarea ref={inputRef} rows={rows} value={text} placeholder={placeholder} aria-label="Message to the AI assistant"
                onChange={(event) => setText(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); send(); }
                  if (event.key === "Escape") event.currentTarget.blur();
                }}
                className="max-h-32 min-h-9 min-w-0 flex-1 resize-none border-0 bg-transparent py-[7px] text-sm leading-snug text-ink placeholder:text-faint focus:outline-none" />
      {busy && onStop ? (
        <button type="button" onClick={onStop} aria-label="Stop thinking" title="Stop (Esc)"
                className="grid size-9 shrink-0 place-items-center rounded-full bg-brand-soft text-brand-ink transition hover:bg-[#e6dfff]">
          <Square aria-hidden="true" className="size-3.5" fill="currentColor" strokeWidth={0} />
        </button>
      ) : (
      <button type="button" onClick={send} disabled={!text.trim() || busy} aria-label="Send"
              className="grid size-9 shrink-0 place-items-center rounded-full bg-linear-to-b from-brand to-brand-hover text-white shadow-[0_3px_10px_rgb(110_76_245/0.35)] transition hover:brightness-110 disabled:bg-none disabled:bg-fill disabled:text-faint disabled:shadow-none">
        {busy ? <Loader2 aria-hidden="true" className="size-4 animate-spin" strokeWidth={2.4} /> : <ArrowUp aria-hidden="true" className="size-4" strokeWidth={2.6} />}
      </button>
      )}
    </div>
  );
}

/**
 * The assistant, small: a glowing box at the bottom of the canvas. Whatever is selected on the canvas shows
 * in it as a chip, so "make this one optional" has something to mean. Sending opens the chat beside the canvas.
 */
export function AssistantBar({ purposeKnown = true, inputRef, refs, onDropRef, onSend, onStop, busy, waiting, onOpen, className }) {
  return (
    <div className={cn("ai-glow pointer-events-auto flex flex-col gap-1 rounded-[26px] py-1.5 pr-1.5 pl-3.5", className)}
         onPointerDown={(event) => event.stopPropagation()}>
      {refs.length > 0 && <div className="px-0.5 pt-1.5 pr-2"><Refs refs={refs} onDrop={onDropRef} /></div>}
      <div className="flex items-center gap-2">
        <span className="grid size-9 shrink-0 place-items-center text-brand"><AiIcon aria-hidden="true" className="size-[18px]" strokeWidth={2.1} /></span>
        <div className="min-w-0 flex-1">
          <Composer inputRef={inputRef} busy={busy} onSend={onSend} onStop={onStop}
                    placeholder={!purposeKnown ? "First, why is this call being made?" : refs.length ? "What should change about it?" : "Ask AI to build or change the call…"} />
        </div>
        {/* Always there: opens the whole chat beside the canvas, with the conversation so far (and how many messages it has). */}
        <button type="button" onClick={onOpen} title="Open the chat" aria-label={waiting > 0 ? `Open the chat, ${waiting} messages` : "Open the chat"}
                className="flex h-9 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-xs font-semibold text-muted transition-colors hover:bg-brand-wash hover:text-brand-ink">
          <PanelRightOpen aria-hidden="true" className="size-4" strokeWidth={2} />{waiting > 0 && waiting}
        </button>
      </div>
    </div>
  );
}

const CARD = "mt-3 overflow-hidden rounded-2xl border border-line bg-white shadow-[0_1px_2px_rgb(17_17_20/0.04),0_12px_30px_-16px_rgb(17_17_20/0.2)]";
const kindName = (step) => (step.kind === "end" && step.handoff ? "Hand over" : KIND[step.kind || "ask"]);

/** The top of a list of offers: what it is, how many, and one control to tick them all or none. */
function ListHead({ title, count, ticked, all, onAll, open }) {
  return (
    <div className="flex items-center gap-2 border-b border-line bg-brand-wash/60 px-3.5 py-2.5">
      <AiIcon aria-hidden="true" className="size-4 shrink-0 text-brand" />
      <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-ink">
        {title} <span className="font-medium text-muted">· {count}</span>
      </span>
      {open && onAll && (
        <button type="button" onClick={onAll} className="shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold text-brand-ink hover:bg-brand-soft">
          {all ? "Clear" : "Tick all"}{!all && ticked ? ` (${ticked})` : ""}
        </button>
      )}
    </div>
  );
}

/** One thing the AI offers, with a box to tick: nothing is done until the ticked ones are applied. */
function Tick({ on, onToggle, disabled, step, number, tag, tone, text, strike }) {
  const look = lookOf(step);
  const Icon = look.icon;
  return (
    <button type="button" disabled={disabled} role="checkbox" aria-checked={on} onClick={onToggle}
            className={cn("group flex w-full items-start gap-3 px-3.5 py-3 text-left transition-colors",
                          on && !disabled ? "bg-brand-wash/70" : "bg-white", !disabled && !on && "hover:bg-hover")}>
      <span className={cn("mt-1 grid size-[18px] shrink-0 place-items-center rounded-md border transition-colors",
                          on ? "border-brand bg-brand text-white" : "border-[#c9c9d1] bg-white group-hover:border-brand/50")}>
        {on && <Check aria-hidden="true" className="size-3" strokeWidth={3.2} />}
      </span>
      <span className={cn("grid size-8 shrink-0 place-items-center rounded-lg", look.tile, strike && "opacity-50")}>
        <Icon aria-hidden="true" className="size-4" strokeWidth={2.1} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5 text-[11px] font-semibold tracking-wide">
          {tag && <span className={cn("rounded-full bg-current/10 px-1.5 py-px", tone)}>{tag}</span>}
          <span className="truncate text-muted">{number ? `${number}. ` : ""}{kindName(step)}</span>
        </span>
        <span className={cn("mt-1 line-clamp-3 block text-[13px] leading-snug text-ink", strike && "text-muted line-through")}>{text}</span>
      </span>
    </button>
  );
}

/** The buttons under a list of ticks: apply what is ticked; once applied, undo it, and then apply again. */
function Actions({ state, count, verb, onApply, onUndo, extra }) {
  if (state === "open") {
    return (
      <div className="flex items-center gap-2 border-t border-line bg-fill/50 px-3 py-2.5">
        <button type="button" disabled={!count} onClick={onApply}
                className="flex h-9 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-full bg-linear-to-b from-brand to-brand-hover px-4 text-[13px] font-semibold text-white shadow-[0_4px_12px_rgb(110_76_245/0.3)] transition hover:brightness-110 disabled:bg-none disabled:bg-[#e6e6ec] disabled:text-faint disabled:shadow-none">
          <Check aria-hidden="true" className="size-3.5 shrink-0" strokeWidth={2.6} />
          <span className="truncate">{count ? `${verb} ${count} selected` : `Tick the ones to ${verb.toLowerCase()}`}</span>
        </button>
        {extra}
      </div>
    );
  }
  if (state === "applied") {
    return (
      <div className="flex items-center gap-2 border-t border-line bg-good-soft/50 px-3.5 py-2.5">
        <span className="flex items-center gap-1.5 text-[13px] font-semibold text-good"><Check aria-hidden="true" className="size-4" strokeWidth={2.6} />Applied<span className="font-medium text-muted"> · not right? Undo</span></span>
        <span className="flex-1" />
        <button type="button" onClick={onUndo} className="flex h-8 items-center gap-1.5 rounded-full border border-edge bg-white px-3 text-[13px] font-semibold text-ink hover:bg-fill">
          <Undo2 aria-hidden="true" className="size-3.5" strokeWidth={2.4} />Undo
        </button>
      </div>
    );
  }
  return <p className="border-t border-line bg-fill/50 px-3.5 py-2.5 text-xs font-semibold text-muted">{state === "stale" ? "The call changed since this was suggested. Ask again." : "Discarded."}</p>;
}

/** Ideas from the AI (steps to add): tick the ones wanted. After adding they can be undone and added again. */
function Ideas({ ideas, onAdd, onUndo }) {
  const [ticked, setTicked] = useState([]);
  const flip = (index) => setTicked((now) => (now.includes(index) ? now.filter((one) => one !== index) : [...now, index]));
  const open = ideas.state === "open";
  const all = ticked.length === ideas.list.length;
  return (
    <div className={CARD}>
      <ListHead title="Ideas to add" count={ideas.list.length} ticked={ticked.length} all={all} open={open}
                onAll={() => setTicked(all ? [] : ideas.list.map((_, index) => index))} />
      <div className="divide-y divide-line">
        {ideas.list.map((idea, index) => (
          <Tick key={index} on={ticked.includes(index)} disabled={!open} onToggle={() => flip(index)} step={idea}
                text={idea.ask?.trim() || "Says goodbye in its own words"} />
        ))}
      </div>
      <Actions state={ideas.state === "added" ? "applied" : ideas.state} count={ticked.length} verb="Add"
               onApply={() => onAdd(ticked.map((index) => ideas.list[index]))} onUndo={onUndo} />
    </div>
  );
}

/** What a reply would change, one tick for each change: apply the ticked ones, undo them, apply again. */
function Proposal({ proposal, onApply, onUndo, onDiscard }) {
  const { added, edited, removed, reordered, state } = proposal;
  const text = (question) => question.ask?.trim() || "Says goodbye in its own words";
  const rows = [
    ...added.map((question) => ({ key: `add:${question.save_as}`, step: question, tag: "Add", tone: "text-good", text: text(question) })),
    ...edited.map((question) => ({ key: `edit:${question.save_as}`, step: question, tag: "Change", tone: "text-brand", text: text(question) })),
    ...removed.map((question) => ({ key: `remove:${question.save_as}`, step: question, tag: "Remove", tone: "text-bad", text: text(question), strike: true })),
  ];
  const [ticked, setTicked] = useState(() => rows.map((row) => row.key));
  const flip = (key) => setTicked((now) => (now.includes(key) ? now.filter((one) => one !== key) : [...now, key]));
  const all = ticked.length === rows.length;
  const open = state === "open";
  return (
    <div className={CARD}>
      <ListHead title={state === "applied" ? "Changes made" : "Suggested changes"} count={rows.length} ticked={ticked.length} all={all} open={open && rows.length > 0}
                onAll={() => setTicked(all ? [] : rows.map((row) => row.key))} />
      {proposal.restart && <p className="border-b border-line bg-brand-wash/40 px-3.5 py-2 text-xs font-semibold text-brand-ink">A new call: it replaces the steps now there.</p>}
      {rows.length === 0 && <p className="px-3.5 py-3 text-xs text-muted">{reordered ? "The same steps, in a different order." : "Nothing would change."}</p>}
      <div className="divide-y divide-line">
        {rows.map((row) => (
          <Tick key={row.key} on={ticked.includes(row.key)} disabled={!open} onToggle={() => flip(row.key)}
                step={row.step} tag={row.tag} tone={row.tone} text={row.text} strike={row.strike} />
        ))}
      </div>
      {reordered && rows.length > 0 && <p className="border-t border-line px-3.5 py-2 text-xs text-muted">With all ticked, some steps also change places.</p>}
      <Actions state={state} count={rows.length ? ticked.length : (reordered ? 1 : 0)} verb="Apply"
               onApply={() => onApply({ keys: ticked, all })} onUndo={onUndo}
               extra={<button type="button" onClick={onDiscard} className="h-9 shrink-0 rounded-full px-3.5 text-[13px] font-semibold text-muted hover:bg-white hover:text-ink">Discard</button>} />
    </div>
  );
}

const ANSWER = { text: "Free answer", number: "Number", date: "Date", time: "Time", yes_no: "Yes / No", choice: "Choice" };

/** What is worth knowing about a step beyond its wording, as small chips. */
function chipsOf(step) {
  const chips = [];
  const kind = step.kind || "ask";
  if (kind === "ask") {
    chips.push(ANSWER[step.type] || "Free answer");
    if (step.type === "choice" && step.options?.length) chips.push(step.options.join(" / "));
    if (step.required === false) chips.push("Optional");
  }
  if (kind === "end" && step.handoff) chips.push("Hand over to a person");
  if (kind === "loop") chips.push(`Goes back to ${step.back_to || "?"}${step.times ? `, up to ${step.times}x` : ""}`);
  if (step.only_if) chips.push(`Only if ${step.only_if}${step.only_if_is?.length ? ` is ${step.only_if_is.join(" or ")}` : ""}`);
  return chips;
}

/** The call's steps, in order, as they are now: what was asked to be seen (all, only the questions, only the messages). */
function FlowList({ flow }) {
  const { steps, filter, open, close } = flow;
  const all = filter === "all";
  const rows = steps.map((step, index) => ({ step, number: index + 1 }))
    .filter(({ step }) => all || (filter === "questions" ? (step.kind || "ask") === "ask" : step.kind === "say" || step.kind === "end"));
  const edge = (Icon, name, text, tile) => (
    <div className="flex items-start gap-3 bg-white px-3.5 py-2.5">
      <span className={cn("grid size-8 shrink-0 place-items-center rounded-lg", tile)}><Icon aria-hidden="true" className="size-4" strokeWidth={2.2} /></span>
      <span className="min-w-0 flex-1 pt-0.5">
        <span className="block text-[11px] font-semibold tracking-wide text-muted">{name}</span>
        <span className="block text-[12.5px] leading-snug text-muted">{text}</span>
      </span>
    </div>
  );
  return (
    <div className={CARD}>
      <ListHead title={all ? "Whole call flow" : filter === "questions" ? "Questions" : "Messages"} count={`${rows.length} ${rows.length === 1 ? "step" : "steps"}`} />
      <div className="divide-y divide-line">
        {all && open && edge(Phone, "Call starts", "The assistant greets the customer.", "bg-good text-white")}
        {rows.length === 0 && <p className="px-3.5 py-3 text-xs text-muted">Nothing like that in the call yet.</p>}
        {rows.map(({ step, number }) => {
          const look = lookOf(step);
          const Icon = look.icon;
          const chips = chipsOf(step);
          return (
            <div key={step.save_as || number} className="flex items-start gap-3 bg-white px-3.5 py-3">
              <span className={cn("grid size-8 shrink-0 place-items-center rounded-lg", look.tile)}><Icon aria-hidden="true" className="size-4" strokeWidth={2.1} /></span>
              <span className="min-w-0 flex-1">
                <span className="block text-[11px] font-semibold tracking-wide text-muted">{number}. {kindName(step)}</span>
                <span className="mt-1 block text-[13px] leading-snug text-ink">{step.ask?.trim() || (step.kind === "end" ? "Says goodbye in its own words" : "No wording yet")}</span>
                {chips.length > 0 && (
                  <span className="mt-1.5 flex flex-wrap gap-1">
                    {chips.map((chip) => <span key={chip} className="rounded-full bg-fill px-2 py-0.5 text-[11px] font-medium text-muted">{chip}</span>)}
                  </span>
                )}
              </span>
            </div>
          );
        })}
        {all && close && edge(PhoneOff, "Finish", "The call closes and the answers are saved.", "bg-bad text-white")}
      </div>
    </div>
  );
}

const PANEL = { min: 340, normal: 380, max: 760, key: "voice-call-chat-width" };
const panelMax = () => Math.max(PANEL.min, Math.min(PANEL.max, Math.round(window.innerWidth * 0.6)));   // never more than the canvas can spare
const keepWithin = (value) => Math.max(PANEL.min, Math.min(panelMax(), Math.round(value)));

/** The assistant, open: the conversation beside the canvas. Selecting a step puts it back at the bottom. */
export function AssistantPanel({ purposeKnown = true, context = "", onContext, onReset, inputRef, messages, busy, refs, onDropRef, onSend, onStop, onClose, onResize, onApply, onUndo, onDiscard, onAddIdeas, onUndoIdeas }) {
  const end = useRef(null);
  // The purpose sits folded to one line once it is written, so the conversation gets the room.
  const [editing, setEditing] = useState(!context.trim());
  // Pulled wider by its left edge, up to a limit; the width is remembered.
  const [width, setWidth] = useState(() => { try { return keepWithin(Number(localStorage.getItem(PANEL.key)) || PANEL.normal); } catch { return PANEL.normal; } });
  const [pulling, setPulling] = useState(false);
  const wide = useRef(width);
  wide.current = width;
  const remember = () => { try { localStorage.setItem(PANEL.key, String(wide.current)); } catch { /* optional */ } };
  const pull = { start: useRef(null) };
  const grab = (event) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    pull.start.current = { x: event.clientX, width };
    setPulling(true);
  };
  // One way to change the width: the canvas beside it is told by how much, so it can stay centred in what is left.
  const resizeTo = (next) => {
    const was = wide.current, now = keepWithin(next);
    if (now === was) return;
    wide.current = now;
    setWidth(now);
    onResize?.(now - was);
  };
  const drag = (event) => { if (pull.start.current) resizeTo(pull.start.current.width + (pull.start.current.x - event.clientX)); };
  const drop = () => { if (!pull.start.current) return; pull.start.current = null; setPulling(false); };
  useEffect(() => { if (!pulling) remember(); }, [width, pulling]); // eslint-disable-line react-hooks/exhaustive-deps
  const nudge = (event) => {
    const by = event.key === "ArrowLeft" ? 40 : event.key === "ArrowRight" ? -40 : 0;
    if (event.key === "Home") { event.preventDefault(); resizeTo(PANEL.normal); return; }
    if (!by) return;
    event.preventDefault();
    resizeTo(wide.current + by);
  };
  useEffect(() => { end.current?.scrollIntoView({ block: "end" }); }, [messages.length, busy]);
  useEffect(() => { inputRef.current?.focus({ preventScroll: true }); }, [inputRef]);

  return (
    <aside aria-label="AI assistant" style={{ "--chat-w": `${width}px` }}
           className={cn("relative z-30 flex w-(--chat-w) shrink-0 animate-[slide-in_.18s_ease-out] flex-col border-l border-line bg-white max-sm:fixed max-sm:inset-x-2 max-sm:bottom-[60px] max-sm:h-[70dvh] max-sm:w-auto max-sm:rounded-3xl max-sm:border max-sm:shadow-float", pulling && "select-none")}>
      {/* The left edge: pull it to the left to make the chat wider (double-click puts it back). Not on a phone, where it is a sheet. */}
      <div role="separator" aria-orientation="vertical" aria-label="Make the chat wider or narrower" aria-valuemin={PANEL.min} aria-valuemax={panelMax()} aria-valuenow={width}
           tabIndex={0} title="Drag to resize · double-click to reset"
           onPointerDown={grab} onPointerMove={drag} onPointerUp={drop} onPointerCancel={drop} onKeyDown={nudge}
           onDoubleClick={() => resizeTo(PANEL.normal)}
           className="group absolute inset-y-0 -left-1.5 z-10 flex w-3 cursor-col-resize touch-none items-center justify-center focus:outline-none max-sm:hidden">
        <span aria-hidden="true" className={cn("absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 rounded-full transition-colors group-hover:bg-brand/50 group-focus-visible:bg-brand/50", pulling ? "bg-brand" : "bg-transparent")} />
        <span aria-hidden="true" className={cn("relative h-10 w-1 rounded-full bg-[#c9c9d1] transition-all group-hover:h-14 group-hover:bg-brand", pulling && "h-14 bg-brand")} />
      </div>
      <div className="flex items-center gap-2.5 px-4 pt-3.5 pb-3">
        <Mark className="size-9" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[15px] leading-tight font-bold tracking-[-0.01em] text-ink">AI assistant</p>
          <p className="truncate text-xs text-muted">Builds and edits your call with you</p>
        </div>
        <button type="button" onClick={onReset} disabled={busy || messages.length === 0} aria-label="Start a new chat" title="New chat"
                className="grid size-8 place-items-center rounded-full text-muted hover:bg-fill hover:text-ink disabled:opacity-40 disabled:hover:bg-transparent">
          <RotateCcw aria-hidden="true" className="size-4" strokeWidth={2} />
        </button>
        <button type="button" onClick={onClose} aria-label="Put the chat back at the bottom" title="Back to the bottom"
                className="grid size-8 place-items-center rounded-full text-muted hover:bg-fill hover:text-ink">
          <PanelBottomClose aria-hidden="true" className="size-4" strokeWidth={2} />
        </button>
      </div>

      <div className="px-4 pb-3">
        {editing || !context.trim() ? (
          <label className="block rounded-2xl border border-line bg-canvas p-3">
            <span className="mb-1.5 flex items-center justify-between text-xs font-semibold text-ink">
              Say why it is calling<span className="font-medium text-faint">the AI works from this</span>
            </span>
            <textarea value={context} onChange={(event) => onContext?.(event.target.value)} rows={3}
                      placeholder="Say why the call is made and anything the assistant should know. e.g. Call customers to confirm their table booking for tonight."
                      className="max-h-32 min-h-[68px] w-full resize-y overflow-y-auto rounded-xl border border-line bg-white px-3 py-2 text-[13px] leading-snug text-ink placeholder:text-faint focus:border-brand focus:ring-3 focus:ring-brand/15 focus:outline-none" />
            <span className="mt-2 flex items-center gap-2">
              <RewriteButton text={context} onResult={(value) => onContext?.(value)} />
              {context.trim() && (
                <button type="button" onClick={() => setEditing(false)} className="ml-auto h-8 rounded-full px-3 text-xs font-semibold text-brand-ink hover:bg-brand-soft">Done</button>
              )}
            </span>
          </label>
        ) : (
          <button type="button" onClick={() => setEditing(true)} aria-label="Edit why it is calling"
                  className="group flex w-full items-start gap-2.5 rounded-2xl border border-line bg-canvas px-3.5 py-2.5 text-left transition-colors hover:border-edge">
            <span className="min-w-0 flex-1">
              <span className="block text-[11px] font-semibold tracking-wide text-faint uppercase">Say why it is calling</span>
              <span className="mt-0.5 line-clamp-2 block text-[13px] leading-snug text-ink">{context}</span>
            </span>
            <ChevronDown aria-hidden="true" className="mt-1 size-4 shrink-0 text-faint group-hover:text-ink" strokeWidth={2} />
          </button>
        )}
      </div>

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-2" aria-live="polite">
        {messages.length === 0 && (
          <div className="flex flex-col items-center gap-3 px-2 pt-6 pb-2 text-center">
            <Mark className="size-12" />
            <div>
              <p className="text-[15px] font-semibold text-ink">{purposeKnown ? "What should we work on?" : "Start with the reason for the call"}</p>
              <p className="mt-1 text-[13px] leading-relaxed text-muted">
                {purposeKnown ? "Ask for steps, change the wording, or click a step on the canvas to point at it."
                  : "Say why this call is being made, then I can suggest the steps."}
              </p>
            </div>
            {purposeKnown && (
              <div className="mt-1 flex flex-col items-stretch gap-2 self-stretch">
                {STARTERS.map((text) => (
                  <button key={text} type="button" disabled={busy} onClick={() => onSend(text)}
                          className="rounded-xl border border-line bg-white px-3.5 py-2.5 text-left text-[13px] font-medium text-ink transition-colors hover:border-brand/40 hover:bg-brand-wash disabled:opacity-50">
                    {text}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        {messages.map((message, at) => (message.role === "user" ? (
          <div key={at} className="flex flex-col items-end gap-1">
            {message.refs?.length > 0 && (
              <span className="max-w-[85%] truncate text-[11px] font-semibold text-brand-ink">about {message.refs.join(", ")}</span>
            )}
            <p className="max-w-[85%] rounded-[20px] rounded-br-md bg-linear-to-br from-brand to-[#8b5cf6] px-4 py-2.5 text-[14px] leading-snug whitespace-pre-wrap text-white shadow-[0_4px_14px_-4px_rgb(110_76_245/0.5)]">{message.text}</p>
          </div>
        ) : (
          <div key={at} className="flex gap-2.5">
            <Mark className="mt-0.5 size-6" />
            <div className="min-w-0 flex-1">
              <p className={cn("text-[14px] leading-relaxed whitespace-pre-wrap", message.failed ? "rounded-xl bg-bad-soft px-3 py-2 text-bad" : "text-ink")}>
                {message.text}
              </p>
              {message.flow && <FlowList flow={message.flow} />}
              {message.ideas && <Ideas ideas={message.ideas} onAdd={(chosen) => onAddIdeas(at, chosen)} onUndo={() => onUndoIdeas(at)} />}
              {message.proposal && <Proposal proposal={message.proposal} onApply={(pick) => onApply(at, pick)} onUndo={() => onUndo(at)} onDiscard={() => onDiscard(at)} />}
            </div>
          </div>
        )))}
        {busy && (
          <div className="flex items-center gap-2.5" role="status">
            <Mark className="size-6" spin />
            <span className="text-[13px] font-medium text-muted">Thinking…</span>
            {onStop && (
              <button type="button" onClick={onStop}
                      className="ml-1 flex h-7 items-center gap-1.5 rounded-full border border-edge bg-white px-2.5 text-xs font-semibold text-ink hover:bg-fill">
                <Square aria-hidden="true" className="size-3" fill="currentColor" strokeWidth={0} />Stop<span className="font-medium text-faint">Esc</span>
              </button>
            )}
          </div>
        )}
        <span ref={end} />
      </div>

      <div className="p-3 pt-2">
        <div className="ai-glow flex flex-col gap-1.5 rounded-[22px] py-1.5 pr-1.5 pl-3.5">
          {refs.length > 0 && <div className="pt-1.5 pr-1.5"><Refs refs={refs} onDrop={onDropRef} /></div>}
          <Composer inputRef={inputRef} busy={busy} onSend={onSend} onStop={onStop} placeholder={purposeKnown ? "Reply, or say what to change…" : "Why is this call being made?"} />
        </div>
      </div>
    </aside>
  );
}

/**
 * What could come next, offered beside the glowing button on the canvas: a few different steps to pick from.
 * Picking one adds it after the step being worked on.
 *
 *   at      {x, y} in the window
 *   state   {loading, options, problem}
 */
export function NextSteps({ at, state, onPick, onChat, onClose }) {
  const box = useRef(null);
  const [place, setPlace] = useState({ left: at.x, top: at.y });

  useLayoutEffect(() => {
    const size = box.current.getBoundingClientRect();
    setPlace({
      left: Math.max(8, Math.min(at.x, window.innerWidth - size.width - 8)),
      top: Math.max(8, Math.min(at.y, window.innerHeight - size.height - 8)),
    });
  }, [at.x, at.y, state.loading, state.options?.length]);

  useEffect(() => {
    const away = (event) => { if (!box.current?.contains(event.target)) onClose(); };
    const escape = (event) => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } };
    document.addEventListener("pointerdown", away, true);
    document.addEventListener("keydown", escape, true);
    window.addEventListener("wheel", onClose, { passive: true });
    return () => {
      document.removeEventListener("pointerdown", away, true);
      document.removeEventListener("keydown", escape, true);
      window.removeEventListener("wheel", onClose);
    };
  }, [onClose]);

  const options = state.options || [];
  return (
    <div ref={box} role="dialog" aria-label="Smart suggestions" style={place}
         className="ai-glow fixed z-[80] w-[280px] max-w-[calc(100vw-16px)] animate-[toast-in_.14s_ease-out] rounded-2xl bg-white p-1.5">
      <div className="flex items-center gap-2 px-2 pt-1 pb-2">
        <Mark className="size-6" spin={state.loading} />
        <div className="min-w-0">
          <p className="text-[13px] leading-tight font-semibold text-ink">Smart suggestions</p>
          <p className="text-[11px] text-muted">{state.loading ? "Thinking…" : "Pick one to add it next"}</p>
        </div>
      </div>
      {state.loading && (
        <div className="flex flex-col gap-2 px-1 pb-2" role="status" aria-label="Thinking of a few ideas">
          {[0, 1, 2].map((row) => (
            <span key={row} className="flex items-center gap-3 rounded-2xl border border-line px-3 py-3">
              <span className="size-8 rounded-xl bg-fill motion-safe:animate-pulse" />
              <span className="flex flex-1 flex-col gap-1.5"><span className="h-2 w-1/3 rounded-full bg-fill motion-safe:animate-pulse" /><span className="h-2.5 w-4/5 rounded-full bg-fill motion-safe:animate-pulse" /></span>
            </span>
          ))}
        </div>
      )}
      {state.problem && <p className="px-2.5 py-2 text-[13px] text-bad">{state.problem}</p>}
      {!state.loading && !state.problem && options.length === 0 && (
        <p className="px-2.5 py-2 text-[13px] text-muted">No more suggestions. This call already covers its purpose.</p>
      )}
      <div className="flex flex-col gap-1.5">
        {options.map((option, index) => {
          const look = lookOf(option);
          const Icon = look.icon;
          return (
            <button key={index} type="button" onClick={() => onPick(option)}
                    className="group flex w-full items-center gap-2.5 rounded-xl border border-line bg-white px-2.5 py-2 text-left transition-all hover:-translate-y-px hover:border-brand/40 hover:bg-brand-wash hover:shadow-[0_6px_16px_-8px_rgb(110_76_245/0.4)] focus-visible:border-brand focus-visible:outline-none">
              <span className={cn("grid size-7 shrink-0 place-items-center rounded-lg", look.tile)}>
                <Icon aria-hidden="true" className="size-3.5" strokeWidth={2.1} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[10px] font-semibold tracking-wide text-faint uppercase">
                  {option.kind === "end" && option.handoff ? "Hand over" : KIND[option.kind || "ask"]}
                  {option.only_if ? ` · only if ${option.only_if.replaceAll("_", " ")} is ${(option.only_if_is || []).join(" or ")}` : ""}
                </span>
                <span className="block text-[12.5px] leading-snug font-medium text-ink">{option.ask?.trim() || "Says goodbye in its own words"}</span>
              </span>
            </button>
          );
        })}
      </div>
      {!state.loading && (
        <button type="button" onClick={onChat}
                className="mt-1 flex w-full items-center justify-center gap-1.5 rounded-xl px-2.5 py-2 text-[12.5px] font-semibold text-brand-ink hover:bg-brand-soft">
          <MessagesSquare aria-hidden="true" className="size-4" strokeWidth={2} />Something else? Tell the AI
        </button>
      )}
    </div>
  );
}
