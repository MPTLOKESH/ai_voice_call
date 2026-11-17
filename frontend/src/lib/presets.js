/* What can be dragged onto the line.
 *
 * Question presets arrive already written and typed, so a rating is one drag, not a drag and five fields.
 * The other blocks are steps of a different kind: a message the assistant says, and an end to the call.
 * "Branch" is not added to the line: it is dropped on a question to make that question conditional.
 */
import { CalendarDays, GitBranch, Hash, ListChecks, Megaphone, MessageSquareText, PhoneForwarded, PhoneOff, Repeat, Star, ThumbsUp } from "lucide-react";

export const QUESTION_PRESETS = [
  { id: "yes_no", label: "Yes / No", icon: ThumbsUp,
    question: { type: "yes_no", ask: "Are you happy with it?" } },
  { id: "rating", label: "Rating 1–5", icon: Star,
    question: { type: "number", ask: "On a scale of 1 to 5, how would you rate it?", rule: "A whole number from 1 to 5." } },
  { id: "nps", label: "Score 0–10", icon: Hash,
    question: { type: "number", ask: "On a scale of 0 to 10, how likely are you to recommend us to a friend?", rule: "A whole number from 0 to 10." } },
  { id: "choice", label: "Choice", icon: ListChecks,
    question: { type: "choice", ask: "Which would you prefer?", options: ["Option A", "Option B"] } },
  { id: "number", label: "Number", icon: Hash,
    question: { type: "number", ask: "How many?", rule: "A whole number." } },
  { id: "date", label: "Date", icon: CalendarDays,
    question: { type: "date", ask: "What date works best for you?" } },
  { id: "text", label: "Open answer", icon: MessageSquareText,
    question: { type: "text", ask: "Is there anything else you would like to tell us?", required: false } },
];

export const STEP_BLOCKS = [
  { id: "say", label: "Message", icon: Megaphone, hint: "The assistant tells them something, and expects no answer" },
  { id: "end", label: "End call", icon: PhoneOff, hint: "Ends the call politely when an earlier answer matches" },
  { id: "handoff", label: "Hand over", icon: PhoneForwarded, hint: "Ends the call and marks it for a person to follow up" },
  { id: "loop", label: "Go back", icon: Repeat, hint: "Goes back to an earlier question and asks again when an answer matches" },
];

export const BRANCH_BLOCK = {
  id: "branch", label: "Branch", icon: GitBranch,
  hint: "Drag onto a question to ask it only when an earlier answer matches",
};

/** The fields a new step of that kind starts with (the saved name and key are given by the form). */
export const stepFields = (id) => ({
  say: { kind: "say", type: "text", required: false },
  end: { kind: "end", type: "text", required: false, handoff: false },
  handoff: { kind: "end", type: "text", required: false, handoff: true },
  loop: { kind: "loop", type: "text", required: false, times: 2 },
}[id]);
