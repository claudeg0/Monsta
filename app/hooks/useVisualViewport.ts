import * as React from "react";

/**
 * The region of the page the user can actually see, in layout viewport client
 * coordinates — the same space `getBoundingClientRect` and ProseMirror's
 * `coordsAtPos` report in.
 */
export interface VisualViewportBand {
  /** Client-space y of the top edge of the visible area. */
  top: number;
  /** Client-space y of the bottom edge of the visible area. */
  bottom: number;
  /** Client-space x of the left edge of the visible area. */
  left: number;
  /** Client-space x of the right edge of the visible area. */
  right: number;
  /** Width of the visible area. */
  width: number;
  /** Height of the visible area. */
  height: number;
}

function toFinite(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

/**
 * Measures the visible region of the page.
 *
 * On iOS the layout viewport does not shrink when the software keyboard opens —
 * only the visual viewport does — so `window.innerHeight` and `vh` units both
 * describe an area larger than the user can see. Anything positioned or sized
 * against them ends up underneath the keyboard. This reads the visual viewport
 * instead, which is correct whether or not the browser resizes the layout
 * viewport, so callers do not need to care which behavior the browser has.
 *
 * Synchronous and allocation-light, so it is safe to call from a
 * requestAnimationFrame loop.
 *
 * @returns The visible region in layout viewport client coordinates.
 */
export function readVisualViewport(): VisualViewportBand {
  const viewport = window.visualViewport;

  // Only reachable where the API is absent, such as jsdom under test. The
  // layout viewport is the best available answer there, and unlike innerHeight
  // it excludes any scrollbar.
  if (!viewport) {
    const width = document.documentElement.clientWidth;
    const height = document.documentElement.clientHeight;
    return { top: 0, bottom: height, left: 0, right: width, width, height };
  }

  const top = toFinite(viewport.offsetTop, 0);
  const left = toFinite(viewport.offsetLeft, 0);
  const width = toFinite(viewport.width, document.documentElement.clientWidth);
  const height = toFinite(
    viewport.height,
    document.documentElement.clientHeight
  );

  return {
    top,
    bottom: top + height,
    left,
    right: left + width,
    width,
    height,
  };
}

/**
 * Publishes the visible region to CSS as custom properties on the document
 * root, so stylesheets can size and position against it:
 *
 * - `--visible-height`: height of the visible area. `vh` units resolve against
 *   the large viewport on iOS and ignore the software keyboard, so an element
 *   sized in `vh` overflows the screen by roughly the height of the keyboard.
 *   Use `min(<vh fallback>, var(--visible-height))`.
 * - `--keyboard-inset`: distance from the bottom of the layout viewport up to
 *   the bottom of the visible area, i.e. the height of the keyboard. A
 *   `position: fixed; bottom: 0` element is anchored to the layout viewport,
 *   which on iOS does not shrink for the keyboard, so such an element is left
 *   behind it. Use `bottom: var(--keyboard-inset, 0px)` to lift it clear.
 *
 * Both resolve to their no-keyboard values when the keyboard is closed, so the
 * properties are safe to reference unconditionally.
 *
 * Kept as an opt-in hook rather than an app-wide effect so the properties only
 * exist while something depends on them.
 */
export function useVisibleViewportVars(): void {
  React.useEffect(() => {
    const root = document.documentElement;

    // Measured per frame rather than from throttled state: the keyboard
    // animates, and a stale value during that animation is visible as the panel
    // overflowing the screen or sitting behind the keyboard.
    let frame = requestAnimationFrame(function tick() {
      const band = readVisualViewport();
      // The containing block for a fixed element is the initial containing
      // block, so clientHeight is the correct reference here rather than
      // innerHeight.
      const inset = Math.max(
        0,
        document.documentElement.clientHeight - band.bottom
      );

      root.style.setProperty(
        "--visible-height",
        `${Math.round(band.height)}px`
      );
      root.style.setProperty("--keyboard-inset", `${Math.round(inset)}px`);
      frame = requestAnimationFrame(tick);
    });

    return () => {
      cancelAnimationFrame(frame);
      root.style.removeProperty("--visible-height");
      root.style.removeProperty("--keyboard-inset");
    };
  }, []);
}
