/* One page, two panes: the setup on the left, the call on the right. */

import * as api from "./api.js";
import * as callView from "./call.js";
import * as setupView from "./setup.js";
import { el, toast } from "./ui.js";

function showHeader(setup) {
  el("business-name").textContent = setup.business_name || "Voice Call";
  el("business-purpose").textContent = setup.purpose || "a voice assistant for your business";
}

/** Folding the setup away gives the call the whole width, which is what a long call wants. */
function hideSetup(hidden) {
  el("split").dataset.setup = hidden ? "hidden" : "shown";
  el("toggle-setup").textContent = hidden ? "Show setup" : "Hide setup";
  try { localStorage.setItem("voice-call-setup-hidden", hidden ? "1" : ""); } catch {}
}

async function begin() {
  let setup;
  try {
    setup = await api.loadSetup();
  } catch (problem) {
    toast(`Could not load your setup: ${problem.message}`, "bad");
    return;
  }

  showHeader(setup);
  setupView.start(setup, {
    onChange: (saved) => { showHeader(saved); callView.setupChanged(saved); },
  });
  callView.start(setup);

  el("toggle-setup").addEventListener("click", () => hideSetup(el("split").dataset.setup !== "hidden"));
  let wasHidden = false;
  try { wasHidden = localStorage.getItem("voice-call-setup-hidden") === "1"; } catch {}
  hideSetup(wasHidden);

  // "Save and call" lives in the setup pane but the call is in the other one: bring it into view.
  document.addEventListener("go-to-call", () => {
    el("pane-call").scrollIntoView({ behavior: "smooth", block: "start" });
    el("start").focus({ preventScroll: true });
  });

  api.services()
    .then((models) => { el("services").textContent = models.ai || "—"; })
    .catch(() => {});
}

begin();
