import {
  ArrowLeft, ArrowRight, Bot, CopyPlus, Flag, GitBranch, Megaphone, MessageCircleQuestion, Minus, Phone, PhoneForwarded, PhoneOff, Play,
  Plus, Repeat, Square, UserRound,
} from "lucide-react";
import { useState } from "react";
import { cn } from "../../lib/cn.js";
import { TYPES, commas } from "../../lib/setupForm.js";
import { orb } from "../../lib/thread.js";
import { Pills, Select, TextInput } from "../ui/fields.jsx";
import { RewriteButton } from "./RewriteButton.jsx";

const ANSWER_TYPES = [["text", "Text"], ["number", "Number"], ["date", "Date"], ["time", "Time"],
                      ["yes_no", "Yes / No"], ["choice", "Choice"]];

// What each kind of step is called at the top of its editor, and the badge it wears (the colours of its tile on the canvas).
const HEADS = {
  context: { kicker: "Say why it is calling", icon: MessageCircleQuestion, tile: "bg-why-soft text-why" },
  open: { kicker: "The call starts", icon: Phone, tile: "bg-good text-white" },
  close: { kicker: "At the end, the AI…", icon: PhoneOff, tile: "bg-bad text-white" },
  ask: { kicker: "The AI asks…", icon: Bot, tile: "bg-brand-soft text-brand" },
  answer: { kicker: "The customer answers…", icon: UserRound, tile: "bg-[#d3efdf] text-good" },
  say: { kicker: "The AI tells them…", icon: Megaphone, tile: "bg-[#0891b2]/12 text-[#0e7490]" },
  end: { kicker: "The call ends…", icon: PhoneOff, tile: "bg-bad text-white" },
  handoff: { kicker: "The AI hands over…", icon: PhoneForwarded, tile: "bg-[#0d9488]/12 text-[#0f766e]" },
  loop: { kicker: "The call goes back…", icon: Repeat, tile: "bg-loop-soft text-loop-ink" },
};

/** The badge and the line under the name at the top of a step's editor. */
export function headOf(step) {
  const key = step.kind === "end" && step.question?.handoff ? "handoff" : step.kind;
  return HEADS[key] || HEADS.ask;
}

const IconButton = ({ label, icon: Icon, danger, ...props }) => (
  <button type="button" aria-label={label} title={label}
          className={cn("grid size-8 place-items-center rounded-full text-muted transition-colors disabled:opacity-30",
                        danger ? "hover:bg-bad-soft hover:text-bad" : "hover:bg-fill hover:text-ink")}
          {...props}>
    <Icon aria-hidden="true" className="size-4" strokeWidth={2} />
  </button>
);

const hasKeyboard = () => window.matchMedia?.("(pointer: fine)").matches;

/** A labelled part of the editor, with an optional line of help under it. */
const Block = ({ label, hint, children }) => (
  <div className="flex flex-col gap-2">
    {label && <span className="text-[13px] font-medium text-ink">{label}</span>}
    {children}
    {hint && <p className="text-[12px] leading-relaxed text-muted">{hint}</p>}
  </div>
);

/** The box every step begins with: what the step says, in the size it will be read. */
const Say = ({ value, onChange, placeholder, rows = 3 }) => (
  <textarea autoFocus={hasKeyboard() && !value.trim()} value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} rows={rows}
            className="block w-full resize-none rounded-2xl border border-edge bg-white px-3.5 py-3 text-[15px] leading-relaxed text-ink
                       transition-colors placeholder:text-faint hover:border-[#c9c9d1] focus:border-brand focus:ring-3 focus:ring-brand/15 focus:outline-none" />
);

/** A number that goes up and down in steps, with its unit written beside it. */
function Stepper({ value, unit, onLess, onMore, lessDisabled, moreDisabled, lessLabel, moreLabel }) {
  return (
    <div className="flex w-fit items-center gap-1 rounded-full border border-edge bg-white p-0.5">
      <button type="button" aria-label={lessLabel} disabled={lessDisabled} onClick={onLess}
              className="grid size-8 place-items-center rounded-full text-muted hover:bg-fill hover:text-ink disabled:opacity-30">
        <Minus aria-hidden="true" className="size-3.5" strokeWidth={2.4} />
      </button>
      <span className="min-w-20 text-center font-mono text-[13px] font-semibold text-ink">{value} {unit}</span>
      <button type="button" aria-label={moreLabel} disabled={moreDisabled} onClick={onMore}
              className="grid size-8 place-items-center rounded-full text-muted hover:bg-fill hover:text-ink disabled:opacity-30">
        <Plus aria-hidden="true" className="size-3.5" strokeWidth={2.4} />
      </button>
    </div>
  );
}

