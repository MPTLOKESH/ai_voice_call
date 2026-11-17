/* Where things sit on the studio canvas, with no UI in it.
 *
 * The call goes in the order of the list of questions; the canvas is only where each step is drawn. A "node"
 * is one thing to move: the greeting, the close, a message or an end (one tile each), or a question (two
 * tiles, the assistant asking and the customer answering, kept together). Nodes are drawn in call order and
 * joined by connectors, wherever they have been put. A node with no place of its own sits where the
 * horizontal layout would put it.
 */
import { CLOSE, CONTEXT, OPEN, SLOT, TILE, answerId, askId } from "./thread.js";

export const LABEL_H = 54;                // room under a tile for its name and its line of detail
export const NODE_H = TILE + LABEL_H;
export const ROW_H = NODE_H + 300;         // from one row of steps to the next: room for the arches and loops between them
export const ROW_Y = 120;                 // where the default horizontal line runs
const ROW_MAX = 1800;                      // how wide a row of steps gets before the call carries on below
export const PAIR_GAP = 84;                // the short line between a question and its answer
export const PAIR_W = TILE * 2 + PAIR_GAP; // a question: two tiles, side by side

const kindOf = (question) => question.kind || "ask";

/**
 * Every node in call order, each with its place, size and tiles.
 *   id      "open", "close", or the question's key
 *   tiles   what can be selected in it: [{id, kind, dx}], dx being how far along the node the tile is
 * `openAt` or `closeAt` given as null leaves that one out: it has been taken off the canvas.
 */
export const BRANCH_DY = NODE_H + 64;      // from one way through the call to the next, where it splits (if / else)
const answersOf = (question) => (question.only_if_is || []).map((one) => String(one).trim().toLowerCase()).filter(Boolean);

export function layoutNodes(questions, openAt = [], closeAt = []) {
  // By default the call is one straight line, step after step. A step the person has moved keeps the place
  // they gave it; nothing is moved for them, and steps that were not moved stay on the line in their order.
  // Where the call splits (steps that each wait on a different answer to the same question: an if and its else)
  // the ways run side by side, one below the other, and come together again at the next step.
  const nodes = [];
  let next = { x: 0, y: ROW_Y };            // where a step that was not placed goes: straight on from the one before it
  const put = (node, spot) => {
    const at = spot?.length === 2 ? { x: spot[0], y: spot[1] } : next;
    const placed = { ...node, x: at.x, y: at.y, row: 0 };
    nodes.push(placed);
    next = { x: at.x + node.w + (SLOT - TILE), y: at.y };
    return placed;
  };
  let open = null;                          // the ways the call is splitting into right now: {on, answers, members, x, y, right}
  put({ id: CONTEXT, type: "context", w: TILE, tiles: [{ id: CONTEXT, kind: "context", dx: 0 }] }, null);
  if (openAt !== null) put({ id: OPEN, type: "open", w: TILE, tiles: [{ id: OPEN, kind: "open", dx: 0 }] }, openAt);
  questions.forEach((question, index) => {
    const kind = kindOf(question);
    const spot = question.x != null && question.y != null ? [question.x, question.y] : null;
    const answers = answersOf(question);
    const another = !spot && open && question.only_if === open.on && answers.length && answers.every((one) => !open.answers.has(one));
    if (another) {
      // Another way through: below the ones already there, in the same column.
      const lane = open.members.length;
      const wide = kind === "ask" ? PAIR_W : TILE;
      const node = { id: question._key, type: "question", kind, question, index, w: wide, x: open.x, y: open.y + lane * BRANCH_DY, row: 0, group: open.members[0].id, lane,
                     tiles: kind === "ask" ? [{ id: askId(question), kind: "ask", dx: 0 }, { id: answerId(question), kind: "answer", dx: TILE + PAIR_GAP }] : [{ id: askId(question), kind, dx: 0 }] };
      nodes.push(node);
      open.members.forEach((member) => { member.group = open.members[0].id; });
      open.members[0].lane = 0;
      open.members.push(node);
      answers.forEach((one) => open.answers.add(one));
      open.right = Math.max(open.right, open.x + wide);
      next = { x: open.right + (SLOT - TILE), y: open.y };
      return;
    }
    const node = kind === "ask"
      ? put({ id: question._key, type: "question", kind, question, index, w: PAIR_W,
              tiles: [{ id: askId(question), kind: "ask", dx: 0 }, { id: answerId(question), kind: "answer", dx: TILE + PAIR_GAP }] }, spot)
      : put({ id: question._key, type: "question", kind, question, index, w: TILE, tiles: [{ id: askId(question), kind, dx: 0 }] }, spot);
    open = !spot && question.only_if && answers.length
      ? { on: question.only_if, answers: new Set(answers), members: [node], x: node.x, y: node.y, right: node.x + node.w }
      : null;
  });
  if (closeAt !== null) put({ id: CLOSE, type: "close", w: TILE, tiles: [{ id: CLOSE, kind: "close", dx: 0 }] }, closeAt);
  return nodes;
}

