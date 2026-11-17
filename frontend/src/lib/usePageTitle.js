import { useEffect } from "react";

const APP = "Voice Call";

/** The browser tab says where you are, so several tabs of this app can be told apart. */
export function usePageTitle(title) {
  useEffect(() => {
    document.title = title ? `${title} · ${APP}` : APP;
  }, [title]);
}