/** Who is speaking: an orb in the voice's own colours, and the voice to pick. One voice speaks the whole call. */
function VoiceChip({ form, voices, set }) {
  const known = voices.some((voice) => voice.id === form.voice_id);
  const options = [["", "Default voice"], ...voices.map((voice) => [voice.id, voice.name]),
                   ...(form.voice_id && !known ? [[form.voice_id, `Voice ${form.voice_id}`]] : [])];
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span aria-hidden="true" className="size-7 shrink-0 rounded-full" style={{ background: orb(form.voice_id || "default") }} />
      <select aria-label="Voice" value={form.voice_id} onChange={(event) => set("voice_id", event.target.value)}
              className="min-w-0 max-w-[170px] cursor-pointer truncate border-0 bg-transparent text-[13px] font-semibold text-ink">
        {options.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select>
    </div>
  );
}

/** The voice and the button to hear it, as one row. */
function Voice({ form, voices, set, hearing, onHear }) {
  return (
    <div className="flex items-center gap-2 rounded-2xl border border-line bg-canvas p-2 pl-3">
      <VoiceChip form={form} voices={voices} set={set} />
      <span className="flex-1" />
      <button type="button" onClick={onHear}
              className="flex h-8 shrink-0 items-center gap-1.5 rounded-full bg-brand px-3.5 text-[13px] font-semibold text-white transition-colors hover:bg-brand-hover">
        {hearing ? <Square aria-hidden="true" className="size-3" fill="currentColor" /> : <Play aria-hidden="true" className="size-3" fill="currentColor" />}
        {hearing ? "Stop" : "Hear it"}
      </button>
    </div>
  );
}

const Note = ({ children }) => <p className="text-[12px] leading-relaxed text-muted">{children}</p>;

/**
 * The editor of a selected step, in the side panel. Each kind of step asks for just what it is: why it is
 * calling, a question for its wording, an answer for what counts, the close for how it ends. The panel's own
 * header (name, remove, close) is drawn by the page, from `headOf`.
 */
