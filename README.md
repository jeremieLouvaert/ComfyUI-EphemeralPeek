# ComfyUI-EphemeralPeek

Alt+click any output socket on any node and a floating preview appears. Not just the sockets already wired to a Preview or Save node: any socket, on any node, whether or not anything downstream ever looks at it. It is the Blender geometry-nodes viewer idiom (hold a modifier, click a socket, see the data) transplanted onto ComfyUI's graph, where the normalized workaround has always been to wire a `PreviewImage` node onto whatever you want to inspect and delete it again afterward. This tool skips that whole ritual: click, look, move on. Your saved workflow never grows an extra node just because you were curious.

## How it works

Alt+click hit-tests the socket you clicked, serializes the current graph with `graphToPrompt`, injects one temporary preview node wired to that socket, and submits it as a `partial_execution_targets` request scoped to just that temporary node. The server's own cache does the rest: if the branch feeding your socket already ran with the same inputs, the injected node is the only thing that executes and the result comes back in tens of milliseconds. If the branch is cold or its inputs changed, the server computes its ancestors first, honestly, before the preview appears.

Be precise about what "zero clutter" means: your saved workflow file, your undo history, and the canvas are never touched. Nothing is written to disk or to graph state. But under the hood a real prompt is submitted and a real (if minimal) execution happens on every peek. This is not a static readout of cached data, it is a live, transient computation that happens to be instant when the cache lets it be.

## Peek vs core Partial Execution vs wired preview nodes

| | **Ephemeral Peek** | **Core Partial Execution** | **Wired preview/debug nodes** |
|---|---|---|---|
| What it targets | Any output socket, on demand | An existing output node you must have already placed | An existing output node you must have already placed |
| Graph footprint | None, ever | One node, permanent | One node, permanent |
| Setup before first use | None | Add and wire a Preview/Save node | Add and wire a Preview/Save node |
| Cleanup after use | None needed | Delete the node yourself | Delete the node yourself |
| Result delivery | Floating overlay near the click | Renders on the node in the graph | Renders on the node in the graph |

Core Partial Execution and Ephemeral Peek share the same server mechanism (both scope execution with `partial_execution_targets`). The difference is entirely about where the target node comes from: Partial Execution requires you to have already dropped and wired an output node; Peek needs no node in the graph at all; it manufactures a temporary one for the single request and throws it away.

## Controls

- **Alt+click** an output socket: peek it.
- **Esc**, clicking away from the overlay, or starting a new peek: dismiss.
- Setting: **Ephemeral Peek: trigger modifier** (`Alt` or `Shift+Alt`), in ComfyUI's settings panel. Switch to `Shift+Alt` if `Alt` conflicts with another extension's bindings on your setup.

## Type support

| Socket type | Behavior |
|---|---|
| `IMAGE` | Rendered inline, batches show image 1 with a count badge; click the image to cycle. |
| `MASK` | Rendered as a preview image via the core `MaskPreview` node. |
| `LATENT` | Gated in v1. The overlay explains: a latent preview needs a VAE decode, which is a real compute cost we are not willing to spend silently on every peek. Planned for v1.1. |
| Everything else (`STRING`, `INT`, `FLOAT`, `CONDITIONING`-shaped, `ANY`) | Rendered as text via the core `PreviewAny` node, in a scrollable panel. |

If the server rejects the peek for any reason (a type `PreviewAny` cannot actually accept, a validation error, and so on), the overlay shows the server's own error message. It never fails silently and never throws an uncaught error into the console.

## Known limits

- Verified on the classic LiteGraph renderer. The newer Vue-based renderer (Nodes 2.0) is untested and may need a future update.
- A peek on a volatile node (randomized seeds, a changed source file, anything with `IS_CHANGED` logic) recomputes honestly. The peek reflects current reality, not a stale cached guess.
- A peek queues behind whatever job is already running. There is one execution queue; Peek does not jump it.
- Tested against ComfyUI 0.28+ and frontend 1.45+. Older versions are unverified.

## Install

Clone into your `custom_nodes` folder and restart ComfyUI:

```
cd ComfyUI/custom_nodes
git clone https://github.com/jeremieLouvaert/ComfyUI-EphemeralPeek
```

It is frontend-only, so there are no Python dependencies.

## License

MIT.
