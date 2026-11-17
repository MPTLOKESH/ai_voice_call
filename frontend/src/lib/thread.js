/* The call as a thread of steps, with no UI in it.
 *
 * The setup is a list of questions. The Studio draws it as a line the call follows: a greeting, then for
 * each question the assistant asking and the customer answering, then the close. This file turns one into
 * the other and works out where things sit, so the canvas only has to draw what it is given.
 */

export const SLOT = 296;   // the room each step takes along the line
export const TILE = 96;    // the tile in it; the rest of the slot is the line to the next step

export const CONTEXT = "context";   // "Why are we calling?": the first thing on the canvas, before the call starts
export const OPEN = "open";
export const CLOSE = "close";
export const askId = (question) => `${question._key}:ask`;
export const answerId = (question) => `${question._key}:answer`;

const kindOf = (question) => question.kind || "ask";

/**
 * Every step in order, each with its place along the line. A question is two steps, the assistant asking and
 * the customer answering; a message, or an end to the call, is one.
 */
export function buildSteps(questions, { open = true, close = true } = {}) {
  const steps = [{ id: CONTEXT, kind: "context" }, ...(open ? [{ id: OPEN, kind: "open" }] : [])];
  questions.forEach((question, index) => {
    const kind = kindOf(question);
    steps.push({ id: askId(question), kind, question, index });
    if (kind === "ask") steps.push({ id: answerId(question), kind: "answer", question, index });
  });
  if (close) steps.push({ id: CLOSE, kind: "close" });
  return steps.map((step, at) => ({ ...step, at, x: at * SLOT }));
}

/** Where each question would begin, and (last) where the end of the call is: the places something can be put. */
export function boundaries(questions) {
  let at = 1;
  const found = [];
  for (const question of questions) {
    found.push(at * SLOT);
    at += kindOf(question) === "ask" ? 2 : 1;
  }
  found.push(at * SLOT);
  return found;
}

/** The question position nearest an x on the line (0 is before the first question, the last is the end). */
export function nearestBoundary(x, bounds) {
  let best = 0;
  bounds.forEach((bound, index) => { if (Math.abs(bound - x) < Math.abs(bounds[best] - x)) best = index; });
  return best;
}

/** Where the "+" between two steps sits: the middle of the gap before the boundary. */
export const gapX = (bounds, index) => bounds[index] - (SLOT - TILE) / 2;

// ── names ───────────────────────────────────────────────────────────────────

const FILLER = new Set(["a", "an", "the", "is", "are", "was", "were", "do", "does", "did", "you", "your", "to", "of",
                        "and", "or", "for", "on", "in", "it", "that", "this", "can", "could", "would", "will",
                        "please", "how", "what", "which", "when", "where", "who", "much", "many", "us", "me", "we", "i"]);

/** A saved name made from the words of a question: "How many people are coming?" is people_coming. */
export function slug(text) {
  const words = text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
  const kept = words.filter((word) => !FILLER.has(word));
  const chosen = (kept.length ? kept : words).slice(0, 3).join("_");
  return /^[0-9]/.test(chosen) ? `q_${chosen}` : chosen;
}

/** What was typed into a saved-name box, made into a valid name: "Party size" is party_size. */
export function toName(text) {
  const name = text.toLowerCase().replace(/[\s-]+/g, "_").replace(/[^a-z0-9_]/g, "");
  return /^[0-9]/.test(name) ? `q_${name}` : name;
}

/** The name a question gets from its wording, falling back to "question" when the wording has no letters to use. */
export const autoName = (text, taken, fallback = "question") => unique(slug(text) || fallback, taken);

/** `name`, or `name_2`, `name_3`… so no two questions are saved as the same thing. */
export function unique(name, taken) {
  if (!name) return "";
  let candidate = name;
  for (let n = 2; taken.includes(candidate); n++) candidate = `${name}_${n}`;
  return candidate;
}

export const humanize = (name) => {
  const spaced = (name || "").replace(/_/g, " ").trim();
  return spaced ? spaced[0].toUpperCase() + spaced.slice(1) : "";
};

// ── how long ────────────────────────────────────────────────────────────────

/** Roughly how long the assistant takes to say a line, at a calm pace of about 2.6 words a second. */
export const speakSeconds = (text) => Math.max(2, Math.round((text.trim().split(/\s+/).filter(Boolean).length / 2.6) * 2) / 2);
export const CUSTOMER_SECONDS = 4;

/** A rough length for the whole call: a greeting, each question and its answer, a close. */
export const estimateSeconds = (questions) =>
  4 + questions.reduce((sum, question) => {
    const kind = kindOf(question);
    if (kind === "end" || kind === "loop") return sum;
    // A message is only said; a question is asked and answered.
    return sum + speakSeconds(question.ask) + (kind === "ask" ? CUSTOMER_SECONDS : 0);
  }, 0) + 3;

export const clock = (seconds) => {
  const whole = Math.max(0, Math.round(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
};

// ── checking ────────────────────────────────────────────────────────────────

/** What is wrong with a question, in a few words, or "" if nothing: the amber dot on its tile. */
export function questionIssue(question, index, all) {
  const kind = kindOf(question);
  if (!question.ask.trim() && kind !== "end" && kind !== "loop") return "Needs wording";
  if (!/^[a-z_][a-z0-9_]*$/i.test(question.save_as)) return "Needs a column name";
  if (all.some((other, at) => at !== index && other.save_as === question.save_as)) return "Column name is used twice";
  if (kind === "ask" && question.type === "choice" && (question.options || []).length < 2) return "Needs two options";
  if (kind === "loop") {
    const target = all.findIndex((other) => kindOf(other) === "ask" && other.save_as === question.back_to);
    if (target < 0 || target >= index) return "Choose where it goes back to";
    if (!question.only_if) return "Needs a condition";
  }
  if (question.only_if) {
    // Only a question asked above it can be waited on.
    const parent = all.findIndex((other) => kindOf(other) === "ask" && other.save_as === question.only_if);
    if (parent < 0 || parent >= index) return "Depends on a later question";
    if (!(question.only_if_is || []).length) return "Needs an answer to wait for";
  }
  return "";
}

// ── voices ──────────────────────────────────────────────────────────────────

const HUES = [285, 20, 150, 330, 60, 220, 250, 110];

/** A gradient orb for a voice, the same colours every time, so a voice is recognised by its orb. */
export function orb(seed) {
  let n = 0;
  for (const ch of String(seed)) n = (n * 31 + ch.charCodeAt(0)) >>> 0;
  const hue = HUES[n % HUES.length];
  return `linear-gradient(135deg, oklch(0.9 0.07 ${hue}), oklch(0.66 0.17 ${hue + 35}))`;
}
