import { FileSpreadsheet, Upload } from "lucide-react";
import { useRef, useState } from "react";
import * as api from "../../lib/api.js";
import { cn } from "../../lib/cn.js";
import { guessMapping } from "../../lib/columns.js";
import { Button } from "../ui/Button.jsx";
import { Dialog } from "../ui/Dialog.jsx";
import { Pills, Select, TextInput } from "../ui/fields.jsx";
import { useToast } from "../ui/Toasts.jsx";
import { ColumnMatch, Footer, ImportSummary, PreviewTable, Steps } from "./shared.jsx";

const STEPS = ["Choose a file", "Match columns", "Review", "Done"];
const SAMPLE = "data:text/csv;charset=utf-8," + encodeURIComponent(
  "Name,Phone,Email,City\nAsha Rao,98765 43210,asha@example.com,Pune\nBen Thomas,+44 20 7946 0958,,London\n");

/**
 * Bringing contacts in from a CSV or Excel file: pick the file, say which column is which, see what will
 * happen, then put them in a group (a new one, or one that exists).
 */
export function ImportDialog({ groups, intoGroup = "", country: defaultCountry = "+91", onClose, onDone }) {
  const toast = useToast();
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [file, setFile] = useState(null);           // {name, columns, rows, total}
  const [mapping, setMapping] = useState(null);
  const [country, setCountry] = useState(defaultCountry);
  const [check, setCheck] = useState(null);         // what the dry run found
  const [where, setWhere] = useState(intoGroup ? "existing" : "new");
  const [groupId, setGroupId] = useState(intoGroup || groups[0]?.id || "");
  const [newName, setNewName] = useState("");
  const [result, setResult] = useState(null);
  const [over, setOver] = useState(false);
  const picker = useRef(null);

  async function choose(chosen) {
    if (!chosen) return;
    setBusy(true);
    try {
      const table = await api.readFile(chosen);
      setFile({ name: chosen.name, ...table });
      setMapping(guessMapping(table.columns));
      setNewName(chosen.name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim().slice(0, 80) || "Imported contacts");
      setStep(1);
    } catch (failure) {
      toast(failure.message, "bad");
    } finally {
      setBusy(false);
    }
  }

  const body = (extra) => ({ columns: file.columns, rows: file.rows, mapping, country, ...extra });

  async function review() {
    setBusy(true);
    try {
      setCheck(await api.importRows(body({ dry_run: true })));
      setStep(2);
    } catch (failure) {
      toast(failure.message, "bad");
    } finally {
      setBusy(false);
    }
  }

  async function bringIn() {
    setBusy(true);
    try {
      const done = await api.importRows(body(where === "new" ? { new_group: newName } : { group_id: groupId }));
      setResult(done);
      setStep(3);
      onDone(done.group);
    } catch (failure) {
      toast(failure.message, "bad");
    } finally {
      setBusy(false);
    }
  }

  const ready = check ? check.added + check.updated : 0;

  return (
    <Dialog title="Import contacts" subtitle={file ? `${file.name} · ${file.total.toLocaleString()} rows` : "From a CSV or Excel file"}
            onClose={onClose} className="w-[640px]">
      <Steps steps={STEPS} at={step} />

      {step === 0 && (
        <>
          <div className="px-6 py-4">
            <button type="button" onClick={() => picker.current?.click()} disabled={busy}
                    onDragOver={(event) => { event.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
                    onDrop={(event) => { event.preventDefault(); setOver(false); choose(event.dataTransfer.files[0]); }}
                    className={cn("flex w-full flex-col items-center gap-3 rounded-2xl border-2 border-dashed px-6 py-10 text-center transition-colors",
                                  over ? "border-brand bg-brand-wash" : "border-edge hover:border-[#c9c9d1] hover:bg-hover")}>
              <span className="grid size-12 place-items-center rounded-2xl bg-brand-soft text-brand">
                <Upload aria-hidden="true" className="size-5" strokeWidth={2} />
              </span>
              <span className="text-[15px] font-semibold text-ink">{busy ? "Reading…" : "Drop a file here, or choose one"}</span>
              <span className="text-[13px] text-muted">CSV or Excel (.xlsx). The first row names the columns; one contact per row.</span>
            </button>
            <input ref={picker} type="file" accept=".csv,.tsv,.txt,.xlsx,.xlsm" className="hidden"
                   onChange={(event) => { choose(event.target.files[0]); event.target.value = ""; }} />
          </div>
          <Footer note={<a href={SAMPLE} download="contacts-sample.csv" className="font-medium text-brand-ink hover:underline">Download a sample file</a>}>
            <Button variant="secondary" onClick={onClose}>Cancel</Button>
          </Footer>
        </>
      )}

      {step === 1 && (
        <>
          <div className="flex flex-col gap-4 px-6 py-4">
            <ColumnMatch columns={file.columns} rows={file.rows} mapping={mapping} onChange={setMapping}
                         country={country} onCountry={setCountry} />
            <PreviewTable columns={file.columns} rows={file.rows.slice(0, 5)} highlight={[mapping.phone, mapping.email, ...mapping.name]} />
          </div>
          <Footer>
            <Button variant="secondary" onClick={() => setStep(0)}>Back</Button>
            <Button variant="primary" disabled={!mapping.phone || busy} onClick={review}>{busy ? "Checking…" : "Next"}</Button>
          </Footer>
        </>
      )}

      {step === 2 && (
        <>
          <div className="flex flex-col gap-5 px-6 py-4">
            <ImportSummary result={check} />
            <div className="flex flex-col gap-2.5">
              <span className="text-[13px] font-semibold text-ink">Put them in</span>
              <Pills label="Which group" value={where} onChange={setWhere}
                     options={[["new", "A new group"], ...(groups.length ? [["existing", "A group I have"]] : [])]} />
              {where === "new" ? (
                <TextInput aria-label="New group name" value={newName} onChange={(event) => setNewName(event.target.value)} placeholder="Group name" />
              ) : (
                <Select aria-label="Group" value={groupId} onChange={(event) => setGroupId(event.target.value)}
                        options={groups.map((group) => [group.id, `${group.name} (${group.count})`])} />
              )}
            </div>
          </div>
          <Footer>
            <Button variant="secondary" onClick={() => setStep(1)}>Back</Button>
            <Button variant="primary" disabled={busy || !ready || (where === "new" ? !newName.trim() : !groupId)} onClick={bringIn}>
              {busy ? "Importing…" : ready ? `Import ${ready.toLocaleString()} ${ready === 1 ? "contact" : "contacts"}` : "Nothing to import"}
            </Button>
          </Footer>
        </>
      )}

      {step === 3 && result && (
        <>
          <div className="flex flex-col gap-4 px-6 py-4">
            <p className="flex items-center gap-2.5 text-[15px] font-semibold text-ink">
              <FileSpreadsheet aria-hidden="true" className="size-5 text-good" strokeWidth={2} />
              {result.group.name} now has {result.group.count.toLocaleString()} {result.group.count === 1 ? "contact" : "contacts"}.
            </p>
            <ImportSummary result={result} done />
          </div>
          <Footer>
            <Button variant="primary" onClick={onClose}>Done</Button>
          </Footer>
        </>
      )}
    </Dialog>
  );
}
