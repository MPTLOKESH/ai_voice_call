/* Hearing and speaking, in the browser.
 *
 * Player: plays the raw audio the server streams, and can be stopped mid-sentence.
 * Mic:    listens continuously, works out when someone has finished, and notices being talked over.
 *
 * The room is measured between turns, as two percentiles of the last few seconds. The low one guards
 * starting a turn, so a background never triggers one. The high one decides what counts as a pause, so a
 * background that comes and goes — voices, a television, traffic — still falls below it and the turn can
 * end. Underneath both sits a backstop measured against the speaker's own voice, for rooms too loud for
 * any threshold to separate.
 */

export const SPEAKER_RATE = 24000;
export const MIC_RATE = 16000;

const FRAME = 1024;                 // about 21 ms at 48 kHz
const START_OVER_ROOM = 2.2;        // over the loud end of the room, to start a turn
const STOP_OVER_ROOM = 1.25;        // over the loud end of the room, to end one
const VOICE_OF_PEAK = 0.35;         // anything above this share of your own peak is you, still talking
const VOICE_GAP = 2.0;              // a last resort only: people pause a second mid-sentence and mean to go on
const START_FLOOR = 0.008;
const STOP_FLOOR = 0.005;
const QUIET_OF_PEAK = 0.18;         // speech towers over a pause: a fifth of this turn's peak is silence
const PEAK_DECAY = 0.995;           // the peak follows recent speech rather than one early shout
const NOISE_FRAMES = 280;           // ~6 s of levels behind the room estimate
const NOISE_EVERY = 5;              // frames between estimates: sorting on every frame is wasted work
const WARM_UP_FRAMES = 40;          // ~0.85 s of room before any turn may start
const QUIET_SHARE = 0.85;           // how much of the last pause must be quiet to call the turn over
const FRAMES_TO_START = 3;          // ~60 ms, so a keystroke is not speech
const FRAMES_TO_INTERRUPT = 5;
const PAUSE_ENDS_TURN = 0.5;
const PAUSE_WHEN_CONFIRMING = 0.32;
const LONGEST_TURN = 10;
const SHORTEST_TURN = 0.3;

let context = null;
export async function audioContext() {
  context ??= new (window.AudioContext || window.webkitAudioContext)();
  if (context.state === "suspended") await context.resume();
  return context;
}

export class Player {
  constructor(context) {
    this.context = context;
    this.nextAt = 0;
    this.sources = [];
    this.spare = -1;                  // a byte that arrived without the other half of its sample
  }

  /** One piece of the stream, exactly as it came off the wire: any length, at any offset. */
  push(bytes) {
    // Nothing about a network read is aligned to a 16-bit sample, and the old
    // `new Int16Array(bytes.buffer, bytes.byteOffset, …)` needed both ends of it to be.
    //   · an odd byteOffset — which the first piece after the reply text always has when the head is an
    //     even number of bytes, and the two arrive in one read — throws RangeError outright, and the
    //     whole turn failed with "start offset of Int16Array should be a multiple of 2";
    //   · an odd byteLength lost its last byte to the Math.floor, and every sample after that point was
    //     read one byte out, so the rest of the reply played as noise.
    // Copy into a buffer of our own, and keep the odd byte back for the piece that completes it.
    let joined = bytes;
    if (this.spare >= 0) {
      joined = new Uint8Array(bytes.length + 1);
      joined[0] = this.spare;
      joined.set(bytes, 1);
      this.spare = -1;
    }
    const whole = joined.length - (joined.length % 2);
    if (whole < joined.length) this.spare = joined[joined.length - 1];
    if (!whole) return;

    const samples = new Int16Array(whole / 2);
    new Uint8Array(samples.buffer).set(joined.subarray(0, whole));
    const buffer = this.context.createBuffer(1, samples.length, SPEAKER_RATE);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < samples.length; i++) channel[i] = samples[i] / 32768;

    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.context.destination);
    const at = Math.max(this.context.currentTime + 0.03, this.nextAt);
    source.start(at);
    this.nextAt = at + buffer.duration;
    this.sources.push(source);
    source.onended = () => { this.sources = this.sources.filter((s) => s !== source); };
  }

  get playing() { return this.nextAt > this.context.currentTime + 0.02; }

  /** How much sound is still scheduled. A boolean can't say whether a wait is real audio or a stuck flag. */
  secondsLeft() { return Math.max(0, this.nextAt - this.context.currentTime); }

  stop() {
    this.sources.forEach((source) => { try { source.stop(); } catch {} });
    this.sources = [];
    this.nextAt = this.context.currentTime;
    this.spare = -1;                  // half a sample of an abandoned reply must not shift the next one
  }
}

