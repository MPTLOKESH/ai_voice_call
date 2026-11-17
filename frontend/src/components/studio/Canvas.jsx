import {
  Bot, MessageCircleQuestion, Map as MapIcon, Maximize2, Megaphone, MessagesSquare, Minus, Phone, PhoneForwarded, PhoneOff, Plus, Repeat, RotateCcw, Square, UserRound,
} from "lucide-react";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import { cn } from "../../lib/cn.js";
import { LABEL_H, NODE_H, PAIR_GAP, boundsOf, connectorsOf, hitTest, joinsOf, returnsOf } from "../../lib/layout.js";
import { SLOT, TILE, humanize } from "../../lib/thread.js";
import { AiIcon } from "../ui/AiIcon.jsx";

const MIN_ZOOM = 0.2;
const MAX_ZOOM = 1.6;
/** One step of zoom with a mouse: the next 5% mark up or down (97% goes to 100%, 100% to 105%). */
const stepZoom = (z, direction) => (direction > 0 ? Math.floor(z * 20 + 1e-6) + 1 : Math.ceil(z * 20 - 1e-6) - 1) / 20;
const GRID = 32;                                   // the gap between background dots, at 100%
const DRAG_FROM = 4;     // pixels the pointer must travel before a press becomes a drag

// What each kind of tile looks like: its icon and its colour. The two sides of the call are told apart at a
// glance: what the AI does is purple and square, with the AI asking as a solid robot; what the customer does is
// teal and round, a solid person.
// `edge` and `wash` tint the card itself in its kind's colour, very lightly: white at the top, a breath of colour below.
const KINDS = {
  context: { icon: MessageCircleQuestion, tile: "bg-why-soft text-why", edge: "border-why/30", wash: "to-why-soft/70" },
  open: { icon: Phone, tile: "bg-good text-white", edge: "border-good/40", wash: "to-good-soft/80" },
  ask: { icon: Bot, tile: "bg-brand text-white", edge: "border-brand/20", wash: "to-brand-wash" },
  answer: { icon: UserRound, tile: "bg-[#d3efdf] text-good", round: true, edge: "border-good/25", wash: "to-good-soft/60" },
  say: { icon: Megaphone, tile: "bg-brand-soft text-brand", edge: "border-brand/20", wash: "to-brand-wash" },
  end: { icon: PhoneOff, tile: "bg-bad text-white", edge: "border-bad/40", wash: "to-bad-soft/80" },
  handoff: { icon: PhoneForwarded, tile: "bg-loop-soft text-loop", edge: "border-loop/25", wash: "to-loop-soft/80" },
  loop: { icon: Repeat, tile: "bg-loop-soft text-loop", edge: "border-loop/25", wash: "to-loop-soft/80" },
  close: { icon: PhoneOff, tile: "bg-bad text-white", edge: "border-bad/40", wash: "to-bad-soft/80" },
};
const kindOf = (tile, node) => (tile.kind === "end" && node.question?.handoff ? "handoff" : tile.kind);
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

/**
 * The call drawn on a canvas of its own. The pointer is an ordinary one: click a node to pick it, Shift or
 * Ctrl+click to pick more, drag over the background to pick everything in a box, drag a node (or the picked
 * ones together) to put it anywhere. The view is moved with the middle mouse button, or with Space held
 * down; scroll to move, Ctrl+scroll (or the buttons) to zoom. Nodes are joined in the order of the call,
 * so dropping something on a connector puts it there.
 *
 *   nodes       from layoutNodes
 *   details     {tileId: {title, sub, flag}} for the labels under each tile
 *   picked      ids of the nodes picked (one or many); onPick(ids) changes them
 *   onMenu      a right-click: ({x, y, node, tile}) on a step, ({x, y, world}) on empty canvas
 *   hintAt      id of the node the glowing "what next?" button sits after; onHint({x, y, node}) when pressed
 *   probe       {x, y} client position of a block being dragged in from outside, or null
 *   trashRef    the element a node can be dropped on to delete it
 *
 * Through its ref: hit(clientX, clientY) says what is there, fit() and zoomBy(±1) move the view.
 */
