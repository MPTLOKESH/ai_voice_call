/* Small shared helpers. Nothing here knows about calls or setups. */

export const el = (id) => document.getElementById(id);

export const lines = (text) => text.split("\n").map((s) => s.trim()).filter(Boolean);

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

/** Build an element: make("div", {class: "x"}, "text" | [children]) */
export function make(tag, attributes = {}, children = []) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (name === "class") node.className = value;
    else if (name === "text") node.textContent = value;
    else if (value === true) node.setAttribute(name, "");
    else if (value !== false && value != null) node.setAttribute(name, value);
  }
  (Array.isArray(children) ? children : [children]).forEach((child) => {
    if (child == null) return;
    node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
  });
  return node;
}

let toastHolder = null;
export function toast(message, kind = "note") {
  toastHolder ??= el("toasts");
  const node = make("div", { class: `toast ${kind}`, text: message });
  toastHolder.appendChild(node);
  setTimeout(() => node.classList.add("going"), kind === "bad" ? 6000 : 3500);
  setTimeout(() => node.remove(), kind === "bad" ? 6400 : 3900);
}

/** A level bar plus its numbers, drawn no more than five times a second. */
export function levelMeter(barId, numbersId) {
  let shownAt = 0;
  return (level, startsAt, doing) => {
    const bar = el(barId);
    if (bar) bar.style.transform = `scaleX(${Math.max(0.02, Math.min(1, level / (startsAt * 2.5)))})`;
    const now = performance.now();
    if (now - shownAt < 200) return;
    shownAt = now;
    const numbers = el(numbersId);
    if (!numbers) return;
    numbers.textContent = `you ${level.toFixed(4)} · speak above ${startsAt.toFixed(4)} · ${doing}`;
    numbers.classList.toggle("loud", level > startsAt);
  };
}

export function stopwatch(onTick) {
  let timer = null;
  return {
    start() {
      const began = performance.now();
      this.stop();
      timer = setInterval(() => onTick((performance.now() - began) / 1000), 100);
    },
    stop() { if (timer) clearInterval(timer); timer = null; },
  };
}
