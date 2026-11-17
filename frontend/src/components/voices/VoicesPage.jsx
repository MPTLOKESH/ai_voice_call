import { Check, Pause, Play, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { cn } from "../../lib/cn.js";
import { sampleGreeting, speakLine } from "../../lib/speak.js";
import { orb } from "../../lib/thread.js";
import { NO_AUDIO } from "../../lib/useVoice.js";
import { Page } from "../layout/Page.jsx";
import { Skeleton } from "../ui/States.jsx";
import { useToast } from "../ui/Toasts.jsx";

const BARS = [8, 14, 20, 11, 17, 24, 9, 15, 21, 12, 7, 18, 13, 22, 10, 16];

/** Every voice this account can speak with. Press play to hear one say the greeting, then use it. */
export function VoicesPage({ voices, loaded, voice, setupState }) {
  const toast = useToast();
  const { form, setup, set } = setupState;
  const [query, setQuery] = useState("");

  const rows = useMemo(() => {
    const everyone = [{ id: "", name: "Default voice", about: "The one set in settings.py." }, ...voices];
    const known = voices.some((one) => one.id === form.voice_id);
    // A saved voice this account no longer lists still has to appear, or it could never be told from "none chosen".
    if (form.voice_id && !known) everyone.push({ id: form.voice_id, name: `Voice ${form.voice_id}`, about: "Not in this account’s list." });
    const needle = query.trim().toLowerCase();
    return everyone.filter((one) => !needle || `${one.name} ${one.about}`.toLowerCase().includes(needle));
  }, [voices, form.voice_id, query]);

  const preview = (one) => voice.run(`preview:${one.id || "default"}`, async (signal) => {
    if (!(await speakLine({ ...setup, voice_id: one.id }, sampleGreeting(setup), signal)) && !signal.aborted) toast(NO_AUDIO, "bad");
  });

  const use = (one) => {
    set("voice_id", one.id);
    toast(`${one.name} is now the voice for this flow.`);
  };

  return (
    <Page title="Voice library" subtitle="The voices that can ask your questions. Preview one, then use it."
          actions={
            <label className="flex w-80 max-w-full items-center gap-2 max-sm:w-full rounded-full border border-edge bg-white px-3.5 py-2.5 text-faint focus-within:border-brand focus-within:ring-3 focus-within:ring-brand/15">
              <Search aria-hidden="true" className="size-4" strokeWidth={2} />
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search name or description"
                     className="min-w-0 flex-1 border-0 bg-transparent text-sm text-ink placeholder:text-faint focus:outline-none" />
            </label>
          }>
      <p className="-mt-2 mb-3.5 text-right text-[13px] text-faint">
        {loaded ? `${rows.length} ${rows.length === 1 ? "voice" : "voices"}` : <Skeleton className="ml-auto h-4 w-16" />}
      </p>

      <div className="overflow-hidden rounded-[20px] border border-line bg-white">
        {rows.map((one) => {
          const id = `preview:${one.id || "default"}`;
          const playing = voice.playing === id;
          const inUse = form.voice_id === one.id;
          return (
            <div key={one.id || "default"} className="flex flex-wrap items-center gap-4 border-b border-fill px-[18px] py-3.5 last:border-b-0 hover:bg-dots">
              <button type="button" onClick={() => preview(one)} aria-label={playing ? `Stop ${one.name}` : `Hear ${one.name}`}
                      className="grid size-[46px] shrink-0 place-items-center rounded-full text-ink" style={{ background: orb(one.id || "default") }}>
                <span className="grid size-6 place-items-center rounded-full bg-white/85">
                  {playing ? <Pause aria-hidden="true" className="size-2.5" fill="currentColor" /> : <Play aria-hidden="true" className="size-2.5" fill="currentColor" />}
                </span>
              </button>
              <div className="min-w-0 flex-[1_1_220px]">
                <p className="text-[15px] font-semibold text-ink">{one.name}</p>
                <p className="mt-px text-[13px] text-muted">{one.about || "No description."}</p>
              </div>
              <div aria-hidden="true" className="flex h-[26px] w-[90px] items-center gap-0.5">
                {BARS.map((height, at) => (
                  <span key={at} className={cn("w-[3px] rounded-sm", playing && at < 10 ? "bg-brand" : "bg-[#d4d4da]")} style={{ height }} />
                ))}
              </div>
              {inUse ? (
                <span className="flex items-center gap-1.5 rounded-full bg-brand-soft px-4 py-2 text-[13px] font-semibold whitespace-nowrap text-brand-ink">
                  <Check aria-hidden="true" className="size-3.5" strokeWidth={2.6} />In use
                </span>
              ) : (
                <button type="button" onClick={() => use(one)}
                        className="rounded-full bg-brand px-4 py-2 text-[13px] font-semibold whitespace-nowrap text-white transition-colors hover:bg-brand-hover">
                  Use voice
                </button>
              )}
            </div>
          );
        })}
        {loaded && voices.length === 0 && (
          <p className="px-5 py-6 text-sm text-muted">
            No voices were listed. Put ELEVENLABS_API_KEY in the .env file beside the project and they will appear here.
          </p>
        )}
      </div>
    </Page>
  );
}
