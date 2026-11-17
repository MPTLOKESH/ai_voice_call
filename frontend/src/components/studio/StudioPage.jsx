import {
  AlignHorizontalDistributeCenter, AlignVerticalDistributeCenter, Check, ChevronDown, ChevronLeft, Copy, GitBranch, History, LayoutGrid,
  Bot, Loader2, Maximize2, Megaphone, MessagesSquare, PanelRightClose, PanelRightOpen, Pause, Pencil, Phone, Play, Plus, Redo2, Repeat, RotateCcw,
  Settings2, SquareDashedMousePointer, Trash2, TriangleAlert, Undo2, Upload, X,
} from "lucide-react";
import { AiIcon } from "../ui/AiIcon.jsx";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as api from "../../lib/api.js";
import { cn } from "../../lib/cn.js";
import { PAIR_W, TIDY, layoutNodes } from "../../lib/layout.js";
import { sampleGreeting, speakLine } from "../../lib/speak.js";
import {
  CLOSE, CONTEXT, OPEN, TILE, answerId, askId, buildSteps, clock, estimateSeconds, humanize, questionIssue,
} from "../../lib/thread.js";
import { NO_AUDIO, wait } from "../../lib/useVoice.js";
import { Button } from "../ui/Button.jsx";
import { ConfirmDialog } from "../ui/Dialog.jsx";
import { Menu } from "../ui/Menu.jsx";
import { useToast } from "../ui/Toasts.jsx";
import { QUESTION_PRESETS, STEP_BLOCKS, stepFields } from "../../lib/presets.js";
import { AssistantBar, AssistantPanel, diffSteps, signature } from "./Assistant.jsx";
import { Canvas } from "./Canvas.jsx";
import { ContextMenu } from "./ContextMenu.jsx";
import { ListView } from "./ListView.jsx";
import { SettingsDrawer } from "./SettingsDrawer.jsx";
import { StepCard, headOf } from "./StepCard.jsx";
import { VersionsDialog } from "./VersionsDialog.jsx";

const TYPE_LABELS = { text: "Text", number: "Number", date: "Date", time: "Time", yes_no: "Yes / No", choice: "Choice" };
const snippet = (text) => (text.trim().length > 26 ? `${text.trim().slice(0, 25)}…` : text.trim());
const isAsk = (question) => (question.kind || "ask") === "ask";

/** Under the flow's name: whether what is on screen is stored, and what to do when it couldn't be. */
function SaveStatus({ setupState, flow, onDiscard }) {
  const { status } = setupState;
  const changed = flow.status !== "Draft" && flow.unpublished_changes && status === "saved";
  const dot = { saved: "bg-live", saving: "bg-amber", failed: "bg-bad", conflict: "bg-bad" }[status];
  return (
    <span aria-live="polite" className="flex min-w-0 items-center gap-1.5 text-xs text-faint">
      <span className={cn("size-1.5 shrink-0 rounded-full", changed ? "bg-amber" : dot)} />
      {status === "saving" && "Saving…"}
      {status === "conflict" && <span className="font-medium text-bad">Changed in another tab</span>}
      {status === "failed" && (
        <>
          <span className="font-medium text-bad">Couldn’t save</span>
          <button type="button" onClick={() => setupState.save()} className="font-semibold text-ink underline-offset-2 hover:underline">Retry</button>
        </>
      )}
      {status === "saved" && !changed && "All changes saved"}
      {changed && (
        <>
          <span className="truncate">Saved · not published yet</span>
          <button type="button" onClick={onDiscard} className="shrink-0 font-semibold text-ink underline-offset-2 hover:underline">Discard</button>
        </>
      )}
    </span>
  );
}

/** Under a step's editor: whether it is stored, or what it still needs, and Done to close it. Changes save on their own. */
function StepStatus({ issue, status, onDone }) {
  const problem = issue && issue !== "Ready" ? issue : "";
  return (
    <div className="flex items-center gap-3">
      <span aria-live="polite" className={cn("flex min-w-0 flex-1 items-center gap-2 text-[13px]", problem ? "text-warn" : "text-muted")}>
        {problem ? <span className="size-2 shrink-0 rounded-full bg-amber" />
          : status === "saving" ? <Loader2 aria-hidden="true" className="size-3.5 shrink-0 motion-safe:animate-spin" />
          : <Check aria-hidden="true" className="size-3.5 shrink-0 text-good" strokeWidth={2.6} />}
        <span className="truncate">
          {problem || (status === "saving" ? "Saving…" : status === "failed" ? "Couldn’t save. Try again from the top." : "Saved. It saves as you type.")}
        </span>
      </span>
      <button type="button" onClick={onDone}
              className="rounded-full bg-brand px-4 py-2 text-[13px] font-semibold text-white transition-colors hover:bg-brand-hover">
        Done
      </button>
    </div>
  );
}

/** Other ways to word the selected step, from the AI, to pick from. */
function Wording({ state, onPick, onAsk, canAsk }) {
  if (!canAsk) return null;
  return (
    <div className="mt-5 rounded-2xl border border-brand/15 bg-brand-wash p-3.5">
      <div className="flex items-center gap-2">
        <AiIcon aria-hidden="true" spin={state?.loading} className="size-[18px] text-brand" />
        <span className="flex-1 text-[13px] font-semibold text-ink">Other ways to say it</span>
        <button type="button" onClick={onAsk} disabled={state?.loading}
                className="h-8 rounded-full border border-brand/25 bg-white px-3.5 text-xs font-semibold text-brand-ink hover:bg-brand-soft disabled:opacity-60">
          {state?.loading ? "Thinking…" : state?.options ? "Again" : "Suggest"}
        </button>
      </div>
      {state?.loading && (
        <p className="mt-2 flex items-center gap-2 text-xs text-muted"><Loader2 aria-hidden="true" className="size-3.5 motion-safe:animate-spin" />Writing a few ways to put it…</p>
      )}
      {state?.problem && <p role="alert" className="mt-2 text-xs font-medium text-bad">{state.problem}</p>}
      {state?.options && state.options.length === 0 && <p className="mt-2 text-xs text-muted">Nothing different from what is there already.</p>}
      {state?.options?.map((option) => (
        <button key={option} type="button" onClick={() => onPick(option)}
                className="mt-2 block w-full rounded-xl border border-line bg-white px-3 py-2.5 text-left text-[13px] leading-snug text-ink transition-all hover:-translate-y-px hover:border-brand/40 hover:shadow-[0_6px_16px_-8px_rgb(110_76_245/0.4)]">
          {option}
        </button>
      ))}
    </div>
  );
}

