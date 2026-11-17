"""Run with:  python -m unittest discover tests

No network and no API keys: the AI is replaced where a test would reach it, and every file goes to a temp folder.
"""
import json
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

from voice_call import contacts, engine, gemini, results, scope, server, settings, speech, storage
from voice_call.models import Answer, BusinessSetup, Call, Flow, Question, Turn

OWNER = "a" * 16          # any account id: storage only runs on behalf of someone


def setup(**more) -> BusinessSetup:
    return BusinessSetup(purpose="Check a booking", questions=[
        Question(save_as="party_size", ask="How many?", type="number"),
        Question(save_as="on_time", ask="On time?", type="yes_no"),
        Question(save_as="why", ask="What went wrong?", only_if="on_time", only_if_is=["no"]),
    ], **more)


class StopAndOptOut(unittest.TestCase):
    def test_plain_stops_end_a_call_however_short(self):
        for words in ("stop", "not interested", "no thanks", "bye", "I don't want this"):
            self.assertTrue(engine.PLAIN_STOP.search(words), words)

    def test_ordinary_answers_do_not_stop_it(self):
        for words in ("four people", "yes", "no", "Friday at seven", "I'll be there"):
            self.assertFalse(engine.PLAIN_STOP.search(words), words)
            self.assertFalse(engine.NEVER_AGAIN.search(words), words)

    def test_asking_never_to_be_called_again(self):
        for words in ("Please do not call me again", "stop calling me", "take me off your list", "remove my number"):
            self.assertTrue(engine.NEVER_AGAIN.search(words), words)

    def test_opt_out_ends_the_call_and_is_remembered(self):
        call = Call(setup(), {"id": "abc"})
        turn = Turn(answers=[], intent="answering", reply="Of course, goodbye.")
        with mock.patch.object(engine, "think", return_value=turn):
            result = engine.reply_to(call, "Please don't call me again")
        self.assertTrue(result["ended"])
        self.assertTrue(call.opt_out)
        self.assertEqual(call.outcome, "incomplete")

    def test_a_short_stop_phrase_ends_the_call(self):
        call = Call(setup(), {})
        turn = Turn(answers=[], intent="answering", reply="Goodbye.")
        with mock.patch.object(engine, "think", return_value=turn):
            result = engine.reply_to(call, "not interested")
        self.assertTrue(result["ended"])
        self.assertFalse(call.opt_out)


class Answers(unittest.TestCase):
    def test_choice_answers_must_match_an_option(self):
        s = BusinessSetup(questions=[Question(save_as="mood", ask="?", type="choice", options=["good", "bad"])])
        call = Call(s, {})
        engine.keep_answers(call, Turn(answers=[Answer(save_as="mood", value="GOOD", valid=True)], intent="answering", reply=""))
        self.assertEqual(call.answers["mood"]["value"], "good")
        engine.keep_answers(call, Turn(answers=[Answer(save_as="mood", value="meh", valid=True)], intent="answering", reply=""))
        self.assertEqual(call.failed["mood"], 1)

    def test_conditional_question_waits_for_its_answer(self):
        call = Call(setup(), {})
        self.assertIsNone(call.applies(call.setup.question("why")))
        call.answers["on_time"] = {"value": "no", "said": "no"}
        self.assertTrue(call.applies(call.setup.question("why")))
        call.answers["on_time"] = {"value": "yes", "said": "yes"}
        self.assertFalse(call.applies(call.setup.question("why")))


class Phones(unittest.TestCase):
    def test_numbers_are_made_alike(self):
        self.assertEqual(contacts.phone_number("98765 43210"), "+919876543210")
        self.assertEqual(contacts.phone_number("09876543210"), "+919876543210")
        self.assertEqual(contacts.phone_number("0044 7700 900123"), "+447700900123")
        self.assertEqual(contacts.phone_number("123"), "")


class Csv(unittest.TestCase):
    def test_formulas_are_made_text(self):
        self.assertEqual(results._safe("=1+1"), "'=1+1")
        self.assertEqual(results._safe("@SUM(A1)"), "'@SUM(A1)")
        self.assertEqual(results._safe("four"), "four")
        self.assertEqual(results._safe("+919876543210"), "+919876543210")     # a phone number is not a formula
        self.assertEqual(results._safe(None), "")

    def test_test_calls_are_left_out_of_results(self):
        with tempfile.TemporaryDirectory() as folder, mock.patch.object(settings, "DATA_FOLDER", Path(folder)), \
                scope.acting_as(OWNER):
            for name, test in (("a", True), ("b", False)):
                call = Call(setup(), {}, flow_id="f1")
                call.id, call.test, call.outcome = name, test, "completed"
                storage.save_call(call)
            flow = Flow(id="f1", setup=setup())
            self.assertEqual(results.flow_results(flow)["calls"], 1)
            self.assertEqual(results.flow_results(flow, tests=True)["calls"], 2)
            self.assertEqual(results.stats()["flows"]["f1"]["calls"], 1)


