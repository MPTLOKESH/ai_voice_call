import { History } from "lucide-react";
import { useState } from "react";
import { Button } from "../ui/Button.jsx";
import { ConfirmDialog, Dialog } from "../ui/Dialog.jsx";

const when = (iso) => new Date(iso).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

/** The versions of a flow that were published, newest first. One can be brought back as the draft. */
export function VersionsDialog({ flow, onRestore, onClose }) {
  const [asking, setAsking] = useState(null);   // the version about to be brought back
  const history = flow.history || [];

  return (
    <Dialog title="Versions" subtitle="Each time you publish, that version is kept." onClose={onClose} className="w-[520px]">
      <div className="px-6 pt-2 pb-5">
        {history.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-edge px-6 py-10 text-center">
            <History aria-hidden="true" className="size-5 text-muted" strokeWidth={1.8} />
            <p className="text-sm font-semibold text-ink">Nothing published yet</p>
            <p className="text-[13px] text-muted">Publish this flow and its versions are listed here, to go back to.</p>
          </div>
        ) : (
          <ul className="divide-y divide-line rounded-2xl border border-line">
            {history.map((version, index) => {
              const count = version.setup.questions.filter((one) => (one.kind || "ask") === "ask").length;
              const live = flow.status !== "Draft" && version.at === flow.published_at;
              return (
                <li key={version.at} className="flex items-center gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-ink">
                      {when(version.at)}
                      {live && <span className="ml-2 rounded-full bg-good-soft px-2 py-0.5 text-[11px] font-semibold text-good">Live</span>}
                    </p>
                    <p className="truncate text-xs text-muted">
                      {count} {count === 1 ? "question" : "questions"} · {version.setup.purpose || "No purpose"}
                    </p>
                  </div>
                  {index > 0 || !live ? (
                    <Button size="sm" variant="secondary" onClick={() => setAsking(version)}>Bring back</Button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </div>
      {asking && (
        <ConfirmDialog title="Bring this version back?" confirm="Bring it back" onClose={() => setAsking(null)}
                       onConfirm={() => { onRestore(asking.at); onClose(); }}>
          It becomes the draft you are editing, from {when(asking.at)}. What is on screen now is replaced, so
          anything not yet published is lost. Nothing goes live until you publish.
        </ConfirmDialog>
      )}
    </Dialog>
  );
}
