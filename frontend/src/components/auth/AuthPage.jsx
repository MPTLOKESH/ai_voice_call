import { useState } from "react";
import * as api from "../../lib/api.js";
import { Button } from "../ui/Button.jsx";
import { Field, TextInput } from "../ui/fields.jsx";

const COPY = {
  in: ["Welcome back", "Sign in to carry on with your flows.", "Sign in"],
  up: ["Make your account", "Your flows, contacts and usage stay yours.", "Create account"],
  forgot: ["Reset your password", "Enter your email and we will send you a link to choose a new one.", "Send the link"],
  reset: ["Choose a new password", "Pick one you have not used here before.", "Save password"],
};

/** Sign in, make an account, or get back in after forgetting. One thing on the page at a time. */
export function AuthPage({ needsCode, first, startAs, token, notice, onSignedIn, onReset }) {
  const [mode, setMode] = useState(startAs || (first ? "up" : "in"));
  const [form, setForm] = useState({ name: "", email: "", password: "", code: "" });
  const [problem, setProblem] = useState("");
  const [done, setDone] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (key) => (event) => setForm((one) => ({ ...one, [key]: event.target.value }));
  const [title, subtitle, action] = COPY[mode];
  const choosing = mode === "up" || mode === "reset";

  const go = (next) => { setMode(next); setProblem(""); setDone(""); };

  async function submit(event) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setProblem("");
    try {
      if (mode === "forgot") {
        await api.forgotPassword(form.email);
        setDone("If there is an account with that email, a link is on its way. It works once, for an hour.");
      } else if (mode === "reset") {
        await api.resetPassword(token, form.password);
        onReset?.();
        setForm((one) => ({ ...one, password: "" }));
        setMode("in");
        setDone("Your password is changed. Sign in with the new one.");
      } else {
        const { user } = await (mode === "up" ? api.signUp(form) : api.signIn(form));
        onSignedIn(user);
        return;
      }
    } catch (failure) {
      setProblem(failure.message);
    }
    setBusy(false);
  }

  return (
    <main className="grid min-h-dvh place-items-center bg-canvas px-4 py-10">
      <div className="w-full max-w-[400px]">
        <div className="mb-7 flex items-center gap-3">
          <div className="flex size-[38px] items-center justify-center gap-[3px] rounded-xl bg-ink">
            <span className="size-[7px] rounded-full bg-white" />
            <span className="h-[3px] w-3.5 rounded-sm bg-white" />
          </div>
          <span className="text-[15px] font-semibold text-ink">Voice Call</span>
        </div>

        {notice && <p role="status" className="mb-4 rounded-2xl bg-good-soft px-4 py-3 text-[13px] text-good">{notice}</p>}

        <form onSubmit={submit} className="rounded-3xl border border-line bg-white p-7 shadow-float">
          <h1 className="text-[22px] font-semibold tracking-tight text-ink">{title}</h1>
          <p className="mt-1 text-[14px] text-muted">{subtitle}</p>

          <div className="mt-6 flex flex-col gap-4">
            {mode === "up" && (
              <Field label="Your name">
                <TextInput value={form.name} onChange={set("name")} autoComplete="name" maxLength={80} />
              </Field>
            )}
            {mode !== "reset" && (
              <Field label="Email">
                <TextInput type="email" value={form.email} onChange={set("email")} autoComplete="email" required autoFocus />
              </Field>
            )}
            {mode !== "forgot" && (
              <Field label={mode === "reset" ? "New password" : "Password"} hint={choosing ? "At least 10 characters." : undefined}
                     aside={mode === "in" && (
                       <button type="button" onClick={() => go("forgot")} className="text-[12px] font-medium text-brand-ink hover:underline">Forgot it?</button>
                     )}>
                <TextInput type="password" value={form.password} onChange={set("password")} required autoFocus={mode === "reset"}
                           autoComplete={choosing ? "new-password" : "current-password"} minLength={choosing ? 10 : undefined} />
              </Field>
            )}
            {mode === "up" && needsCode && (
              <Field label="Invite code" hint="Ask whoever runs this server for one.">
                <TextInput value={form.code} onChange={set("code")} required />
              </Field>
            )}
          </div>

          {done && <p role="status" className="mt-4 rounded-xl bg-good-soft px-3.5 py-2.5 text-[13px] text-good">{done}</p>}
          {problem && <p role="alert" className="mt-4 rounded-xl bg-bad-soft px-3.5 py-2.5 text-[13px] text-bad">{problem}</p>}

          <Button type="submit" variant="brand" size="lg" disabled={busy} className="mt-6 w-full justify-center">
            {busy ? "One moment…" : action}
          </Button>
        </form>

        {mode !== "reset" && (
          <p className="mt-5 text-center text-[13px] text-muted">
            {mode === "up" ? "Already have an account?" : mode === "forgot" ? "Remembered it?" : "New here?"}{" "}
            <button type="button" onClick={() => go(mode === "up" || mode === "forgot" ? "in" : "up")}
                    className="font-semibold text-brand-ink hover:underline">
              {mode === "up" || mode === "forgot" ? "Sign in" : "Make an account"}
            </button>
          </p>
        )}
      </div>
    </main>
  );
}