// ── connectors ──────────────────────────────────────────────────────────────

const out = (node) => ({ x: node.x + node.w, y: node.y + TILE / 2 });
const into = (node) => ({ x: node.x, y: node.y + TILE / 2 });

/**
 * The curve from one node to the next, as control points. Side to side it leaves the right edge and enters
 * the left; when the next node is well below, it leaves under the name and enters from the top, so a column
 * of nodes reads as a column rather than a row of loops.
 */
function curve(a, b) {
  const lastTile = a.x + a.w - TILE / 2;
  const firstTile = b.x + TILE / 2;
  const down = b.y - (a.y + NODE_H);
  if (down > 24 && Math.abs(firstTile - lastTile) < down * 1.2) {
    const from = { x: lastTile, y: a.y + NODE_H - 6 };
    const to = { x: firstTile, y: b.y - 4 };
    const reach = Math.max(36, Math.min(140, (to.y - from.y) / 2));
    return [from, { x: from.x, y: from.y + reach }, { x: to.x, y: to.y - reach }, to];
  }
  const from = out(a), to = into(b);
  const reach = Math.max(48, Math.min(180, Math.abs(to.x - from.x) / 2));
  return [from, { x: from.x + reach, y: from.y }, { x: to.x - reach, y: to.y }, to];
}

const at = (curvePoints, t) => {
  const [a, b, c, d] = curvePoints;
  const u = 1 - t;
  return {
    x: u * u * u * a.x + 3 * u * u * t * b.x + 3 * u * t * t * c.x + t * t * t * d.x,
    y: u * u * u * a.y + 3 * u * u * t * b.y + 3 * u * t * t * c.y + t * t * t * d.y,
  };
};

export const pathOf = (points) => `M${points[0].x} ${points[0].y} C${points[1].x} ${points[1].y} ${points[2].x} ${points[2].y} ${points[3].x} ${points[3].y}`;

/**
 * The connectors between consecutive nodes. Connector `i` is the place a question can be put to become
 * question `i`: between the node before it and the node after.
 */
export function connectorsOf(nodes) {
  const found = [];
  const make = (a, b, extra = {}) => {
    const points = curve(a, b);
    found.push({
      // Where a step put on it lands in the call: before the step it leads to, or after the one it leaves.
      index: b.type === "question" ? b.index : (a.index ?? -1) + 1, from: a.id, to: b.id, points, d: pathOf(points),
      samples: Array.from({ length: 25 }, (_, step) => at(points, step / 24)),
      middle: at(points, 0.5), ...extra,
    });
  };
  for (let i = 0; i < nodes.length - 1; i++) {
    const a = nodes[i], b = nodes[i + 1];
    if (b.group && b.lane > 0) continue;                   // another way through is reached from where the call split, not from the one before it
    make(a, b, b.group ? { tag: branchTag(b) } : {});
  }
  // Where the call splits: a line to each other way, and from each of the ways back to the step after them.
  const ways = {};
  nodes.forEach((node, at) => { if (node.group) (ways[node.group] ||= []).push(at); });
  for (const members of Object.values(ways)) {
    const before = nodes[members[0] - 1], after = nodes[members[members.length - 1] + 1];
    members.slice(1).forEach((at) => before && make(before, nodes[at], { branch: true, tag: branchTag(nodes[at]) }));
    if (after) members.slice(0, -1).forEach((at) => make(nodes[at], after, { branch: true }));
  }
  return found;
}

/** What a line into one of the ways says: the first is the "if", the others are the "else". */
function branchTag(node) {
  const answers = (node.question.only_if_is || []).join(" or ");
  return node.lane > 0 ? `else · ${answers}` : `if ${answers}`;
}

/** A step that waits on an earlier answer, joined to the question it waits on by an arch above them. */
export function joinsOf(nodes) {
  const found = [];
  for (const node of nodes) {
    const want = node.question?.only_if;
    if (!want || node.group) continue;
    const parent = nodes.find((other) => other.kind === "ask" && other.index < node.index && other.question.save_as === want);
    if (!parent) continue;
    const from = { x: parent.x + TILE / 2 + 8, y: parent.y };
    const to = { x: node.x + TILE / 2 - 8, y: node.y };
    const span = Math.hypot(to.x - from.x, to.y - from.y);
    const rise = Math.max(54, Math.min(170, 44 + span * 0.14));
    const top = Math.min(from.y, to.y) - rise;
    const points = [from, { x: from.x, y: top }, { x: to.x, y: top }, to];
    found.push({ node, parent, points, d: pathOf(points), label: at(points, 0.5), to });
  }
  return found;
}

