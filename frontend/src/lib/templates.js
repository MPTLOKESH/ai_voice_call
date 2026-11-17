/* Starting points for a new flow: what it is for and the questions that usually go with it.
 * A flow made from one still keeps who is calling and how it sounds from the flow it was started in. */

const q = (save_as, ask, type = "text", more = {}) => ({
  save_as, ask, type, rule: "", options: [], required: true, only_if: "", only_if_is: [], ...more,
});

export const TEMPLATES = [
  {
    id: "blank", name: "Blank flow", blurb: "Start from nothing and add your own questions.",
    purpose: "", questions: [],
  },
  {
    id: "booking", name: "Booking confirmation", blurb: "Confirm a booking, and the number of people.",
    purpose: "Call customers to confirm their upcoming booking.",
    questions: [
      q("booking_confirmed", "Can you confirm you are still coming?", "yes_no"),
      q("party_size", "How many people will be coming?", "number", { rule: "A whole number from 1 to 20." }),
      q("special_requests", "Is there anything we should know about before you arrive?", "text", { required: false }),
    ],
  },
  {
    id: "feedback", name: "Post-visit feedback", blurb: "A rating, what went well, and what to improve.",
    purpose: "Call customers after their visit to hear how it went.",
    questions: [
      q("rating", "On a scale of 1 to 5, how was your visit?", "number", { rule: "A whole number from 1 to 5." }),
      q("liked", "What did you like most?", "text", { required: false }),
      q("improve", "Is there anything we could do better?", "text", { required: false }),
    ],
  },
  {
    id: "nps", name: "Recommend score (NPS)", blurb: "How likely they are to recommend you, and why.",
    purpose: "Call customers to ask how likely they are to recommend us.",
    questions: [
      q("recommend_score", "On a scale of 0 to 10, how likely are you to recommend us to a friend?", "number",
        { rule: "A whole number from 0 to 10." }),
      q("reason", "What is the main reason for that score?", "text"),
    ],
  },
  {
    id: "delivery", name: "Delivery check", blurb: "Did it arrive, on time, and in good shape.",
    purpose: "Call customers to check that their delivery arrived properly.",
    questions: [
      q("delivery_received", "Did your order arrive?", "yes_no"),
      q("on_time", "Did it arrive on time?", "yes_no"),
      q("condition", "Was everything in good condition?", "yes_no"),
      q("problem", "What was the problem?", "text", { only_if: "condition", only_if_is: ["no"] }),
    ],
  },
];
