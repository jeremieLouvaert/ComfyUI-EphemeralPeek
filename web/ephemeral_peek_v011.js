// ComfyUI-EphemeralPeek -- alt-click any output socket for a floating, ephemeral
// preview. No node is ever added to the saved graph: a temporary preview node is
// injected into a one-off /prompt submission (partial_execution_targets), so a
// cache-hit ancestor peeks in tens of ms and a cold one honestly computes first.
//
// The mechanisms below are validated by web/spike.js (banked at
// _ephemeral_peek_spike/) and MUST be kept exactly as proven:
//   - window-capture pointerdown interception, filtered on e.target === canvasEl
//   - the gesture-swallow (pointerup/click/mousedown/mouseup at window-capture,
//     within a short window after we intercept) -- without it Alt-clone fires on
//     the up-side of the same gesture
//   - geometric socket hit-test via node.getConnectionPos(false, i) with a ~14
//     canvas-unit radius (isOverNodeOutput/getSlotInPosition do not exist on
//     this frontend's canvas instance)
//   - ds.convertCanvasToOffset coordinate conversion, with a manual fallback
//   - graphToPrompt -> structuredClone -> inject node id "akurate_peek" ->
//     POST /prompt with partial_execution_targets + client_id
//   - executed / execution_cached / executing websocket event handling
//   - /view?...&type=temp&preview=webp;90 for the thumbnail fetch
//
// Proven on the classic LiteGraph renderer. Vue/Nodes 2.0 is untested, same
// forward-compat posture as ComfyUI-ReferenceCopy.

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const PEEK_ID = "akurate_peek";
const SETTING_ID = "AKURATE.EphemeralPeek.Modifier";
const HIT_RADIUS = 14; // canvas units around a socket dot
const SWALLOW_MS = 500; // gesture-swallow window after we intercept a pointerdown
const GESTURE_EVENTS = ["pointerup", "click", "mouseup", "mousedown"];

// Flip to true only while diagnosing -- the product ships quiet.
const DEBUG = false;
function log(...args) { if (DEBUG) console.log("[EphemeralPeek]", ...args); }

let modifierSetting = "Alt"; // "Alt" | "Shift+Alt" -- kept in sync with the setting
let peekSeq = 0;
let currentPeek = null; // the one in-flight/shown peek; a new click supersedes it
let overlayEl = null;

function modifierMatches(e) {
  if (e.button !== 0 || e.metaKey) return false;
  if (modifierSetting === "Shift+Alt") return e.altKey && e.shiftKey && !e.ctrlKey;
  return e.altKey && !e.ctrlKey && !e.shiftKey;
}

// The server validates EVERY node in a submitted prompt, so an incomplete
// node anywhere in the graph (dangling required input on some work-in-progress
// branch) would reject the whole peek even when it is nowhere near the peeked
// socket (found live 2026-07-18: an unconnected DarkroomSpectralBW killed a
// peek of an unrelated branch). Submit ONLY the ancestors of the peeked node.
function pruneToAncestors(promptDict, rootId) {
  const keep = new Set();
  const stack = [String(rootId)];
  while (stack.length) {
    const id = stack.pop();
    if (keep.has(id)) continue;
    const n = promptDict[id];
    if (!n) continue;
    keep.add(id);
    for (const v of Object.values(n.inputs ?? {})) {
      if (Array.isArray(v) && v.length === 2 && typeof v[1] === "number") {
        stack.push(String(v[0])); // [source_node_id, slot] link
      }
    }
  }
  const pruned = {};
  for (const id of keep) pruned[id] = promptDict[id];
  return pruned;
}

// --- per-type injection recipe (verified server mechanism, do not change) ---
function pickPreviewNode(slotType, sourceId, slot) {
  if (slotType === "IMAGE") return { class_type: "PreviewImage", inputs: { images: [String(sourceId), slot] } };
  if (slotType === "MASK") return { class_type: "MaskPreview", inputs: { mask: [String(sourceId), slot] } };
  if (slotType === "LATENT") return null; // gated in v1 -- needs a VAE decode
  return { class_type: "PreviewAny", inputs: { source: [String(sourceId), slot] } };
}

