/* Deciding when someone is speaking, with Silero VAD.
 *
 * A small neural network judges each frame and returns the chance that it contains a human voice. That is a
 * different question from "is this loud", which is what a level meter answers and why a fan, a television or
 * traffic used to hold a turn open forever: all of them are loud, none of them is a voice.
 *
 * The model and the runtime are served from /static/vendor/, so starting a call needs nothing from the
 * internet.
 *
 * Every step reports itself through `onNote`, and nothing is swallowed: if a turn is not sent, the call log
 * says which step dropped it and why.
 */

import { toWav } from "./audio.js";

const VENDOR = "/static/vendor/";
export const MIC_RATE = 16000;            // what the model works at, and what we send to the server

const TUNING = {
  model: "v5",
  positiveSpeechThreshold: 0.35,          // chance of voice at which a turn starts
  negativeSpeechThreshold: 0.25,          // and below which it is no longer speech
  // Silence after speech before the turn is finished. Every millisecond of it is dead air the caller
  // sits through after they have stopped talking, so it is the cheapest quarter-second on the whole
  // turn to get back. Below about 350 the detector starts handing over during the pause people leave
  // mid-sentence, and the assistant talks over the end of their own answer.
  redemptionMs: 450,
  preSpeechPadMs: 500,                    // kept from before the trigger, so no clipped first word
  minSpeechMs: 250,                       // shorter than this was a cough or a door
};

// The read-back wants a "yes", not an answer, so it need not wait as long for a pause as a spoken
// answer must. Applied per turn through `quickPause` below.
const CONFIRM_REDEMPTION_MS = 300;

// Talking over the assistant has to be a voice held for a moment. A loud room crosses the start threshold
// now and then, and each time it used to cut the assistant off mid-question. A burst that never gets this
// far is still sent as a turn when it ends; if it was only noise the server ignores it, and the assistant
// carries on as though nothing happened.
const INTERRUPT_AFTER = 0.4;              // seconds of voice
const INTERRUPT_CHANCE = 0.6;             // the average chance of voice across them

// Silero has no longest-turn of its own: if it never calls the speech finished, nothing is ever sent. This
// is the backstop the loudness detector had, and it is what stops a call listening forever.
const LONGEST_TURN = 10;                  // seconds

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const tag = document.createElement("script");
    tag.src = src;
    tag.onload = () => resolve();
    tag.onerror = () => reject(new Error(`could not load ${src}`));
    document.head.appendChild(tag);
  });
}

let loaded = null;
function libraries() {
  loaded ??= (async () => {
    await loadScript(`${VENDOR}ort.wasm.min.js`);
    if (!window.ort) throw new Error("the speech runtime did not load");
    // One thread on purpose: the threaded build needs SharedArrayBuffer, which needs cross-origin
    // isolation headers this little server does not send. One frame takes well under a millisecond.
    window.ort.env.wasm.wasmPaths = VENDOR;
    window.ort.env.wasm.numThreads = 1;
    window.ort.env.logLevel = "error";

    await loadScript(`${VENDOR}bundle.min.js`);
    if (!window.vad?.MicVAD) throw new Error("the voice detector did not load");
  })().catch((problem) => { loaded = null; throw problem; });
  return loaded;
}

/** Same shape as `Mic` in audio.js, so the call view doesn't care which one it got. */
export class VoiceMic {
  constructor(isSpeaking) {
    this.stream = null;                   // filled in by getStream below, so we can stop it later
    this.isSpeaking = isSpeaking;
    this.engine = null;

    this.talking = false;
    this.frames = [];                     // this turn's audio, so a turn that never ends can still be sent
    this.talkingFor = 0;
    this.voiceSum = 0;                    // chance of voice summed over this turn's frames, and how many
    this.voiceFrames = 0;
    this.interrupted = false;             // this turn has already stopped the assistant
    this._enabled = false;
    this._work = null;                    // start and pause, run one after another rather than at once
    this._quickPause = false;             // see the accessor below
    this._waitMs = TUNING.redemptionMs;   // the business's choice: see `waitMs` below
    this.chance = 0;

    this.onSpeech = () => {};
    this.onTurn = () => {};
    this.onInterrupt = () => {};
    this.onLevel = () => {};
    this.onNote = () => {};               // what happened, for the call log
  }

