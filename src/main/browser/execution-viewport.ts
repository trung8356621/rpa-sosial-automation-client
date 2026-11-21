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