class Flows(unittest.TestCase):
    def test_deleting_the_last_flow_does_not_bring_the_example_back(self):
        with tempfile.TemporaryDirectory() as folder, mock.patch.object(settings, "DATA_FOLDER", Path(folder)), \
                scope.acting_as(OWNER):
            first = storage.list_flows()
            self.assertEqual(len(first), 1)
            storage.delete_flow(first[0].id)
            self.assertEqual(storage.list_flows(), [])


class Models(unittest.TestCase):
    def test_a_new_day_goes_back_to_the_first_model(self):
        gemini.current["ai"] = settings.AI_MODELS[-1]
        gemini._day = "2000-01-01"
        gemini._new_day()
        self.assertEqual(gemini.current["ai"], settings.AI_MODELS[0])


class Words(unittest.TestCase):
    def test_a_setting_out_of_range_is_said_plainly(self):
        from pydantic import ValidationError
        with self.assertRaises(ValidationError) as caught:
            BusinessSetup(speaking_speed=5)
        self.assertEqual(server.explain(caught.exception), "Speed can't be more than 1.2.")


class Small(unittest.TestCase):
    def test_a_hindi_full_stop_ends_a_sentence(self):
        self.assertEqual(len(speech.sentences("आपका दिन शुभ हो। क्या आप कल आ सकते हैं।")), 2)

    def test_bad_numbers_in_the_query_use_the_default(self):
        self.assertEqual(server.whole({"limit": "abc"}, "limit", 20, 1, 100), 20)
        self.assertEqual(server.whole({"limit": "999"}, "limit", 20, 1, 100), 100)
        self.assertEqual(server.whole({}, "limit", 20, 1, 100), 20)


class Abandoned(unittest.TestCase):
    def test_a_quiet_call_is_saved_and_closed_once(self):
        with tempfile.TemporaryDirectory() as folder, mock.patch.object(settings, "DATA_FOLDER", Path(folder)), \
                mock.patch.object(server.engine, "summarise", side_effect=RuntimeError("no AI in tests")):
            call = Call(setup(), {"id": "c1"}, owner=OWNER)
            call.add("assistant", "Hello")
            server.calls[call.id] = call
            server.close_abandoned(call, "test")
            server.close_abandoned(call, "test again")        # the second does nothing
            saved = json.loads((Path(folder) / "users" / OWNER / "calls" / f"{call.id}.json").read_text(encoding="utf-8"))
            self.assertEqual(saved["end_reason"], "hung up")
            self.assertEqual(saved["outcome"], "incomplete")
            server.calls.pop(call.id, None)

    def test_a_call_in_the_middle_of_a_turn_is_not_closed(self):
        call = Call(setup(), {})
        with server.turn_lock(call.id):
            server.close_abandoned(call, "test")
        self.assertIsNone(call.outcome)