  static async open(isSpeaking) {
    await libraries();
    const mic = new VoiceMic(isSpeaking);

    mic.engine = await window.vad.MicVAD.new({
      ...TUNING,
      baseAssetPath: VENDOR,
      onnxWASMBasePath: VENDOR,

      // This version opens the microphone itself and has no option to be handed one, so the constraints
      // are supplied here instead: echo cancellation so the assistant's own voice can't trigger a turn,
      // and a reference kept so the tracks can be stopped when the call ends.
      getStream: async () => {
        mic.stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: false,
          },
        });
        return mic.stream;
      },

      // The wrapper's own pauseStream stops the stream's tracks and its resumeStream calls getUserMedia
      // again. Only getStream was overridden, so both of those defaults were in force, and a pause/start
      // pair — which is every single turn — closed the microphone and opened a new one. A device open
      // costs hundreds of milliseconds, and nothing reaches the detector while it is happening: the
      // first words of every answer from the second turn onwards were dropped on the floor, and the
      // turn only really began once the caller repeated themselves. The fresh stream also came back
      // with the wrapper's constraints rather than the ones above, so automatic gain control — switched
      // off on purpose — came back on and stayed on for the rest of the call.
      //
      // Hold the one stream open instead. Pausing already disconnects the source node, which is all
      // that is needed to stop frames arriving, and leaving the device open keeps echo cancellation
      // converged, so talking over the assistant works from the first turn rather than the third.
      pauseStream: async () => {},
      resumeStream: async (stream) => stream,

