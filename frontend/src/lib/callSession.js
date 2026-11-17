/* One test call: holding the conversation, and keeping the state the call page draws.
 *
 * The timing here is delicate — when the microphone is armed, which reply is stale, what an interruption
 * cancels — so it lives in a plain class rather than in React effects. React reads `state` through
 * `subscribe`/`getSnapshot` and never reaches in. Microphone levels arrive dozens of times a second, so
 * they go to `onLevel` listeners that draw directly, rather than through state.
 *
 * The session outlives the call page: leaving the page mid-call doesn't end the call.
 */

import * as api from "./api.js";
import { Mic, Player, audioContext } from "./audio.js";
import { VoiceMic } from "./vad.js";

const NO_MIC = "The microphone is blocked. Click the lock icon beside the address, allow the microphone, then try again.";
const TURN_EARLY = 0.12;              // hand over while the last breath is still trailing off

const INITIAL = {
  phase: "ready",                     // ready → live → ended
  status: { kind: "idle", text: "Ready" },
  transcript: [],                     // { who, text, cut }
  call: null,                         // the server's view of the call: answers, step, events…
  notes: [],                          // what the browser saw, drawn alongside the server's events
  timings: { heard: null, think: null, speak: null, total: 0 },
  services: "",
  outcome: null,                      // { outcome, end_reason }
  summary: "",
  micOpen: false,
  problem: "",
  interruptible: true,
};

export class CallSession {
  constructor() {
    this.state = INITIAL;
    this.listeners = new Set();
    this.levelListeners = new Set();
    this.toast = () => {};

    this.setup = null;
    this.flowId = "";                 // the flow being tested, so the saved call says which one it was
    this.callId = null;
    this.lastCallId = null;           // the call that has just ended, so its summary can still be looked up
    this.speakOutLoud = true;
    this.player = null;
    this.mic = null;
    this.inFlight = null;             // the turn being streamed, so it can be called off
    this.replying = Promise.resolve(); // settles once that turn's reply has fully arrived
    this.turns = 0;                   // counts turns, so one that has been overtaken knows to step aside
    this.callBegan = 0;               // when this call started, so a note can be placed against the clock
    this.deadline = null;             // ends a call that goes quiet past its time limit
    this.talkedOver = false;          // the next turn interrupted the assistant, and the server must know
    this.clock = null;

    // Closing the tab mid-call: tell the server, or the call is never saved. sendBeacon outlives the page.
    if (typeof window !== "undefined") {
      window.addEventListener("pagehide", () => {
        if (!this.callId) return;
        try { navigator.sendBeacon("/api/call/end", new Blob([JSON.stringify({ call: this.callId })], { type: "application/json" })); } catch {}
      });
    }
  }

  // ── for React ────────────────────────────────────────────────────────────
  subscribe = (listener) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = () => this.state;

  onLevel(listener) {
    this.levelListeners.add(listener);
    return () => this.levelListeners.delete(listener);
  }

  set(patch) {
    this.state = { ...this.state, ...(typeof patch === "function" ? patch(this.state) : patch) };
    this.listeners.forEach((listener) => listener());
  }

  setSetup(setup, flowId = "") {
    this.setup = setup;
    this.flowId = flowId;
  }

  interruptible() {
    return this.setup?.allow_interruptions !== false;
  }

  // ── before a call ────────────────────────────────────────────────────────
  async checkMic() {
    try {
      await this.openMic();
      this.set({ micOpen: true });
    } catch {
      this.problem(NO_MIC);
    }
  }