function resolveNodeTitle(id) {
  if (id == null) return null;
  const graph = app.graph;
  if (!graph) return null;
  if (typeof graph.getNodeById === "function") {
    const n = graph.getNodeById(id) ?? graph.getNodeById(String(id));
    if (n) return n.title || n.type;
  }
  const found = (graph._nodes ?? []).find((n) => String(n.id) === String(id));
  return found?.title || found?.type || null;
}

function imageUrl(im) {
  return api.apiURL(
    `/view?filename=${encodeURIComponent(im.filename)}&subfolder=${encodeURIComponent(im.subfolder ?? "")}&type=${im.type}&preview=webp;90`
  );
}

// --- overlay: created once per peek, then updated in place as state changes ---

function isCurrent(p) {
  return !!(p && !p.dismissed && currentPeek && p.seq === currentPeek.seq && overlayEl);
}

function positionOverlay(box, clientX, clientY) {
  box.style.left = Math.min(clientX + 12, window.innerWidth - 360) + "px";
  box.style.top = Math.min(clientY + 12, window.innerHeight - 340) + "px";
}

function dismiss() {
  if (overlayEl) { overlayEl.remove(); overlayEl = null; }
  if (currentPeek) currentPeek.dismissed = true;
}

function createOverlay(p) {
  const box = document.createElement("div");
  box.style.cssText =
    "position:fixed;z-index:10000;background:#1e1e1e;border:1px solid #555;" +
    "border-radius:6px;padding:8px;box-shadow:0 4px 16px rgba(0,0,0,.6);" +
    "max-width:340px;font:12px sans-serif;color:#ccc;";
  positionOverlay(box, p.clientX, p.clientY);

  const header = document.createElement("div");
  header.style.cssText =
    "margin-bottom:4px;color:#8fd;font-weight:600;display:flex;align-items:center;" +
    "gap:6px;white-space:nowrap;overflow:hidden;";
  box.appendChild(header);

  const status = document.createElement("div");
  status.style.cssText = "color:#999;font-style:italic;margin-bottom:2px;";
  box.appendChild(status);

  const content = document.createElement("div");
  box.appendChild(content);

  document.body.appendChild(box);
  box._akHeader = header;
  box._akStatus = status;
  box._akContent = content;
  overlayEl = box;
  return box;
}

function setHeaderText(p, text) {
  if (!isCurrent(p)) return;
  overlayEl._akHeader.replaceChildren();
  const span = document.createElement("span");
  span.style.cssText = "overflow:hidden;text-overflow:ellipsis;";
  span.textContent = text;
  overlayEl._akHeader.appendChild(span);
}

function appendChip(text, color) {
  if (!overlayEl) return;
  const chip = document.createElement("span");
  chip.textContent = text;
  chip.style.cssText =
    `flex:0 0 auto;background:${color};color:#111;border-radius:3px;` +
    "padding:0 5px;font-size:10px;font-weight:700;";
  overlayEl._akHeader.appendChild(chip);
}

function setStatus(p, text) {
  if (!isCurrent(p)) return;
  overlayEl._akStatus.style.color = "#999";
  overlayEl._akStatus.textContent = text;
}

function setError(p, message) {
  if (!isCurrent(p)) return;
  overlayEl._akStatus.style.color = "#e77";
  overlayEl._akStatus.textContent = "error";
  overlayEl._akContent.replaceChildren();
  const msg = document.createElement("div");
  msg.style.cssText = "color:#e99;max-width:280px;white-space:pre-wrap;";
  msg.textContent = message;
  overlayEl._akContent.appendChild(msg);
  log("error", message);
}

function renderGated(p) {
  if (!isCurrent(p)) return;
  overlayEl._akStatus.textContent = "";
  overlayEl._akContent.replaceChildren();
  const msg = document.createElement("div");
  msg.style.cssText = "color:#ccc;max-width:280px;";
  msg.textContent = "Latent peek needs a VAE decode, coming in v1.1";
  overlayEl._akContent.appendChild(msg);
}