/** A go-back step, joined to the question it goes back to by a curve that dips under them both. */
export function returnsOf(nodes) {
  const found = [];
  for (const node of nodes) {
    if (node.kind !== "loop" || !node.question.back_to) continue;
    const target = nodes.find((other) => other.kind === "ask" && other.index < node.index && other.question.save_as === node.question.back_to);
    if (!target) continue;
    const from = { x: node.x + TILE / 2, y: node.y + NODE_H - 4 };
    const to = { x: target.x + TILE / 2, y: target.y + NODE_H - 4 };
    const span = Math.hypot(to.x - from.x, to.y - from.y);
    const dip = Math.max(from.y, to.y) + Math.max(50, Math.min(150, 36 + span * 0.12));
    const points = [from, { x: from.x, y: dip }, { x: to.x, y: dip }, to];
    found.push({ node, target, points, d: pathOf(points), label: at(points, 0.5) });
  }
  return found;
}

// ── where a point is ────────────────────────────────────────────────────────

const near = (point, a, b) => {
  const dx = b.x - a.x, dy = b.y - a.y;
  const along = dx || dy ? Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / (dx * dx + dy * dy))) : 0;
  return Math.hypot(point.x - (a.x + dx * along), point.y - (a.y + dy * along));
};

/**
 * What is under a point of the canvas: a node (its tiles and the name under them), else the nearest
 * connector within `reach`, else nothing. `skip` is a node to look past: the one being dragged.
 */
export function hitTest(point, nodes, connectors, { reach = 30, skip = "" } = {}) {
  for (let i = nodes.length - 1; i >= 0; i--) {
    const node = nodes[i];
    if (node.id === skip) continue;
    if (point.x >= node.x - 8 && point.x <= node.x + node.w + 8 && point.y >= node.y - 8 && point.y <= node.y + NODE_H) {
      return { type: "node", node };
    }
  }
  let best = null;
  for (const connector of connectors) {
    if (connector.from === skip || connector.to === skip) continue;
    for (let i = 0; i < connector.samples.length - 1; i++) {
      const gap = near(point, connector.samples[i], connector.samples[i + 1]);
      if (gap <= reach && (!best || gap < best.gap)) best = { type: "connector", connector, gap };
    }
  }
  return best;
}

/** The box round everything, for fitting it to the screen and for the overview. */
export function boundsOf(nodes, joins = []) {
  if (!nodes.length) return { left: 0, top: ROW_Y - 28, right: 600, bottom: ROW_Y + NODE_H, width: 600, height: NODE_H + 28 };
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (const node of nodes) {
    // The call-start bubble hangs off the greeting's left.
    left = Math.min(left, node.x);
    top = Math.min(top, node.y);
    right = Math.max(right, node.x + node.w + (node.type === "close" ? 0 : 0));
    bottom = Math.max(bottom, node.y + NODE_H);
  }
  for (const join of joins) {
    top = Math.min(top, ...join.points.map((point) => point.y));
    bottom = Math.max(bottom, ...join.points.map((point) => point.y));
  }
  return { left, top: top - 28, right, bottom, width: right - left, height: bottom - top + 28 };
}

// ── keeping things apart ────────────────────────────────────────────────────

const GAP_X = 44, GAP_Y = 24;             // the room a node put somewhere new keeps round itself
const STEP = 26;                          // how finely a free place is looked for

// The room a node takes, its name included; the call-start bubble hangs off the greeting's left.
const boxOf = (node, x = node.x, y = node.y) => ({ left: x - (node.type === "open" ? 190 : 0), right: x + node.w, top: y, bottom: y + NODE_H });
const clash = (a, b, gapX, gapY) => a.left < b.right + gapX && a.right + gapX > b.left && a.top < b.bottom + gapY && a.bottom + gapY > b.top;

