/* The setup form's rules, with no UI in them: defaults, limits, and turning the form into a setup.
 *
 * The form holds what the fields show (numbers as typed text, lists as the text in their box) and the
 * setup is what the server stores. `toForm` goes one way, `collect` the other.
 */

import { autoName } from "./thread.js";

export const TYPES = ["text", "number", "date", "time", "yes_no", "choice"];

// Every field, by kind, with what it falls back to when left empty. Each key is the setting's own name.
const TEXT = ["business_name", "assistant_name", "purpose", "calling_from", "language", "voice_id"];
const CHOICES = { ai_disclosure: "when_asked", tone: "friendly", reply_length: "balanced", formality: "neutral" };
const NUMBERS = { max_minutes: 4, speaking_speed: 1, tries_per_question: 3, silences_before_ending: 2,
                  wait_after_speech_ms: 450 };
// The server refuses anything outside these, so a number typed past the end is brought back inside.
const LIMITS = { max_minutes: [1, 30, 0.5], speaking_speed: [0.7, 1.2, 0.05], tries_per_question: [1, 5, 1],
                 silences_before_ending: [1, 5, 1], wait_after_speech_ms: [300, 1500, 1] };
const SWITCHES = { confirm_at_end: true, allow_interruptions: true, show_open: true, show_close: true };
const LINES = ["business_info", "rules"];
const COMMAS = ["other_languages"];

export const OPTIONS = {
  ai_disclosure: [["when_asked", "When asked"], ["at_start", "In the greeting, and when asked"]],
  tone: [["friendly", "Friendly"], ["warm", "Warm"], ["professional", "Professional"],
         ["energetic", "Energetic"], ["calm", "Calm"]],
  reply_length: [["brief", "Brief"], ["balanced", "Balanced"], ["chatty", "Chatty"]],
  formality: [["casual", "Casual"], ["neutral", "Neutral"], ["formal", "Formal"]],
  wait_after_speech_ms: [["350", "Quick · 0.35 s"], ["450", "Normal · 0.45 s"],
                         ["700", "Patient · 0.7 s"], ["1000", "Very patient · 1 s"]],
};

/** A place on the canvas, to a whole pixel, or null. */
const spot = (value) => (Number.isFinite(Number(value)) && value !== null && value !== "" ? Math.round(Number(value)) : null);
/** [x, y], or [] when the greeting or the close is where the default layout puts it. */
const pair = (value) => (Array.isArray(value) && value.length === 2 && value.every((one) => Number.isFinite(Number(one)))
  ? value.map((one) => Math.round(Number(one))) : []);

export function number(name, value) {
  const [low, high, step] = LIMITS[name];
  const given = Number(value) || NUMBERS[name];
  return Math.min(high, Math.max(low, Number((Math.round(given / step) * step).toFixed(2))));
}

const lines = (text) => text.split("\n").map((s) => s.trim()).filter(Boolean);
export const commas = (text) => text.split(",").map((s) => s.trim()).filter(Boolean);

let keys = 0;
/** Each question on screen gets a key of its own, so React keeps its boxes in place when one is removed. */
const withKey = (question) => ({ ...question, _key: question._key ?? `q${++keys}`, _auto: question._auto ?? false });

// `_auto`: the saved name still follows the wording, until someone types a name of their own.
// `kind`: "ask" (a question), "say" (a message, no answer), "end" (ends the call once its condition is met)
// or "loop" (goes back to the step `back_to` once its condition is met, at most `times` times).
export const blankQuestion = () => withKey({
  _auto: true, kind: "ask", handoff: false, back_to: "", times: 2,
  save_as: "", ask: "", type: "text", rule: "", options: [], required: true, only_if: "", only_if_is: [],
});

/** The steps that are questions: what gets answered. */
export const asks = (questions) => questions.filter((question) => (question.kind || "ask") === "ask");

/** A question saved without a usable name (an older one) is given one from its wording, so nothing waits on it. */
function named(questions) {
  const valid = /^[a-z_][a-z0-9_]*$/i;
  return questions.map((question, at) => (valid.test(question.save_as || "") || (question.kind || "ask") !== "ask" ? question
    : { ...question, save_as: autoName(question.ask || "", questions.filter((_, other) => other !== at).map((one) => one.save_as)) }));
}