export class Mic {
  /** `isSpeaking()` tells the mic when the assistant is talking, so it neither learns from it nor records it. */
  constructor(context, stream, isSpeaking = () => false) {
    this.context = context;
    this.stream = stream;
    this.isSpeaking = isSpeaking;

    this.levels = [];
    this.pieces = [];
    this.runUp = [];
    this.loudRun = 0;
    this.quietRun = [];             // was each of the last few frames quiet? the end-of-turn window
    this.spokeFor = 0;
    this.peak = 0;                  // the loudest this turn has been, so a pause can be judged against it
    this.sinceVoice = 0;            // seconds since anything clearly *you* arrived
    this.room = { low: 0.002, high: 0.004 };   // re-estimated every few frames, between turns
    this.sinceNoise = 0;
    this.recording = false;
    this.enabled = false;
    this.quickPause = false;
    this.waitMs = PAUSE_ENDS_TURN * 1000;   // how long a pause ends a turn, as the business set it

    this.onSpeech = () => {};
    this.onTurn = () => {};
    this.onInterrupt = () => {};
    this.onLevel = () => {};

    this.source = context.createMediaStreamSource(stream);
    this.node = context.createScriptProcessor(FRAME, 1, 1);
    this.node.onaudioprocess = (event) => this.hear(event.inputBuffer.getChannelData(0));
    this.source.connect(this.node);
    const mute = context.createGain();      // the processor needs an output, but not to the speakers
    mute.gain.value = 0;
    this.node.connect(mute);
    mute.connect(context.destination);
  }

