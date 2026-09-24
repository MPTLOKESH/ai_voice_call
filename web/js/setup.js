/* The setup view: everything a business decides, and nothing else. */

import * as api from "./api.js";
import { Player, audioContext } from "./audio.js";
import { clear, el, lines, make, toast } from "./ui.js";

const TYPES = ["text", "number", "date", "time", "yes_no", "choice"];

// Every field on the form, by kind, with what it falls back to when left empty. Each id is the setting's
// own name, so one list drives filling the form, reading it back and comparing it with what was saved.
const TEXT = ["business_name", "assistant_name", "purpose", "calling_from", "language", "voice_id"];
const CHOICES = { ai_disclosure: "when_asked", tone: "friendly", reply_length: "balanced", formality: "neutral" };
const NUMBERS = { max_minutes: 4, speaking_speed: 1, tries_per_question: 3, silences_before_ending: 2,
                  wait_after_speech_ms: 450 };
// The server refuses anything outside these, so a number typed past the end is brought back inside.
const LIMITS = { max_minutes: [1, 30, 0.5], speaking_speed: [0.7, 1.2, 0.05], tries_per_question: [1, 5, 1],
                 silences_before_ending: [1, 5, 1], wait_after_speech_ms: [300, 1500, 1] };

function number(name, value) {
  const [low, high, step] = LIMITS[name];
  const given = Number(value) || NUMBERS[name];
  return Math.min(high, Math.max(low, Number((Math.round(given / step) * step).toFixed(2))));
}

const SWITCHES = { confirm_at_end: true, allow_interruptions: true };
const LINES = ["business_info", "rules"];
const COMMAS = ["other_languages"];

let questions = [];
let onSaved = () => {};
// The last setup the server confirmed. Kept so Reset can tell a form worth clearing from one that is
// already empty, and so the header can stay on what a call would actually use.
let saved = null;
let voices = [];

// What Reset leaves behind: every box empty, so the placeholders show and there is somewhere to start,
// and every choice back at its default.
const EMPTY = {
  ...Object.fromEntries(TEXT.map((name) => [name, ""])),
  ...CHOICES, ...SWITCHES,
  ...Object.fromEntries(Object.keys(NUMBERS).map((name) => [name, ""])),
  ...Object.fromEntries([...LINES, ...COMMAS].map((name) => [name, []])),
  questions: [],
};

export function start(setup, { onChange }) {
  onSaved = onChange || (() => {});
  saved = setup;
  fill(setup);

  el("add-question").addEventListener("click", () => {
    questions.push({ save_as: "", ask: "", type: "text", rule: "", options: [], required: true,
                     only_if: "", only_if_is: [] });
    drawQuestions();
    el("questions").lastElementChild?.querySelector("input")?.focus();
  });

  el("suggest").addEventListener("click", suggest);
  el("reset").addEventListener("click", reset);
  el("save").addEventListener("click", () => save());
  el("save-and-call").addEventListener("click", async () => {
    if (await save()) document.dispatchEvent(new CustomEvent("go-to-call"));
  });

  el("speaking_speed").addEventListener("input", showSpeed);
  el("voice_id").addEventListener("change", showVoice);
  el("hear").addEventListener("click", hear);
  loadVoices(setup.voice_id);
}

export function fill(setup) {
  TEXT.forEach((name) => { el(name).value = setup[name] ?? ""; });
  Object.entries(CHOICES).forEach(([name, fallback]) => { el(name).value = setup[name] || fallback; });
  Object.keys(NUMBERS).forEach((name) => { el(name).value = setup[name] ?? ""; });
  Object.entries(SWITCHES).forEach(([name, fallback]) => { el(name).checked = setup[name] ?? fallback; });
  LINES.forEach((name) => { el(name).value = (setup[name] || []).join("\n"); });
  COMMAS.forEach((name) => { el(name).value = (setup[name] || []).join(", "); });
  // A saved voice this account no longer lists still needs an option to show as chosen.
  if (setup.voice_id) addVoiceOption(setup.voice_id);
  el("voice_id").value = setup.voice_id || "";
  // The wait is a list of steps. A value saved by hand between them has no option, so it shows as Normal.
  if (!el("wait_after_speech_ms").value) el("wait_after_speech_ms").value = String(NUMBERS.wait_after_speech_ms);
  questions = (setup.questions || []).map((question) => ({ ...question }));
  showSpeed();
  showVoice();
  drawQuestions();
}

/** A setup however it was built, with every empty field at its fallback, so two can be compared. */
function normalise(setup) {
  return {
    ...Object.fromEntries(TEXT.map((name) => [name, (setup[name] ?? "").trim()])),
    language: (setup.language || "").trim() || "English",
    ...Object.fromEntries(Object.entries(CHOICES).map(([name, fallback]) => [name, setup[name] || fallback])),
    ...Object.fromEntries(Object.keys(NUMBERS).map((name) => [name, number(name, setup[name])])),
    ...Object.fromEntries(Object.entries(SWITCHES).map(([name, fallback]) => [name, setup[name] ?? fallback])),
    ...Object.fromEntries([...LINES, ...COMMAS].map((name) => [name, setup[name] || []])),
    questions: (setup.questions || []).map((question) => ({
      save_as: question.save_as, ask: question.ask, type: question.type, rule: question.rule || "",
      options: question.options || [], required: question.required !== false,
      only_if: question.only_if || "", only_if_is: question.only_if ? question.only_if_is || [] : [],
    })),
  };
}