  async openMic() {
    if (this.mic) return this.mic;
    const context = await audioContext();
    this.player ??= new Player(context);

    // Silero decides what is a voice. If it can't be loaded, the old loudness test still works — badly in
    // a noisy room, but better than leaving the caller with no microphone at all.
    let mic;
    try {
      mic = await VoiceMic.open(() => this.player.playing);
      mic.onNote = (text) => this.note(text);      // every step of a turn, so nothing fails invisibly
      this.note("listening with Silero voice detection");
    } catch (problem) {
      this.toast(`Voice detection unavailable (${problem.message}); falling back to loudness.`, "bad");
      mic = await Mic.open(() => this.player.playing);
    }
    mic.onLevel = (level, startsAt, doing) => {
      this.levelListeners.forEach((listener) => listener(level, startsAt, doing));
    };
    mic.onSpeech = () => this.status("hearing", "Hearing you");
    mic.onInterrupt = () => {
      // Stopping the player only clears what is already scheduled. The request is still open and its
      // audio kept arriving, so the rest was scheduled a moment later and the assistant carried on
      // mid-sentence. Call the turn off as well, and the server stops making speech nobody will hear.
      this.inFlight?.abort();
      this.player.stop();
      // Stopping the voice is only half of it: the server still believes the whole reply was heard and
      // would carry straight on to the next question. The turn this speech becomes says otherwise.
      this.talkedOver = true;
      this.set((state) => {
        const transcript = [...state.transcript];
        for (let at = transcript.length - 1; at >= 0; at--) {
          if (transcript[at].who === "assistant") { transcript[at] = { ...transcript[at], cut: true }; break; }
        }
        return { transcript };
      });
      this.note("you talked over the assistant");
      if (this.callId) this.status("listening", "Listening");
    };
    mic.onTurn = (wav, spoken) => {
      if (!this.callId) return;        // the call is over: whatever was said is not ours to send
      this.note(`recorded ${spoken.toFixed(1)}s`);
      const interrupted = this.talkedOver;
      this.talkedOver = false;
      // Not talking over the assistant (that is `onInterrupt`, which has already called the reply off),
      // so this may well be the room rather than the customer. Let the reply still arriving finish rather
      // than cut it off: if this turn was only noise, the customer should still hear the whole question.
      this.run((signal) => api.sendAudio(this.callId, wav, this.speakOutLoud, interrupted, this.hooks(), signal),
               { afterReply: true });
    };
    this.mic = mic;
    return mic;
  }

  /** `customer`: a contact ({id, name, phone}), or just a name typed in. */
  async begin({ customer = "", speak = true } = {}) {
    this.problem("");
    this.speakOutLoud = speak;
    this.callBegan = performance.now();   // before the microphone opens, so its notes are on the clock too
    this.talkedOver = false;
    this.set({ notes: [], call: null });

    const context = await audioContext();
    this.player ??= new Player(context);

    // A call is spoken, so there is nothing to fall back to: without a microphone there is no call.
    try { await this.openMic(); } catch { return this.problem(NO_MIC); }
    this.mic.waitMs = Number(this.setup?.wait_after_speech_ms) || 450;
    if (!this.interruptible()) this.note("interruptions are off: listening once the assistant has finished");

    this.set({
      phase: "live", transcript: [], outcome: null, summary: "", interruptible: this.interruptible(),
      timings: { heard: null, think: null, speak: null, total: 0 },
    });

    const known = typeof customer === "object" && customer ? customer : { name: String(customer || "").trim() };
    const who = Object.fromEntries(Object.entries(known).filter(([, value]) => value));
    const head = await this.run((signal) =>
      api.startCall(this.setup, who, this.speakOutLoud, this.hooks(), signal, this.flowId));
    if (!head) { this.set({ phase: "ready" }); return; }
    this.callId = head.state.id;
    this.startClock();
  }

