import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useToast } from "../components/ui/Toasts.jsx";
import * as api from "./api.js";
import { blankQuestion, collect, normalise, toForm } from "./setupForm.js";
import { ROW_GAP, layoutMode, layoutNodes, makeRoom, tidy, unclash } from "./layout.js";
import { CLOSE, OPEN, autoName, toName, unique } from "./thread.js";

const AUTOSAVE_MS = 700;
const HISTORY = 100;        // changes that can be undone
const COALESCE_MS = 1000;   // typing in one box is one change, until it pauses this long

/** The name a question is known by to the questions that wait on it, even while its box is being retyped. */
// Where the opening and the finish are, as the layout wants them: null for one taken off the canvas.
const ends = (form) => [form.show_open === false ? null : form.open_at, form.show_close === false ? null : form.close_at];
const known = (question) => question.save_as || question._was || "";
const isAsk = (question) => (question.kind || "ask") === "ask";

/**
 * One flow being edited: its name, its form, and every change a person can make to it. A draft saves
 * itself a moment after the last change, so there is no Save to forget; `save()` does it at once, for the
 * moments (calling, publishing) that need what is on screen to be what is stored.
 *
 * `status` is what the header says: "saved", "saving", "failed" (it tries again on the next change, or on
 * Retry) or "conflict" (another tab saved this flow first; `conflict` holds that version until the person
 * picks theirs or this one).
 *
 * Changes to the form can be undone and redone (`undo`, `redo`). The name has its own box and its own undo.
 */
