import { cn } from "../../lib/cn.js";

/**
 * The AI's mark, the same wherever the AI appears: a large four-point star and a small one, in the current
 * colour. It takes the place of an icon from the icon set, so it is sized and coloured the same way. `spin`
 * turns it while the AI is working.
 */
export function AiIcon({ spin = false, className, strokeWidth: _ignored, ...props }) {
  return (
    <svg viewBox="0 -2 24 24" aria-hidden="true" {...props}
         className={cn("shrink-0 fill-current", spin && "motion-safe:animate-spin", className)}>
      <path d="M9.5 3c.7 5.3 2.7 7.3 8 8-5.3.7-7.3 2.7-8 8-.7-5.3-2.7-7.3-8-8 5.3-.7 7.3-2.7 8-8Z" />
      <path d="M19 1c.3 2.3 1.2 3.2 3.5 3.5C20.2 4.8 19.3 5.7 19 8c-.3-2.3-1.2-3.2-3.5-3.5C17.8 4.2 18.7 3.3 19 1Z" />
    </svg>
  );
}