  // ── during a call ────────────────────────────────────────────────────────
  hooks() {
    let began = performance.now();
    return {
      onReply: (head) => {
        // Take the call's id the moment it arrives, so the microphone can be armed after the greeting.
        if (head.state?.id) this.callId = head.state.id;
        if (head.ignored) {
          // Only noise: nothing was said and nothing changed, so whatever the assistant is saying goes on.
          this.note("only noise heard: ignored");
          this.set({ call: head.state });
          if (this.player?.playing) this.status("speaking", "Speaking");
          return;
        }
        if (head.say && this.player?.playing) {
          // The call has moved on, so the last reply is out of date. Left playing, it would be heard in
          // full with the new one queued behind it.
          this.player.stop();
          this.note("stopped the last reply: they had already answered");
        }
        this.set((state) => ({
          transcript: [
            ...state.transcript,
            ...(head.heard ? [{ who: "customer", text: head.heard }] : []),
            ...(head.say ? [{ who: "assistant", text: head.say }] : []),
          ],
          timings: { ...state.timings, heard: head.heard_ms || null, think: head.think_ms || null },
          services: head.speech_model ? `${head.listen_model} · ${head.speech_model}` : state.services,
          call: head.state,
        }));
        this.watchTheClock(head.state);
        (head.notices || []).forEach((notice) => { this.note(notice); this.toast(notice); });
        if (this.mic) this.mic.quickPause = head.state.step === "confirm";

        // Arm the microphone the moment the reply text lands, rather than when the last byte of speech has
        // downloaded, so the caller can talk over it. With interruptions off, `listenAgain` arms it once
        // the speech has finished instead.
        if (!head.ended && this.callId && this.mic && this.interruptible()) this.mic.enabled = true;
        began = performance.now();
      },
      onAudio: (bytes, first) => {
        if (first) {
          const speak = Math.round(performance.now() - began);
          this.set((state) => ({ timings: { ...state.timings, speak } }));
          this.status("speaking", "Speaking");
        }
        this.player.push(bytes);
      },
    };
  }

  async run(request, { afterReply = false } = {}) {
    const turn = ++this.turns;

    // Off only while we think: `onReply` arms it again the moment the reply text arrives.
    if (this.mic) this.mic.enabled = false;
    this.status("thinking", "Thinking");

    // Whatever was still streaming belongs to a turn that has been overtaken: either call it off, or wait
    // for it to finish arriving, so two turns never reach the server together.
    if (afterReply) await this.replying;
    else this.inFlight?.abort();
    if (turn !== this.turns) return null;      // overtaken while waiting: the newer turn is in charge

    const mine = new AbortController();
    this.inFlight = mine;
    let arrived;
    this.replying = new Promise((resolve) => (arrived = resolve));
    let head = null;
    try {
      head = await request(mine.signal);
    } catch (failure) {
      // We stopped it ourselves — talked over, or replaced by a newer turn. Whoever did that is in charge
      // of what happens next.
      if (failure.name === "AbortError") return null;
      this.toast(failure.message, "bad");
      this.status("idle", "Stopped");
      // A failed request must not leave the microphone disarmed: nothing else would re-arm it.
      if (this.callId && turn === this.turns) this.listenAgain();
      return null;
    } finally {
      if (this.inFlight === mine) this.inFlight = null;
      arrived();
    }

    if (head && this.speakOutLoud && head.say && !head.audioBytes) {
      this.toast("No audio came back. The speech service may be out of credit or quota.", "bad");
      this.note("no audio came back");
    }
    if (head?.ended) this.ended(head.state);
    else if (turn === this.turns) this.listenAgain();   // a newer turn is on its way: it arms the mic itself
    return head;
  }

  listenAgain() {
    if (!this.callId) return;
    const turn = this.turns;
    if (this.mic && this.interruptible()) this.mic.enabled = true;  // armed at once, to talk over the reply

    const arrived = performance.now();
    const toPlay = this.player?.secondsLeft() ?? 0;
    if (toPlay > 0.05) this.note(`reply in hand · ${toPlay.toFixed(1)}s of speech still to play`);

    const check = () => {
      if (!this.callId || turn !== this.turns) return;   // a newer turn has taken over the microphone
      if ((this.player?.secondsLeft() ?? 0) > TURN_EARLY) return setTimeout(check, 25);
      if (this.mic) this.mic.enabled = true;
      this.note(`your turn · ${Math.round(performance.now() - arrived)} ms after the reply arrived`);
      this.status("listening", "Listening");
    };
    check();
  }

