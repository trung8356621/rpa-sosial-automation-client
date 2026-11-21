export const EXECUTION_VIEWPORT = {
  width: 1024,
  height: 560,
  zoom: 1.0,
} as const;

/**
 * Pin embedded WebContentsView dimensions to the fixed 1024x560 execution viewport
 * regardless of outer Electron window resize, maximize/restore, or sidebar changes.
 */
export function clampExecutionBounds(bounds: {
  x: number;
  y: number;
  width?: number;
  height?: number;
}): { x: number; y: number; width: number; height: number } {
  return {
    x: Number.isFinite(bounds.x) ? Math.max(0, Math.round(bounds.x)) : 0,
    y: Number.isFinite(bounds.y) ? Math.max(0, Math.round(bounds.y)) : 0,
    width: EXECUTION_VIEWPORT.width,
    height: EXECUTION_VIEWPORT.height,
  };
}

/**
 * Transparent interaction-blocking HTML for the native overlay WebContentsView.
 * Status bar + Stop Automation button live in the React toolbar outside 1024x560.
 */
export function buildTransparentOverlayHtml(): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"/>
<style>
  html,body{margin:0;height:100%;width:100%;background:transparent;cursor:not-allowed;user-select:none;-webkit-user-select:none;box-sizing:border-box;outline:2px solid rgba(239,68,68,0.45);outline-offset:-2px;}
</style></head>
<body>
  <script>
    var block = function(e){ e.preventDefault(); e.stopPropagation(); };
    window.addEventListener('wheel', block, { passive: false, capture: true });
    window.addEventListener('dragstart', block, { capture: true });
    window.addEventListener('mousedown', block, { capture: true });
    window.addEventListener('pointerdown', block, { capture: true });
    window.addEventListener('click', block, { capture: true });
    window.addEventListener('contextmenu', block, { capture: true });
  </script>
</body></html>`;
}