export function StepCard({ step, form, set, voices, questions, hearing, onHear, onMove, onChange, onDuplicate, onAddAfter }) {
  const stack = "flex flex-col gap-5";

  if (step.kind === "context") {
    return (
      <div className={stack}>
        <Block label="Why is the call being made?" hint="The assistant uses this to word every question and to know when the call is done.">
          <Say value={form.purpose} onChange={(value) => set("purpose", value)} rows={6}
               placeholder="Describe why you are calling and what the assistant should know. For example: confirm tonight’s table booking, and mention we close at 11pm." />
          <div><RewriteButton text={form.purpose} onResult={(value) => set("purpose", value)} /></div>
        </Block>
      </div>
    );
  }

  if (step.kind === "open") {
    return (
      <div className={stack}>
        <Note>The assistant says hello and who is calling, then goes on to the first step.</Note>
        <Block label="Voice"><Voice form={form} voices={voices} set={set} hearing={hearing} onHear={onHear} /></Block>
      </div>
    );
  }

  if (step.kind === "close") {
    const minutes = Number(form.max_minutes || 4);
    const bump = (by) => set("max_minutes", String(Math.min(30, Math.max(1, minutes + by))));
    return (
      <div className={stack}>
        <Block label="Repeat the answers back to them">
          <Pills label="Read the answers back" options={[["on", "Yes"], ["off", "No"]]}
                 value={form.confirm_at_end ? "on" : "off"} onChange={(value) => set("confirm_at_end", value === "on")} />
        </Block>
        <Block label="End the call after" hint="It thanks them and ends the call, or sooner if every answer is in.">
          <Stepper value={minutes} unit="min" lessLabel="Shorter" moreLabel="Longer" onLess={() => bump(-0.5)} onMore={() => bump(0.5)} />
        </Block>
      </div>
    );
  }

  const { question, index } = step;
  // Only a question asked above can be waited on.
  const earlier = questions.slice(0, index).filter((other) => (other.kind || "ask") === "ask").map((other) => other.save_as).filter(Boolean);
  const names = [...new Set([...earlier, question.only_if].filter(Boolean))];

  /** Move, duplicate, add another after it: along the bottom of every step that is in the line. */
  const Along = (
    <div className="flex items-center gap-0.5 rounded-2xl bg-canvas p-1.5">
      <IconButton label="Earlier" icon={ArrowLeft} disabled={index === 0} onClick={() => onMove(index - 1)} />
      <IconButton label="Later" icon={ArrowRight} disabled={index === questions.length - 1} onClick={() => onMove(index + 2)} />
      <IconButton label="Duplicate" icon={CopyPlus} onClick={onDuplicate} />
      <IconButton label="Add a question after this" icon={Plus} onClick={onAddAfter} />
      <span className="ml-1.5 text-xs text-muted">Step {index + 1} of {questions.length}. Drag a tile to move it.</span>
    </div>
  );

  if (step.kind === "say") {
    return (
      <div className={stack}>
        <Block label="What it says" hint="Said in its own words, just before the next question. It doesn’t wait for an answer.">
          <Say value={question.ask} onChange={(value) => onChange({ ask: value })} rows={3}
               placeholder="What should it say? e.g. “Just so you know, a receipt will be emailed to you.”" />
        </Block>
        <Voice form={form} voices={voices} set={set} hearing={hearing} onHear={onHear} />
        <Condition question={question} names={names} questions={questions} onChange={onChange} label="Only say it if…" />
        {Along}
      </div>
    );
  }

  if (step.kind === "end") {
    return (
      <div className={stack}>
        <Condition question={question} names={names} questions={questions} onChange={onChange}
                   label={question.handoff ? "Hand over when… (optional)" : "End the call when… (optional)"} />
        <Block label="Last thing it says">
          <Say value={question.ask} onChange={(value) => onChange({ ask: value })} rows={2}
               placeholder={question.handoff ? "What it says last. Leave empty and it will say someone will be in touch."
                 : "What it says last. Leave empty and it will write a goodbye."} />
        </Block>
        <Block label="What happens"
               hint={question.handoff
                 ? "The call is marked for a person to follow up. Nobody is phoned for you yet: it is noted on the call for someone to follow up."
                 : "Questions after it are not asked, and don’t count against the call being complete."}>
          <Pills label="What happens" options={[["end", "End the call"], ["handoff", "Hand over to a person"]]}
                 value={question.handoff ? "handoff" : "end"} onChange={(value) => onChange({ handoff: value === "handoff" })} />
        </Block>
        {Along}
      </div>
    );
  }

  if (step.kind === "loop") {
    const times = Math.min(5, Math.max(1, Number(question.times) || 2));
    const wording = (name) => questions.find((other) => other.save_as === name)?.ask?.trim() || name;
    const targets = [...new Set([...earlier, question.back_to].filter(Boolean))];
    return (
      <div className={stack}>
        <Condition question={question} names={names} questions={questions} onChange={onChange} mandatory label="Go back when…" />
        <Block label="Go back to">
          <Select aria-label="The question to go back to" value={question.back_to || ""} onChange={(event) => onChange({ back_to: event.target.value })}
                  options={[["", targets.length ? "Choose a question…" : "No question above it yet"], ...targets.map((name) => [name, wording(name)])]} />
        </Block>
        <Block label="At most"
               hint={`The answers from that question up to here are forgotten and asked again. After ${times} ${times === 1 ? "time" : "times"} it carries on, so a call can never go round for ever.`}>
          <Stepper value={times} unit={times === 1 ? "time" : "times"} lessLabel="Fewer times" moreLabel="More times"
                   lessDisabled={times <= 1} moreDisabled={times >= 5}
                   onLess={() => onChange({ times: times - 1 })} onMore={() => onChange({ times: times + 1 })} />
        </Block>
        <Block label="What it says as it goes back">
          <Say value={question.ask} onChange={(value) => onChange({ ask: value })} rows={2}
               placeholder="What it says as it goes back. Leave empty and it will find its own words." />
        </Block>
        {Along}
      </div>
    );
  }

  if (step.kind === "ask") {
    return (
      <div className={stack}>
        <Block label="What it asks">
          <Say value={question.ask} onChange={(value) => onChange({ ask: value })}
               placeholder="What should it ask? e.g. “How many people are coming?”" />
        </Block>
        <Voice form={form} voices={voices} set={set} hearing={hearing} onHear={onHear} />
        <Condition question={question} names={names} questions={questions} onChange={onChange} label="Only ask if…" />
        {Along}
      </div>
    );
  }

  // The customer's answer
  return (
    <div className={stack}>
      <Block label="What counts as a good answer">
        <Say value={question.rule || ""} onChange={(value) => onChange({ rule: value })} rows={2}
             placeholder="e.g. “Between 1 and 20 people. We are closed on Mondays.”" />
      </Block>
      <Block label="Answer is a">
        <Pills label="Kind of answer" options={ANSWER_TYPES.filter(([type]) => TYPES.includes(type))} value={question.type}
               onChange={(type) => onChange({ type })} />
      </Block>
      {question.type === "choice" && (
        <Block label="Options, separated by commas">
          <TextInput value={question._optionsText ?? (question.options || []).join(", ")} placeholder="inside, outside"
                     onChange={(event) => onChange({ _optionsText: event.target.value, options: commas(event.target.value) })} />
        </Block>
      )}
      <Block label="Must they answer?">
        <Pills label="Required" options={[["yes", "Yes"], ["no", "No, optional"]]}
               value={question.required !== false ? "yes" : "no"} onChange={(value) => onChange({ required: value === "yes" })} />
      </Block>
      <details className="group rounded-2xl border border-line">
        <summary className="cursor-pointer list-none px-3.5 py-3 text-[13px] font-semibold text-ink [&::-webkit-details-marker]:hidden">
          More options
        </summary>
        <div className="flex flex-col gap-2 border-t border-line px-3.5 py-3.5">
          <span className="text-[13px] font-medium text-ink">Column name in results and exports</span>
          <TextInput className="font-mono text-[13px]" value={question.save_as} placeholder="filled in from the question"
                     onChange={(event) => onChange({ save_as: event.target.value })}
                     onBlur={() => { if (!question.save_as) onChange({ _reauto: true }); }} />
          <span className="text-xs text-muted">Chosen for you from the question. You only need this if you read the results in a spreadsheet.</span>
        </div>
      </details>
    </div>
  );
}