  /** The server only looks at the clock when a turn arrives, so a line that falls quiet past the time
   *  limit would stay open for ever. Once the time is up, a silent turn is sent and it says goodbye. */
  watchTheClock(state) {
    clearTimeout(this.deadline);
    if (state.outcome) return;
    const left = (Number(this.setup?.max_minutes) || 4) * 60 - state.seconds;
    this.deadline = setTimeout(() => this.timeUp(), Math.max(0, left) * 1000 + 500);
  }

  timeUp() {
    if (!this.callId) return;
    // Never over the top of either side: wait for the assistant to finish and the customer to stop talking.
    if (this.inFlight || this.player?.playing || this.state.status.kind === "hearing") {
      this.deadline = setTimeout(() => this.timeUp(), 500);
      return;
    }
    this.note("time is up: ending the call");
    this.say("");
  }

  /** Stands in for the customer: `hangUp` is them ending the call, `sayNothing` a turn where nobody spoke. */
  hangUp() { this.say("I need to go, sorry."); }

  sayNothing() { this.say(""); }

  say(message) {
    if (!this.callId) return;
    if (message) this.set((state) => ({ transcript: [...state.transcript, { who: "customer", text: message }] }));
    this.run((signal) => api.sayText(this.callId, message, this.speakOutLoud, this.hooks(), signal));
  }

  ended(state) {
    try { localStorage.setItem("voice-call-tested", "1"); } catch { /* optional */ }
    this.lastCallId = this.callId;
    this.callId = null;
    this.inFlight = null;
    clearTimeout(this.deadline);
    // Release the microphone itself, not just the recording flag, or the tab keeps showing as listening.
    this.mic?.close();
    this.mic = null;
    this.levelListeners.forEach((listener) => listener(0, 0, "off"));
    this.stopClock();
    this.status("idle", "Call ended");
    this.set({
      phase: "ended", micOpen: false, call: state,
      outcome: { outcome: state.outcome, end_reason: state.end_reason }, summary: "Writing a summary…",
    });
    this.refreshSummary(this.lastCallId);
  }

  /** The summary is written by the AI after the call is saved, which takes a few seconds: look a few times. */
  async refreshSummary(id, tries = 10) {
    for (let attempt = 0; attempt < tries; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, attempt === 0 ? 1200 : 1500));
      if (this.callId || this.lastCallId !== id) return;           // a new call began: this one is no longer on screen
      try {
        // This call's own entry: with other calls finishing too, the newest one need not be it.
        const { calls } = await api.recentCalls({ limit: 10 });
        const mine = calls.find((one) => one.call === id);
        if (mine?.summary) return this.set({ summary: mine.summary });
      } catch { /* try again */ }
    }
    if (this.lastCallId === id) this.set({ summary: "" });
  }

  reset() {
    this.set({ phase: "ready", transcript: [], call: null, notes: [], outcome: null, summary: "" });
    this.status("idle", "Ready");
  }

  // ── small parts ──────────────────────────────────────────────────────────
  startClock() {
    this.stopClock();
    const began = performance.now();
    this.clock = setInterval(() => {
      const total = (performance.now() - began) / 1000;
      this.set((state) => ({ timings: { ...state.timings, total } }));
    }, 100);
  }

  stopClock() {
    if (this.clock) clearInterval(this.clock);
    this.clock = null;
  }

  note(text) {
    const at = this.callBegan ? (performance.now() - this.callBegan) / 1000 : 0;
    this.set((state) => ({ notes: [...state.notes, { at, text }] }));
  }

  status(kind, text) {
    this.set({ status: { kind, text } });
  }

  problem(message) {
    this.set({ problem: message });
    if (message) this.toast(message, "bad");
  }
}