/** Which steps a message asks to SEE ("all", "questions", "messages"), or "": the same reading the server makes, in case it did not say. */
function showWanted(text) {
  const said = text || "";
  if (!/\b(show|list|display|see|view|print|read out|what (are|is|do)|what \w+ (are|is|do|does)|what's|whats|give me|tell me)\b/i.test(said)) return "";
  if (/\b(add|creat\w*|build\w*|generat\w*|new|make|write|remove|delete|change|reword)\b/i.test(said)) return "";
  if (!/\b(flow|steps?|script|questions?|messages?|(whole|entire|full|complete) call)\b/i.test(said)) return "";
  const asks = /\bquestions?\b/i.test(said), says = /\b(messages?|say|says|tell|tells)\b/i.test(said);
  return asks && !says ? "questions" : says && !asks ? "messages" : "all";
}

/** A flow's saved talk with the assistant, or none. */
function loadChat(key) {
  try {
    const list = JSON.parse(localStorage.getItem(key) || "[]");
    return Array.isArray(list) ? list : [];
  } catch { return []; }
}

/**
 * The studio: the call on a canvas where every step can be put anywhere. Blocks come from the bar along
 * the top; the editor for the selected step docks on the right, and can be minimised.
 */
export function StudioPage({ flow, setupState, voices, voice, onTest, onPublish, onBack, onVoices }) {
  const toast = useToast();
  const { form, set, setup, name, setName, saving, conflict } = setupState;
  const [confirming, setConfirming] = useState(null);   // {kind: "remove", question, dependents} or {kind: "discard"}
  const [selectedId, setSelectedId] = useState(null);
  // The talk with the assistant: [{role, text, refs, proposal}]. It is kept for each flow, through leaving the page and
  // reloading, until it is reset with the New chat button.
  const chatKey = `voice-call-chat-${flow?.id ?? "new"}`;
  const [chat, setChat] = useState(() => loadChat(chatKey));
  const [chatOpen, setChatOpen] = useState(() => { try { return localStorage.getItem(`${chatKey}:open`) === "1" && loadChat(chatKey).length > 0; } catch { return false; } });   // open beside the canvas; shut, it is the small box at the bottom
  const chatOf = useRef(chatKey);
  useEffect(() => {
    if (chatOf.current !== chatKey) return;               // the flow changed: the new one's talk is loaded below first
    try {
      if (chat.length) localStorage.setItem(chatKey, JSON.stringify(chat.slice(-60)));
      else localStorage.removeItem(chatKey);
      localStorage.setItem(`${chatKey}:open`, chatOpen ? "1" : "0");
    } catch { /* optional */ }
  }, [chat, chatOpen, chatKey]);
  useEffect(() => {
    if (chatOf.current === chatKey) return;
    chatOf.current = chatKey;
    setChat(loadChat(chatKey));
  }, [chatKey]);
  const [chatBusy, setChatBusy] = useState(false);
  const stopper = useRef(null);                          // the request the AI is working on, so it can be stopped
  const stopThinking = useCallback(() => stopper.current?.abort(), []);
  // Escape stops the AI while it is thinking.
  useEffect(() => {
    if (!chatBusy) return undefined;
    const escape = (event) => { if (event.key === "Escape") stopThinking(); };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [chatBusy, stopThinking]);
  const chatInput = useRef(null);
  const [menu, setMenu] = useState(null);               // the right-click menu: {x, y, node, tile} or {x, y, world}
  const [picked, setPicked] = useState([]);             // the nodes picked on the canvas: one, or many to move or delete together
  const [cardOpen, setCardOpen] = useState(false);
  const [minimized, setMinimized] = useState(false);
  const [settings, setSettings] = useState(false);
  const [versions, setVersions] = useState(false);
  const [issuesOpen, setIssuesOpen] = useState(false);
  const [activeId, setActiveId] = useState(null);   // the step being spoken during Listen
  const [elapsed, setElapsed] = useState(0);
  const [ghost, setGhost] = useState(null);         // a block being carried: {x, y, block, tint}
  const [trashLit, setTrashLit] = useState(false);
  const [wording, setWording] = useState({});       // {stepId: {loading, options, problem}}
  const canvas = useRef(null);
  const trash = useRef(null);
  // A plain numbered list is the way in; the free canvas is the same flow drawn however the person likes.
  const [view, setView] = useState(() => { try { return localStorage.getItem("voice-call-studio-view") === "list" ? "list" : "canvas"; } catch { return "canvas"; } });
  const chooseView = (next) => { setView(next); try { localStorage.setItem("voice-call-studio-view", next); } catch { /* optional */ } };

  const questions = form.questions;
  const voiceName = voices.find((one) => one.id === form.voice_id)?.name || (form.voice_id ? "Custom voice" : "Default voice");

  const steps = useMemo(() => buildSteps(questions, { open: form.show_open !== false, close: form.show_close !== false }).map((step) => {
    if (step.kind === "context") {
      const ready = Boolean(form.purpose.trim());
      return { ...step, title: "Say why it is calling", sub: ready ? snippet(form.purpose) : "Tell the assistant the reason", flag: { ok: ready, note: ready ? "Ready" : "Say why it is calling" } };
    }
    if (step.kind === "open") return { ...step, title: "Call starts", sub: voiceName };
    if (step.kind === "ask") {
      const issue = questionIssue(step.question, step.index, questions);
      return { ...step, number: step.index + 1, title: (step.question.ask.trim() && snippet(step.question.ask)) || "New question", sub: issue || voiceName, flag: { ok: !issue, note: issue || "Ready" } };
    }
    if (step.kind === "say") {
      const issue = questionIssue(step.question, step.index, questions);
      return { ...step, number: step.index + 1, title: "Message", sub: issue || snippet(step.question.ask), flag: { ok: !issue, note: issue || "Ready" } };
    }
    if (step.kind === "end") {
      const issue = questionIssue(step.question, step.index, questions);
      const what = step.question.handoff ? "Hand over" : "End call";
      return { ...step, number: step.index + 1, title: what, sub: issue || `if ${humanize(step.question.only_if)} is ${(step.question.only_if_is || []).join(" or ")}`, flag: { ok: !issue, note: issue || "Ready" } };
    }
    if (step.kind === "loop") {
      const issue = questionIssue(step.question, step.index, questions);
      const target = questions.find((one) => one.save_as === step.question.back_to);
      return { ...step, number: step.index + 1, title: "Go back", sub: issue || `to “${snippet(target?.ask || "") || humanize(step.question.back_to)}”`, flag: { ok: !issue, note: issue || "Ready" } };
    }
    if (step.kind === "answer") {
      const { type, required } = step.question;
      return { ...step, title: "Their answer", sub: TYPE_LABELS[type] + (required === false ? " · optional" : "") };
    }
    return { ...step, title: "Finish", sub: form.confirm_at_end ? "Reads answers back" : "Ends the call" };
  }), [questions, form.purpose, form.confirm_at_end, voiceName]);

  // The opening and the finish are on the canvas unless they were taken off it.
  const nodes = useMemo(
    () => layoutNodes(questions, form.show_open === false ? null : form.open_at, form.show_close === false ? null : form.close_at),
    [questions, form.open_at, form.close_at, form.show_open, form.show_close]);
  const details = useMemo(() => Object.fromEntries(steps.map((step) => [step.id, step])), [steps]);
  const selected = steps.find((step) => step.id === selectedId);
  const total = estimateSeconds(questions);
  const tooLong = total > Number(form.max_minutes || 4) * 60;

  // What is stopping it being tried or published, each one a step to jump to.
  const issues = useMemo(() => {
    const found = [];
    if (!form.purpose.trim()) found.push({ id: CONTEXT, text: "Say why it is calling" });
    if (!questions.some(isAsk)) found.push({ id: null, text: "Add at least one question" });
    steps.forEach((step) => {
      if (step.kind !== "context" && step.flag && !step.flag.ok) found.push({ id: step.id, text: `${step.title}: ${step.flag.note}` });
    });
    return found;
  }, [steps, form.purpose, questions]);

  // A step that goes away (removed, or the form cleared) can't stay selected.
  useEffect(() => { if (selectedId && !selected) { setSelectedId(null); setCardOpen(false); } }, [selectedId, selected]);

  // A step just added can land off screen (after the last one, behind the editor): once it is drawn, the view goes to it.
  const bringIntoView = useRef(null);
  useEffect(() => {
    if (bringIntoView.current && steps.some((step) => step.id === bringIntoView.current)) {
      canvas.current?.focus(bringIntoView.current);
      bringIntoView.current = null;
    }
  });

  /** One step selected to be edited: it is the only one picked. */
  const select = (id) => {
    const node = nodes.find((one) => one.tiles.some((tile) => tile.id === id));
    // A step only just added is not drawn yet: its node is named in its tile's id.
    setSelectedId(id); setCardOpen(true); setMinimized(false); setPicked([node ? node.id : id.replace(/:(ask|answer)$/, "")]);
    setChatOpen(false);                                  // the editor takes the side; the chat goes back to the bottom
  };
  /** Nothing selected, nothing picked, the editor shut. */
  const deselect = () => { setSelectedId(null); setCardOpen(false); setPicked([]); };
  const byKey = (key) => questions.find((one) => one._key === key);

  /** Removes a step straight away. */
  function remove(question, sure = false) {
    // Deleted at once, no question asked: Ctrl+Z brings it back. Steps that waited on it now run on every call, and it says so.
    const dependents = setupState.dependentsOf(question._key);
    setupState.removeQuestion(question._key);
    deselect();
    toast(dependents.length
      ? `Step removed. ${dependents.length === 1 ? "One step that waited on it now runs" : `${dependents.length} steps that waited on it now run`} on every call. Ctrl+Z undoes it.`
      : "Step removed. Ctrl+Z undoes it.");
  }

  /** Takes the opening or the finish off the canvas. The call still greets and still says goodbye. */
  function hideEnd(id) {
    if (id === OPEN) { set("show_open", false); return; }
    set("show_close", false);
    if (form.confirm_at_end) set("confirm_at_end", false);     // with no finish step, nothing is read back
  }

  /** Removes everything picked at once, the opening and the finish too, asking first when steps left behind wait on one of them. */
  function removeMany(ids, sure = false) {
    const keys = ids.filter(byKey);
    const last = ids.filter((id) => (id === OPEN && form.show_open !== false) || (id === CLOSE && form.show_close !== false));
    if (!keys.length && !last.length) return;
    if (keys.length === 1 && !last.length) { remove(byKey(keys[0]), sure); return; }
    if (keys.length) setupState.removeQuestions(keys);
    last.forEach(hideEnd);
    deselect();
    if (keys.length + last.length > 1) toast(`${keys.length + last.length} steps removed. Ctrl+Z undoes it.`);
    else toast(`The ${last[0] === OPEN ? "call start" : "finish"} is off the canvas. Right-click the canvas to add it again.`);
  }

  // ── putting things on the canvas ──────────────────────────────────────────
  /** The call starts right after "Say why it is calling": when something is added after it, the "Call starts" step comes back if it was taken off. */
  const ensureStart = () => { if (form.show_open === false) set("show_open", true); };

  /** Adds a step at a position in the call, drawn at `where` (its middle) on the canvas. */
  function addAt(index, fields, where) {
    ensureStart();
    // An end-the-call or hand-over step closes the call, so it only ever goes last; whatever is added after the
    // rest goes in front of one that already closes the call.
    if (fields.kind === "end") {
      if (index !== undefined && index < questions.length) toast("End call and Hand over go at the very end, so it was put there.");
      index = undefined;
    } else {
      let tail = questions.length;
      while (tail > 0 && (questions[tail - 1].kind || "ask") === "end") tail--;
      if (index === undefined || index > tail) index = tail < questions.length ? tail : index;
    }
    if (fields.kind === "loop" && !fields.back_to) {
      // A go-back step starts out pointing at the question just before it, waiting on that question's answer.
      const parent = questions.slice(0, index ?? questions.length).filter(isAsk).pop();
      if (!parent) { toast("Add a question first: a go-back step needs one above it to go back to.", "bad"); return; }
      fields = { ...fields, back_to: parent.save_as, only_if: parent.save_as, only_if_is: parent.type === "yes_no" ? ["no"] : [] };
    }
    const width = (fields.kind || "ask") === "ask" ? PAIR_W : TILE;
    const placed = fields;                    // a new step joins the line in its order: it is not put anywhere else for you
    const made = setupState.addQuestion(index, placed);
    bringIntoView.current = askId(made);
    select(askId(made));
  }

  /** The step the selection means, as something blocks can be applied to. */
  const selectedNode = () => (selected?.question ? nodes.find((node) => node.id === selected.question._key) : null);

  /** A new step after the selected one if there is one, else at the end. */
  const addAfterSelected = (fields) => {
    const node = selectedNode();
    if (node) {
      addAt(node.index + 1, fields, { x: node.x + node.w + 120 + (((fields.kind || "ask") === "ask" ? PAIR_W : TILE) / 2), y: node.y + TILE / 2 });
    } else {
      const last = [...nodes].reverse().find((one) => one.type !== "close");
      const where = last && last.type === "question"
        ? { x: last.x + last.w + 120 + (((fields.kind || "ask") === "ask" ? PAIR_W : TILE) / 2), y: last.y + TILE / 2 }
        : undefined;
      addAt(undefined, fields, where);
    }
  };

  /** A "Customer answers" block applied to a question: how it is answered changes, what is asked doesn't. */
  function applyAnswer(question, fields) {
    setupState.changeQuestion(question._key, {
      type: fields.type, rule: fields.rule || "", options: fields.options || [], _optionsText: undefined,
    });
    select(answerId(question));
    toast(`The customer now answers with ${TYPE_LABELS[fields.type].toLowerCase()}.`);
  }

  /** A branch: the step waits on the question above it, to be told which answer. */
  function branch(question) {
    const at = questions.findIndex((one) => one._key === question._key);
    const parent = questions.slice(0, at).filter(isAsk).pop();
    if (!parent) { toast("There is no question above it to wait on.", "bad"); return; }
    setupState.changeQuestion(question._key, {
      only_if: parent.save_as, only_if_is: parent.type === "yes_no" ? ["no"] : [], _onlyIfIsText: undefined,
    });
    select(askId(question));
  }

  async function suggestQuestions() {
    const missing = await setupState.suggest();
    if (missing === "purpose") { toast("Say why it is calling first. It writes the questions from that.", "bad"); select(CONTEXT); }
  }

  /** Other ways to word one step's line, from the AI. */
  async function suggestWording(step) {
    const question = step.question;
    if (!question?.ask.trim()) { toast("Write something first. It suggests other ways to say it.", "bad"); return; }
    setWording((now) => ({ ...now, [step.id]: { loading: true } }));
    try {
      const { options, notices } = await api.reword(setup, question.ask, question.kind || "ask");
      setWording((now) => ({ ...now, [step.id]: { options } }));
      (notices || []).forEach((notice) => toast(notice));
    } catch (failure) {
      setWording((now) => ({ ...now, [step.id]: { problem: failure.message } }));
    }
  }

  /** What pressing a block does: the same as dropping it, with the selection standing in for the pointer. */
  function press(block) {
    const { payload } = block;
    const node = selectedNode();
    if (payload.kind === "new") addAfterSelected(payload.fields);
    else if (payload.kind === "answer") {
      if (node?.kind === "ask") applyAnswer(node.question, payload.fields);
      else addAfterSelected(payload.fields);
    } else if (payload.kind === "branch") {
      if (node && node.kind !== undefined) branch(node.question);
      else toast("Select a step first, or drag Branch onto one.");
    } else if (payload.kind === "suggest") suggestQuestions();
  }

  /** Where in the call a drop at a hit puts a new step, and where on the canvas. */
  function dropNew(fields, found) {
    const { hit, world } = found;
    if (hit?.type === "connector") return addAt(hit.connector.index, fields, world);
    if (hit?.type === "node") {
      const node = hit.node;
      const width = (fields.kind || "ask") === "ask" ? PAIR_W : TILE;
      const index = node.type === "open" || node.type === "context" ? 0 : node.type === "close" ? questions.length : node.index + 1;
      return addAt(index, fields, { x: node.x + node.w + 120 + width / 2, y: node.y + TILE / 2 });
    }
    return addAt(undefined, fields, world);
  }

  /** A block was put down at a point on the screen. */
  function drop(block, clientX, clientY) {
    if (view === "list") { press(block); return; }
    const found = canvas.current?.hit(clientX, clientY);
    if (!found?.inside) return;
    const { payload } = block;
    const node = found.hit?.type === "node" ? found.hit.node : null;
    if (payload.kind === "new") dropNew(payload.fields, found);
    else if (payload.kind === "answer") {
      if (node?.kind === "ask") applyAnswer(node.question, payload.fields);
      else dropNew(payload.fields, found);
    } else if (payload.kind === "branch") {
      if (node?.type === "question") branch(node.question);
      else toast("Drop Branch onto a step to make it wait on an earlier answer.");
    } else if (payload.kind === "suggest") {
      if (node?.type === "question" && node.kind !== "end") {
        select(askId(node.question));
        suggestWording({ id: askId(node.question), question: node.question });
      } else suggestQuestions();
    }
  }

  /** A block was pressed. A press that goes nowhere is a click; one that is carried is put down on drop. */
  function grab(event, block, tint) {
    if (!event) { press(block); return; }
    if (event.button !== 0) return;
    const start = { x: event.clientX, y: event.clientY };
    let moved = false;
    const track = (move) => {
      if (!moved && Math.hypot(move.clientX - start.x, move.clientY - start.y) < 5) return;
      moved = true;
      setGhost({ x: move.clientX, y: move.clientY, block, tint });
    };
    const finish = (up) => {
      window.removeEventListener("pointermove", track);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      setGhost(null);
      if (up.type === "pointercancel") return;
      if (moved) drop(block, up.clientX, up.clientY); else press(block);
    };
    window.addEventListener("pointermove", track);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
  }

  // ── the assistant ─────────────────────────────────────────────────────────
  // What is picked on the canvas is what the next message is about.
  const refOf = (node) => {
    if (!node) return null;
    const id = node.id;
    if (node.type === "context") return null;
    if (!node.question) return { id, label: node.type === "open" ? "Call starts" : "Finish", name: node.type === "open" ? "greeting" : "finish" };
    const detail = details[askId(node.question)] || {};
    return { id, label: `${detail.number || node.index + 1}. ${detail.title || "Step"}`, name: node.question.save_as };
  };
  const refs = picked.map((id) => refOf(nodes.find((one) => one.id === id))).filter(Boolean);

  const latestQuestions = useRef(questions);              // the steps as they are when the answer comes back, not as they were when it was asked
  latestQuestions.current = questions;

  /** Sends what was typed, with what is pointed at. The chat opens beside the canvas for the answer. */
  async function ask(text, only = null, after = null) {
    const said = text.trim();
    if (!said || chatBusy) return;
    const about = only || refs;
    // The AI works from why the call is made. Until that is known, the first thing said is that.
    const knowing = form.purpose.trim();
    if (!knowing) set("purpose", said);
    const mine = { role: "user", text: said, refs: about.map((ref) => ref.label) };
    const history = [...chat, mine];
    const names = about.map((ref) => ref.name);
    const basis = signature(questions);
    setChat(history);
    const controller = new AbortController();
    stopper.current = controller;
    setChatBusy(true);
    setSelectedId(null); setCardOpen(false); setPicked([]);
    setChatOpen(true);
    try {
      const found = await api.assist({ ...setupState.setup, purpose: knowing || said }, history.map((one) => ({
        role: one.role, text: one.refs?.length ? `${one.text} (pointing at: ${one.refs.join(", ")})` : one.text,
      })), names, controller.signal);
      (found.notices || []).forEach((notice) => toast(notice));
      const proposal = found.changed ? { questions: found.questions, restart: !!found.restart, purpose: found.purpose || "", basis, state: "open", ...diffSteps(questions, found.questions) } : null;
      // Asked plainly to change the call, or to build a whole flow: it is done now, and Undo on the answer takes it
      // back. Only a call that was edited while the AI was thinking waits for a yes.
      const now = proposal && found.direct && signature(latestQuestions.current) === basis;
      if (now) {
        const fresh = setupState.replaceQuestions(found.questions, !!found.restart);
        if (fresh.length) ensureStart();
        if (found.purpose && found.restart) set("purpose", found.purpose);
        if (fresh.length) bringIntoView.current = askId({ _key: fresh[0] });
        else setTimeout(() => canvas.current?.fit(), 60);
      }
      const show = found.show || (!found.changed && !found.ideas?.length ? showWanted(said) : "");
      const flow = show ? { filter: show, steps: now ? found.questions : latestQuestions.current, open: form.show_open !== false, close: form.show_close !== false } : null;
      setChat((before) => [
        // Anything still on offer was made for the call as it was.
        ...(now ? before.map((one) => (one.proposal?.state === "open" ? { ...one, proposal: { ...one.proposal, state: "stale" } } : one)) : before),
        {
          role: "assistant", text: found.reply || (now ? "Done." : found.changed ? "Here is what I would change." : "I have nothing to add."),
          proposal: now ? { ...proposal, state: "applied", before: questions, result: signature(found.questions) } : proposal,
          ideas: found.ideas?.length ? { list: found.ideas, state: "open", after } : null,
          flow,
        },
      ]);
    } catch (failure) {
      setChat((now) => [...now, failure.name === "AbortError" ? { role: "assistant", text: "Stopped. Nothing was changed." }
        : { role: "assistant", text: failure.message, failed: true }]);
    } finally {
      if (stopper.current === controller) stopper.current = null;
      setChatBusy(false);
    }
  }

  const settle = (at, state) => setChat((now) => now.map((one, index) => (index === at ? { ...one, proposal: { ...one.proposal, state } } : one)));

  /** The steps as they would be with only the ticked changes made. All of them ticked is the proposal as it stands. */
  function composed(proposal, pick) {
    if (pick.all) return proposal.questions;
    const has = (type, question) => pick.keys.includes(`${type}:${question.save_as}`);
    const target = Object.fromEntries(proposal.questions.map((one) => [one.save_as, one]));
    let list = questions.filter((one) => !(proposal.removed.some((gone) => gone.save_as === one.save_as) && has("remove", one)));
    list = list.map((one) => (target[one.save_as] && has("edit", one) ? { ...one, ...target[one.save_as], x: one.x, y: one.y } : one));
    proposal.questions.forEach((one, at) => {
      if (!proposal.added.some((added) => added.save_as === one.save_as) || !has("add", one)) return;
      let place = 0;
      for (let back = at - 1; back >= 0; back--) {
        const found = list.findIndex((other) => other.save_as === proposal.questions[back].save_as);
        if (found >= 0) { place = found + 1; break; }
      }
      list.splice(place, 0, one);
    });
    return list;
  }

  /** Puts the ticked changes into the call, as one change that Undo (or Ctrl+Z) takes back. Not if the call has moved on since. */
  function applyProposal(at, pick) {
    const proposal = chat[at]?.proposal;
    if (!proposal || proposal.state !== "open") return;
    if (signature(questions) !== proposal.basis) { settle(at, "stale"); return; }
    const list = composed(proposal, pick);
    const before = questions;
    const fresh = setupState.replaceQuestions(list, proposal.restart && pick.all);
    // The chat can be where the call's purpose is first said: kept when none was written, replaced on a new call.
    if (proposal.purpose && (proposal.restart || !form.purpose.trim())) set("purpose", proposal.purpose);
    setChat((now) => now.map((one, index) => {
      if (index === at) return { ...one, proposal: { ...one.proposal, state: "applied", before, result: signature(list) } };
      // Anything else still on offer was made for the call as it was.
      return one.proposal?.state === "open" ? { ...one, proposal: { ...one.proposal, state: "stale" } } : one;
    }));
    if (fresh.length) bringIntoView.current = askId({ _key: fresh[0] });
    else setTimeout(() => canvas.current?.fit(), 60);
  }

  /** Takes an applied proposal back, so it can be ticked differently and applied again. Not if the call has changed since. */
  function undoProposal(at) {
    const proposal = chat[at]?.proposal;
    if (!proposal || proposal.state !== "applied") return;
    if (signature(questions) !== proposal.result) { toast("The call has changed since. Use Ctrl+Z to step back.", "bad"); return; }
    setupState.replaceQuestions(proposal.before, true);
    setChat((now) => now.map((one, index) => (index === at ? { ...one, proposal: { ...one.proposal, state: "open", before: null } } : one)));
  }

  /** Adds the ideas that were ticked, after the step they were asked for. */
  function addIdeas(at, chosen) {
    const ideas = chat[at]?.ideas;
    if (!ideas || ideas.state !== "open" || !chosen.length) return;
    const place = ideas.after == null ? questions.length : Math.min(questions.length, ideas.after);
    const list = [...questions.slice(0, place), ...chosen, ...questions.slice(place)];
    const before = questions;
    const fresh = setupState.replaceQuestions(list);
    if (fresh.length) ensureStart();
    setChat((now) => now.map((one, index) => (index === at ? { ...one, ideas: { ...one.ideas, state: "added", before, result: signature(list) } } : one)));
    if (fresh.length) bringIntoView.current = askId({ _key: fresh[0] });
  }

  function undoIdeas(at) {
    const ideas = chat[at]?.ideas;
    if (!ideas || ideas.state !== "added") return;
    if (signature(questions) !== ideas.result) { toast("The call has changed since. Use Ctrl+Z to step back.", "bad"); return; }
    setupState.replaceQuestions(ideas.before, true);
    setChat((now) => now.map((one, index) => (index === at ? { ...one, ideas: { ...one.ideas, state: "open", before: null } } : one)));
  }

  const dropRef = (id) => { setPicked((now) => now.filter((one) => one !== id)); setSelectedId(null); setCardOpen(false); };

  // ── what could come next ──────────────────────────────────────────────────
  // The glowing button always sits after the last step of the call, but before any end-call step and the finish.
  const current = [...nodes].reverse().find((node) => node.type !== "close" && node.kind !== "end") || null;   // always after the last step: it does not follow the selection

  /** The glowing button talks to the same AI as the chat: it asks for ideas after a step, and they come back there to pick from. */
  async function suggestNext(info) {
    const { node } = info;
    if (chatBusy) return;
    if (!form.purpose.trim()) {
      setChat((now) => [...now, { role: "assistant", text: "First, why is this call being made? Tell me in a sentence and I will suggest what to ask." }]);
      setChatOpen(true);
      setTimeout(() => chatInput.current?.focus(), 0);
      return;
    }
    const ref = refOf(node);
    const after = node.type === "open" || node.type === "context" ? 0 : node.index + 1;
    // Said as a full sentence, with the place in the call: that is what the chat shows, and what is understood later.
    const title = node.question ? (details[askId(node.question)]?.title || node.question.save_as) : "";
    const said = node.question
      ? `Suggest what to ask right after “${title}”. It has to follow naturally from the steps before it and lead into the ones after it, without repeating them.`
      : "Suggest the first questions to ask right after the call starts: the natural way to open the conversation for the reason it is calling.";
    setChat((now) => [...now, { role: "user", text: said, refs: ref ? [ref.label] : [] }]);
    const controller = new AbortController();
    stopper.current = controller;
    setChatBusy(true);
    setSelectedId(null); setCardOpen(false); setPicked([]);
    setChatOpen(true);
    try {
      const found = await api.suggestNext(setupState.setup, node.question?.save_as || "", controller.signal);
      (found.notices || []).forEach((notice) => toast(notice));
      setChat((now) => [...now, found.options?.length
        ? { role: "assistant", text: "Tick the ones you want and press Add.", ideas: { list: found.options, state: "open", after } }
        : { role: "assistant", text: "No more suggestions. This call already covers its purpose." }]);
    } catch (failure) {
      setChat((now) => [...now, failure.name === "AbortError" ? { role: "assistant", text: "Stopped. Nothing was changed." }
        : { role: "assistant", text: failure.message, failed: true }]);
    } finally {
      if (stopper.current === controller) stopper.current = null;
      setChatBusy(false);
    }
  }

  // ── the right-click menu ──────────────────────────────────────────────────
  /** A right-click picks what it is on (unless that is one of several already picked), then offers what can be done. */
  function openMenu(info) {
    if (info.node && !(picked.length > 1 && picked.includes(info.node.id))) {
      if (selectedId !== info.tile.id) setCardOpen(false);
      setSelectedId(info.tile.id);
      setPicked([info.node.id]);
    }
    setMenu(info);
  }

  /** The answers that take the other way from a conditional step ("only if no" has "yes" as its else), or null when there is no other way. */
  function elseOf(question) {
    const parent = question.only_if && questions.find((one) => isAsk(one) && one.save_as === question.only_if);
    if (!parent) return null;
    const have = (question.only_if_is || []).map((one) => String(one).trim().toLowerCase());
    if (!have.length) return null;
    const others = parent.type === "yes_no" ? ["yes", "no"] : parent.type === "choice" ? (parent.options || []) : [];
    const rest = others.filter((one) => !have.includes(String(one).trim().toLowerCase()));
    return rest.length && rest.length < others.length ? rest : null;
  }

  /** What the menu offers, for where it was opened. Everything that can be done to the call is in here. */
  function menuItems() {
    if (!menu) return [];
    const { node, tile, world } = menu;
    const beside = (one, fields) => ({ x: one.x + one.w + 120 + ((fields.kind || "ask") === "ask" ? PAIR_W : TILE) / 2, y: one.y + TILE / 2 });
    // The kinds of step there are, each added by `add(fields)`.
    // `index` is where in the call it would go: an end-the-call step is offered only at the very end.
    const kinds = (add, index) => [
      { label: "Question", icon: Bot, onPick: () => add({}) },
      ...STEP_BLOCKS.map((block) => {
        const closes = stepFields(block.id).kind === "end";
        const middle = closes && index !== undefined && index < questions.length;
        return { label: block.label, icon: block.icon, disabled: middle, hint: middle ? "Last only" : undefined, onPick: () => add(stepFields(block.id)) };
      }),
    ];
    // Opened from a plus on the line: just the kinds of step, each going in at that place.
    if (menu.add) {
      // Smart suggestions for this very place: ideas for what could go after the step the plus sits behind.
      const { index } = menu.add;
      const before = index > 0 ? nodes.find((one) => one.type === "question" && one.index === index - 1) : (nodes.find((one) => one.type === "open") || nodes.find((one) => one.type === "context"));
      return [
        before && { label: "Smart suggestions", icon: AiIcon, onPick: () => suggestNext({ x: menu.x, y: menu.y, node: before }) },
        before && null,
        ...kinds((fields) => addAt(index, fields, menu.add.where), index),
      ].filter((item) => item !== false && item !== undefined);
    }
    if (!node) {
      return [
        { label: "Add a step", icon: Plus, items: kinds((fields) => addAt(undefined, fields, world), undefined) },
        current && { label: "Smart suggestions", icon: AiIcon, onPick: () => suggestNext({ x: menu.x, y: menu.y, node: current }) },
        form.show_open === false && { label: "Add the call start", icon: Phone, onPick: () => set("show_open", true) },
        form.show_close === false && { label: "Add the finish", icon: Check, onPick: () => set("show_close", true) },
        null,
        { label: "Select all", icon: SquareDashedMousePointer, hint: "Ctrl+A", onPick: () => { setSelectedId(null); setCardOpen(false); setPicked(nodes.map((one) => one.id)); } },
        { label: "Straighten into one line", icon: LayoutGrid, onPick: () => { setupState.tidyUp("horizontal"); setTimeout(() => canvas.current?.fit(), 60); } },
        { label: "Fit to screen", icon: Maximize2, onPick: () => canvas.current?.fit() },
      ].filter((item) => item !== false);
    }
    if (picked.length > 1 && picked.includes(node.id)) {
      return [
        { label: `Delete ${picked.length} steps`, icon: Trash2, hint: "Del", danger: true, onPick: () => removeMany(picked) },
        { label: "Deselect", icon: X, hint: "Esc", onPick: deselect },
      ];
    }
    const next = { label: "Smart suggestions", icon: AiIcon, onPick: () => suggestNext({ x: menu.x, y: menu.y, node }) };
    const question = node.question;
    if (node.type === "context") {
      return [
        { label: "Edit why it is calling", icon: Pencil, onPick: () => select(tile.id) },
        { label: "Add a step after the call starts", icon: Plus, items: kinds((fields) => addAt(0, fields), 0) },
      ];
    }
    if (!question) {
      const first = node.type === "open";
      return [
        { label: first ? "Edit the call start" : "Edit the finish", icon: Pencil, onPick: () => select(tile.id) },
        first
          ? { label: "Add a step after", icon: Plus, items: kinds((fields) => addAt(0, fields, beside(node, fields)), 0) }
          : { label: "Add a step before", icon: Plus, items: kinds((fields) => addAt(questions.length, fields, { x: node.x - 120 - PAIR_W / 2, y: node.y + TILE / 2 }), questions.length) },
        first && next,
        null,
        { label: "Delete", icon: Trash2, hint: "Del", danger: true, onPick: () => removeMany([node.id]) },
      ].filter((item) => item !== false);
    }
    const worded = node.kind === "ask" || node.kind === "say";
    return [
      { label: "Edit", icon: Pencil, onPick: () => select(tile.id) },
      { label: "Add a step after", icon: Plus, items: kinds((fields) => addAt(node.index + 1, fields, beside(node, fields)), node.index + 1) },
      node.kind === "ask" && {
        label: "How they answer", icon: MessagesSquare,
        items: QUESTION_PRESETS.map((preset) => ({ label: preset.label, icon: preset.icon, onPick: () => applyAnswer(question, preset.question) })),
      },
      { label: question.only_if ? "Change the condition" : "Only if… (a condition)", icon: GitBranch, onPick: () => (question.only_if ? select(askId(question)) : branch(question)) },
      elseOf(question) && { label: "Add the else step", icon: GitBranch, onPick: () => addAt(node.index + 1, { only_if: question.only_if, only_if_is: elseOf(question) }, beside(node, {})) },
      { label: "Duplicate", icon: Copy, hint: "Ctrl+D", onPick: () => { const copy = setupState.duplicateQuestion(question._key); if (copy) select(askId(copy)); } },
      null,
      next,
      { label: "Ask AI about this", icon: AiIcon, onPick: () => { setCardOpen(false); setTimeout(() => chatInput.current?.focus(), 0); } },
      worded && { label: "Suggest other wording", icon: AiIcon, onPick: () => { select(askId(question)); suggestWording({ id: askId(question), question }); } },
      null,
      { label: "Delete", icon: Trash2, hint: "Del", danger: true, onPick: () => remove(question) },
    ].filter((item) => item !== false);
  }

  /** Test and publish only go ahead when nothing is wrong; otherwise the list of what is, with where to go. */
  function guarded(next) {
    if (issues.length) {
      setIssuesOpen(true);
      toast(issues.length === 1 ? issues[0].text : `${issues.length} things need fixing first.`, "bad");
      return;
    }
    next();
  }

  /** What a block would do if put down here: said next to it as it is carried. */
  const caption = useMemo(() => {
    if (!ghost) return "";
    const found = canvas.current?.hit(ghost.x, ghost.y);
    if (!found?.inside) return "Bring it onto the canvas";
    const { kind } = ghost.block.payload;
    const hit = found.hit;
    if (kind === "branch") return hit?.type === "node" && hit.node.type === "question" ? `Make ${details[askId(hit.node.question)]?.title || "it"} conditional` : "Drop on a step";
    if (kind === "suggest") return hit?.type === "node" && hit.node.type === "question" ? "Other ways to word this" : "Suggest questions";
    if (kind === "answer" && hit?.type === "node" && hit.node.kind === "ask") return `Answered with ${ghost.block.label.toLowerCase()}`;
    if (hit?.type === "connector") return "Put it on this line";
    if (hit?.type === "node") return "Add it after this step";
    return "Add it at the end";
  }, [ghost, details]);

  // ── hearing ────────────────────────────────────────────────────────────────
  const hearing = (id) => voice.playing === `hear:${id}`;
  const hear = (step) => voice.run(`hear:${step.id}`, async (signal) => {
    const text = step.kind === "open" ? sampleGreeting(setup) : step.question.ask.trim();
    if (!text) { toast("Write what it should say first.", "bad"); return; }
    if (!(await speakLine(setup, text, signal)) && !signal.aborted) toast(NO_AUDIO, "bad");
  });

  const listening = voice.playing === "listen";
  const listen = () => voice.run("listen", async (signal) => {
    const started = performance.now();
    const tick = setInterval(() => setElapsed((performance.now() - started) / 1000), 200);
    try {
      for (const step of steps) {
        if (signal.aborted) return;
        if (step.kind === "end" || step.kind === "loop" || step.kind === "context") continue;                      // an end only happens when an answer calls for it
        setActiveId(step.id);
        const said = step.kind === "open" ? sampleGreeting(setup) : step.kind === "ask" || step.kind === "say" ? step.question.ask.trim() : "";
        if (!said) { await wait(step.kind === "close" ? 600 : 1200, signal); continue; }
        if (!(await speakLine(setup, said, signal))) {
          if (!signal.aborted) toast(NO_AUDIO, "bad");
          return;
        }
      }
    } finally {
      clearInterval(tick);
      setActiveId(null);
      setElapsed(0);
    }
  });

  // ── keyboard ───────────────────────────────────────────────────────────────
  // The handler is kept in a ref so the listener is set up once and still sees the latest of everything.
  const keys = useRef(null);
  keys.current = (event) => {
    if (event.key === "Escape") {
      if (issuesOpen) setIssuesOpen(false);
      else if (chatOpen && !chatBusy) setChatOpen(false);       // Escape while it is thinking stops it instead
      else if (!settings) deselect();
      return;
    }
    // Typing, or a window over the page: the keys belong to that.
    if (event.target.closest?.("input, textarea, select, [contenteditable=true]")) return;
    if (settings || versions || confirming || document.querySelector("[role=dialog]")) return;
    const mod = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();
    if (mod && key === "z") { event.preventDefault(); if (event.shiftKey) setupState.redo(); else setupState.undo(); return; }
    if (mod && key === "y") { event.preventDefault(); setupState.redo(); return; }
    if (mod && key === "d" && selected?.question) {
      event.preventDefault();
      const copy = setupState.duplicateQuestion(selected.question._key);
      if (copy) select(askId(copy));
      return;
    }
    if (mod && key === "a" && view === "canvas") {
      event.preventDefault();
      setSelectedId(null); setCardOpen(false); setPicked(nodes.map((node) => node.id));
      return;
    }
    if (event.key === "Delete" || event.key === "Backspace") {
      if (picked.length) { event.preventDefault(); removeMany(picked); } else if (selected?.question) { event.preventDefault(); remove(selected.question); }
      return;
    }
    if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      event.preventDefault();
      const at = steps.findIndex((step) => step.id === selectedId);
      const next = steps[Math.max(0, Math.min(steps.length - 1, (at < 0 ? -1 : at) + (event.key === "ArrowRight" ? 1 : -1)))];
      if (next) { select(next.id); canvas.current?.focus(next.id); }
    }
  };
  useEffect(() => {
    const listener = (event) => keys.current(event);
    document.addEventListener("keydown", listener);
    return () => document.removeEventListener("keydown", listener);
  }, []);

  const editable = Boolean(selected && cardOpen);
  const card = editable ? (
    <>
      <StepCard key={selected.id} step={selected} form={form} set={set} voices={voices} questions={questions}
                hearing={hearing(selected.id)} onHear={() => hear(selected)}
                onMove={(to) => selected.question && setupState.moveQuestion(selected.question._key, to)}
                onDuplicate={() => { const copy = selected.question && setupState.duplicateQuestion(selected.question._key); if (copy) select(askId(copy)); }}
                onAddAfter={() => addAfterSelected({})}
                onChange={(patch) => setupState.changeQuestion(selected.question._key, patch)} />
      <Wording canAsk={selected.kind === "ask" || selected.kind === "say"} state={wording[selected.id]}
               onAsk={() => suggestWording(selected)} onPick={(option) => setupState.changeQuestion(selected.question._key, { ask: option })} />
    </>
  ) : null;
  const cardStatus = editable ? (
    <StepStatus issue={selected.question ? details[askId(selected.question)]?.flag?.note : ""} status={setupState.status} onDone={deselect} />
  ) : null;

  const iconButton = "max-sm:size-9";

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex h-[58px] shrink-0 items-center gap-1.5 border-b border-line bg-white px-2 sm:gap-2 sm:px-4">
        <button type="button" onClick={onBack} aria-label="Back to all flows" title="Back to all flows"
                className="grid size-9 shrink-0 place-items-center rounded-full text-muted hover:bg-fill hover:text-ink">
          <ChevronLeft aria-hidden="true" className="size-[18px]" strokeWidth={2} />
        </button>
        <div className="flex min-w-0 flex-1 flex-col sm:max-w-80 sm:flex-none sm:basis-80">
          <input aria-label="Flow name" value={name} onChange={(event) => setName(event.target.value)}
                 placeholder="Untitled flow"
                 className="-ml-1.5 w-full min-w-0 truncate rounded-lg border-0 bg-transparent px-1.5 py-[3px] text-[15px] font-semibold text-ink
                            placeholder:text-faint hover:bg-canvas focus:bg-fill focus:outline-none" />
          <SaveStatus setupState={setupState} flow={flow} onDiscard={() => setConfirming({ kind: "discard" })} />
        </div>
        <div className="hidden flex-1 sm:block" />
        <Button variant="ghost" size="icon" icon={Undo2} disabled={!setupState.canUndo} onClick={setupState.undo}
                aria-label="Undo" title="Undo (Ctrl+Z)" className={cn("max-sm:hidden", iconButton)} />
        <Button variant="ghost" size="icon" icon={Redo2} disabled={!setupState.canRedo} onClick={setupState.redo}
                aria-label="Redo" title="Redo (Ctrl+Shift+Z)" className={cn("max-sm:hidden", iconButton)} />
        <Button variant="ghost" size="icon" icon={History} onClick={() => setVersions(true)}
                aria-label="Earlier versions" title="Earlier sent versions" className={iconButton} />
        {/* On a phone the actions are icons of one size; with room they say what they do */}
        <Button variant="ghost" icon={Settings2} onClick={() => setSettings(true)} aria-label="Call settings" title="Voice, tone and rules"
                className="max-sm:w-10 max-sm:justify-center max-sm:px-0">
          <span className="hidden sm:inline">Settings</span>
        </Button>
        <Button variant="secondary" icon={Phone} disabled={saving} onClick={() => guarded(onTest)} aria-label="Test it" title="Try the call yourself"
                className="max-sm:w-10 max-sm:justify-center max-sm:px-0">
          <span className="hidden sm:inline">Test it</span>
        </Button>
        <Button variant="primary" icon={Upload} onClick={() => guarded(onPublish)} aria-label="Send" title="Choose who it goes to"
                className="max-sm:w-10 max-sm:justify-center max-sm:px-0">
          <span className="hidden sm:inline">{flow.status !== "Draft" && flow.unpublished_changes ? "Send changes" : "Send"}</span>
        </Button>
      </header>

      {conflict && (
        <div role="alert" className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-line bg-bad-soft px-4 py-2.5 text-[13px] text-ink">
          <TriangleAlert aria-hidden="true" className="size-4 shrink-0 text-bad" strokeWidth={2} />
          <span className="min-w-0 flex-1">
            This flow was saved in another tab or window. Pick which version to keep; the other one is lost.
          </span>
          <Button size="sm" variant="secondary" icon={RotateCcw} onClick={() => setupState.reload(conflict)}>Use the other version</Button>
          <Button size="sm" variant="primary" onClick={setupState.keepMine}>Keep this one</Button>
        </div>
      )}


      <section className="relative flex min-h-0 flex-1 bg-white">
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          {view === "list" ? (
            <ListView steps={steps} questions={questions} purpose={form.purpose} selectedId={editable ? selectedId : null} activeId={activeId}
                      closing={form.confirm_at_end ? "Reading the answers back, then saying goodbye" : "Saying goodbye and ending the call"}
                      onSelect={select} onMove={(key, to) => setupState.moveQuestion(key, to)}
                      onInsert={(index) => addAt(index, {})} onAdd={() => addAt(undefined, {})} />
          ) : (
          <Canvas ref={canvas} nodes={nodes} details={details} selectedId={selectedId} activeId={activeId} picked={picked} onPick={setPicked}
                  tries={Number(form.tries_per_question) || 3} probe={ghost ? { x: ghost.x, y: ghost.y } : null}
                  trashRef={trash} empty={questions.length === 0}
                  onSelect={select} onDeselect={deselect} onTrash={setTrashLit}
                  onPlace={(id, x, y) => setupState.placeNode(id, x, y)}
                  onPlaceMany={setupState.placeNodes} onDeleteMany={(ids) => removeMany(ids)} onMenu={openMenu}
                  hintAt={current?.id} hintBusy={chatBusy} onStop={stopThinking} onHint={suggestNext}
                  onRelocate={(key, to, x, y) => setupState.relocate(key, to, x, y)}
                  onDelete={(key) => { const question = byKey(key); if (question) remove(question); }}
                  onInsertHere={(index, where, at) => openMenu({ ...at, add: { index, where } })} />
          )}

          {/* What is wrong, and Listen: floating over the canvas so it keeps all the room */}
          <div className="pointer-events-none absolute top-3 right-3 left-3 flex items-start gap-2">
            <button type="button" onClick={() => setIssuesOpen(!issuesOpen)} aria-expanded={issuesOpen}
                    className={cn("pointer-events-auto flex h-9 items-center gap-1.5 rounded-full px-3.5 text-[13px] font-semibold shadow-card transition-colors",
                                  issues.length ? "bg-warn-soft text-warn hover:brightness-95" : "bg-good-soft text-good")}>
              <span className={cn("size-1.5 rounded-full", issues.length ? "bg-amber" : "bg-live")} />
              {issues.length ? `${issues.length} ${issues.length === 1 ? "thing to fix" : "things to fix"}` : (
                <><span className="max-sm:hidden">Ready to test</span><span className="sm:hidden">Ready</span></>
              )}
            </button>
            <div role="group" aria-label="How to show the call"
                 className="pointer-events-auto flex h-9 items-center rounded-full border border-line bg-white p-0.5 shadow-card">
              {[["canvas", "Canvas"], ["list", "List"]].map(([id, label]) => (
                <button key={id} type="button" aria-pressed={view === id} onClick={() => chooseView(id)}
                        className={cn("h-8 rounded-full px-3.5 text-[13px] font-semibold transition-colors",
                                      view === id ? "bg-brand-soft text-brand-ink" : "text-muted hover:text-ink")}>
                  {label}
                </button>
              ))}
            </div>
            {view === "canvas" && (picked.length > 0 || trashLit) && <button ref={trash} type="button"
                    onClick={() => removeMany(picked)}
                    title="Delete what is selected (or press Delete). A step can be dropped here too."
                    className={cn("pointer-events-auto flex h-9 items-center gap-1.5 rounded-full px-3.5 text-[13px] font-semibold shadow-card transition-all duration-150",
                                  trashLit ? "scale-110 bg-bad text-white shadow-[0_8px_18px_rgb(196_55_43/0.4)]"
                                    : "border border-line bg-white text-bad hover:-translate-y-px hover:bg-bad-soft disabled:opacity-50 disabled:hover:translate-y-0 disabled:hover:bg-white")}>
              <Trash2 aria-hidden="true" className={cn("size-4", trashLit && "motion-safe:animate-bounce")} strokeWidth={2.1} />
              <span className={cn(!trashLit && "max-sm:hidden")}>{trashLit ? "Let go to delete" : "Delete"}</span>
            </button>}
            {view === "canvas" && form.show_open === false && (
              <button type="button" onClick={() => { set("show_open", true); setTimeout(() => canvas.current?.fit(), 60); }}
                      className="pointer-events-auto flex h-9 items-center gap-1.5 rounded-full border border-dashed border-brand/50 bg-white px-3.5 text-[13px] font-semibold text-brand shadow-card hover:bg-brand-soft">
                <Plus aria-hidden="true" className="size-4" strokeWidth={2.4} />Call start
              </button>
            )}
            <span className="flex-1" />
            {selected && cardOpen && minimized && (
              <button type="button" onClick={() => setMinimized(false)}
                      aria-label={`Open the editor for ${selected.title}`}
                      className="pointer-events-auto flex h-9 items-center gap-2 rounded-full border border-line bg-white px-3.5 text-[13px] font-semibold text-ink shadow-card hover:bg-hover">
                <PanelRightOpen aria-hidden="true" className="size-4 text-muted" strokeWidth={2} /><span className="max-sm:hidden">Editing {selected.title}</span>
              </button>
            )}
            <div className="pointer-events-auto flex shrink-0 items-center gap-2 rounded-full border border-line bg-white py-1 pr-3 pl-1 shadow-card sm:gap-2.5 sm:pr-3.5">
              <button type="button" onClick={listen} aria-label={listening ? "Stop listening" : "Listen to the whole call"}
                      className="grid size-7 place-items-center rounded-full bg-brand text-white transition-colors hover:bg-brand-hover">
                {listening ? <Pause aria-hidden="true" className="size-3" fill="currentColor" /> : <Play aria-hidden="true" className="size-3" fill="currentColor" />}
              </button>
              <span className="text-[13px] font-semibold">Listen</span>
              <span title={tooLong ? "Longer than the time it wraps up after" : "A rough guess at how long the call takes"}
                    className={cn("font-mono text-xs whitespace-nowrap max-sm:hidden", tooLong ? "text-warn" : "text-faint")}>
                {clock(elapsed)} / ≈{clock(total)}
              </span>
            </div>
          </div>

          {/* The assistant, small: at the bottom until a message is sent */}
          {!chatOpen && (
            <div className={cn("pointer-events-none absolute inset-x-3 bottom-4 z-20 flex justify-center", editable && !minimized && "max-sm:hidden")}>
              <AssistantBar purposeKnown={Boolean(form.purpose.trim())} inputRef={chatInput} refs={refs} onDropRef={dropRef} onSend={ask} busy={chatBusy} onStop={stopThinking}
                            waiting={chat.length} onOpen={() => { deselect(); setChatOpen(true); }}
                            className="w-[min(520px,100%)]" />
            </div>
          )}

          {issuesOpen && (
            <>
              <button type="button" aria-label="Close the list of issues" className="absolute inset-0 z-20 cursor-default" onClick={() => setIssuesOpen(false)} />
              <div role="region" aria-label="Issues" className="absolute top-14 left-3 z-30 w-[min(360px,calc(100%-24px))] rounded-2xl border border-line bg-white p-1.5 shadow-float">
                {issues.length === 0 ? (
                  <p className="px-3 py-3 text-[13px] text-muted">Nothing is in the way. It can be tried or published.</p>
                ) : issues.map((issue, at) => (
                  <button key={`${issue.id}-${at}`} type="button"
                          onClick={() => { setIssuesOpen(false); if (issue.id) { if (issue.id === OPEN && form.show_open === false) set("show_open", true); select(issue.id); canvas.current?.focus(issue.id); } }}
                          className="flex w-full items-start gap-2.5 rounded-xl px-3 py-2.5 text-left text-[13px] font-medium text-ink hover:bg-fill">
                    <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-amber" />
                    {issue.text}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>

        {/* The editor for the selected step: docked beside the canvas, a sheet from the bottom on a phone */}
        {editable && !minimized && (
          <aside aria-label="Edit the selected step"
                 className="z-30 flex w-[380px] shrink-0 flex-col border-l border-line bg-white max-sm:fixed max-sm:inset-x-2 max-sm:bottom-[60px] max-sm:max-h-[58dvh] max-sm:w-auto max-sm:rounded-3xl max-sm:border max-sm:shadow-float">
            {(() => {
              const head = headOf(selected);
              const HeadIcon = head.icon;
              return (
                <div className="flex items-center gap-3 px-4 pt-3.5 pb-3">
                  <span className={cn("grid size-9 shrink-0 place-items-center rounded-xl", head.tile)}>
                    <HeadIcon aria-hidden="true" className="size-[18px]" strokeWidth={2.1} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[15px] leading-tight font-bold tracking-[-0.01em] text-ink">{selected.title}</p>
                    <p className="truncate text-xs text-muted">{head.kicker}</p>
                  </div>
                  {selected.question && (
                    <button type="button" onClick={() => remove(selected.question)} aria-label="Remove this step" title="Remove this step"
                            className="grid size-8 place-items-center rounded-full text-muted hover:bg-bad-soft hover:text-bad">
                      <Trash2 aria-hidden="true" className="size-4" strokeWidth={2} />
                    </button>
                  )}
                  <button type="button" onClick={() => setMinimized(true)} aria-label="Minimise the editor" title="Minimise"
                          className="grid size-8 place-items-center rounded-full text-muted hover:bg-fill hover:text-ink">
                    <PanelRightClose aria-hidden="true" className="size-4" strokeWidth={2} />
                  </button>
                  <button type="button" onClick={deselect} aria-label="Close" title="Close"
                          className="grid size-8 place-items-center rounded-full text-muted hover:bg-fill hover:text-ink">
                    <X aria-hidden="true" className="size-4" strokeWidth={2.2} />
                  </button>
                </div>
              );
            })()}
            <div className="min-h-0 flex-1 overflow-y-auto px-4 pt-1 pb-5">{card}</div>
            <div className="border-t border-line bg-white px-4 py-3">{cardStatus}</div>
          </aside>
        )}
        {/* The assistant, open: the conversation takes the side the editor would */}
        {chatOpen && !(editable && !minimized) && (
          <AssistantPanel onResize={(dx) => canvas.current?.slide(dx)} purposeKnown={Boolean(form.purpose.trim())} context={form.purpose} onContext={(value) => set("purpose", value)} onReset={() => setChat([])} inputRef={chatInput} messages={chat} busy={chatBusy} refs={refs} onDropRef={dropRef} onSend={ask}
                          onClose={() => setChatOpen(false)} onApply={applyProposal} onUndo={undoProposal} onUndoIdeas={undoIdeas} onDiscard={(at) => settle(at, "discarded")} onAddIdeas={addIdeas} />
        )}
      </section>

      {ghost && (
        <div aria-hidden="true" style={{ left: ghost.x, top: ghost.y }}
             className="pointer-events-none fixed z-[70] -translate-x-5 -translate-y-1/2">
          <div className="flex rotate-[-4deg] scale-105 items-center gap-2 rounded-2xl bg-white py-1.5 pr-3.5 pl-1.5 text-[13px] font-semibold text-ink shadow-[0_18px_36px_rgb(17_17_20/0.22)] ring-2 ring-brand/40">
            <span className={cn("grid size-[30px] place-items-center rounded-xl", ghost.tint.tile)}>
              <ghost.block.icon aria-hidden="true" className="size-[17px]" strokeWidth={2.1} />
            </span>
            {ghost.block.label}
          </div>
          <span className="mt-2 ml-1 inline-block rounded-full bg-ink px-2.5 py-1 text-[11px] font-semibold whitespace-nowrap text-white shadow-lg">{caption}</span>
        </div>
      )}

      {menu && <ContextMenu at={menu} items={menuItems()} onClose={() => setMenu(null)} />}

      {confirming?.kind === "discard" && (
        <ConfirmDialog title="Discard unpublished changes?" confirm="Discard changes" danger onClose={() => setConfirming(null)}
                       onConfirm={setupState.discard}>
          The flow goes back to what was last published. Everything changed since then is lost.
        </ConfirmDialog>
      )}
      {versions && <VersionsDialog flow={flow} onClose={() => setVersions(false)} onRestore={setupState.restore} />}

      <SettingsDrawer open={settings} onClose={() => setSettings(false)} form={form} set={set} voices={voices}
                      hearing={hearing(OPEN)} onHear={() => hear({ id: OPEN, kind: "open" })} onVoices={onVoices} />
    </div>
  );
}
