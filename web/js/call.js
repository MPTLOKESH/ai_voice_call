/* The call view: holding a conversation, and showing what the code decided. */

import * as api from "./api.js";
import { Mic, Player, audioContext } from "./audio.js";
import { VoiceMic } from "./vad.js";
import { clear, el, levelMeter, make, stopwatch, toast } from "./ui.js";

let setup = null;
let callId = null;
let speakOutLoud = true;
let player = null;
let mic = null;
let inFlight = null;              // the turn being streamed, so it can be called off
let replying = Promise.resolve(); // settles once that turn's reply has fully arrived
let turns = 0;                    // counts turns, so one that has been overtaken knows to step aside
let callBegan = 0;                // when this call started, so a note can be placed against the clock
let serverEvents = [];            // what the server decided
let notes = [];                   // what the browser saw: the two are drawn together
let deadline = null;              // ends a call that goes quiet past its time limit
let talkedOver = false;           // the next turn interrupted the assistant, and the server must know

const NO_MIC = "No microphone available. A call is spoken, so check this page is allowed to use yours.";

const micMeter = levelMeter("mic-level", "mic-numbers");
const callMeter = levelMeter("call-level", "call-numbers");
const clock = stopwatch((seconds) => (el("t-total").textContent = `${seconds.toFixed(1)}s`));

export function start(loaded) {
  setup = loaded;

  el("start").addEventListener("click", begin);
  el("check-mic").addEventListener("click", checkMic);
  el("again").addEventListener("click", reset);
  // Both of these stand in for something the customer would do, so they still go through `say`: one
  // hangs up mid-call, the other is a turn where nobody spoke.
  el("hangup").addEventListener("click", () => say("I need to go, sorry."));
  el("silent").addEventListener("click", () => say(""));
}

export function setupChanged(loaded) {
  setup = loaded;
}

// ── before a call ──────────────────────────────────────────────────────────
async function checkMic() {
  try {
    await openMic();
    el("mic-meter").hidden = false;
    el("check-mic").querySelector("span").textContent = "Say something and watch the bar";
  } catch {
    problem(NO_MIC);
  }
}

async function openMic() {
  if (mic) return mic;
  const context = await audioContext();
  player ??= new Player(context);

  // Silero decides what is a voice. If it can't be loaded, the old loudness test still works — badly in a
  // noisy room, but better than leaving the caller with no microphone at all.
  try {
    mic = await VoiceMic.open(() => player.playing);
    mic.onNote = (text) => note(text);          // every step of a turn, so nothing fails invisibly
    note("listening with Silero voice detection");
  } catch (problem) {
    toast(`Voice detection unavailable (${problem.message}); falling back to loudness.`, "bad");
    mic = await Mic.open(() => player.playing);
  }
  mic.onLevel = (level, startsAt, doing) => {
    micMeter(level, startsAt, doing);
    callMeter(level, startsAt, doing);
    // The orb swells with the caller's voice, and only theirs: while the assistant talks it stays still.
    const orb = el("orb");
    const yours = orb.dataset.state === "listening" || orb.dataset.state === "hearing";
    orb.style.setProperty("--level", yours ? Math.min(1, level / (startsAt * 2.5)).toFixed(3) : "0");
  };
  mic.onSpeech = () => status("hearing", "Hearing you");
  mic.onInterrupt = () => {
    // Stopping the player only clears what is already scheduled. The request is still open and its
    // audio kept arriving, so `push` scheduled the rest a moment later and the assistant carried on
    // mid-sentence. Call the turn off as well, and the server stops making speech nobody will hear.
    inFlight?.abort();
    player.stop();
    // Stopping the voice is only half of it: the server still believes the whole reply was heard and
    // would carry straight on to the next question. The turn this speech becomes says otherwise.
    talkedOver = true;
    [...el("transcript").querySelectorAll(".line.assistant")].pop()?.classList.add("cut");
    note("you talked over the assistant");
    if (callId) status("listening", "Listening");
  };
  mic.onTurn = (wav, spoken) => {
    if (!callId) return;                           // the call is over: whatever was said is not ours to send
    note(`recorded ${spoken.toFixed(1)}s`);
    const interrupted = talkedOver;
    talkedOver = false;
    // Not talking over the assistant (that is `onInterrupt`, which has already called the reply off), so
    // this may well be the room rather than the customer. Let the reply still arriving finish rather than
    // cut it off: if this turn was only noise, the customer should still hear the whole question.
    run((signal) => api.sendAudio(callId, wav, speakOutLoud, interrupted, hooks(), signal), { afterReply: true });
  };
  return mic;
}