  static async open(isSpeaking) {
    const context = await audioContext();
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: false },
    });
    return new Mic(context, stream, isSpeaking);
  }

  /** Both ends of the room: the quiet slices it falls to, and the level it spends most of its time under. */
  estimateRoom() {
    if (this.levels.length < 20) return { low: 0.002, high: 0.004 };
    const sorted = [...this.levels].sort((a, b) => a - b);
    const at = (share) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * share))];
    return { low: Math.max(at(0.1), 0.0005), high: Math.max(at(0.8), 0.001) };
  }

  /** Starting a turn is judged against the loud end too. Against the quiet end alone, a steady hum — where
   *  both ends are the same level — puts the bar at four times the background, above a normal voice, and
   *  no turn can ever start. */
  get startsAt() { return Math.max(this.room.high * START_OVER_ROOM, START_FLOOR); }

  /** A pause is judged against the loud end. Against the quiet end, a background that comes and goes sits
   *  above the threshold nearly all the time and the turn never ends — which is the bug you hit. */
  get stopsAt() {
    return Math.max(this.room.high * STOP_OVER_ROOM, this.peak * QUIET_OF_PEAK, STOP_FLOOR);
  }

  hear(frame) {
    let sum = 0;
    for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
    const level = Math.sqrt(sum / frame.length);
    const seconds = frame.length / this.context.sampleRate;
    const speaking = this.isSpeaking();

    // Learn the room between turns only, and never from the assistant's own voice. Learning during a turn
    // fills this buffer with the customer's speech, the estimate climbs to meet it, and a long answer gets
    // cut off mid-sentence.
    if (!this.recording && !speaking) {
      this.levels.push(level);
      if (this.levels.length > NOISE_FRAMES) this.levels.shift();
      if (++this.sinceNoise >= NOISE_EVERY) {
        this.room = this.estimateRoom();
        this.sinceNoise = 0;
      }
    }

    this.onLevel(level, this.startsAt, this.recording
      ? `recording ${this.spokeFor.toFixed(1)}s · needs under ${this.stopsAt.toFixed(4)} for `
        + `${this.pause}s · quiet `
        + `${Math.round(this.quietRun.filter(Boolean).length / (this.quietRun.length || 1) * 100)}%`
        + ` · no voice for ${this.sinceVoice.toFixed(1)}s of ${VOICE_GAP}s`
      : this.enabled ? (speaking ? "assistant speaking" : "listening") : "off");

    if (!this.enabled) return;

    if (!this.recording) {
      this.runUp.push(new Float32Array(frame));
      if (this.runUp.length > 8) this.runUp.shift();        // ~170 ms, so no clipped first word

      // Until the room has been listened to for a moment the estimate is only a guess, and in any room
      // above the bare floor a turn would start instantly and send the room itself off to be transcribed.
      if (this.levels.length < WARM_UP_FRAMES) return;

      this.loudRun = level > this.startsAt * (speaking ? 1.4 : 1) ? this.loudRun + 1 : 0;
      if (this.loudRun >= (speaking ? FRAMES_TO_INTERRUPT : FRAMES_TO_START)) {
        if (speaking) this.onInterrupt();
        this.recording = true;
        this.loudRun = 0;
        this.quietRun = [];
        this.spokeFor = 0;
        this.peak = level;
        this.sinceVoice = 0;
        this.pieces = this.runUp.slice();
        this.onSpeech();
      }
      return;
    }

    this.pieces.push(new Float32Array(frame));
    this.spokeFor += seconds;
    this.peak = Math.max(this.peak * PEAK_DECAY, level);

    // Judge the whole of the last pause rather than counting an unbroken run. A gap between words fills
    // only a fraction of that window, so it can never end a turn early; a knock during a real silence is
    // one frame in twenty-four, so it can't hold the turn open either. Counting runs failed both ways.
    const window = Math.ceil(this.pause / seconds);
    const quiet = level < this.stopsAt;
    this.quietRun.push(quiet);
    if (this.quietRun.length > window) this.quietRun.shift();

    const quietShare = this.quietRun.filter(Boolean).length / this.quietRun.length;
    const settled = this.quietRun.length >= window && quietShare >= QUIET_SHARE && quiet;

    // A last resort, for a room too loud for any threshold to work in: your voice is close to the
    // microphone and the background is not, so a long stretch with nothing above a third of your own peak
    // means you have stopped, however loud the room still is. Deliberately slow — people pause for a
    // second mid-sentence and mean to carry on, so this must never be what normally ends a turn.
    this.sinceVoice = level > this.peak * VOICE_OF_PEAK ? 0 : this.sinceVoice + seconds;
    const youStopped = this.sinceVoice >= (this.quickPause ? VOICE_GAP * 0.7 : VOICE_GAP);

    if (settled || youStopped || this.spokeFor > LONGEST_TURN) this.finish();
  }

  /** Seconds of quiet that end a turn: shorter during the read-back, never longer than the business asked. */
  get pause() {
    const wait = this.waitMs / 1000;
    return this.quickPause ? Math.min(PAUSE_WHEN_CONFIRMING, wait) : wait;
  }

  finish() {
    const spoken = this.spokeFor;
    const pieces = this.pieces;
    this.recording = false;
    this.pieces = [];
    this.runUp = [];
    this.quietRun = [];
    this.spokeFor = 0;
    this.peak = 0;
    this.sinceVoice = 0;
    if (spoken < SHORTEST_TURN) return;                     // a cough, a door, a keystroke
    const wav = toWav(pieces, this.context.sampleRate);
    if (wav) this.onTurn(wav, spoken);
  }

  close() {
    this.enabled = false;
    try { this.node.disconnect(); this.source.disconnect(); } catch {}
    this.stream.getTracks().forEach((track) => track.stop());
  }
}

/** Float32 at the browser's rate → 16-bit WAV at 16 kHz. */
export function toWav(pieces, sampleRate) {
  const total = pieces.reduce((sum, piece) => sum + piece.length, 0);
  if (total < sampleRate * 0.2) return null;
  const joined = new Float32Array(total);
  let at = 0;
  pieces.forEach((piece) => { joined.set(piece, at); at += piece.length; });

  const ratio = sampleRate / MIC_RATE;
  const count = Math.floor(joined.length / ratio);
  const samples = new Int16Array(count);
  for (let i = 0; i < count; i++) {
    samples[i] = Math.max(-1, Math.min(1, joined[Math.floor(i * ratio)])) * 32767;
  }

  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const write = (offset, text) => [...text].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  write(0, "RIFF"); view.setUint32(4, 36 + samples.length * 2, true);
  write(8, "WAVEfmt "); view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, MIC_RATE, true); view.setUint32(28, MIC_RATE * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  write(36, "data"); view.setUint32(40, samples.length * 2, true);
  new Int16Array(buffer, 44).set(samples);
  return buffer;
}