function renderImage(p) {
  if (!isCurrent(p)) return;
  const content = overlayEl._akContent;
  content.replaceChildren();
  const im = p.images[p.imgIndex];
  const wrap = document.createElement("div");
  wrap.style.cssText = "position:relative;display:inline-block;";
  const img = document.createElement("img");
  img.src = imageUrl(im);
  img.style.cssText =
    "max-width:320px;max-height:280px;display:block;border-radius:3px;" +
    (p.images.length > 1 ? "cursor:pointer;" : "");
  if (p.images.length > 1) {
    img.title = "Click to cycle";
    img.addEventListener("click", () => {
      p.imgIndex = (p.imgIndex + 1) % p.images.length;
      renderImage(p);
    });
  }
  wrap.appendChild(img);
  if (p.images.length > 1) {
    const badge = document.createElement("div");
    badge.textContent = `${p.imgIndex + 1}/${p.images.length}`;
    badge.style.cssText =
      "position:absolute;right:4px;bottom:4px;background:rgba(0,0,0,.7);color:#fff;" +
      "font-size:10px;padding:1px 5px;border-radius:3px;";
    wrap.appendChild(badge);
  }
  content.appendChild(wrap);
}

function renderExecuted(p, output, ms) {
  if (!isCurrent(p)) return;
  overlayEl._akStatus.textContent = "";
  setHeaderText(p, `«${p.title}» · ${p.type} · ${ms}ms`);
  if (p.cached) appendChip("cached", "#8fd");

  if (output?.images?.length) {
    p.images = output.images;
    p.imgIndex = 0;
    renderImage(p);
  } else if (output?.text != null) {
    overlayEl._akContent.replaceChildren();
    const t = document.createElement("pre");
    t.style.cssText = "white-space:pre-wrap;max-height:280px;overflow:auto;margin:0;color:#ccc;";
    t.textContent = Array.isArray(output.text) ? output.text.join("\n") : String(output.text);
    overlayEl._akContent.appendChild(t);
  } else {
    overlayEl._akContent.replaceChildren();
    const t = document.createElement("div");
    t.style.cssText = "color:#999;font-style:italic;";
    t.textContent = "No preview output produced.";
    overlayEl._akContent.appendChild(t);
    log("executed with empty output", output);
  }
}

// --- the peek round trip: graphToPrompt -> inject -> POST /prompt -> await events ---

