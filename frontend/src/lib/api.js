/* Everything that talks to the server.
 *
 * A turn is one request: the reply text arrives on the first line, then the speech streams behind it as raw
 * 24 kHz audio. `turn()` hands the text over as soon as it lands, and each piece of audio as it arrives.
 */

export const SIGNED_OUT = "voice-call-signed-out";

/**
 * One request, and an Error whose message says what a person can do about it: the server isn't there, the
 * server is older than this page (it has to be restarted to learn the new routes), or what the server said.
 */
async function request(url, { body, method = body === undefined ? "GET" : "POST", keepalive = false, signal } = {}, fallback = "something went wrong") {
  let response;
  try {
    response = await fetch(url, {
      method, keepalive, signal,
      ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    });
  } catch (failure) {
    if (failure?.name === "AbortError") throw failure;       // stopped on purpose: not a server problem
    throw new Error("Could not reach the server. Is `python -m voice_call` still running?");
  }
  let data = null;
  try { data = await response.json(); } catch { /* not JSON: handled below */ }
  if (response.status === 404 && data?.error === "unknown route") {
    throw new Error("The server is older than this page. Stop it, run `python -m voice_call` again, and reload.");
  }
  // The session ended (signed out in another tab, or expired): the app goes back to the sign-in page.
  if (response.status === 401 && data?.signin) window.dispatchEvent(new Event(SIGNED_OUT));
  if (!response.ok || !data || data.error) {
    // The status and the rest of the answer travel with the message: a 409 carries the flow as stored now.
    throw Object.assign(new Error(data?.error || `${fallback} (the server answered ${response.status})`),
                        { status: response.status, data });
  }
  return data;
}

// ── accounts ────────────────────────────────────────────────────────────────

/** Who is signed in: {user: {id, email, name} | null, needs_code, first}. */
export const me = () => request("/api/auth/me", {}, "could not check who is signed in");
export const signUp = (body) => request("/api/auth/signup", { body }, "could not make the account");
export const signIn = (body) => request("/api/auth/signin", { body }, "could not sign in");
export const signOut = () => request("/api/auth/signout", { body: {} }, "could not sign out");
export const verifyEmail = (token) => request("/api/auth/verify", { body: { token } }, "could not confirm the email");
export const forgotPassword = (email) => request("/api/auth/forgot", { body: { email } }, "could not send the link");
export const resetPassword = (token, password) => request("/api/auth/reset", { body: { token, password } }, "could not reset the password");

/** {user, plan: {allowance, used, left, resets, own_used}, keys: {gemini|elevenlabs: {label, does, where, ours_available, has_own, last4, mode}}, mail, default_allowance} */
export const account = () => request("/api/account", {}, "could not load your account");
/** Spending over the last `days`: {totals, daily: [{day, ours, own}], by_service, by_kind, by_flow, recent, names}. */
export const accountUsage = (days) => request(`/api/account/usage?days=${days}`, {}, "could not load your usage");
export const accountActivity = () => request("/api/account/activity", {}, "could not load the activity");
export const saveProfile = (name) => request("/api/account/profile", { body: { name } }, "could not save");
export const changePassword = (current, next) => request("/api/account/password", { body: { current, new: next } }, "could not change the password");
export const signOutEverywhere = () => request("/api/account/signout-everywhere", { body: {} }, "could not sign out everywhere");
export const resendVerification = () => request("/api/account/resend", { body: {} }, "could not send the email");
/** Checks the key with the provider, then stores it encrypted. Resolves with {note, keys}; the key is never sent back. */
export const saveKey = (service, key) => request("/api/account/keys", { body: { service, key } }, "could not save the key");
export const setKeyMode = (service, mode) => request("/api/account/keys/mode", { body: { service, mode } }, "could not switch");
export const removeKey = (service) => request("/api/account/keys/remove", { body: { service } }, "could not remove the key");
export const deleteAccount = (password) => request("/api/account/delete", { body: { password } }, "could not delete the account");
/** For the person running the server: every account, its spend this month, its allowance. */
export const adminUsers = () => request("/api/admin/users", {}, "could not load the accounts");
export const adminChange = (id, changes) => request(`/api/admin/users/${id}`, { body: changes }, "could not change that account");