      onFrameProcessed: (chances, frame) => mic.frame(chances, frame),
      onSpeechStart: () => mic.speechStarted(),
      onSpeechEnd: (audio) => mic.speechEnded(audio),
      onVADMisfire: () => mic.misfired(),
    });

    // MicVAD listens as soon as it is built, so `_enabled` began life disagreeing with the engine. The
    // first `enabled = false` of a call then matched the flag it was already set to and returned without
    // pausing anything, which is why the first turn behaved unlike every turn after it.
    mic._enabled = true;
    return mic;
  }

  /** Paused rather than stopped: the model keeps its place, and starting again is instant. */
  get enabled() { return this._enabled; }

  set enabled(on) {
    if (on === this._enabled) return;
    this._enabled = on;
    if (!on) {
      this.frames = [];
      this.talking = false;
      this.talkingFor = 0;
    }

    // start and pause are async, so a failure would surface only as an unhandled rejection — a mic that
    // quietly failed to pause would record the assistant's own reply and send it to be transcribed —
    // and two of them overlapping would leave the engine in whichever state finished last rather than
    // whichever was asked for last. One after another, in the order they were asked for.
    const began = performance.now();
    this._work = Promise.resolve(this._work)
      .then(() => (on ? this.engine?.start() : this.engine?.pause()))
      .then(() => {
        // Arming used to be fire-and-forget, so the call log could say "your turn" while the microphone
        // was still opening. Anything but instant is worth seeing.
        const took = Math.round(performance.now() - began);
        if (on && took > 40) this.onNote(`microphone took ${took} ms to arm`);
      })
      .catch((problem) => this.onNote(`microphone would not ${on ? "start" : "pause"}: ${problem.message}`));
  }

  /** How long a silence must last before the turn is sent. Shorter during the read-back. */
  get quickPause() { return this._quickPause; }

  set quickPause(on) {
    on = !!on;
    if (on === this._quickPause) return;
    this._quickPause = on;
    this.applyWait();
  }

  /** How long a silence must last before a turn is sent, as the business set it for its callers. */
  get waitMs() { return this._waitMs; }

  set waitMs(ms) {
    if (!ms || ms === this._waitMs) return;
    this._waitMs = ms;
    this.applyWait();
  }

  applyWait() {
    // setOptions recomputes the frame counts from the milliseconds, so the wait really does change
    // mid-call. It used to be fixed when the engine was built and this flag did nothing at all.
    try {
      this.engine?.setOptions({
        redemptionMs: this._quickPause ? Math.min(CONFIRM_REDEMPTION_MS, this._waitMs) : this._waitMs,
      });
    } catch (problem) {
      this.onNote(`could not change the pause: ${problem.message}`);
    }
  }

  frame(chances, frame) {
    this.chance = chances?.isSpeech ?? 0;

    if (this.talking) {
      this.frames.push(new Float32Array(frame));
      this.talkingFor += frame.length / MIC_RATE;
      this.voiceSum += this.chance;
      this.voiceFrames += 1;
      // Checked on every frame rather than once at the start: the assistant may begin speaking after they
      // did, and that is talking over it just the same.
      if (!this.interrupted && this.isSpeaking() && this.talkingFor >= INTERRUPT_AFTER
          && this.voiceSum / this.voiceFrames >= INTERRUPT_CHANCE) {
        this.interrupted = true;
        this.onInterrupt();
      }
      if (this.talkingFor >= LONGEST_TURN) this.tooLong();
    }

    this.report(this.talking ? `hearing you ${this.talkingFor.toFixed(1)}s`
      : this._enabled ? (this.isSpeaking() ? "assistant speaking" : "listening") : "off");
  }

  report(doing) {
    const chance = Math.round(this.chance * 100);
    this.onLevel(this.chance, TUNING.positiveSpeechThreshold,
      `voice ${chance}% · starts at ${TUNING.positiveSpeechThreshold * 100}% · ${doing}`);
  }

  speechStarted() {
    this.talking = true;
    this.frames = [];
    this.talkingFor = 0;
    this.voiceSum = 0;
    this.voiceFrames = 0;
    this.interrupted = false;
    this.onNote("voice started");
    this.onSpeech();
  }

  speechEnded(audio) {
    const spoken = audio ? audio.length / MIC_RATE : 0;
    this.talking = false;
    this.frames = [];
    this.talkingFor = 0;

    if (!this._enabled) return this.onNote("voice ended while the mic was off: not sent");

    const wav = toWav([audio], MIC_RATE);
    if (!wav) return this.onNote(`voice ended after ${spoken.toFixed(1)}s but was too short to send`);
    this.onNote(`voice ended: sending ${spoken.toFixed(1)}s`);
    this.onTurn(wav, spoken);
  }

  misfired() {
    this.talking = false;
    this.frames = [];
    this.talkingFor = 0;
    this.onNote("too short to be speech");
  }

  /** Nothing may run forever. Send what we have and make the model begin a fresh segment. */
  tooLong() {
    const frames = this.frames;
    const spoken = this.talkingFor;
    this.talking = false;
    this.frames = [];
    this.talkingFor = 0;

    const wav = this._enabled ? toWav(frames, MIC_RATE) : null;
    this.onNote(`${spoken.toFixed(1)}s with no pause: sending it as it stands`);
    if (wav) this.onTurn(wav, spoken);

    // Restart so the next turn begins clean rather than continuing this one. Queued behind whatever
    // else is in flight, so it cannot cross with an arm or a pause from the call view.
    this._work = Promise.resolve(this._work)
      .then(() => this.engine?.pause())
      .then(() => (this._enabled ? this.engine?.start() : null))
      .catch((problem) => this.onNote(`could not restart listening: ${problem.message}`));
  }

  close() {
    this._enabled = false;
    // destroy pauses and releases the worklet itself, so it is the only call needed here.
    Promise.resolve(this.engine?.destroy()).catch(() => {});
    this.engine = null;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
  }
}
