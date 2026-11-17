import * as api from "./api.js";
import { Player, audioContext } from "./audio.js";

/**
 * Say one line in the voice as set up and resolve when it has been heard to the end. Aborting the signal
 * cuts it off. Resolves false when the server sent no audio, so a caller can say the voice is out of credit.
 */
export async function speakLine(setup, text, signal) {
  const player = new Player(await audioContext());
  try {
    const head = await api.turn({
      url: "/api/hear", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ setup, text }), signal,
      onAudio: (bytes) => player.push(bytes),
    });
    while (player.secondsLeft() > 0 && !signal?.aborted) await new Promise((resolve) => setTimeout(resolve, 100));
    return Boolean(head?.audioBytes);
  } finally {
    player.stop();
  }
}

/** What the greeting sounds like when tried before a call: the real one is written fresh on each call. */
export const sampleGreeting = (setup) =>
  `Hi, this is ${setup.assistant_name || "your assistant"} from ${setup.business_name || "us"}. `
  + "Is now a good time for a quick chat?";