async function begin() {
  problem("");
  speakOutLoud = el("speak").checked;
  callBegan = performance.now();  // before the microphone opens, so its notes are on the clock too
  serverEvents = [];
  notes = [];
  talkedOver = false;

  const context = await audioContext();
  player ??= new Player(context);

  // A call is spoken, so there is nothing to fall back to: without a microphone there is no call.
  try { await openMic(); } catch { return problem(NO_MIC); }
  mic.waitMs = Number(setup.wait_after_speech_ms) || 450;
  if (!interruptible()) note("interruptions are off: listening once the assistant has finished");
  el("talk-hint").textContent = interruptible() ? "Just talk. Interrupt whenever you like."
                                                : "Just talk. Wait for it to finish before you answer.";

  el("start-card").hidden = true;
  el("call-grid").hidden = false;
  clear(el("transcript"));
  drawEvents();
  el("ending").hidden = true;
  el("controls").hidden = false;

  const name = el("customer").value.trim();
  const head = await run((signal) => api.startCall(name ? { name } : {}, speakOutLoud, hooks(), signal));
  if (!head) { el("start-card").hidden = false; el("call-grid").hidden = true; return; }
  callId = head.state.id;
  clock.start();
}

// ── during a call ──────────────────────────────────────────────────────────
function hooks() {
  let began = performance.now();
  return {
    onReply: (head) => {
      // Take the call's id the moment it arrives. It used to be assigned only after the whole request
      // finished, which was after `listenAgain` had already run and found no call — so the microphone was
      // never armed after the greeting and the call could never go anywhere.
      if (head.state?.id) callId = head.state.id;
      if (head.ignored) {
        // Only noise: nothing was said and nothing changed, so whatever the assistant is saying goes on.
        note("only noise heard: ignored");
        drawAnswers(head.state);
        if (player?.playing) status("speaking", "Speaking");
        return;
      }
      if (head.say && player?.playing) {
        // The call has moved on, so the last reply is out of date. Left playing, it was heard in full with
        // the new one queued behind it, and the chat showed the next question while the voice was still
        // asking the one before.
        player.stop();
        note("stopped the last reply: they had already answered");
      }
      if (head.heard) line("customer", head.heard);
      if (head.say) line("assistant", head.say);
      el("t-heard").textContent = head.heard_ms ? `${head.heard_ms} ms` : "–";
      el("t-think").textContent = head.think_ms ? `${head.think_ms} ms` : "–";
      if (head.speech_model) el("services").textContent = `${head.listen_model} · ${head.speech_model}`;
      drawAnswers(head.state);
      watchTheClock(head.state);
      (head.notices || []).forEach((notice) => { note(notice); toast(notice); });
      if (mic) mic.quickPause = head.state.step === "confirm";

      // Arm the microphone the moment the reply text lands, rather than when the last byte of speech
      // has finished downloading. The request stays open for as long as the speech takes to make, and
      // the caller was shut out for all of it: unable to interrupt, and unheard for the opening of
      // their own turn. `listenAgain` still runs at the end of the request and is a no-op by then.
      // When the business has turned interruptions off, the microphone waits for the speech to finish
      // instead, and `listenAgain` arms it then.
      if (!head.ended && callId && mic && interruptible()) mic.enabled = true;
      began = performance.now();
    },
    onAudio: (bytes, first) => {
      if (first) {
        el("t-speak").textContent = `${Math.round(performance.now() - began)} ms`;
        status("speaking", "Speaking");
      }
      player.push(bytes);
    },
  };
}