async function peek(node, slot, e) {
  dismiss();

  const out = node.outputs?.[slot];
  const slotType = String(out?.type ?? "*");
  const seq = ++peekSeq;
  const p = {
    seq,
    sourceId: String(node.id),
    slot,
    type: slotType,
    title: node.title || node.type || "node",
    clientX: e.clientX,
    clientY: e.clientY,
    t0: performance.now(),
    promptId: null,
    early: [],
    cached: false,
    images: null,
    imgIndex: 0,
    dismissed: false,
  };
  currentPeek = p;
  createOverlay(p);
  setHeaderText(p, `«${p.title}» · ${p.type}`);
  setStatus(p, "peeking…");
  log("peek start", p.sourceId, p.type, `slot ${slot}`);

  const inj = pickPreviewNode(slotType, p.sourceId, slot);
  if (!inj) { renderGated(p); return; }

  let graphResult;
  try {
    graphResult = await app.graphToPrompt();
  } catch (err) {
    setError(p, "Could not serialize the graph for peeking.");
    log("graphToPrompt threw", err);
    return;
  }
  if (p.seq !== currentPeek?.seq) return; // superseded while awaiting

  const fullDict = structuredClone(graphResult.output);
  if (!fullDict[p.sourceId]) {
    setError(p, "Source node is muted, bypassed, or missing from the serialized graph.");
    return;
  }
  const promptDict = pruneToAncestors(fullDict, p.sourceId);
  promptDict[PEEK_ID] = inj;
  log(`pruned prompt: ${Object.keys(promptDict).length - 1} ancestor node(s) of ${Object.keys(fullDict).length} total`);

  const clientId = api.clientId ?? api.initialClientId;

  // Snapshot the queue AT SUBMIT TIME -- this is what decides the "queued
  // behind current job" chip, not a live poll afterward.
  let queueBusy = false;
  try {
    const qRes = await api.fetchApi("/queue");
    const qBody = await qRes.json();
    queueBusy = (qBody.queue_running?.length ?? 0) > 0 || (qBody.queue_pending?.length ?? 0) > 0;
  } catch (err) {
    log("queue check failed (non-fatal)", err);
  }
  if (p.seq !== currentPeek?.seq) return;
  if (queueBusy) setStatus(p, "queued behind current job…");

  let res, body;
  try {
    res = await api.fetchApi("/prompt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: promptDict,
        client_id: clientId,
        partial_execution_targets: [PEEK_ID],
      }),
    });
    body = await res.json();
  } catch (err) {
    if (p.seq !== currentPeek?.seq) return;
    setError(p, "Network error submitting the peek request.");
    log("prompt POST threw", err);
    return;
  }
  if (p.seq !== currentPeek?.seq) return;

  if (res.status !== 200) {
    // node_errors names the actual failing upstream node(s) -- far more useful
    // than the generic "Prompt outputs failed validation" envelope.
    let msg = (typeof body?.error === "string" ? body.error : body?.error?.message) ||
              "The server rejected this peek.";
    const nodeErrors = body?.node_errors ?? {};
    const parts = [];
    for (const [nid, info] of Object.entries(nodeErrors)) {
      const title = resolveNodeTitle(nid) ?? `node ${nid}`;
      for (const err of info?.errors ?? []) {
        parts.push(`Upstream «${title}» (${nid}): ${err.message}` +
                   (err.details ? ` (${err.details})` : ""));
      }
    }
    if (parts.length) msg = "This branch can't run yet:\n" + parts.join("\n");
    setError(p, msg);
    log("server rejected prompt", body);
    return;
  }

  // From here on, websocket events (matched by prompt_id) drive all further
  // state transitions. IMPORTANT: on a fast cache-hit the "executed" ws event
  // can arrive BEFORE this HTTP response resolves (observed in the spike), so
  // events that raced ahead were buffered in p.early -- replay them now.
  p.promptId = body.prompt_id;
  log("queued ok", p.promptId);
  const early = p.early.splice(0);
  for (const [type, detail] of early) routePeekEvent(type, detail);
}

// --- websocket events: matched by prompt_id so a stale/older peek (same
// constant PEEK_ID, different submission) can never clobber the current one.
// Events arriving before the /prompt response (fast cache-hits) are buffered
// on the peek and replayed once the prompt_id is known. ---

const HANDLERS = {
  execution_cached(p, d) {
    const nodes = d.nodes ?? [];
    p.cached = nodes.includes(p.sourceId);
    setStatus(p, p.cached ? "cached, fetching…" : "computing…");
    log("execution_cached", nodes, "sourceCached=", p.cached);
  },
  executing(p, d) {
    const nodeId = d?.node;
    if (nodeId == null) return; // queue-idle signal, not relevant to us
    if (String(nodeId) === PEEK_ID) { setStatus(p, "finishing…"); return; }
    const title = resolveNodeTitle(d.display_node ?? nodeId) ?? String(nodeId);
    setStatus(p, `computing ancestors… (${title})`);
  },
  executed(p, d) {
    if (d?.node !== PEEK_ID) return;
    const ms = Math.round(performance.now() - p.t0);
    log("executed", PEEK_ID, `${ms}ms`);
    renderExecuted(p, d.output, ms);
  },
  execution_error(p, d) {
    setError(p, d?.exception_message || "Execution failed.");
  },
  execution_interrupted(p, _d) {
    setError(p, "Interrupted.");
  },
};

function routePeekEvent(type, detail) {
  const p = currentPeek;
  if (!p || p.dismissed) return;
  if (!p.promptId) { p.early.push([type, detail]); return; }
  if (detail?.prompt_id !== p.promptId) return;
  HANDLERS[type]?.(p, detail);
}

