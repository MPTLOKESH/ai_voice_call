/* Everything that talks to the server.
 *
 * A turn is one request: the reply text arrives on the first line, then the speech streams behind it as raw
 * 24 kHz audio. `turn()` hands the text over as soon as it lands, and each piece of audio as it arrives.
 */

export async function loadSetup() {
  const response = await fetch("/api/setup");
  return response.json();
}

export async function saveSetup(setup) {
  const response = await fetch("/api/setup", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(setup),
  });
  const data = await response.json();
  if (!response.ok || data.error) throw new Error(data.error || "could not save");
  return data.setup;
}

export async function suggestQuestions(setup) {
  const response = await fetch("/api/suggest", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(setup),
  });
  const data = await response.json();
  if (!response.ok || data.error) throw new Error(data.error || "could not suggest questions");
  return data;
}

export async function voices() {
  const response = await fetch("/api/voices");
  return response.json();
}

export async function services() {
  const response = await fetch("/api/models");
  return (await response.json()).models;
}

/**
 * Start a call, or answer within one.
 *
 *   onReply(head)   the moment the reply text arrives
 *   onAudio(bytes)  each piece of speech, as it arrives
 * Returns the head, or null if the request failed.
 */
export async function turn({ url, headers, body, signal, onReply, onAudio }) {
  let response;
  try {
    response = await fetch(url, { method: "POST", headers, body, signal });
  } catch (problem) {
    // An abort is the caller stopping this on purpose — talking over the reply, or a newer turn taking
    // over. It must keep its name so the caller can tell it apart from the server being unreachable.
    if (problem.name === "AbortError") throw problem;
    throw new Error(`could not reach the server: ${problem.message}`);
  }
  if (!response.ok || !response.body) {
    const text = await response.text();
    let message = text;
    try { message = JSON.parse(text).error || text; } catch {}
    throw new Error(message);
  }

  const reader = response.body.getReader();
  let head = null;
  let spare = new Uint8Array(0);
  let audioBytes = 0;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    let bytes = value;

    if (!head) {
      const joined = new Uint8Array(spare.length + bytes.length);
      joined.set(spare);
      joined.set(bytes, spare.length);
      const newline = joined.indexOf(10);
      if (newline === -1) { spare = joined; continue; }
      head = JSON.parse(new TextDecoder().decode(joined.subarray(0, newline)));
      onReply?.(head);
      bytes = joined.subarray(newline + 1);
      if (!bytes.length) continue;
    }

    audioBytes += bytes.length;
    onAudio?.(bytes, audioBytes === bytes.length);
  }

  return head ? { ...head, audioBytes } : null;
}

export const startCall = (customer, speak, hooks, signal) => turn({
  url: "/api/call/start",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ customer, speak }),
  signal,
  ...hooks,
});

export const sayText = (callId, message, speak, hooks, signal) => turn({
  url: "/api/call/turn",
  headers: { "Content-Type": "application/json", "X-Call-Id": callId, "X-Speak": speak ? "1" : "0" },
  body: JSON.stringify({ message }),
  signal,
  ...hooks,
});

export const sendAudio = (callId, wav, speak, hooks, signal) => turn({
  url: "/api/call/turn",
  headers: { "Content-Type": "audio/wav", "X-Call-Id": callId, "X-Speak": speak ? "1" : "0" },
  body: wav,
  signal,
  ...hooks,
});