class GoingBack(unittest.TestCase):
    """A loop step sends the call back to an earlier question, a set number of times and no more."""

    def looped(self, times=2) -> Call:
        return Call(setup=BusinessSetup(purpose="Take a booking", confirm_at_end=False, questions=[
            Question(save_as="party_size", ask="How many?", type="number"),
            Question(save_as="day", ask="Which day?"),
            Question(save_as="correct", ask="Is that right?", type="yes_no"),
            Question(kind="loop", save_as="go_back", ask="", back_to="party_size", times=times,
                     only_if="correct", only_if_is=["no"], required=False),
            Question(save_as="name", ask="What name?"),
        ]), customer={})

    def answer(self, call, **given):
        for name, value in given.items():
            call.answers[name] = {"value": value, "said": value}

    def test_it_waits_until_the_call_reaches_it(self):
        call = self.looped()
        self.answer(call, correct="no")                      # said early, with questions before it still open
        self.assertIsNone(call.triggered_loop())
        self.answer(call, party_size="4", day="friday")
        self.assertEqual(call.triggered_loop().save_as, "go_back")

    def test_yes_moves_on(self):
        call = self.looped()
        self.answer(call, party_size="4", day="friday", correct="yes")
        self.assertIsNone(call.triggered_loop())

    def test_going_back_clears_the_answers_and_asks_again(self):
        call = self.looped()
        self.answer(call, party_size="4", day="friday", correct="no")
        with mock.patch.object(engine, "think", return_value=Turn(reply="Sorry. How many?", intent="answering", answers=[])):
            said = engine.go_back(call, call.triggered_loop(), "no that's wrong")
        self.assertFalse(said["ended"])
        self.assertEqual(call.answers, {})
        self.assertEqual([q.save_as for q in call.unanswered()][0], "party_size")
        self.assertEqual(call.loops, {"go_back": 1})

    def test_it_stops_going_back_after_its_limit(self):
        call = self.looped(times=2)
        with mock.patch.object(engine, "think", return_value=Turn(reply="Again.", intent="answering", answers=[])):
            for _ in range(2):
                self.answer(call, party_size="4", day="friday", correct="no")
                engine.go_back(call, call.triggered_loop(), "no")
        self.answer(call, party_size="4", day="friday", correct="no")
        self.assertIsNone(call.triggered_loop())             # third "no": it moves on rather than loop for ever

    def test_a_setup_is_checked(self):
        bad = BusinessSetup(purpose="x", questions=[
            Question(save_as="a", ask="A?"),
            Question(kind="loop", save_as="go_back", ask="", back_to="nowhere"),
        ])
        found = " ".join(server.check_setup(bad))
        self.assertIn("needs a condition", found)
        self.assertIn("go back to", found)