export function collect() {
  return normalise({
    ...Object.fromEntries([...TEXT, ...Object.keys(CHOICES), ...Object.keys(NUMBERS)]
      .map((name) => [name, el(name).value])),
    ...Object.fromEntries(Object.keys(SWITCHES).map((name) => [name, el(name).checked])),
    ...Object.fromEntries(LINES.map((name) => [name, lines(el(name).value)])),
    ...Object.fromEntries(COMMAS.map((name) => [name, commas(el(name).value)])),
    questions,
  });
}

const commas = (text) => text.split(",").map((s) => s.trim()).filter(Boolean);

/** Problems a business can fix, checked here so the call page never starts on a broken setup. */
export function problems(setup) {
  const found = [];
  if (!setup.purpose.trim()) found.push("say why it is calling");
  if (!setup.questions.length) found.push("add at least one question");
  const names = setup.questions.map((question) => question.save_as);
  setup.questions.forEach((question, at) => {
    if (!question.ask.trim()) found.push("every question needs wording");
    if (!/^[a-z_][a-z0-9_]*$/i.test(question.save_as)) found.push(`"${question.save_as || "unnamed"}": the saved name needs letters, numbers and underscores`);
    if (question.type === "choice" && (question.options || []).length < 2) found.push(`"${question.save_as}": a choice needs at least two options`);
    if (question.only_if && !names.slice(0, at).includes(question.only_if)) found.push(`"${question.save_as}" can only depend on a question above it`);
    else if (question.only_if && !question.only_if_is.length) found.push(`"${question.save_as}": say which answer it is asked after`);
  });
  names.forEach((name, at) => {
    if (name && names.indexOf(name) !== at) found.push(`two questions are saved as "${name}"`);
  });
  return [...new Set(found)];
}

async function save() {
  const setup = collect();
  const found = problems(setup);
  el("setup-problems").textContent = found.length ? found[0] : "";
  if (found.length) { toast(found[0], "bad"); return null; }

  try {
    saved = await api.saveSetup(setup);
    disarmReset();                      // there is nothing left to discard
    el("saved-note").textContent = "Saved";
    setTimeout(() => (el("saved-note").textContent = ""), 2500);
    onSaved(saved);
    return saved;
  } catch (problem) {
    toast(problem.message, "bad");
    return null;
  }
}

function alreadyEmpty() {
  return JSON.stringify(collect()) === JSON.stringify(normalise(EMPTY));
}

// Clearing the form throws away everything on screen in one click, so it asks first — on the button
// itself, because a browser modal would block the page and nothing else in this pane uses one.
let armed = false;
let disarmAfter = null;

function disarmReset() {
  armed = false;
  clearTimeout(disarmAfter);
  el("reset").textContent = "Reset";
  el("reset").classList.remove("danger");
}

function reset() {
  if (alreadyEmpty()) {
    disarmReset();
    return toast("The form is already empty.");
  }
  if (!armed) {
    armed = true;
    el("reset").textContent = "Clear everything?";
    el("reset").classList.add("danger");
    disarmAfter = setTimeout(disarmReset, 5000);   // a click meant for something else shouldn't stay armed
    return;
  }
  disarmReset();
  fill(EMPTY);
  el("setup-problems").textContent = "";
  // Deliberately not telling the header or the call view. Emptying the form changes nothing on disk, so
  // until this is saved a call would still use the setup that is already there, and saying otherwise
  // would have the page claim a business it cannot yet call as.
  el("business_name").focus();
  toast("Cleared. Fill it in and save.");
}

async function suggest() {
  const setup = collect();
  if (!setup.purpose.trim()) { toast("Say why it is calling first.", "bad"); return; }
  const button = el("suggest");
  button.disabled = true;
  const wasSaying = button.textContent;
  button.textContent = "Thinking…";
  try {
    const { questions: found, notices } = await api.suggestQuestions(setup);
    questions = questions.concat(found.map((question) => ({ ...question, only_if: "", only_if_is: [] })));
    drawQuestions();
    toast(`Added ${found.length}. Edit or remove any of them.`);
    (notices || []).forEach((notice) => toast(notice));
  } catch (problem) {
    toast(problem.message, "bad");
  } finally {
    button.disabled = false;
    button.textContent = wasSaying;
  }
}

// ── voice ──────────────────────────────────────────────────────────────────
function showSpeed() {
  el("speed-shown").textContent = `${Number(el("speaking_speed").value || 1).toFixed(2)}×`;
}

function addVoiceOption(id, name = `Voice ${id}`) {
  if ([...el("voice_id").options].some((option) => option.value === id)) return;
  el("voice_id").appendChild(make("option", { value: id, text: name }));
}

function showVoice() {
  const voice = voices.find((one) => one.id === el("voice_id").value);
  el("voice-about").textContent = voice?.about || (el("voice_id").value ? "" : "The one set in settings.py.");
}