export function useSetup(flow, onSaved) {
  const toast = useToast();
  // The form, and what undo and redo move between. `group` and `at` let typing in one box count as one change.
  const [store, setStore] = useState(() => ({ form: toForm(flow.setup), past: [], future: [], group: "", at: 0 }));
  const form = store.form;
  const [name, setName] = useState(flow.name);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState("");         // the state a save last failed on, so it isn't retried in a loop
  const [conflict, setConflict] = useState(null);   // the flow as another tab stored it
  const [suggesting, setSuggesting] = useState(false);
  const inflight = useRef(null);     // the save under way, so another waits its turn instead of racing it
  const version = useRef(flow.version ?? 0);
  const gone = useRef(false);        // unmounted, or the flow was deleted: nothing more to save or say

  // A publish or a discard elsewhere stores a newer version of this flow: later saves are made from that.
  useEffect(() => { if ((flow.version ?? 0) > version.current) version.current = flow.version; }, [flow.version]);
  useEffect(() => () => { gone.current = true; }, []);

  const setup = useMemo(() => collect(form), [form]);
  const finalName = name.trim() || "Untitled flow";
  const unsaved = useMemo(
    () => JSON.stringify(setup) !== JSON.stringify(normalise(flow.setup)) || finalName !== flow.name,
    [setup, finalName, flow],
  );
  const stateKey = JSON.stringify([setup, finalName]);

  /** Changes the form. Calls with the same `group` in quick succession are one undo step. */
  const change = useCallback((updater, group = "") => {
    const now = Date.now();
    setStore((current) => {
      const next = updater(current.form);
      if (next === current.form) return current;
      const merge = group && current.group === group && now - current.at < COALESCE_MS && current.past.length > 0;
      return {
        form: next, future: [], group, at: now,
        past: merge ? current.past : [...current.past, current.form].slice(-HISTORY),
      };
    });
  }, []);

  const set = useCallback((field, value) => change((current) => ({ ...current, [field]: value }), `field:${field}`), [change]);

  const undo = useCallback(() => setStore((current) => (current.past.length ? {
    form: current.past[current.past.length - 1], past: current.past.slice(0, -1),
    future: [current.form, ...current.future], group: "", at: 0,
  } : current)), []);
  const redo = useCallback(() => setStore((current) => (current.future.length ? {
    form: current.future[0], past: [...current.past, current.form], future: current.future.slice(1), group: "", at: 0,
  } : current)), []);

  /** Puts a stored flow on screen in place of what was being edited. */
  const reload = useCallback((stored) => {
    version.current = stored.version ?? version.current;
    setStore({ form: toForm(stored.setup), past: [], future: [], group: "", at: 0 });
    setName(stored.name);
    setFailed("");
    setConflict(null);
    onSaved(stored);
  }, [onSaved]);

  const save = useCallback(async () => {
    if (inflight.current) await inflight.current;
    if (gone.current) return null;
    setSaving(true);
    const job = (async () => {
      try {
        const stored = await api.saveFlow(flow.id, { name: finalName, setup, version: version.current });
        version.current = stored.version;
        setFailed("");
        setConflict(null);
        if (!gone.current) onSaved(stored);
        return stored;
      } catch (failure) {
        if (gone.current || failure.status === 404) return null;   // deleted while the save was on its way
        if (failure.status === 409 && failure.data?.flow) {
          setConflict(failure.data.flow);
          return null;
        }
        setFailed(stateKey);
        toast(failure.message, "bad");
        return null;
      }
    })();
    inflight.current = job;
    const stored = await job;
    if (inflight.current === job) { inflight.current = null; setSaving(false); }
    return stored;
  }, [flow.id, finalName, setup, stateKey, onSaved, toast]);

  // A draft saves itself shortly after the last change, unless that very state just failed or another tab
  // got there first.
  useEffect(() => {
    if (!unsaved || saving || conflict || failed === stateKey) return;
    const timer = setTimeout(save, AUTOSAVE_MS);
    return () => clearTimeout(timer);
  }, [unsaved, saving, conflict, failed, stateKey, save]);

  // Closing the tab inside the autosave wait would lose the last few keystrokes. Hiding it saves at once,
  // the ordinary way, since the page is still there to hear back; leaving it sends what is left on the way
  // out, with nobody to hear the answer.
  const latest = useRef(null);
  latest.current = { unsaved, conflict, save, body: { name: finalName, setup, version: version.current } };
  useEffect(() => {
    const flush = () => {
      const now = latest.current;
      if (!now.unsaved || now.conflict || gone.current || inflight.current) return;
      api.saveFlow(flow.id, now.body, { keepalive: true }).catch(() => {});
    };
    const hidden = () => {
      const now = latest.current;
      if (document.visibilityState === "hidden" && now.unsaved && !now.conflict && !gone.current) now.save();
    };
    const warn = (event) => { if (latest.current.unsaved && !latest.current.conflict) event.preventDefault(); };
    document.addEventListener("visibilitychange", hidden);
    window.addEventListener("pagehide", flush);
    window.addEventListener("beforeunload", warn);
    return () => {
      document.removeEventListener("visibilitychange", hidden);
      window.removeEventListener("pagehide", flush);
      window.removeEventListener("beforeunload", warn);
    };
  }, [flow.id]);

  /** After a conflict: this tab's version, saved on top of the other one. */
  function keepMine() {
    if (!conflict) return;
    version.current = conflict.version;
    setConflict(null);
    save();
  }

  /** Drops the edits since the last publish. */
  async function discard() {
    try {
      reload(await api.discardFlow(flow.id));
      toast("Back to the published version.");
    } catch (failure) {
      toast(failure.message, "bad");
    }
  }

  /** An earlier published version, brought back as the draft. */
  async function restore(at) {
    try {
      reload(await api.restoreFlow(flow.id, at));
      toast("Brought back as the draft. Publish it to make it live.");
    } catch (failure) {
      toast(failure.message, "bad");
    }
  }

  // ── steps ──────────────────────────────────────────────────────────────────
  /**
   * The form with nothing on the canvas sitting on top of anything else. The nodes in `ids` (just added or
   * moved) are the ones that give way, to the nearest free place; the rest stay put.
   */
  const spaced = (current, ids = []) => {
    const moved = unclash(current.questions, ...ends(current), ids);
    if (!Object.keys(moved).length) return current;
    return {
      ...current, open_at: moved[OPEN] || current.open_at, close_at: moved[CLOSE] || current.close_at,
      questions: current.questions.map((one) => (moved[one._key] ? { ...one, x: moved[one._key][0], y: moved[one._key][1] } : one)),
    };
  };

  const moved = (current, spots) => (Object.keys(spots).length ? {
    ...current, open_at: spots[OPEN] || current.open_at, close_at: spots[CLOSE] || current.close_at,
    questions: current.questions.map((one) => (spots[one._key] ? { ...one, x: spots[one._key][0], y: spots[one._key][1] } : one)),
  } : current);

  /** Every node laid out again in one of Tidy's ways; "horizontal" clears the places, back to one line. */
  const tidied = (current, mode) => {
    const found = tidy(current.questions, mode);
    if (!found) return { ...current, open_at: [], close_at: [], questions: current.questions.map((one) => ({ ...one, x: null, y: null })) };
    return {
      ...current, open_at: found.open, close_at: found.close,
      questions: current.questions.map((one) => ({ ...one, x: found.spots[one._key][0], y: found.spots[one._key][1] })),
    };
  };

  /**
   * Keeps the canvas neat when steps are added, removed or put in another order. A canvas that is still laid
   * out (one line, or as Tidy left it) is laid out again the same way, so a new step simply takes its place
   * in the line. One that was arranged by hand keeps its arrangement: a new step goes beside the step before
   * it, and the rest of that row moves along to make room.
   */
  const arranged = (before, next) => next;      // nothing is placed by hand: the canvas lays the call out itself

  /** Changes the steps. `ids` are the ones this adds or moves, which the others make room for. */
  const setQuestions = (changeIt, group = "", ids = []) => change((current) => arranged(current, { ...current, questions: changeIt(current.questions) }, ids), group);

  /**
   * Adds a step before position `index` (the end by default). `fields` is what it starts with: a question
   * preset, or the fields of a message or an end (see lib/presets.js). Returns it, to select it.
   */
  function addQuestion(index, fields = {}) {
    const blank = blankQuestion();
    const kind = fields.kind || "ask";
    const taken = form.questions.map((one) => one.save_as);
    const base = kind === "say" ? "message" : kind === "end" ? (fields.handoff ? "handoff" : "end_call") : kind === "loop" ? "go_back" : "";
    const made = { ...blank, ...fields, kind, save_as: base ? unique(base, taken) : autoName(fields.ask || "", taken), _auto: kind === "ask" };
    setQuestions((all) => {
      const next = [...all];
      next.splice(index ?? all.length, 0, made);
      return next;
    }, "", [made._key]);
    return made;
  }

  /**
   * Swaps in a whole new list of steps (what the assistant proposed), as one change. A step kept under its
   * name keeps its key and its place on the canvas; new ones find room. Returns the keys of the new ones.
   */
  function replaceQuestions(list, restart = false) {
    const old = restart ? {} : Object.fromEntries(form.questions.map((one) => [one.save_as, one]));
    const next = list.map((question) => {
      const was = old[question.save_as];
      return { ...blankQuestion(), ...question, _auto: false, ...(was ? { _key: was._key, x: was.x, y: was.y } : { x: null, y: null }) };
    });
    const fresh = next.filter((one) => !old[one.save_as]).map((one) => one._key);
    if (restart) change((current) => ({ ...current, open_at: [], close_at: [], questions: next }));   // a new call, laid out afresh
    else setQuestions(() => next, "", fresh);
    return fresh;
  }

  /** A copy placed straight after the original, with a saved name of its own. */
  function duplicateQuestion(key) {
    const at = form.questions.findIndex((one) => one._key === key);
    if (at < 0) return null;
    const original = form.questions[at];
    const copy = {
      ...blankQuestion(), ...original, _key: blankQuestion()._key, _auto: false, _was: undefined,
      save_as: unique(original.save_as || "question", form.questions.map((one) => one.save_as)),
    };
    setQuestions((all) => {
      const next = [...all];
      next.splice(at + 1, 0, copy);
      return next;
    }, "", [copy._key]);
    return copy;
  }

  /**
   * Changes one question. A question that others are only asked after keeps them pointing at it when its
   * saved name changes, and its name stops following its wording, so a reworded question can't cut them loose.
   */
  const changeQuestion = (key, patch) => setQuestions((all) => {
    const at = all.findIndex((question) => question._key === key);
    if (at < 0) return all;
    const before = all[at];
    const was = known(before);
    const waitedOn = isAsk(before) && Boolean(was) && all.some((other, index) => index !== at && (other.only_if === was || other.back_to === was));
    const others = all.filter((_, other) => other !== at).map((one) => one.save_as);
    const next = { ...before, ...patch };
    if ("save_as" in patch) {
      next.save_as = toName(patch.save_as);
      next._auto = false;
    } else if (patch._reauto) {
      // The name box was left empty: it goes back to following the wording.
      next.save_as = autoName(next.ask, others);
      next._auto = true;
    } else if ("ask" in patch && next._auto && !waitedOn && isAsk(next)) {
      next.save_as = autoName(next.ask, others);
    }
    delete next._reauto;
    next._was = next.save_as || was;
    const renamed = waitedOn && next.save_as && next.save_as !== was;
    return all.map((question, index) => {
      if (index === at) return next;
      if (!renamed || (question.only_if !== was && question.back_to !== was)) return question;
      // Whatever waits on it, or goes back to it, follows its new name.
      return {
        ...question, only_if: question.only_if === was ? next.save_as : question.only_if,
        back_to: question.back_to === was ? next.save_as : question.back_to,
      };
    });
  }, `question:${key}:${Object.keys(patch).join(",")}`);

  /** The steps only asked (or run) after this question, which removing it would leave waiting on nothing. */
  const dependentsOf = (key) => {
    const question = form.questions.find((one) => one._key === key);
    const name = question && isAsk(question) && known(question);
    return name ? form.questions.filter((other) => other._key !== key && other.only_if === name) : [];
  };

  /** Removes a step; any that were waiting on it are then always run. */
  const removeQuestion = (key) => setQuestions((all) => {
    const question = all.find((one) => one._key === key);
    const name = question && isAsk(question) && known(question);
    return all.filter((one) => one._key !== key)
      .map((other) => (name && other.only_if === name ? { ...other, only_if: "", only_if_is: [], _onlyIfIsText: undefined } : other));
  });

  /** Removes several steps as one change; any left that were waiting on one of them are then always run. */
  const removeQuestions = (keys) => setQuestions((all) => {
    const going = new Set(keys);
    const names = new Set(all.filter((one) => going.has(one._key) && isAsk(one)).map(known).filter(Boolean));
    return all.filter((one) => !going.has(one._key))
      .map((other) => (names.has(other.only_if) ? { ...other, only_if: "", only_if_is: [], _onlyIfIsText: undefined } : other));
  });

  /** Moves a step to sit before position `to`, counted as it was before the move. */
  const moveQuestion = (key, to) => setQuestions((all) => {
    const from = all.findIndex((question) => question._key === key);
    if (from < 0) return all;
    const next = [...all];
    const [one] = next.splice(from, 1);
    next.splice(to > from ? to - 1 : to, 0, one);
    return next;
  });

  // ── where things are on the canvas ────────────────────────────────────────
  const whole = (value) => Math.round(value);

  /** Puts the greeting, the close, or a question somewhere on the canvas. It stays where it is in the call. */
  /** Everything where it is now, so that moving one step leaves all the others exactly where they are. */
  const frozen = (current) => {
    const [openAt, closeAt] = ends(current);
    const found = layoutNodes(current.questions, openAt, closeAt);
    const at = (id) => found.find((node) => node.id === id);
    return {
      ...current,
      open_at: openAt === null ? current.open_at : [whole(at(OPEN).x), whole(at(OPEN).y)],
      close_at: closeAt === null ? current.close_at : [whole(at(CLOSE).x), whole(at(CLOSE).y)],
      questions: current.questions.map((one) => ({ ...one, x: whole(at(one._key).x), y: whole(at(one._key).y) })),
    };
  };

  const placeNode = (id, x, y) => change((now) => {
    const current = frozen(now);
    if (id === OPEN) return { ...current, open_at: [whole(x), whole(y)] };
    if (id === CLOSE) return { ...current, close_at: [whole(x), whole(y)] };
    return { ...current, questions: current.questions.map((one) => (one._key === id ? { ...one, x: whole(x), y: whole(y) } : one)) };
  }, `place:${id}`);

  /** Puts several nodes somewhere at once, as one change: `spots` is {id: [x, y]}. */
  const placeNodes = (spots) => change((now) => ({
    ...frozen(now),
    open_at: spots[OPEN] ? spots[OPEN].map(whole) : frozen(now).open_at,
    close_at: spots[CLOSE] ? spots[CLOSE].map(whole) : frozen(now).close_at,
    questions: frozen(now).questions.map((one) => (spots[one._key] ? { ...one, x: whole(spots[one._key][0]), y: whole(spots[one._key][1]) } : one)),
  }));

  /** Moves a question to sit before position `to` in the call, and puts it at (x, y), as one change. */
  const relocate = (key, to, x, y) => setQuestions((all) => {
    const from = all.findIndex((question) => question._key === key);
    if (from < 0) return all;
    const next = [...all];
    const [one] = next.splice(from, 1);
    next.splice(to > from ? to - 1 : to, 0, { ...one, x: whole(x), y: whole(y) });
    return next;
  }, "", [key]);

  /** Lays every node out again: "horizontal" clears the places, back to one line. */
  const tidyUp = (mode) => change((current) => {
    const found = tidy(current.questions, mode);
    if (!found) {
      return { ...current, open_at: [], close_at: [], questions: current.questions.map((one) => ({ ...one, x: null, y: null })) };
    }
    return {
      ...current, open_at: found.open, close_at: found.close,
      questions: current.questions.map((one) => ({ ...one, x: found.spots[one._key][0], y: found.spots[one._key][1] })),
    };
  });

  async function suggest() {
    if (!setup.purpose.trim()) return "purpose";
    setSuggesting(true);
    try {
      const { questions: found, notices } = await api.suggestQuestions(setup);
      if (found.length) {
        const added = found.map((question) => ({ ...blankQuestion(), ...question, _auto: false, only_if: "", only_if_is: [] }));
        setQuestions((all) => [...all, ...added], "", added.map((one) => one._key));
        toast(`Added ${found.length}. Edit or remove any of them.`);
      } else {
        toast("Nothing new to suggest: it already asks what suits this purpose.");
      }
      (notices || []).forEach((notice) => toast(notice));
    } catch (failure) {
      toast(failure.message, "bad");
    } finally {
      setSuggesting(false);
    }
    return "";
  }

  const status = conflict ? "conflict" : saving || (unsaved && failed !== stateKey) ? "saving" : failed === stateKey && unsaved ? "failed" : "saved";

  return {
    form, set, setup, name, setName, unsaved, saving, status, conflict, suggesting,
    canUndo: store.past.length > 0, canRedo: store.future.length > 0, undo, redo,
    save, reload, keepMine, discard, restore, suggest,
    addQuestion, replaceQuestions, duplicateQuestion, changeQuestion, removeQuestion, removeQuestions, moveQuestion, dependentsOf,
    placeNode, placeNodes, relocate, tidyUp,
  };
}
