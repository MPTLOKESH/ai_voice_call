import { useId } from "react";
import { cn } from "../../lib/cn.js";
import { IconTile } from "./Card.jsx";

const WEEKDAY = new Intl.DateTimeFormat(undefined, { weekday: "short" });
const dayName = (iso) => WEEKDAY.format(new Date(`${iso}T12:00:00`));

/** A tiny trend line with a soft fill beneath it. `values` are plain numbers, oldest first. */
export function Sparkline({ values, className, color = "var(--color-brand)" }) {
  const id = useId();
  const W = 120, H = 36, PAD = 3;
  const most = Math.max(1, ...values);
  const step = values.length > 1 ? (W - PAD * 2) / (values.length - 1) : 0;
  const points = values.map((value, at) => [PAD + at * step, H - PAD - (value / most) * (H - PAD * 2)]);
  const line = points.map(([x, y], at) => `${at ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
  const area = `${line} L${points.at(-1)[0].toFixed(1)} ${H} L${points[0][0].toFixed(1)} ${H} Z`;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true" className={cn("h-9 w-full", className)}>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.22" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      {values.length > 1 && <path d={area} fill={`url(#${id})`} />}
      <path d={line} fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/**
 * One headline number: an icon on a soft tile, the figure, a line of context, and (when given) a trend.
 * `value` can be a placeholder node while the number is on its way.
 */
export function StatCard({ icon, tone = "brand", label, value, sub, trend, trendColor, valueClass }) {
  return (
    <div className="group flex flex-col rounded-3xl border border-line bg-white p-5 shadow-tile transition-shadow hover:shadow-float">
      <div className="flex items-center gap-2.5">
        <IconTile icon={icon} tone={tone} size="sm" />
        <p className="text-[13px] font-medium text-muted">{label}</p>
      </div>
      <p className={cn("mt-4 text-[32px] leading-none font-bold tracking-[-0.03em] tabular-nums text-ink", valueClass)}>{value}</p>
      <p className="mt-2 min-h-4 text-xs text-faint">{sub}</p>
      {trend && trend.some((one) => one > 0) && (
        <div className="mt-3 -mb-1"><Sparkline values={trend} color={trendColor} /></div>
      )}
    </div>
  );
}

/**
 * Calls for each day as bars; the part that was completed is solid, the rest is a tint.
 * `days` is [{day, calls, completed}], oldest first.
 */
export function DayBars({ days, height = 148 }) {
  const most = Math.max(1, ...days.map((one) => one.calls));
  const last = days.length - 1;
  return (
    <div role="img" aria-label={`Calls per day: ${days.map((one) => `${dayName(one.day)} ${one.calls}`).join(", ")}`}
         className="flex items-end gap-2 sm:gap-3" style={{ height }}>
      {days.map((one, at) => {
        const tall = (one.calls / most) * (height - 42);
        const finished = one.calls ? (one.completed / one.calls) * 100 : 0;
        return (
          <div key={one.day} className="group relative flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-2">
            <span className={cn("text-[11px] font-semibold tabular-nums", one.calls ? "text-ink" : "text-transparent")}>{one.calls}</span>
            <div className="relative w-full max-w-9 overflow-hidden rounded-xl bg-brand-soft transition-colors group-hover:bg-[#e4dcff]"
                 style={{ height: Math.max(one.calls ? 8 : 4, tall) }} title={`${one.calls} ${one.calls === 1 ? "call" : "calls"}, ${one.completed} completed`}>
              <span className="absolute inset-x-0 bottom-0 bg-brand" style={{ height: `${finished}%` }} />
              {!one.calls && <span className="absolute inset-0 bg-fill" />}
            </div>
            <span className={cn("text-[11px] font-medium", at === last ? "text-ink" : "text-faint")}>{at === last ? "Today" : dayName(one.day)}</span>
          </div>
        );
      })}
    </div>
  );
}

/** A ring that fills to `percent`, with the figure in the middle. */
export function Ring({ percent, size = 96, stroke = 9, label, color = "var(--color-live)" }) {
  const radius = (size - stroke) / 2;
  const whole = 2 * Math.PI * radius;
  return (
    <div className="relative grid shrink-0 place-items-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90" aria-hidden="true">
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="var(--color-fill)" strokeWidth={stroke} />
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke={color} strokeWidth={stroke} strokeLinecap="round"
                strokeDasharray={whole} strokeDashoffset={whole * (1 - Math.min(100, Math.max(0, percent)) / 100)}
                className="transition-[stroke-dashoffset] duration-700" />
      </svg>
      <span className="absolute text-center leading-none">
        <span className="block text-xl font-bold tracking-[-0.02em] tabular-nums text-ink">{percent}%</span>
        {label && <span className="mt-1 block text-[10px] font-medium text-muted">{label}</span>}
      </span>
    </div>
  );
}

/** A thin progress bar, with its figure. */
export function Meter({ percent, tone = "bg-brand", className }) {
  return (
    <span className={cn("block h-2 overflow-hidden rounded-full bg-fill", className)}>
      <span className={cn("block h-full rounded-full transition-[width] duration-700", tone)} style={{ width: `${Math.min(100, percent)}%` }} />
    </span>
  );
}