async function run(request, { afterReply = false } = {}) {
  const turn = ++turns;

  // Off only while we think: `onReply` arms it again the moment the reply text arrives, so the speech
  // that follows can be talked over.
  if (mic) mic.enabled = false;
  status("thinking", "Thinking");

  // Whatever was still streaming belongs to a turn that has been overtaken. Two turns at once used to
  // reach the server together, where they ran on the same call side by side. Either call it off, or wait
  // for it to finish arriving.
  if (afterReply) await replying;
  else inFlight?.abort();
  if (turn !== turns) return null;              // overtaken while waiting: the newer turn is in charge

  const mine = new AbortController();
  inFlight = mine;
  let arrived;
  replying = new Promise((resolve) => (arrived = resolve));
  let head = null;
  try {
    head = await request(mine.signal);
  } catch (failure) {
    // We stopped it ourselves — talked over, or replaced by a newer turn. Whoever did that is in charge
    // of what happens next, so this one leaves the microphone and the status exactly as it found them.
    if (failure.name === "AbortError") return null;
    toast(failure.message, "bad");
    status("idle", "Stopped");
    // A failed request must not leave the microphone disarmed. Nothing else re-arms it, so the call would
    // sit there with the customer talking into a mic that is switched off.
    if (callId && turn === turns) listenAgain();
    return null;
  } finally {
    if (inFlight === mine) inFlight = null;
    arrived();
  }

  if (head && speakOutLoud && head.say && !head.audioBytes) {
    toast("No audio came back — the speech service may be out of credit or quota.", "bad");
    note("no audio came back");
  }
  if (head?.ended) ended(head.state);
  else if (turn === turns) listenAgain();       // a newer turn is on its way: it arms the mic itself
  return head;
}

const TURN_EARLY = 0.12;              // hand over while the last breath is still trailing off

const interruptible = () => setup?.allow_interruptions !== false;

function listenAgain() {
  if (!callId) return;
  const turn = turns;
  if (mic && interruptible()) mic.enabled = true;  // armed at once, so you can talk over the reply

  const arrived = performance.now();
  const toPlay = player?.secondsLeft() ?? 0;
  if (toPlay > 0.05) note(`reply in hand · ${toPlay.toFixed(1)}s of speech still to play`);

  const check = () => {
    if (!callId || turn !== turns) return;       // a newer turn has taken over the microphone
    if ((player?.secondsLeft() ?? 0) > TURN_EARLY) return setTimeout(check, 25);
    if (mic) mic.enabled = true;
    note(`your turn · ${Math.round(performance.now() - arrived)} ms after the reply arrived`);
    status("listening", "Listening");
  };
  check();
}

/** The server only looks at the clock when a turn arrives, so a line that falls quiet past the time limit
 *  would stay open for ever. Once the time is up, a silent turn is sent and the server says goodbye. */
function watchTheClock(state) {
  clearTimeout(deadline);
  if (state.outcome) return;
  const left = (Number(setup.max_minutes) || 4) * 60 - state.seconds;
  deadline = setTimeout(timeUp, Math.max(0, left) * 1000 + 500);
}

function timeUp() {
  if (!callId) return;
  // Never over the top of either side: wait for the assistant to finish and the customer to stop talking.
  if (inFlight || player?.playing || el("orb").dataset.state === "hearing") {
    deadline = setTimeout(timeUp, 500);
    return;
  }
  note("time is up: ending the call");
  say("");
}

function say(message) {
  if (!callId) return;
  if (message) line("customer", message);
  run((signal) => api.sayText(callId, message, speakOutLoud, hooks(), signal));
}