class StudioChat(unittest.TestCase):
    """The studio chat proposes steps; what comes back is made safe before anyone sees it."""

    def test_a_proposal_keeps_places_and_fixes_names(self):
        from voice_call import assist
        base = setup()
        base.questions[0].x, base.questions[0].y = 40, 60
        proposed = assist.Proposal(reply="Added a question about allergies.", changed=True, questions=[
            base.questions[0],
            Question(save_as="Any allergies?", ask="Any allergies?", type="yes_no", options=["x"]),
            Question(save_as="party_size", ask="Again?"),          # a name already used
        ])
        with mock.patch.object(assist, "ask_ai", return_value=proposed):
            found = assist.assist(base, [{"role": "user", "text": "ask about allergies"}], ["party_size", "nonsense"])
        self.assertTrue(found["changed"])
        names = [q["save_as"] for q in found["questions"]]
        self.assertEqual(len(names), len(set(names)))
        self.assertTrue(all(name.isidentifier() for name in names))
        self.assertEqual((found["questions"][0]["x"], found["questions"][0]["y"]), (40, 60))
        self.assertEqual(found["questions"][1]["options"], [])     # options only belong to a choice

    def test_an_answer_with_no_change_proposes_nothing(self):
        from voice_call import assist
        reply = assist.Proposal(reply="Keep it under five questions.", changed=False, questions=[])
        with mock.patch.object(assist, "ask_ai", return_value=reply):
            found = assist.assist(setup(), [{"role": "user", "text": "how long should it be?"}], [])
        self.assertEqual((found["changed"], found["questions"]), (False, []))

    def test_asking_to_see_the_flow_is_a_look_not_a_build(self):
        from voice_call import assist
        looking = assist.Proposal(reply="Here it is.", changed=False, questions=[], show="questions")
        # "flow" reads like a build word, but the person only wants to see: no second, firmer ask for steps
        with mock.patch.object(assist, "ask_ai", return_value=looking) as asked:
            found = assist.assist(setup(), [{"role": "user", "text": "show me the whole flow"}], [])
        self.assertEqual(asked.call_count, 1)
        self.assertEqual((found["show"], found["changed"], found["direct"]), ("questions", False, False))
        junk = assist.Proposal(reply="ok", changed=False, questions=[], show="everything")
        with mock.patch.object(assist, "ask_ai", return_value=junk):
            self.assertEqual(assist.assist(setup(), [{"role": "user", "text": "how long?"}], [])["show"], "")

    def test_the_flow_is_shown_even_when_the_ai_only_answered_in_words(self):
        from voice_call import assist
        words = assist.Proposal(reply="Here is the current call flow.", changed=False, questions=[])   # forgot to say `show`
        for text, shown in [("Show me the whole call flow", "all"), ("list all the questions", "questions"),
                            ("what messages does it say", "messages"), ("What is the call about?", ""), ("how long?", "")]:
            with mock.patch.object(assist, "ask_ai", return_value=words):
                self.assertEqual(assist.assist(setup(), [{"role": "user", "text": text}], [])["show"], shown, text)

    def test_the_number_asked_for_is_the_number_given_and_a_complete_flow_is_not_thin(self):
        from voice_call import assist
        self.assertEqual([assist._requested(t) for t in ("add 4 more questions", "I need five questions", "suggest 6 new questions", "add a question")], [4, 5, 6, 0])
        base = setup()
        old = list(base.questions)
        qs = lambda n: [Question(save_as=f"extra_{i}", ask=f"Extra question {i}?") for i in range(n)]
        # asked for 4 more: the first answer has 3, the second has 4 and is taken
        three = assist.Proposal(reply="ok", changed=True, questions=old + qs(3))
        four = assist.Proposal(reply="ok", changed=True, questions=old + qs(4))
        with mock.patch.object(assist, "ask_ai", side_effect=[three, four]) as asked:
            found = assist.assist(base, [{"role": "user", "text": "add 4 more questions"}], [])
        self.assertEqual(asked.call_count, 2)
        self.assertEqual(len(found["questions"]), len(old) + 4)
        # ideas follow the number too, up to ten
        six = assist.Proposal(reply="ok", changed=False, questions=[], ideas=qs(6))
        with mock.patch.object(assist, "ask_ai", return_value=six):
            self.assertEqual(len(assist.assist(base, [{"role": "user", "text": "suggest 6 more questions"}], [])["ideas"]), 6)
        # a complete flow with two questions is asked again for the whole thing
        thin = assist.Proposal(reply="ok", changed=True, questions=qs(2))
        whole = assist.Proposal(reply="ok", changed=True, questions=qs(7))
        with mock.patch.object(assist, "ask_ai", side_effect=[thin, whole]):
            found = assist.assist(base, [{"role": "user", "text": "give me the complete flow"}], [])
        self.assertEqual(len(found["questions"]), 7)

    def test_a_plain_request_is_marked_direct_only_when_steps_came_back(self):
        from voice_call import assist
        base = setup()
        said = [{"role": "user", "text": "delete the last question"}]
        done = assist.Proposal(reply="I removed it.", changed=True, direct=True, questions=base.questions[:-1])
        with mock.patch.object(assist, "ask_ai", return_value=done):
            self.assertTrue(assist.assist(base, said, [])["direct"])
        empty = assist.Proposal(reply="Which one?", changed=False, direct=True, questions=[])
        with mock.patch.object(assist, "ask_ai", return_value=empty):
            self.assertFalse(assist.assist(base, said, [])["direct"])

    def test_conditions_and_go_backs_only_where_they_make_sense(self):
        from voice_call import assist
        fine = Question(save_as="fine", ask="Was everything fine?", type="yes_no")
        why = Question(save_as="why", ask="What went wrong?", only_if="fine", only_if_is=["no"])           # a real follow-up
        always = Question(save_as="always", ask="Anything else?", only_if="fine", only_if_is=["yes", "no"])  # true whatever they say
        nothing = Question(save_as="nothing", ask="Tell us more", only_if="ghost", only_if_is=["x"])         # waits on nothing
        free = Question(save_as="name", ask="Your name?")
        onfree = Question(save_as="spell", ask="Spell it?", only_if="name", only_if_is=["bob"])              # a free answer cannot be matched
        back = Question(save_as="again", ask="", kind="loop", back_to="fine", only_if="fine", only_if_is=["no"], times=2)
        nowhere = Question(save_as="lost", ask="", kind="loop", back_to="ghost", only_if="fine", only_if_is=["no"])
        bare = Question(save_as="bare", ask="", kind="loop", back_to="fine")
        steps = [fine, why, always, nothing, free, onfree, back, nowhere, bare]
        empty = setup().model_copy(update={"questions": []})
        kept = {q.save_as: q for q in assist.tidy(steps, empty, True, loops_ok=True)}
        self.assertEqual(kept["why"].only_if, "fine")
        for name in ("always", "nothing", "spell"):
            self.assertEqual((kept[name].only_if, kept[name].only_if_is), ("", []), name)
        self.assertIn("again", kept)
        self.assertNotIn("lost", kept)        # goes back to nothing
        self.assertNotIn("bare", kept)        # waits on nothing
        # never added on the AI's own: no go-back unless the person talked about one
        self.assertNotIn("again", {q.save_as for q in assist.tidy(steps, empty, True, loops_ok=False)})
        self.assertFalse(assist._wants_loops("build a flow for booking a table"))
        self.assertTrue(assist._wants_loops("ask again if they say no"))

    def test_the_ways_of_an_if_and_its_else_sit_next_to_each_other(self):
        from voice_call import assist
        coming = Question(save_as="coming", ask="Still coming?", type="yes_no")
        guests = Question(save_as="guests", ask="Same guests?", type="yes_no", only_if="coming", only_if_is=["yes"])
        time = Question(save_as="time", ask="Which time?")
        move = Question(save_as="move", ask="Another day?", type="yes_no", only_if="coming", only_if_is=["no"])   # the else, far from its if
        empty = setup().model_copy(update={"questions": []})
        kept = assist.tidy([coming, guests, time, move], empty, True)
        self.assertEqual([q.save_as for q in kept], ["coming", "guests", "move", "time"])
        self.assertEqual([q.only_if_is for q in kept[1:3]], [["yes"], ["no"]])       # both ways, an if and an else

    def test_a_step_the_person_already_has_keeps_its_condition(self):
        from voice_call import assist
        mine = Question(save_as="note", ask="Note?", only_if="ghost", only_if_is=["x"])
        base = setup().model_copy(update={"questions": [mine]})
        kept = assist.tidy([mine], base)
        self.assertEqual(kept[0].only_if, "ghost")          # theirs: the studio flags it, it is not quietly dropped

    def test_nothing_said_asks_nothing(self):
        from voice_call import assist
        with mock.patch.object(assist, "ask_ai", side_effect=AssertionError("should not be asked")):
            self.assertEqual(assist.assist(setup(), [{"role": "user", "text": "  "}], [])["reply"], "")