/**
 * "Only if…": a step that waits on an earlier answer. `mandatory` is for an end, which without a condition
 * would end every call, so there is no "always".
 */
function Condition({ question, names, questions, onChange, label, mandatory = false }) {
  const [open, setOpen] = useState(false);
  const parent = questions.find((other) => other.save_as === question.only_if && (other.kind || "ask") === "ask");
  const hint = parent?.type === "yes_no" ? "no" : parent?.type === "choice" ? (parent.options || []).join(", ") : "";

  if (!names.length) {
    return mandatory
      ? <p className="rounded-2xl bg-canvas px-3.5 py-3 text-[13px] text-muted">Add a question above it first: this waits on an answer.</p>
      : null;
  }
  if (!mandatory && !question.only_if && !open) {
    return (
      <button type="button" onClick={() => setOpen(true)}
              className="flex h-10 items-center justify-center gap-2 rounded-2xl border border-dashed border-brand/40 text-[13px] font-semibold text-brand-ink hover:bg-brand-wash">
        <GitBranch aria-hidden="true" className="size-4" strokeWidth={2} />{label}
      </button>
    );
  }
  return (
    <div className="flex flex-col gap-3.5 rounded-2xl border border-brand/15 bg-brand-wash p-3.5">
      <div className="flex items-center gap-2 text-[13px] font-semibold text-brand-ink">
        <GitBranch aria-hidden="true" className="size-4" strokeWidth={2} />{label}
      </div>
      <div className="flex flex-col gap-2">
        <span className="text-[13px] font-medium text-ink">{label.replace("…", "")}</span>
        <Select aria-label="Question it waits on" options={[["", mandatory ? "Pick a question" : "Always"], ...names.map((name) => [name, `“${questions.find((other) => other.save_as === name)?.ask?.trim().slice(0, 40) || name}” is…`])]}
                value={question.only_if || ""} onChange={(event) => onChange({ only_if: event.target.value })} />
      </div>
      {question.only_if && (
        <div className="flex flex-col gap-2">
          <span className="text-[13px] font-medium text-ink">…any of these answers (separate with commas)</span>
          <TextInput aria-label="Answers it waits for" value={question._onlyIfIsText ?? (question.only_if_is || []).join(", ")} placeholder={hint}
                     onChange={(event) => onChange({ _onlyIfIsText: event.target.value, only_if_is: commas(event.target.value) })} />
        </div>
      )}
    </div>
  );
}