for (const type of Object.keys(HANDLERS)) {
  api.addEventListener(type, (ev) => routePeekEvent(type, ev.detail));
}

app.registerExtension({
  name: "AKURATE.EphemeralPeek",

  setup() {
    app.ui.settings.addSetting({
      id: SETTING_ID,
      name: "Ephemeral Peek: trigger modifier",
      type: "combo",
      options: ["Alt", "Shift+Alt"],
      defaultValue: "Alt",
      onChange(value) {
        modifierSetting = value;
        log("modifier setting changed ->", value);
      },
    });
    modifierSetting = app.ui.settings.getSettingValue(SETTING_ID, "Alt");

    const canvasEl = app.canvas?.canvas;
    if (!canvasEl) { console.warn("[EphemeralPeek] no canvas element; extension inert"); return; }

    // LiteGraph binds its own pointer handlers at canvas construction, so a
    // prototype wrap installed here never runs (verified during the spike).
    // A window-capture listener, filtered to events targeting the canvas
    // element, fires before LiteGraph's own bubble-phase handlers instead.
    let swallowUntil = 0;

    // Suppress the up-side of our intercepted gesture (pointerup/click/
    // mousedown/mouseup) so LiteGraph never sees it as a node clone/drag.
    // MUST be registered before the click-away dismiss listener below so it
    // can stopImmediatePropagation() first on the same physical click.
    for (const evName of GESTURE_EVENTS) {
      window.addEventListener(evName, (ev) => {
        if (ev.target === canvasEl && performance.now() < swallowUntil) {
          ev.preventDefault();
          ev.stopImmediatePropagation();
          log(`swallowed ${evName} @window-capture (clone suppression)`);
        }
      }, { capture: true });
    }

    window.addEventListener("pointerdown", (e) => {
      try {
        if (e.target !== canvasEl) return;
        if (!modifierMatches(e)) return;

        // never fire while the user is typing in a widget/text field
        const active = document.activeElement;
        if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.isContentEditable)) return;

        const cv = app.canvas;
        const rect = canvasEl.getBoundingClientRect();
        const relX = e.clientX - rect.left, relY = e.clientY - rect.top;
        let x, y;
        if (cv.ds?.convertCanvasToOffset) {
          [x, y] = cv.ds.convertCanvasToOffset([relX, relY]);
        } else {
          x = relX / cv.ds.scale - cv.ds.offset[0];
          y = relY / cv.ds.scale - cv.ds.offset[1];
        }
        const node = cv.graph?.getNodeOnPos?.(x, y, cv.visible_nodes);
        if (!node) return;

        // isOverNodeOutput/getSlotInPosition are NOT exposed on this frontend's
        // canvas instance (verified headlessly) -- hit-test by geometry against
        // node.getConnectionPos, which IS reliable.
        let slot = -1, best = Infinity;
        for (let i = 0; i < (node.outputs?.length ?? 0); i++) {
          const pos = node.getConnectionPos(false, i, [0, 0]);
          const d = Math.hypot(pos[0] - x, pos[1] - y);
          if (d < HIT_RADIUS && d < best) { best = d; slot = i; }
        }
        if (slot === -1) return; // alt-click on node BODY -> let LiteGraph handle it (clone)

        e.preventDefault();
        e.stopImmediatePropagation(); // block LiteGraph's pointerdown path
        swallowUntil = performance.now() + SWALLOW_MS; // and its pointerup/click path
        log(`hit node ${node.id} "${node.title}" output[${slot}] type=${node.outputs?.[slot]?.type}`);
        peek(node, slot, e);
      } catch (err) {
        console.error("[EphemeralPeek] pointerdown handler error (event passed through):", err);
      }
    }, { capture: true });

    window.addEventListener("keydown", (ev) => {
      if (ev.code === "Escape") dismiss();
    }, true);

    window.addEventListener("mousedown", (ev) => {
      if (overlayEl && !overlayEl.contains(ev.target)) dismiss();
    }, true);

    console.log("[EphemeralPeek] v0.1.1-pruned loaded -- Alt+click an output socket to peek");
  },
});