/** A setup as the form shows it. */
export function toForm(setup) {
  const wait = String(setup.wait_after_speech_ms ?? "");
  return {
    ...Object.fromEntries(TEXT.map((name) => [name, setup[name] ?? ""])),
    ...Object.fromEntries(Object.entries(CHOICES).map(([name, fallback]) => [name, setup[name] || fallback])),
    ...Object.fromEntries(Object.keys(NUMBERS).map((name) => [name, String(setup[name] ?? "")])),
    // The wait is a list of steps. A value saved by hand between them has no step, so it shows as Normal.
    wait_after_speech_ms: OPTIONS.wait_after_speech_ms.some(([value]) => value === wait)
      ? wait : String(NUMBERS.wait_after_speech_ms),
    ...Object.fromEntries(Object.entries(SWITCHES).map(([name, fallback]) => [name, setup[name] ?? fallback])),
    ...Object.fromEntries(LINES.map((name) => [name, (setup[name] || []).join("\n")])),
    ...Object.fromEntries(COMMAS.map((name) => [name, (setup[name] || []).join(", ")])),
    questions: named((setup.questions || []).map(withKey)),
    open_at: pair(setup.open_at), close_at: pair(setup.close_at),
  };
}

/** A setup however it was built, with every empty field at its fallback, so two can be compared. */
export function normalise(setup) {
  return {
    ...Object.fromEntries(TEXT.map((name) => [name, (setup[name] ?? "").trim()])),
    language: (setup.language || "").trim() || "English",
    ...Object.fromEntries(Object.entries(CHOICES).map(([name, fallback]) => [name, setup[name] || fallback])),
    ...Object.fromEntries(Object.keys(NUMBERS).map((name) => [name, number(name, setup[name])])),
    ...Object.fromEntries(Object.entries(SWITCHES).map(([name, fallback]) => [name, setup[name] ?? fallback])),
    ...Object.fromEntries([...LINES, ...COMMAS].map((name) => [name, setup[name] || []])),
    open_at: pair(setup.open_at), close_at: pair(setup.close_at),
    questions: (setup.questions || []).map((question) => ({
      kind: question.kind || "ask", handoff: Boolean(question.handoff), x: spot(question.x), y: spot(question.y),
      back_to: question.kind === "loop" ? question.back_to || "" : "", times: Math.min(5, Math.max(1, Number(question.times) || 2)),
      save_as: question.save_as, ask: question.ask, type: question.type, rule: question.rule || "",
      options: question.options || [], required: question.required !== false,
      only_if: question.only_if || "", only_if_is: question.only_if ? question.only_if_is || [] : [],
    })),
  };
}

/** The form as a setup, ready to save. */
export function collect(form) {
  return normalise({
    ...form,
    ...Object.fromEntries(LINES.map((name) => [name, lines(form[name])])),
    ...Object.fromEntries(COMMAS.map((name) => [name, commas(form[name])])),
  });
}

/** What Reset leaves behind: every box empty so the placeholders show, every choice at its default. */
export const EMPTY = {
  ...Object.fromEntries(TEXT.map((name) => [name, ""])),
  ...CHOICES, ...SWITCHES,
  ...Object.fromEntries(Object.keys(NUMBERS).map((name) => [name, ""])),
  ...Object.fromEntries([...LINES, ...COMMAS].map((name) => [name, []])),
  questions: [],
  open_at: [], close_at: [],
};

/** Problems a business can fix, checked here so a call never starts on a broken setup. */
export function problems(setup) {
  const found = [];
  if (!setup.purpose.trim()) found.push("Say why it is calling.");
  if (!asks(setup.questions).length) found.push("Add at least one question.");
  const names = setup.questions.map((question) => question.save_as);
  setup.questions.forEach((question, at) => {
    const name = question.save_as || "unnamed";
    const kind = question.kind || "ask";
    if (!question.ask.trim() && kind !== "end" && kind !== "loop") found.push(kind === "say" ? "Every message needs wording." : "Every question needs wording.");
    if (!/^[a-z_][a-z0-9_]*$/i.test(question.save_as)) {
      found.push(`"${name}": the saved name needs letters, numbers and underscores.`);
    }
    if (kind === "ask" && question.type === "choice" && (question.options || []).length < 2) {
      found.push(`"${name}": a choice needs at least two options.`);
    }
    const above = setup.questions.slice(0, at).filter((other) => (other.kind || "ask") === "ask").map((other) => other.save_as);
    if (kind === "loop" && !question.only_if) found.push(`"${name}": a go-back step needs a condition, or it would go back on every call.`);
    if (kind === "loop" && !above.includes(question.back_to)) found.push(`"${name}": choose a question above it to go back to.`);
    if (question.only_if && !above.includes(question.only_if)) {
      found.push(`"${name}" can only depend on a question above it.`);
    } else if (question.only_if && !question.only_if_is.length) {
      found.push(`"${name}": say which answer it is asked after.`);
    }
  });
  names.forEach((name, at) => {
    if (name && names.indexOf(name) !== at) found.push(`Two questions are saved as "${name}".`);
  });
  return [...new Set(found)];
}
