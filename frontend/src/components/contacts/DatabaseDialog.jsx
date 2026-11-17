import { Database, Lock, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import * as api from "../../lib/api.js";
import { cn } from "../../lib/cn.js";
import { guessMapping } from "../../lib/columns.js";
import { Button } from "../ui/Button.jsx";
import { Dialog } from "../ui/Dialog.jsx";
import { Field, Pills, Select, TextArea, TextInput } from "../ui/fields.jsx";
import { Skeleton } from "../ui/States.jsx";
import { useToast } from "../ui/Toasts.jsx";
import { ColumnMatch, Footer, ImportSummary, PreviewTable, Steps } from "./shared.jsx";

const STEPS = ["Connect", "Choose rows", "Match columns", "Name the group"];

/**
 * A group read from a database: connect (or pick a saved connection), choose a table or write a SELECT,
 * say which column is which, and name the group. It can be synced again later from the group's page.
 */
export function DatabaseDialog({ onClose, onDone }) {
  const toast = useToast();
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [known, setKnown] = useState(null);           // {drivers, connections, country}
  const [connection, setConnection] = useState(null); // the chosen one, with its tables
  const [adding, setAdding] = useState(false);
  const [kind, setKind] = useState("postgres");
  const [label, setLabel] = useState("");
  const [address, setAddress] = useState("");
  const [how, setHow] = useState("table");
  const [table, setTable] = useState("");
  const [sql, setSql] = useState("");
  const [preview, setPreview] = useState(null);
  const [mapping, setMapping] = useState(null);
  const [country, setCountry] = useState("+91");
  const [name, setName] = useState("");
  const [result, setResult] = useState(null);

  useEffect(() => {
    api.contactSources().then((found) => {
      setKnown(found);
      setCountry(found.country);
      setAdding(!found.connections.length);
    }).catch((failure) => toast(failure.message, "bad"));
  }, [toast]);

  const driver = known?.drivers.find((one) => one.kind === kind);

  async function run(job) {
    setBusy(true);
    try { return await job(); } catch (failure) { toast(failure.message, "bad"); return null; } finally { setBusy(false); }
  }

  const connect = () => run(async () => {
    const saved = await api.saveConnection(label, kind, address);
    setKnown((all) => ({ ...all, connections: [...all.connections, saved] }));
    pickTables(saved, saved.tables);
  });

  const useSaved = (one) => run(async () => pickTables(one, (await api.tables(one.id)).tables));

  function pickTables(one, tables) {
    setConnection({ ...one, tables });
    setTable(tables[0] || "");
    setHow(tables.length ? "table" : "query");
    setPreview(null);
    setStep(1);
  }

  const forget = (one) => run(async () => {
    await api.deleteConnection(one.id);
    setKnown((all) => ({ ...all, connections: all.connections.filter((other) => other.id !== one.id) }));
  });

  const source = () => (how === "table" ? { table } : { query: sql });

  const look = () => run(async () => {
    const found = await api.previewRows(connection.id, source());
    if (!found.rows.length) { toast("That gives no rows. Check the table or the query.", "bad"); return; }
    setPreview(found);
    setMapping(guessMapping(found.columns));
    setName(how === "table" ? table.split(".").pop().replace(/_/g, " ") : `${connection.name} contacts`);
  });

  const create = () => run(async () => {
    const done = await api.databaseGroup({ connection: connection.id, ...{ table: "", query: "" }, ...source(), mapping, country, name });
    setResult(done);
    onDone(done.group);
  });

  return (
    <Dialog title="Connect a database" subtitle={connection ? `${connection.name} · ${connection.label}` : "Contacts read from your own database"}
            onClose={onClose} className="w-[660px]">
      <Steps steps={STEPS} at={result ? 4 : step} />

      {step === 0 && known && (
        <>
          <div className="flex flex-col gap-4 px-6 py-4">
            {known.connections.length > 0 && (
              <div className="flex flex-col gap-2">
                <span className="text-[13px] font-semibold text-ink">Saved connections</span>
                <ul className="divide-y divide-line rounded-2xl border border-line">
                  {known.connections.map((one) => (
                    <li key={one.id} className="flex items-center gap-3 px-3.5 py-2.5">
                      <Database aria-hidden="true" className="size-4 shrink-0 text-muted" strokeWidth={1.8} />
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-semibold text-ink">{one.name} <span className="font-normal text-muted">· {one.label}</span></span>
                        <span className="block truncate font-mono text-xs text-faint">{one.address}</span>
                      </span>
                      <button type="button" aria-label={`Forget ${one.name}`} title="Forget this connection" onClick={() => forget(one)}
                              className="grid size-8 place-items-center rounded-lg text-faint hover:bg-bad-soft hover:text-bad">
                        <Trash2 aria-hidden="true" className="size-3.5" strokeWidth={2} />
                      </button>
                      <Button size="sm" variant="secondary" disabled={busy} onClick={() => useSaved(one)}>Use</Button>
                    </li>
                  ))}
                </ul>
                {!adding && (
                  <button type="button" onClick={() => setAdding(true)} className="self-start text-[13px] font-semibold text-brand-ink hover:underline">
                    + Connect another database
                  </button>
                )}
              </div>
            )}

            {adding && (
              <div className="flex flex-col gap-4">
                <Pills label="Kind of database" value={kind} onChange={setKind}
                       options={known.drivers.map((one) => [one.kind, one.label])} />
                {driver && !driver.ready ? (
                  <p className="rounded-xl bg-warn-soft px-3.5 py-3 text-[13px] leading-relaxed text-warn">
                    {driver.label} needs one more part. In the project folder run{" "}
                    <code className="rounded bg-white/70 px-1.5 py-0.5 font-mono text-[12px]">{driver.install}</code>, then restart the app.
                  </p>
                ) : (
                  <>
                    <div className="grid gap-4 sm:grid-cols-[1fr_2fr]">
                      <Field label="Name it">
                        <TextInput value={label} onChange={(event) => setLabel(event.target.value)} placeholder={driver?.label} />
                      </Field>
                      <Field label={kind === "sqlite" ? "Database file" : "Address"}>
                        <TextInput value={address} onChange={(event) => setAddress(event.target.value)} placeholder={driver?.example}
                                   className="font-mono text-[13px]" spellCheck={false} />
                      </Field>
                    </div>
                    <p className="flex items-start gap-2 text-xs leading-relaxed text-muted">
                      <Lock aria-hidden="true" className="mt-px size-3.5 shrink-0" strokeWidth={2} />
                      Only ever read, never changed. The address and password stay on this computer, in config/connections.json.
                      A read-only database user is safest.
                    </p>
                  </>
                )}
              </div>
            )}
          </div>
          <Footer>
            <Button variant="secondary" onClick={onClose}>Cancel</Button>
            {adding && (
              <Button variant="primary" disabled={busy || !driver?.ready || !address.trim()} onClick={connect}>
                {busy ? "Connecting…" : "Connect"}
              </Button>
            )}
          </Footer>
        </>
      )}
      {step === 0 && !known && (
        <div role="status" aria-label="Loading" className="flex flex-col gap-3 px-6 py-5">
          <Skeleton className="h-10" /><Skeleton className="h-10" />
        </div>
      )}

      {step === 1 && (
        <>
          <div className="flex flex-col gap-4 px-6 py-4">
            <Pills label="What to read" value={how} onChange={(value) => { setHow(value); setPreview(null); }}
                   options={[["table", "A whole table"], ["query", "A query"]]} />
            {how === "table" ? (
              <Select aria-label="Table" value={table} onChange={(event) => { setTable(event.target.value); setPreview(null); }}
                      options={connection.tables.length ? connection.tables.map((one) => [one, one]) : [["", "No tables found"]]} />
            ) : (
              <TextArea aria-label="Query" value={sql} onChange={(event) => { setSql(event.target.value); setPreview(null); }} spellCheck={false}
                        className="min-h-24 font-mono text-[13px]"
                        placeholder={"SELECT name, phone, email FROM customers\nWHERE delivered_at > now() - interval '1 day'"} />
            )}
            {preview && (
              <>
                <PreviewTable columns={preview.columns} rows={preview.rows} />
                <p className="text-xs text-muted">The first {preview.rows.length} rows{preview.more ? ", of more" : ""}.</p>
              </>
            )}
          </div>
          <Footer>
            <Button variant="secondary" onClick={() => setStep(0)}>Back</Button>
            <Button variant={preview ? "secondary" : "primary"} disabled={busy || (how === "table" ? !table : !sql.trim())} onClick={look}>
              {busy ? "Reading…" : preview ? "Read again" : "Show rows"}
            </Button>
            {preview && <Button variant="primary" onClick={() => setStep(2)}>Next</Button>}
          </Footer>
        </>
      )}

      {step === 2 && (
        <>
          <div className="flex flex-col gap-4 px-6 py-4">
            <ColumnMatch columns={preview.columns} rows={preview.rows} mapping={mapping} onChange={setMapping}
                         country={country} onCountry={setCountry} />
          </div>
          <Footer>
            <Button variant="secondary" onClick={() => setStep(1)}>Back</Button>
            <Button variant="primary" disabled={!mapping.phone} onClick={() => setStep(3)}>Next</Button>
          </Footer>
        </>
      )}

      {step === 3 && !result && (
        <>
          <div className="flex flex-col gap-3 px-6 py-4">
            <Field label="Group name" hint="Syncing it later reads the rows again: new people join, anyone no longer there leaves the group.">
              <TextInput value={name} onChange={(event) => setName(event.target.value)} />
            </Field>
          </div>
          <Footer>
            <Button variant="secondary" onClick={() => setStep(2)}>Back</Button>
            <Button variant="primary" disabled={busy || !name.trim()} onClick={create}>{busy ? "Reading every row…" : "Make the group"}</Button>
          </Footer>
        </>
      )}

      {result && (
        <>
          <div className={cn("flex flex-col gap-4 px-6 py-4")}>
            <p className="text-[15px] font-semibold text-ink">
              {result.group.name} has {result.group.count.toLocaleString()} {result.group.count === 1 ? "contact" : "contacts"}.
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