/** The free place nearest to where a node is, leaning towards below it rather than above. */
function freeSpot(node, kept) {
  let best = null;
  for (let ring = 1; ring <= 90 && !best; ring++) {
    for (let i = -ring; i <= ring; i++) {
      for (const [dx, dy] of [[i, ring], [i, -ring], [ring, i], [-ring, i]]) {
        const x = node.x + dx * STEP, y = node.y + dy * STEP;
        const box = boxOf(node, x, y);
        if (kept.some((other) => clash(box, other, GAP_X, GAP_Y))) continue;
        const cost = Math.hypot(dx, dy * (dy > 0 ? 0.9 : 1.15));
        if (!best || cost < best.cost) best = { x, y, cost };
      }
    }
  }
  return best || { x: node.x, y: node.y + 91 * STEP };
}

/**
 * New places for the nodes that sit on top of another, as {id: [x, y]}; empty when nothing does. The ones
 * in `last` (just added, or just moved) are the ones to give way: everything else stays where it is unless
 * two of them are truly on top of each other.
 */
export function unclash(questions, openAt, closeAt, last = []) {
  const nodes = layoutNodes(questions, openAt, closeAt);
  const order = [...nodes.filter((node) => !last.includes(node.id)), ...nodes.filter((node) => last.includes(node.id))];
  const kept = [], moved = {};
  for (const node of order) {
    let box = boxOf(node);
    const fresh = last.includes(node.id);
    if (kept.some((other) => clash(box, other, fresh ? GAP_X - 1 : 4, fresh ? GAP_Y - 1 : 0))) {
      const spot = freeSpot(node, kept);
      moved[node.id] = [Math.round(spot.x), Math.round(spot.y)];
      box = boxOf(node, spot.x, spot.y);
    }
    kept.push(box);
  }
  return moved;
}

export const ROW_GAP = SLOT - TILE;      // the line between two steps side by side

/**
 * Room for a node among ones that were put where they are by hand: when it sits on top of something, the
 * steps that come after it in the call and share its row all move along by the same amount, so the row
 * opens up for it rather than the new step being pushed off the line. Returns {id: [x, y]}.
 */
export function makeRoom(questions, openAt, closeAt, id) {
  const nodes = layoutNodes(questions, openAt, closeAt);
  const at = nodes.findIndex((node) => node.id === id);
  if (at < 0) return {};
  const me = nodes[at];
  const box = boxOf(me);
  if (!nodes.some((other) => other !== me && clash(box, boxOf(other), ROW_GAP - 1, 0))) return {};
  const row = nodes.slice(at + 1).filter((other) => Math.abs(other.y - me.y) < NODE_H * 0.6 && other.x + other.w > me.x);
  if (!row.length) return {};
  const by = me.x + me.w + ROW_GAP - Math.min(...row.map((other) => other.x - (other.type === "open" ? 190 : 0)));
  return by > 0 ? Object.fromEntries(row.map((other) => [other.id, [Math.round(other.x + by), other.y]])) : {};
}

/**
 * How the canvas is laid out: "horizontal" (nothing has a place of its own: one line), "vertical" or "snake"
 * (exactly what Tidy made), or "free" (someone has put things where they want them).
 */
export function layoutMode(questions, openAt = [], closeAt = []) {
  const placed = questions.some((one) => one.x != null && one.y != null) || openAt?.length === 2 || closeAt?.length === 2;
  if (!placed) return "horizontal";
  const same = (a, b) => a?.length === 2 && a[0] === b[0] && a[1] === b[1];
  for (const mode of ["vertical", "snake"]) {
    const found = tidy(questions, mode);
    if ((openAt === null || same(openAt, found.open)) && (closeAt === null || same(closeAt, found.close)) && questions.every((one) => same([one.x, one.y], found.spots[one._key]))) return mode;
  }
  return "free";
}

// ── tidying ─────────────────────────────────────────────────────────────────

export const TIDY = {
  horizontal: { label: "Horizontal", hint: "One line, left to right" },
  vertical: { label: "Vertical", hint: "Top to bottom" },
  snake: { label: "Wrapped", hint: "Rows of four, like a page" },
};

/**
 * New places for every node. `null` is "clear them": back to the default horizontal line.
 * Returns {open, close, spots: {key: [x, y]}}.
 */
export function tidy(questions, mode) {
  if (mode === "horizontal") return null;
  const nodes = layoutNodes(questions.map((one) => ({ ...one, x: null, y: null })));
  const pitchY = NODE_H + 70;
  const place = (index) => {
    if (mode === "vertical") return [0, ROW_Y + index * pitchY];
    const perRow = 4, pitchX = PAIR_W + 110;
    return [(index % perRow) * pitchX, ROW_Y + Math.floor(index / perRow) * pitchY];
  };
  const spots = {};
  nodes.forEach((node, index) => {
    if (node.type === "question") spots[node.id] = place(index);
  });
  return { open: place(0), close: place(nodes.length - 1), spots };
}