/**
 * Every flow, most recently edited first: {id, name, status, channels, audience, when, scheduled_for, created,
 * edited, published_at, version, setup, published, unpublished_changes}. `setup` is the draft being edited,
 * `published` the copy customers get.
 */
export async function flows() {
  return (await request("/api/flows", {}, "could not load your flows")).flows;
}

export const createFlow = (name, setup) => request("/api/flows", { body: { name, setup } }, "could not start a new flow");
/** Saves the draft. `version` is the one it was made from; a newer one stored is a 409 with `data.flow`. */
export const saveFlow = (id, { name, setup, version }, { keepalive = false } = {}) =>
  request(`/api/flows/${id}`, { body: { name, setup, version }, keepalive }, "could not save");
export const discardFlow = (id) => request(`/api/flows/${id}/discard`, { body: {} }, "could not discard the changes");
export const publishFlow = (id, options) => request(`/api/flows/${id}/publish`, { body: options }, "could not publish");
export const deleteFlows = (ids) => request("/api/flows/delete", { body: { ids } }, "could not delete");
export const deleteCalls = (ids) => request("/api/calls/delete", { body: { ids } }, "could not delete the calls");
export const deleteFlow = (id) => request(`/api/flows/${id}/delete`, { body: {} }, "could not delete");
/** One reply in the studio chat: {reply, changed, questions}, `questions` being the whole proposed list of steps. */
export const assist = (setup, messages, refs, signal) => request("/api/assist", { body: { setup, messages, refs }, signal }, "the assistant could not answer");
/** A few steps that could come straight after the one saved as `after` ("" is the opening): {options}. */
export const suggestNext = (setup, after, signal) => request("/api/assist/next", { body: { setup, after }, signal }, "could not suggest what comes next");
/** The rough note about why the call is made, rewritten properly: {text}. */
export const rewriteContext = (text) => request("/api/assist/context", { body: { text } }, "could not rewrite that");
export const suggestQuestions = (setup) => request("/api/suggest", { body: setup }, "could not suggest questions");

export async function voices() {
  try { return await request("/api/voices", {}, "could not list voices"); } catch { return { voices: [] }; }
}

export async function services() {
  return (await request("/api/models", {}, "could not read the models")).models;
}