async function loadVoices(wanted) {
  try {
    ({ voices } = await api.voices());
  } catch {
    voices = [];
  }
  const chosen = el("voice_id").value || wanted || "";
  voices.forEach((voice) => addVoiceOption(voice.id, voice.name));
  el("voice_id").value = chosen;
  showVoice();
}

let sample = null;                   // the one playing, so a second click stops it rather than doubling up

async function hear() {
  const button = el("hear");
  if (sample) {
    sample.abort();
    return;
  }
  const setup = collect();
  const text = `Hi, this is ${setup.assistant_name || "your assistant"} from ${setup.business_name || "us"}. `
    + "Is now a good time for a quick chat?";

  const context = await audioContext();
  const player = new Player(context);
  sample = new AbortController();
  button.textContent = "Stop";
  try {
    const head = await api.turn({
      url: "/api/hear", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ setup, text }), signal: sample.signal,
      onAudio: (bytes) => player.push(bytes),
    });
    if (!head?.audioBytes) toast("No audio came back. The speech service may be out of credit.", "bad");
    while (player.secondsLeft() > 0 && !sample.signal.aborted) await new Promise((r) => setTimeout(r, 100));
  } catch (problem) {
    if (problem.name !== "AbortError") toast(problem.message, "bad");
  } finally {
    player.stop();
    sample = null;
    button.textContent = "Hear it";
  }
}

// ── questions ──────────────────────────────────────────────────────────────
function drawQuestions() {
  const holder = clear(el("questions"));
  if (!questions.length) {
    holder.appendChild(make("p", { class: "empty", text: "No questions yet. Add one, or let the AI suggest some." }));
    return;
  }
  questions.forEach((question, index) => holder.appendChild(questionCard(question, index)));
}

function questionCard(question, index) {
  const update = (key, value, redraw = false) => {
    questions[index][key] = value;
    if (redraw) drawQuestions();
  };

  const ask = make("input", { type: "text", value: question.ask, placeholder: "How many people are coming?" });
  ask.addEventListener("input", () => update("ask", ask.value));

  const savedAs = make("input", { type: "text", value: question.save_as, placeholder: "party_size" });
  // Redrawn on leaving the box rather than on each key, so later questions' "Only ask if" lists keep up
  // without the cursor being thrown out of the box mid-word.
  savedAs.addEventListener("input", () => update("save_as", savedAs.value));
  savedAs.addEventListener("change", () => drawQuestions());

  const type = make("select", {}, TYPES.map((name) =>
    make("option", { value: name, selected: name === question.type }, name.replace("_", " / "))));
  type.addEventListener("change", () => update("type", type.value, true));

  const required = make("input", { type: "checkbox", checked: question.required !== false });
  required.addEventListener("change", () => update("required", required.checked));

  const rule = make("input", { type: "text", value: question.rule || "",
    placeholder: "Between 1 and 20 people. We are closed on Mondays." });
  rule.addEventListener("input", () => update("rule", rule.value));

  const remove = make("button", { class: "icon danger", title: "Remove", text: "×" });
  remove.addEventListener("click", () => { questions.splice(index, 1); drawQuestions(); });

  const parts = [
    make("div", { class: "q-grid" }, [
      make("label", { class: "grow" }, ["Question, as it is spoken", ask]),
      make("label", {}, ["Saved as", savedAs]),
      make("label", {}, ["Answer", type]),
      make("label", { class: "switch tight" }, ["Required", required]),
      remove,
    ]),
    make("label", { class: "rule" }, ["Rule for an acceptable answer", rule]),
  ];

  if (question.type === "choice") {
    const options = make("input", { type: "text", value: (question.options || []).join(", "),
      placeholder: "inside, outside" });
    options.addEventListener("input", () => update("options", commas(options.value)));
    parts.push(make("label", {}, ["Options, separated by commas", options]));
  }

  // Only a question above this one can decide it, so nothing ever waits on something asked later.
  const earlier = questions.slice(0, index).map((other) => other.save_as).filter(Boolean);
  if (earlier.length || question.only_if) {
    const names = [...new Set([...earlier, question.only_if].filter(Boolean))];
    const when = make("select", {}, [
      make("option", { value: "", text: "Always" }),
      ...names.map((name) => make("option", { value: name, selected: name === question.only_if, text: `When ${name} is…` })),
    ]);
    when.addEventListener("change", () => update("only_if", when.value, true));
    const row = [make("label", {}, ["Ask it", when])];

    if (question.only_if) {
      const parent = questions.find((other) => other.save_as === question.only_if);
      const hint = parent?.type === "yes_no" ? "no" : parent?.type === "choice" ? (parent.options || []).join(", ") : "";
      const is = make("input", { type: "text", value: (question.only_if_is || []).join(", "), placeholder: hint });
      is.addEventListener("input", () => update("only_if_is", commas(is.value)));
      row.push(make("label", {}, ["…any of these answers", is]));
    }
    parts.push(make("div", { class: "q-when" }, row));
  }

  return make("div", { class: "question" }, parts);
}
