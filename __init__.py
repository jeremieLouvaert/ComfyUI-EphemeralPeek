"""ComfyUI-EphemeralPeek — frontend-only extension.

Alt-click any output socket -> floating ephemeral preview. Zero graph nodes;
everything lives in web/ephemeral_peek.js.
"""

WEB_DIRECTORY = "./web"
NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}
__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]

print("\033[34m[EphemeralPeek] \033[92mLoaded — Alt+click an output socket to peek\033[0m")
