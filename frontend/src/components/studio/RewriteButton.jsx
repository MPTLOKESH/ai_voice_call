import { Loader2 } from "lucide-react";
import { AiIcon } from "../ui/AiIcon.jsx";
import { useState } from "react";
import * as api from "../../lib/api.js";
import { cn } from "../../lib/cn.js";

/** "Rewrite properly": the AI tidies the rough note typed above it. `onResult(text)` puts the rewrite in; Ctrl+Z takes it back. */
export function RewriteButton({ text, onResult, className }) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  async function go() {
    if (!text.trim() || busy) return;
    setBusy(true); setProblem("");
    try {
      const found = await api.rewriteContext(text);
      if (found.text) onResult(found.text); else setProblem("Nothing came back. Try again.");
    } catch (failure) {
      setProblem(failure.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <button type="button" onClick={go} disabled={!text.trim() || busy} title="The AI rewrites it properly. Ctrl+Z undoes it."
              className="ai-glow flex h-8 items-center gap-1.5 rounded-full bg-white px-3 text-xs font-semibold text-brand-ink disabled:opacity-50">
        {busy ? <Loader2 aria-hidden="true" className="size-3.5 animate-spin" strokeWidth={2.4} /> : <AiIcon aria-hidden="true" className="size-3.5" strokeWidth={2.3} />}
        {busy ? "Rewriting…" : "Rewrite with AI"}
      </button>
      {problem && <span className="text-xs text-bad">{problem}</span>}
    </span>
  );
}