class WhatNext(unittest.TestCase):
    """Suggestions for the next step: only what could really go there is offered."""

    def test_only_usable_suggestions_come_back(self):
        from voice_call import assist
        offered = assist.NextSteps(options=[
            Question(save_as="party_size", ask="Any allergies we should know about?", type="yes_no"),   # name taken
            Question(save_as="late", ask="When will you arrive?", only_if="why", only_if_is=["x"]),     # waits on a later question
            Question(kind="end", save_as="stop", ask="Goodbye."),                                        # an end with no condition
            Question(save_as="again", ask="How many?"),                                                  # already asked
        ])
        with mock.patch.object(assist, "ask_ai", return_value=offered):
            found = assist.suggest_next(setup(), "on_time")
        self.assertEqual([q.ask for q in found], ["Any allergies we should know about?", "When will you arrive?"])
        self.assertNotEqual(found[0].save_as, "party_size")
        self.assertEqual((found[1].only_if, found[1].only_if_is), ("", []))

    def test_a_confirming_call_never_asks_who_they_are(self):
        from voice_call import assist
        base = setup().model_copy(update={"purpose": "Call customers to confirm their table booking for tonight."})
        offered = assist.NextSteps(options=[
            Question(save_as="who", ask="May I know your name?"),
            Question(save_as="phone", ask="What is your phone number?"),
            Question(save_as="under", ask="Whose name is the table booked under?"),
            Question(save_as="coming", ask="Are you still able to make it at the booked time?", type="yes_no"),
            Question(save_as="size", ask="Is the number of guests still the same?", type="yes_no"),
        ])
        with mock.patch.object(assist, "ask_ai", return_value=offered) as asked:
            found = assist.suggest_next(base, "")
        self.assertEqual([q.save_as for q in found], ["coming", "size"])
        self.assertIn("THINK LIKE THE CALLER", asked.call_args.args[1])
        # but where collecting the name is the whole point, it is asked
        taking = base.model_copy(update={"purpose": "Take table bookings: ask the caller for their name and party size."})
        with mock.patch.object(assist, "ask_ai", return_value=offered):
            self.assertIn("who", [q.save_as for q in assist.suggest_next(taking, "")])

    def test_sign_offs_and_second_hellos_are_never_suggested_and_the_place_is_told(self):
        from voice_call import assist
        offered = assist.NextSteps(options=[
            Question(kind="say", save_as="bye", ask="Thank you for your time, have a good day!"),
            Question(kind="say", save_as="hi", ask="Hello, this is Aria calling from the clinic."),
            Question(save_as="reason", ask="What is the visit for?"),
            Question(save_as="slot", ask="Which day suits you best?"),
        ])
        with mock.patch.object(assist, "ask_ai", return_value=offered) as asked:
            found = assist.suggest_next(setup(), "")           # the very start, straight after the greeting
        self.assertEqual([q.save_as for q in found], ["reason", "slot"])
        prompt = asked.call_args.args[1]
        self.assertIn("very START", prompt)
        self.assertIn("NEVER suggest a goodbye", prompt)


if __name__ == "__main__":
    unittest.main()