function ended(state) {
  callId = null;
  inFlight = null;
  clearTimeout(deadline);
  // Release the microphone itself, not just the recording flag: the browser keeps the stream live
  // otherwise, so the level meter carries on moving and the tab shows as still listening.
  mic?.close();
  mic = null;
  micMeter(0, 0, "off");
  callMeter(0, 0, "off");
  el("check-mic").querySelector("span").textContent = "Check my microphone";
  el("mic-meter").hidden = true;
  clock.stop();
  status("idle", "Call ended");
  el("controls").hidden = true;
  el("ending").hidden = false;
  el("outcome").textContent = (state.outcome === "completed" ? "Completed" : "Incomplete")
                            + (state.end_reason ? ` · ${state.end_reason}` : "");
  el("outcome").className = `outcome ${state.outcome}`;
  el("summary").textContent = "Writing a summary…";
  setTimeout(refreshSummary, 1200);
}

async function refreshSummary() {
  try {
    const response = await fetch("/api/calls");
    const { calls } = await response.json();
    const summary = calls?.[0]?.summary;
    el("summary").textContent = summary || "";
  } catch {
    el("summary").textContent = "";
  }
}

function reset() {
  el("start-card").hidden = false;
  el("call-grid").hidden = true;
  status("idle", "Ready");
}

// ── drawing ────────────────────────────────────────────────────────────────
function line(who, what) {
  const row = make("div", { class: `line ${who}` }, make("div", { class: "bubble", text: what }));
  el("transcript").appendChild(row);
  el("transcript").scrollTop = el("transcript").scrollHeight;
}

function note(text) {
  notes.push({ at: callBegan ? (performance.now() - callBegan) / 1000 : 0, text });
  drawEvents();
}

/** The server's decisions and the browser's own notes, in one list, oldest first.
 *
 *  `note` used to append straight to the pane, and `drawAnswers` emptied that pane and redrew it from
 *  the server's events on every turn — so everything the browser had noticed was wiped a moment after
 *  it appeared, the microphone timings included. Both halves are kept here now, and the pane is built
 *  from the two of them. The clocks differ by however long the greeting took, since the server counts
 *  from when the call object was made; close enough to read a call by.
 */
function drawEvents() {
  const holder = clear(el("events"));
  [...serverEvents.map((event) => ({ ...event, ours: false })),
   ...notes.map((event) => ({ ...event, ours: true }))]
    .sort((a, b) => a.at - b.at)
    .forEach((event) => holder.appendChild(make("div", { class: `event${event.ours ? " quiet" : ""}` }, [
      make("span", { class: "at", text: `${event.at.toFixed(1)}s` }), ` ${event.text}`,
    ])));
  holder.scrollTop = holder.scrollHeight;
}

function drawAnswers(state) {
  const holder = clear(el("answers"));
  (setup.questions || []).forEach((question) => {
    const answered = question.save_as in state.answers;
    const skipped = state.skipped.includes(question.save_as);
    const unneeded = (state.not_needed || []).includes(question.save_as);
    const tries = state.failed[question.save_as];
    const value = answered ? state.answers[question.save_as]
      : unneeded ? "not needed" : skipped ? "given up on" : tries ? `asking again (${tries})` : "waiting";

    const card = make("div", {
      class: `answer${answered ? " done" : skipped || unneeded ? " skipped" : tries ? " retry" : ""}`,
    }, [
      make("div", { class: "a-name", text: question.save_as.replace(/_/g, " ") }),
      make("div", { class: "a-value", text: value }),
    ]);
    if (answered && state.said[question.save_as]) {
      card.appendChild(make("div", { class: "a-said", text: `“${state.said[question.save_as]}”` }));
    }
    holder.appendChild(card);
  });
  el("progress").textContent = `${Object.keys(state.answers).length} of ${(setup.questions || []).length}`;

  serverEvents = state.events || [];
  drawEvents();
}

function status(kind, text) {
  el("orb").dataset.state = kind;
  if (kind !== "listening" && kind !== "hearing") el("orb").style.setProperty("--level", "0");
  el("status").textContent = text;
}

function problem(message) {
  el("call-problems").textContent = message;
  if (message) toast(message, "bad");
}