/** Finished calls, newest first, as saved in data/calls/: {calls, total}. Filters: flow, outcome, limit, offset. */
export async function recentCalls(filters = {}) {
  const query = new URLSearchParams(Object.entries(filters).filter(([, value]) => value !== "" && value != null));
  const data = await request(`/api/calls${query.size ? `?${query}` : ""}`, {}, "could not load past calls");
  return { calls: data.calls || [], total: data.total ?? (data.calls || []).length };
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

/** Calls made from this page are tests: the server keeps them out of a flow's results. */
export const startCall = (setup, customer, speak, hooks, signal, flowId = "") => turn({
  url: "/api/call/start",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ setup, customer, speak, flow_id: flowId, test: true }),
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

/** `interrupted`: they talked over the last reply, so the server deals with what they said first. */
export const sendAudio = (callId, wav, speak, interrupted, hooks, signal) => turn({
  url: "/api/call/turn",
  headers: {
    "Content-Type": "audio/wav", "X-Call-Id": callId, "X-Speak": speak ? "1" : "0",
    "X-Interrupted": interrupted ? "1" : "0",
  },
  body: wav,
  signal,
  ...hooks,
});

// ── contacts ────────────────────────────────────────────────────────────────

const query = (filters) => {
  const found = new URLSearchParams(Object.entries(filters).filter(([, value]) => value !== "" && value != null));
  return found.size ? `?${found}` : "";
};

/** {groups: [{id, name, description, source, count, opted_out, synced_at, sync_problem, …}], all: {count, opted_out}} */
export const groups = () => request("/api/contacts/groups", {}, "could not load the groups");
/** A page of contacts: {contacts, total}. Filters: group, search, status ("opted_out" | "reachable"), offset, limit. */
export const contacts = (filters = {}) => request(`/api/contacts${query(filters)}`, {}, "could not load the contacts");
/** One contact, with `calls`: the calls made to them. */
export const contact = (id) => request(`/api/contacts/${id}`, {}, "could not load that contact");
export const saveContact = (data, id = "") => request(`/api/contacts${id ? `/${id}` : ""}`, { body: data }, "could not save the contact");
export const deleteContacts = (ids) => request("/api/contacts/delete", { body: { ids } }, "could not delete");
export const optOut = (ids, opted_out) => request("/api/contacts/opt-out", { body: { ids, opted_out } }, "could not change that");
export const reach = (groupIds) => request("/api/contacts/reach", { body: { groups: groupIds } }, "could not count the contacts");

export const createGroup = (name, description = "") => request("/api/contacts/groups", { body: { name, description } }, "could not make the group");
export const saveGroup = (id, changes) => request(`/api/contacts/groups/${id}`, { body: changes }, "could not save the group");
/** Refused with a 409 (and `data.flows`) when a live flow is sent to it, unless `force`. */
export const deleteGroup = (id, { withContacts = false, force = false } = {}) =>
  request(`/api/contacts/groups/${id}/delete`, { body: { with_contacts: withContacts, force } }, "could not delete the group");
export const syncGroup = (id) => request(`/api/contacts/groups/${id}/sync`, { body: {} }, "could not sync");
export const changeMembers = (id, ids, add) => request(`/api/contacts/groups/${id}/members`, { body: { ids, add } }, "could not change the group");

/** A CSV or Excel file read on the server: {columns, rows, total}. */
export async function readFile(file) {
  let response;
  try {
    response = await fetch("/api/contacts/file", { method: "POST", headers: { "X-Filename": encodeURIComponent(file.name) }, body: file });
  } catch {
    throw new Error("Could not reach the server. Is `python -m voice_call` still running?");
  }
  const data = await response.json().catch(() => null);
  if (!response.ok || !data || data.error) throw new Error(data?.error || `could not read the file (the server answered ${response.status})`);
  return data;
}

/** Brings rows in. With `dry_run` it only checks, for the review step. */
export const importRows = (body) => request("/api/contacts/import", { body }, "could not import");

/** {drivers: [{kind, label, ready, install, example}], connections: [{id, name, kind, label, address}], country} */
export const contactSources = () => request("/api/contacts/sources", {}, "could not load the databases");
export const saveConnection = (name, kind, address) => request("/api/contacts/connections", { body: { name, kind, address } }, "could not connect");
export const deleteConnection = (id) => request(`/api/contacts/connections/${id}/delete`, { body: {} }, "could not remove it");
export const tables = (id) => request(`/api/contacts/connections/${id}/tables`, { body: {} }, "could not list the tables");
export const previewRows = (connection, { table = "", query: sql = "" }) =>
  request("/api/contacts/query", { body: { connection, table, query: sql } }, "could not run the query");
export const databaseGroup = (body) => request("/api/contacts/database-group", { body }, "could not make the group");

// ── dashboard and results ───────────────────────────────────────────────────

/** {flows: {<id>: {calls, completed, average_seconds, last}}, week: {calls, completed, average_seconds}} */
export const stats = () => request("/api/stats", {}, "could not load the numbers");
/** One flow's answers, question by question: {calls, completed, average_seconds, questions, recent, audience}. */
export const flowResults = (id) => request(`/api/flows/${id}/results`, {}, "could not load the results");
export const duplicateFlow = (id) => request(`/api/flows/${id}/duplicate`, { body: {} }, "could not duplicate it");
/** Back to a draft: nothing live or scheduled. */
export const unpublishFlow = (id) => request(`/api/flows/${id}/unpublish`, { body: {} }, "could not unpublish it");
export const exportUrl = (id) => `/api/flows/${id}/export.csv`;

/** An earlier published version becomes the draft again. `at` is the version's `at`, from flow.history. */
export const restoreFlow = (id, at) => request(`/api/flows/${id}/restore`, { body: { at } }, "could not bring that version back");

/** Other ways to put one line: {options: [...]}. `kind` is "ask" or "say". */
export const reword = (setup, text, kind) => request("/api/suggest/reword", { body: { setup, text, kind } }, "could not suggest other wording");