export const Canvas = forwardRef(function Canvas({
  nodes, details, selectedId, activeId, picked = [], tries, probe, trashRef, empty,
  onSelect, onDeselect, onPick, onStop, onPlace, onPlaceMany, onRelocate, onDelete, onDeleteMany, onTrash, onInsertHere, onMenu, hintAt, hintBusy, onHint,
}, ref) {
  const viewport = useRef(null);
  const [view, setView] = useState({ tx: 80, ty: 40, z: 1 });
  // The opening: the "Say why it is calling" card comes in from the left and zooms up to size. Skipped for reduced motion.
  const [intro, setIntro] = useState(() => !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
  const [drag, setDrag] = useState(null);          // {id, x, y, ...}: a step on its way somewhere
  const [panning, setPanning] = useState(false);
  const [glide, setGlide] = useState(false);       // the view is moving on its own (to a new step), so it eases rather than jumps
  const [handy, setHandy] = useState(false);       // Space is held: the pointer is a hand, and moves the view
  const [box, setBox] = useState(null);            // {x, y, w, h} in the viewport: the box being dragged out
  const [map, setMap] = useState(false);           // the overview is asked for, not there from the start
  const [tips, setTips] = useState(() => { try { return localStorage.getItem("voice-call-canvas-tips") !== "seen"; } catch { return false; } });
  const closeTips = () => { setTips(false); try { localStorage.setItem("voice-call-canvas-tips", "seen"); } catch { /* optional */ } };
  const press = useRef(null);                      // the press that may turn into a drag or a pan
  const latest = useRef({});
  const seen = useRef(null);                       // the steps on the canvas last time: what was removed shows by what is missing
  const glided = useRef(0);

  // The nodes as drawn: the one being dragged is where the pointer has it.
  // The others picked with it go along by the same amount.
  const shown = useMemo(() => (drag ? nodes.map((node) => {
    if (node.id === drag.id) return { ...node, x: drag.x, y: drag.y };
    return drag.ids?.includes(node.id) ? { ...node, x: node.x + drag.dx, y: node.y + drag.dy } : node;
  }) : nodes), [nodes, drag]);
  const connectors = useMemo(() => connectorsOf(shown), [shown]);
  // While the call opens, each line draws on just after the step before it lands, then its plus pops in: left to right, quickly.
  const lineDelay = (at) => 0.3 + 0.05 * Math.min(at, 8) + 0.06;
  const timed = (at, extra = 0) => (intro ? { animationDelay: `${(lineDelay(at) + extra).toFixed(2)}s` } : undefined);
  // After the opening: whatever is added (a step, an "only if" arch, a go-back) comes in just after the step it belongs to.
  const lag = (at, extra = 0) => (intro ? timed(at, extra) : { animationDelay: `${(0.12 + extra).toFixed(2)}s` });
  const joins = useMemo(() => joinsOf(shown), [shown]);
  // A line has room for the AI's dot and the plus side by side when it is long enough.
  /** The AI button and the plus share the middle of a line, side by side along it with a gap between them. */
  const pairOn = (connector) => {
    const dx = connector.points[3].x - connector.points[0].x;
    const dy = connector.points[3].y - connector.points[0].y;
    const length = Math.hypot(dx, dy) || 1;
    const start = connector.points[0];
    // Four equal gaps: step, AI button (36), plus (24), next step.
    const gap = Math.max(10, (length - 36 - 24) / 3);
    const along = (by) => ({ x: start.x + (dx / length) * by, y: start.y + (dy / length) * by });
    return { ai: along(gap + 18), plus: along(gap * 2 + 36 + 12) };
  };
  const returns = useMemo(() => returnsOf(shown), [shown]);
  const bounds = useMemo(() => boundsOf(shown, [...joins, ...returns]), [shown, joins, returns]);

  // The AI's ideas button waits until the card has come to rest, then fades in slowly.
  const [aiShown, setAiShown] = useState(!intro);
  useEffect(() => {
    if (!intro) return;
    const done = setTimeout(() => setIntro(false), 900);
    const ai = setTimeout(() => setAiShown(true), 550);
    return () => { clearTimeout(done); clearTimeout(ai); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const size = () => {
    const box = viewport.current?.getBoundingClientRect();
    return { width: box?.width || 800, height: box?.height || 500 };
  };

  /** A client position as a place on the canvas. */
  const toWorld = useCallback((clientX, clientY) => {
    const box = viewport.current.getBoundingClientRect();
    return { x: (clientX - box.left - view.tx) / view.z, y: (clientY - box.top - view.ty) / view.z };
  }, [view]);

  const resolve = useCallback((clientX, clientY, skip = "") => {
    const box = viewport.current?.getBoundingClientRect();
    if (!box) return { inside: false, world: { x: 0, y: 0 }, hit: null };
    const inside = clientX >= box.left && clientX <= box.right && clientY >= box.top && clientY <= box.bottom;
    const world = toWorld(clientX, clientY);
    return { inside, world, hit: inside ? hitTest(world, shown, connectors, { reach: 34 / view.z, skip }) : null };
  }, [toWorld, shown, connectors, view.z]);

  // ── the view ───────────────────────────────────────────────────────────────
  /**
   * Everything in view. `minZoom` stops a long call being shrunk past reading: it is then lined up at its
   * start instead, to be moved along.
   */
  const fit = useCallback(({ minZoom = MIN_ZOOM } = {}) => {
    const { width, height } = size();
    const wanted = Math.min(1, (width - 140) / bounds.width, (height - 140) / bounds.height);
    const z = clamp(Math.max(wanted, minZoom), MIN_ZOOM, 1);
    const tx = bounds.width * z + 120 <= width ? (width - bounds.width * z) / 2 - bounds.left * z : 72 - bounds.left * z;
    setView({ z, tx, ty: Math.max(64, (height - bounds.height * z) / 2) - bounds.top * z });
  }, [bounds]);

  const zoomTo = useCallback((next, around) => {
    setView((now) => {
      const z = clamp(next, MIN_ZOOM, MAX_ZOOM);
      const box = size();
      const px = around?.x ?? box.width / 2, py = around?.y ?? box.height / 2;
      return { z, tx: px - ((px - now.tx) / now.z) * z, ty: py - ((py - now.ty) / now.z) * z };
    });
  }, []);

  /** Moves the view just far enough that a step is fully on screen, clear of the edges and of the bar along the bottom. */
  const reveal = useCallback((node) => {
    const { width, height } = size();
    setView((now) => {
      // Room kept clear: the step before it still shows on the left, the line and plus after it on the right.
      const left = Math.min(140, width * 0.15), right = Math.max(width - 220, left + node.w * now.z + 40), top = 72, bottom = height - 150;
      const x0 = node.x * now.z + now.tx, x1 = (node.x + node.w) * now.z + now.tx;
      const y0 = node.y * now.z + now.ty, y1 = (node.y + NODE_H) * now.z + now.ty;
      let { tx, ty } = now;
      if (x0 < left) tx += left - x0;
      else if (x1 > right) tx -= Math.min(x1 - right, x0 - left);
      if (y0 < top) ty += top - y0;
      else if (y1 > bottom) ty -= Math.min(y1 - bottom, y0 - top);
      if (tx === now.tx && ty === now.ty) return now;
      return { ...now, tx, ty };
    });
    setGlide(true);
    clearTimeout(glided.current);
    glided.current = setTimeout(() => setGlide(false), 380);
  }, []);

  latest.current = { view, zoomTo, fit };
  useImperativeHandle(ref, () => ({
    hit: resolve,
    fit: () => fit(),
    zoomBy: (direction) => zoomTo(stepZoom(view.z, direction)),
    zoom: view.z,
    // The canvas next to it was made `dx` px narrower (or wider): the flow stays centred in what is left, like a split screen.
    slide: (dx) => setView((now) => ({ ...now, tx: now.tx - dx / 2 })),
    focus: (id) => {
      const node = shown.find((one) => one.id === id || one.tiles.some((tile) => tile.id === id));
      if (node) reveal(node);
    },
  }), [resolve, fit, zoomTo, reveal, view.z, shown]);

  // A step that was just added, or the one a removed step leaves beside it, is brought into view: the view moves
  // only as far as it must, and not at all when the step is already in sight.
  useEffect(() => {
    const ids = nodes.map((node) => node.id);
    const before = seen.current;
    seen.current = ids;
    if (!before) return;
    const gone = before.findIndex((id) => !ids.includes(id));
    if (gone < 0) return;
    const beside = [...before.slice(0, gone)].reverse().find((id) => ids.includes(id)) ?? before.slice(gone).find((id) => ids.includes(id));
    const node = nodes.find((one) => one.id === beside);
    if (node) reveal(node);
  }, [nodes, reveal]);

  // Fitted once, when the canvas first has a size; after that the view is the person's.
  const fitted = useRef(false);
  useLayoutEffect(() => {
    if (fitted.current || !viewport.current) return;
    fitted.current = true;
    latest.current.fit({ minZoom: 0.55 });
  }, []);

  // Scroll moves the view, Ctrl+scroll (and a pinch on a trackpad) zooms where the pointer is.
  useEffect(() => {
    const node = viewport.current;
    const wheel = (event) => {
      event.preventDefault();
      const { view: now, zoomTo: zoom } = latest.current;
      if (event.ctrlKey || event.metaKey) {
        const box = node.getBoundingClientRect();
        const around = { x: event.clientX - box.left, y: event.clientY - box.top };
        // A mouse wheel clicks in whole notches: each moves the zoom by 5%. A trackpad pinch sends many small
        // changes, which zoom smoothly.
        const notch = event.deltaMode !== 0 || Math.abs(event.deltaY) >= 40;
        if (notch) zoom(stepZoom(now.z, event.deltaY < 0 ? 1 : -1), around);
        else zoom(now.z * Math.exp(-event.deltaY * 0.01), around);
      } else {
        setView((current) => ({ ...current, tx: current.tx - (event.shiftKey ? event.deltaY : event.deltaX), ty: current.ty - (event.shiftKey ? 0 : event.deltaY) }));
      }
    };
    node.addEventListener("wheel", wheel, { passive: false });
    return () => node.removeEventListener("wheel", wheel);
  }, []);

  // Space held makes the pointer a hand, as in any drawing tool. Not while typing somewhere.
  useEffect(() => {
    const mine = (event) => event.code === "Space" && !event.target.closest?.("input, textarea, select, [contenteditable=true]")
      && !document.querySelector("[role=dialog]") && (event.target === document.body || viewport.current?.contains(event.target));
    const down = (event) => { if (mine(event)) { event.preventDefault(); setHandy(true); } };
    const up = (event) => { if (event.code === "Space") { if (mine(event)) event.preventDefault(); setHandy(false); } };
    const off = () => setHandy(false);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", off);
    return () => { window.removeEventListener("keydown", down); window.removeEventListener("keyup", up); window.removeEventListener("blur", off); };
  }, []);

  // ── pressing: a node to pick or drag, the background to pick with a box, the middle button to move about ──
  const overTrash = (clientX, clientY) => {
    const box = trashRef?.current?.getBoundingClientRect();
    return Boolean(box && clientX >= box.left && clientX <= box.right && clientY >= box.top && clientY <= box.bottom);
  };

  function pressNode(event, node, tile) {
    if (event.button !== 0 || handy) return;       // the middle button and the hand move the view: left to the background
    event.stopPropagation();
    press.current = {
      kind: "node", node, tile, start: { x: event.clientX, y: event.clientY }, origin: { x: node.x, y: node.y }, moved: false,
      add: event.shiftKey || event.ctrlKey || event.metaKey,
      ids: picked.length > 1 && picked.includes(node.id) ? picked : null,
    };
    attach();
  }

  function pressBackground(event) {
    const middle = event.button === 1;
    if (!middle && event.button !== 0) return;
    const start = { x: event.clientX, y: event.clientY };
    if (middle || handy) {
      event.preventDefault();
      press.current = { kind: "pan", start, origin: { tx: view.tx, ty: view.ty }, moved: false };
      setPanning(true);
    } else if (event.target === viewport.current || event.target.dataset.canvas) {
      press.current = { kind: "box", start, moved: false, add: event.shiftKey || event.ctrlKey || event.metaKey };
    } else return;
    attach();
  }

  // The window listeners are the same two functions for the life of the canvas, and look up the latest
  // handlers when they fire, so they can always be taken off again.
  const handlers = useRef({});
  const onMove = useCallback((event) => handlers.current.move(event), []);
  const onUp = useCallback((event) => handlers.current.release(event), []);
  function attach() {
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  }
  function detach() {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onUp);
  }

  function move(event) {
    const now = press.current;
    if (!now) return;
    const dx = event.clientX - now.start.x, dy = event.clientY - now.start.y;
    if (!now.moved && Math.hypot(dx, dy) < DRAG_FROM) return;
    if (now.kind === "node" && now.node.type === "context") return;    // this one stays first
    now.moved = true;
    const { view: current } = latest.current;
    if (now.kind === "pan") {
      setView({ ...current, tx: now.origin.tx + dx, ty: now.origin.ty + dy });
    } else if (now.kind === "box") {
      const edge = viewport.current.getBoundingClientRect();
      setBox({ x: Math.min(now.start.x, event.clientX) - edge.left, y: Math.min(now.start.y, event.clientY) - edge.top, w: Math.abs(dx), h: Math.abs(dy) });
    } else {
      setDrag({ id: now.node.id, x: now.origin.x + dx / current.z, y: now.origin.y + dy / current.z, dx: dx / current.z, dy: dy / current.z, ids: now.ids });
    }
  }

  function release(event) {
    const now = press.current;
    press.current = null;
    detach();
    setPanning(false);
    if (!now) return;
    if (now.kind === "pan") return;
    if (now.kind === "box") {
      setBox(null);
      // A click on nothing lets go of everything; a box picks what it touches (added to what is picked, with Shift).
      let ids = [];
      if (now.moved) {
        const a = toWorld(now.start.x, now.start.y), b = toWorld(event.clientX, event.clientY);
        const left = Math.min(a.x, b.x), right = Math.max(a.x, b.x), top = Math.min(a.y, b.y), bottom = Math.max(a.y, b.y);
        ids = nodes.filter((node) => node.x < right && node.x + node.w > left && node.y < bottom && node.y + TILE > top).map((node) => node.id);
      }
      if (now.add) ids = [...new Set([...picked, ...ids])];
      if (!now.add || now.moved) { onDeselect(); onPick?.(ids); }
      return;
    }
    const { node, tile } = now;
    if (!now.moved) {
      if (now.add) {
        // Shift or Ctrl+click: this one joins the picked ones, or leaves them.
        onDeselect();
        onPick?.(picked.includes(node.id) ? picked.filter((id) => id !== node.id) : [...picked, node.id]);
      } else onSelect(tile.id);
      return;
    }
    // Moved: it stays exactly where it was put. The ones picked with it go by the same amount.
    const { view: current } = latest.current;
    const by = { x: (event.clientX - now.start.x) / current.z, y: (event.clientY - now.start.y) / current.z };
    setDrag(null);
    if (now.ids) onPlaceMany?.(Object.fromEntries(nodes.filter((one) => now.ids.includes(one.id)).map((one) => [one.id, [one.x + by.x, one.y + by.y]])));
    else onPlace?.(node.id, now.origin.x + by.x, now.origin.y + by.y);
  }

  handlers.current = { move, release };
  useEffect(() => detach, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── what is lit up: under a block coming in from outside, or under a node being moved ──
  const target = useMemo(() => {
    if (probe) {
      const found = resolve(probe.x, probe.y);
      return found.inside ? (found.hit || { type: "canvas" }) : null;
    }
    return null;
  }, [probe, resolve]);

  // ── the overview ───────────────────────────────────────────────────────────
  const MAP_W = 188, MAP_H = 120;
  const mapScale = Math.min((MAP_W - 16) / Math.max(bounds.width, 1), (MAP_H - 16) / Math.max(bounds.height, 1));
  // Centred in the box, so a short call does not sit in its corner.
  const mapPad = { x: (MAP_W - bounds.width * mapScale) / 2, y: (MAP_H - bounds.height * mapScale) / 2 };
  const mapAt = (x, y) => ({ left: mapPad.x + (x - bounds.left) * mapScale, top: mapPad.y + (y - bounds.top) * mapScale });
  const { width: vw, height: vh } = viewport.current ? size() : { width: 0, height: 0 };

  function mapPress(event) {
    event.stopPropagation();
    const box = event.currentTarget.getBoundingClientRect();
    const x = (event.clientX - box.left - mapPad.x) / mapScale + bounds.left;
    const y = (event.clientY - box.top - mapPad.y) / mapScale + bounds.top;
    setView((now) => ({ ...now, tx: vw / 2 - x * now.z, ty: vh / 2 - y * now.z }));
  }

  return (
    <div ref={viewport} onPointerDown={pressBackground}
         onMouseDown={(event) => { if (event.button === 1) event.preventDefault(); }}
         onContextMenu={(event) => {
           event.preventDefault();
           if (event.target === viewport.current || event.target.dataset.canvas) onMenu?.({ x: event.clientX, y: event.clientY, world: toWorld(event.clientX, event.clientY) });
         }}
         style={{ backgroundPosition: `${view.tx}px ${view.ty}px`, backgroundSize: `${GRID * view.z}px ${GRID * view.z}px`,
                  transition: glide ? "background-position .35s cubic-bezier(.2,.8,.2,1)" : undefined }}
         className={cn("bg-dotted relative min-h-0 flex-1 touch-none overflow-hidden select-none",
                       drag || panning ? "cursor-grabbing" : handy ? "cursor-grab" : "cursor-default",
                       target?.type === "canvas" && "ring-2 ring-brand/35 ring-inset")}>
      {/* The surface: a soft wash of the brand colour in one corner and warm in the other, behind the dots. It stays put. */}
      <div aria-hidden="true" className="canvas-wash pointer-events-none absolute inset-0" />
      <div data-canvas="true" style={{ transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.z})`, transformOrigin: "0 0",
                                       transition: glide ? "transform .35s cubic-bezier(.2,.8,.2,1)" : undefined }}
           className="absolute top-0 left-0">
        <svg data-canvas="true" width="1" height="1" className="pointer-events-none absolute top-0 left-0 overflow-visible">
          <defs>
            <marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M1 1 L9 5 L1 9 z" fill="#b4b4be" />
            </marker>
            <marker id="arrow-hot" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M1 1 L9 5 L1 9 z" fill="#6e4cf5" />
            </marker>
            <marker id="arrow-loop" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M1 1 L9 5 L1 9 z" fill="#e2551f" />
            </marker>
            <marker id="arrow-join" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M1 1 L9 5 L1 9 z" fill="#0d9488" />
            </marker>
          </defs>
          {connectors.map((connector, at) => {
            const hot = target?.type === "connector" && target.connector.index === connector.index;
            return (
              <path key={`c-${connector.from}-${connector.to}`} d={connector.d} fill="none" strokeLinecap="round" pathLength="1" strokeDasharray="1"
                    stroke={hot ? "#6e4cf5" : "#c4c4cc"} strokeWidth={hot ? 4 : 2} style={lag(at)}
                    markerEnd={hot ? "url(#arrow-hot)" : "url(#arrow)"}
                    className={cn("transition-[stroke-width,stroke] motion-safe:animate-[line-draw_.22s_ease-out_both]", hot && "drop-shadow-[0_0_6px_rgb(110_76_245/0.55)]")} />
            );
          })}
          {joins.map((join) => (
            <g key={`j-${join.node.id}`} style={lag(shown.indexOf(join.node), 0.12)} className="motion-safe:animate-[reveal-x_.45s_ease-out_both]">
              <path d={join.d} fill="none" stroke="#0d9488" strokeWidth="2" strokeDasharray="6 5"
                    strokeLinecap="round" markerEnd="url(#arrow-join)" opacity="0.85" className="motion-safe:animate-[dash-run-if_.9s_linear_infinite]" />
            </g>
          ))}
          {returns.map((back) => (
            <g key={`r-${back.node.id}`} style={lag(shown.indexOf(back.node), 0.12)} className="motion-safe:animate-[reveal-x_.45s_ease-out_both]">
              <path d={back.d} fill="none" stroke="#e2551f" strokeWidth="2" strokeDasharray="2 6"
                    strokeLinecap="round" markerEnd="url(#arrow-loop)" opacity="0.9" className="motion-safe:animate-[dash-run-loop_.8s_linear_infinite]" />
            </g>
          ))}
        </svg>

        {returns.map((back) => (
          <span key={`rl-${back.node.id}`} style={{ left: back.label.x, top: back.label.y, ...lag(shown.indexOf(back.node), 0.4) }}
                className="motion-safe:animate-[tag-in_.25s_ease-out_both] pointer-events-none absolute z-[3] flex -translate-x-1/2 -translate-y-1/2 items-center gap-1 rounded-full bg-loop-soft px-2.5 py-[3px] text-[11px] font-semibold whitespace-nowrap text-loop-ink">
            <Repeat aria-hidden="true" className="size-3" strokeWidth={2.4} />
            asks again, up to {back.node.question.times || 2}×
          </span>
        ))}

        {joins.map((join) => (
          <span key={`jl-${join.node.id}`} style={{ left: join.label.x, top: join.label.y, ...lag(shown.indexOf(join.node), 0.4) }}
                className="motion-safe:animate-[tag-in_.25s_ease-out_both] pointer-events-none absolute z-[3] max-w-[240px] -translate-x-1/2 -translate-y-1/2 truncate rounded-full bg-human-soft px-2.5 py-[3px] text-[11px] font-semibold text-human">
            {join.node.kind === "end" ? "ends if" : join.node.kind === "loop" ? "goes back if" : "only if"} {humanize(join.node.question.only_if)}
            {join.node.question.only_if_is?.length ? ` is ${join.node.question.only_if_is.join(" or ")}` : ""}
          </span>
        ))}

        {connectors.filter((connector) => connector.tag).map((connector) => (
          <span key={`tag-${connector.from}-${connector.to}`} style={{ left: connector.samples[18].x, top: connector.samples[18].y, ...lag(1, 0.3) }}
                className="motion-safe:animate-[tag-in_.25s_ease-out_both] pointer-events-none absolute z-[3] max-w-[200px] -translate-x-1/2 -translate-y-1/2 truncate rounded-full border border-human/25 bg-white px-2.5 py-[3px] text-[11px] font-semibold text-human shadow-[0_1px_2px_rgb(17_17_20/0.08)]">
            {connector.tag}
          </span>
        ))}

        {target?.type === "connector" && (
          <span style={{ left: target.connector.middle.x, top: target.connector.middle.y }}
                className="pointer-events-none absolute z-[6] flex -translate-x-1/2 -translate-y-1/2 items-center gap-1.5 rounded-full bg-brand px-3 py-1.5 text-xs font-semibold whitespace-nowrap text-white shadow-[0_6px_18px_rgb(110_76_245/0.45)] motion-safe:animate-bounce">
            <Plus aria-hidden="true" className="size-3.5" strokeWidth={3} />Put it here
          </span>
        )}

        {/* Connectors can be clicked to add something on them */}
        {!drag && !probe && connectors.map((connector, at) => connector.branch || connector.from === "context" || shown.find((one) => one.id === connector.from)?.kind === "end" ? null : [connector, at]).filter(Boolean).map(([connector, at]) => {
          // On the line the AI's dot is on, the plus comes after it, further along.
          const after = connector.middle;
          return (
          <button key={`add-${connector.from}-${connector.to}`} type="button" aria-label="Add a step here" title="Add a step here"
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => { const box = event.currentTarget.getBoundingClientRect(); onInsertHere(connector.index, after, { x: box.right + 6, y: box.top }); }}
                  style={{ left: after.x, top: after.y, ...lag(at, 0.14) }}
                  className="motion-safe:animate-[plus-in_.2s_ease-out_both] absolute z-[4] grid size-7 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full border-[2.5px] border-white bg-brand text-white shadow-[0_3px_10px_rgb(110_76_245/0.45)] transition-transform hover:scale-115 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand">
            <Plus aria-hidden="true" className="size-3.5" strokeWidth={3.2} />
          </button>
          );
        })}

        {/* The line has no end yet when the last step is neither the close nor an end-the-call step: a plus carries it on */}
        {!drag && !probe && (() => {
          const last = shown[shown.length - 1];
          if (!last || last.type === "close" || last.kind === "end") return null;
          const y = last.y + TILE / 2;
          return (
            <>
              <span aria-hidden="true" style={{ left: last.x + last.w, top: y - 1, width: 52, transformOrigin: "left", ...timed(shown.length - 1) }}
                    className="pointer-events-none absolute z-[3] h-0 border-t-2 border-dashed border-[#c4c4cc] motion-safe:animate-[stub-draw_.22s_ease-out_both]" />
              <button type="button" aria-label="Add a step at the end" title="Add a step at the end"
                      onPointerDown={(event) => event.stopPropagation()}
                      onClick={(event) => { const box = event.currentTarget.getBoundingClientRect(); onInsertHere((last.index ?? -1) + 1, { x: last.x + last.w + 52, y }, { x: box.right + 6, y: box.top }); }}
                      style={{ left: last.x + last.w + 52, top: y, ...timed(shown.length - 1, 0.14) }}
                      className="motion-safe:animate-[plus-in_.2s_ease-out_both] absolute z-[4] grid size-7 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full border-[2.5px] border-white bg-brand text-white shadow-[0_3px_10px_rgb(110_76_245/0.45)] transition-transform hover:scale-115 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand">
                <Plus aria-hidden="true" className="size-3.5" strokeWidth={3.2} />
              </button>
            </>
          );
        })()}

        {/* The AI's own dot on the line leaving the step being worked on, just above the plus: press it for ideas */}
        {!drag && !probe && hintAt && (() => {
          const line = connectors.find((connector) => connector.from === hintAt);
          const node = shown.find((one) => one.id === hintAt);
          if (!node) return null;
          // Beside the step it follows, up at its top right with a gap: clear of the tile, the line and the plus.
          const at = { x: node.x + node.w + 16, y: node.y + 2 };
          return (
            <div style={{ left: at.x, top: at.y, opacity: aiShown ? 1 : 0, pointerEvents: aiShown ? undefined : "none", transition: "opacity .6s ease-out" }}
                 onPointerDown={(event) => event.stopPropagation()}
                 className="ai-glow absolute z-[5] flex h-8 -translate-y-1/2 items-center rounded-xl text-[12px] font-semibold whitespace-nowrap text-brand-ink">
              <button type="button" aria-label="Smart suggestions" title="Smart suggestions: get ideas for the next step" disabled={hintBusy}
                      onClick={(event) => { const box = event.currentTarget.getBoundingClientRect(); onHint?.({ x: box.left, y: box.bottom + 8, node }); }}
                      className="flex h-full items-center gap-1.5 rounded-xl pr-3 pl-2.5 transition-colors hover:bg-brand-wash disabled:hover:bg-transparent">
                <AiIcon spin={hintBusy} className="size-4 text-brand" />
                {hintBusy ? "Thinking…" : "Smart suggestions"}
              </button>
              {hintBusy && (
                <button type="button" onClick={onStop} aria-label="Stop thinking" title="Stop (Esc)"
                        className="mr-1 -ml-1 grid size-6 place-items-center rounded-full bg-brand-soft text-brand-ink hover:bg-[#e6dfff]">
                  <Square aria-hidden="true" className="size-2.5" fill="currentColor" strokeWidth={0} />
                </button>
              )}
            </div>
          );
        })()}

        {shown.map((node, order) => {
          const dragging = drag?.id === node.id || Boolean(drag?.ids?.includes(node.id));
          const lit = target?.type === "node" && target.node.id === node.id;
          return (
            <div key={node.id}
                 className={cn("group absolute", dragging ? "opacity-95 drop-shadow-[0_18px_28px_rgb(17_17_20/0.18)]" : intro && node.type === "context" ? "animate-[context-in_.5s_cubic-bezier(0.2,0.8,0.2,1)_both]" : node.type !== "context" && "motion-safe:animate-[node-in_.28s_ease-out]")}
                 style={{ left: node.x, top: node.y, width: node.w, height: NODE_H, zIndex: dragging ? 20 : 1,
                          // The rest follow once it has landed, one after another.
                          ...(intro && node.type !== "context" && !dragging ? { animationDelay: `${0.3 + 0.05 * Math.min(order, 8)}s`, animationFillMode: "both" } : {}) }}>
              {lit && <span className="pointer-events-none absolute -inset-3 rounded-[28px] border-2 border-dashed border-brand bg-brand/5" />}

              {node.kind === "ask" && <span className="absolute h-0.5 bg-[#c9c9d1]" style={{ left: TILE, top: TILE / 2 - 1, width: PAIR_GAP }} />}

              {node.tiles.map((tile) => {
                const detail = details[tile.id] || {};
                const kind = KINDS[kindOf(tile, node)];
                const Icon = kind.icon;
                const on = tile.id === selectedId || picked.includes(node.id);
                const hot = on || tile.id === activeId;
                return (
                  <div key={tile.id}>
                    <button type="button" aria-pressed={on} aria-label={`${detail.title}. ${detail.sub}`}
                            onPointerDown={(event) => pressNode(event, node, tile)}
                            onClick={(event) => { if (event.detail === 0) onSelect(tile.id); }}
                            onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); onMenu?.({ x: event.clientX, y: event.clientY, node, tile }); }}
                            style={{ left: tile.dx, top: 0, width: TILE, height: TILE }}
                            className={cn("absolute flex touch-none items-center justify-center border bg-linear-to-b from-white transition-[box-shadow,border-color,transform]",
                                          kind.wash, kind.round ? "rounded-full" : "rounded-[22px]",
                                          panning ? "cursor-grabbing" : handy ? "cursor-grab" : "cursor-pointer",
                                          on ? "border-brand ring-1 ring-brand" : cn(kind.edge, "hover:-translate-y-0.5 hover:shadow-[0_2px_4px_rgb(17_17_20/0.04),0_14px_28px_rgb(17_17_20/0.09)]"),
                                          hot ? "shadow-[0_0_0_6px_rgb(110_76_245/0.14),0_10px_24px_rgb(110_76_245/0.14)]" : "shadow-tile")}>
                      {detail.flag && (
                        <span title={detail.flag.note} className={cn("absolute top-2.5 right-2.5 size-2 rounded-full", detail.flag.ok ? "bg-live" : "bg-amber")} />
                      )}
                      <span className={cn("grid size-[52px] place-items-center", kind.round ? "rounded-full" : "rounded-2xl", kind.tile)}>
                        <Icon aria-hidden="true" className="size-[26px]" strokeWidth={2} />
                      </span>
                      {detail.number && (
                        <span title={`Step ${detail.number}: the order the call goes in`}
                              className="absolute -top-2.5 -left-2.5 grid size-6 place-items-center rounded-full bg-brand text-[11px] font-bold text-white ring-2 ring-white">
                          {detail.number}
                        </span>
                      )}
                      {tile.kind === "ask" && tries > 1 && on && (
                        <span title={`Asks again, up to ${tries} tries`}
                              className="absolute -right-2 -bottom-2 flex items-center gap-0.5 rounded-full bg-loop-soft px-1.5 py-0.5 text-[10px] font-bold text-loop-ink">
                          <RotateCcw aria-hidden="true" className="size-2.5" strokeWidth={2.6} />{tries}
                        </span>
                      )}
                    </button>
                    <div className="pointer-events-none absolute text-center" style={{ left: tile.dx - 22, top: TILE + 10, width: 140 }}>
                      <span className={cn("block truncate text-[13px] font-semibold tracking-[-0.005em]", on ? "text-brand" : "text-ink")}>{detail.title}</span>
                      <span className={cn("block truncate text-xs transition-opacity", detail.flag && !detail.flag.ok ? "font-medium text-warn" : cn("text-faint", !hot && "opacity-0 group-hover:opacity-100"))}>{detail.sub}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          );
        })}

        {empty && (
          <p className="pointer-events-none absolute w-[300px] text-[13px] leading-snug text-faint" style={{ left: SLOT, top: 120 + NODE_H + 30 }}>
            Right-click anywhere to add a step, or tell the AI below what the call should do.
          </p>
        )}
      </div>

      {box && (
        <span className="pointer-events-none absolute z-[30] rounded-md border-[1.5px] border-brand bg-brand/10"
              style={{ left: box.x, top: box.y, width: box.w, height: box.h }} />
      )}

      {/* Moving about */}
      <div className="absolute right-3 bottom-3 flex items-center gap-0.5 rounded-full border border-line bg-white p-0.5 shadow-card"
           onPointerDown={(event) => event.stopPropagation()}>
        <button type="button" aria-label="Zoom out" title="Zoom out" onClick={() => zoomTo(stepZoom(view.z, -1))} disabled={view.z <= MIN_ZOOM}
                className="grid size-8 place-items-center rounded-full text-muted hover:bg-fill hover:text-ink disabled:opacity-40">
          <Minus aria-hidden="true" className="size-4" strokeWidth={2.2} />
        </button>
        <span className="w-11 text-center font-mono text-xs text-muted tabular-nums">{Math.round(view.z * 100)}%</span>
        <button type="button" aria-label="Zoom in" title="Zoom in" onClick={() => zoomTo(stepZoom(view.z, 1))} disabled={view.z >= MAX_ZOOM}
                className="grid size-8 place-items-center rounded-full text-muted hover:bg-fill hover:text-ink disabled:opacity-40">
          <Plus aria-hidden="true" className="size-4" strokeWidth={2.2} />
        </button>
        <button type="button" aria-label="Fit the whole call on screen" title="Fit the whole call" onClick={() => fit()}
                className="grid size-8 place-items-center rounded-full text-muted hover:bg-fill hover:text-ink">
          <Maximize2 aria-hidden="true" className="size-4" strokeWidth={2} />
        </button>
        <button type="button" aria-label={map ? "Hide the overview" : "Show the overview"} aria-pressed={map} title="Overview"
                onClick={() => setMap(!map)}
                className={cn("grid size-8 place-items-center rounded-full hover:bg-fill hover:text-ink", map ? "bg-brand-soft text-brand" : "text-muted")}>
          <MapIcon aria-hidden="true" className="size-4" strokeWidth={2} />
        </button>
      </div>

      {tips && !map && (
        <div className="absolute top-14 left-3 w-[250px] rounded-2xl border border-line bg-white/95 p-3.5 shadow-card backdrop-blur-sm"
             onPointerDown={(event) => event.stopPropagation()}>
          <p className="text-[13px] font-semibold text-ink">Getting around</p>
          <ul className="mt-1.5 space-y-1 text-xs leading-snug text-muted">
            <li><b className="font-semibold text-body">Right-click</b> a step or the canvas to add, change or delete.</li>
            <li><b className="font-semibold text-body">Click</b> a step to edit it; drag it to move it anywhere.</li>
            <li><b className="font-semibold text-body">Drag on empty space</b> to select several, then press Delete.</li>
            <li><b className="font-semibold text-body">Middle mouse button</b> (or Space) and drag to move the view.</li>
          </ul>
          <button type="button" onClick={closeTips} className="mt-2.5 text-xs font-semibold text-brand hover:underline">Got it</button>
        </div>
      )}

      {map && (
        <div role="img" aria-label="Overview of the whole call" onPointerDown={mapPress}
             style={{ width: MAP_W, height: MAP_H }}
             className="absolute bottom-3 left-3 cursor-pointer overflow-hidden rounded-2xl border border-line bg-white/90 shadow-card backdrop-blur-sm">
          {shown.map((node) => {
            const where = mapAt(node.x, node.y);
            return (
              <span key={node.id} className={cn("absolute rounded-[3px]", node.type === "context" ? "bg-why/55" : node.type === "open" ? "bg-good/85" : node.type === "close" ? "bg-bad/85" : node.kind === "end" ? "bg-bad/85" : node.kind === "loop" ? "bg-loop/50" : node.kind === "say" ? "bg-[#0891b2]/50" : "bg-brand/40")}
                    style={{ left: where.left, top: where.top, width: Math.max(4, node.w * mapScale), height: Math.max(4, TILE * mapScale) }} />
            );
          })}
          <span className="pointer-events-none absolute rounded-[4px] border-[1.5px] border-brand bg-brand/[0.06]"
                style={{ ...mapAt((-view.tx) / view.z, (-view.ty) / view.z), width: Math.min(MAP_W, (vw / view.z) * mapScale), height: Math.min(MAP_H, (vh / view.z) * mapScale) }} />
        </div>
      )}
    </div>
  );
});
