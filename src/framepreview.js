// The recording frame preview.
//
// A click on a ratio shows the frame for a few seconds, so the player can
// confirm the shape and the framing of the saved video before a capture
// starts. The stage takes the frame's shape for the same few seconds, and a
// dim scrim covers everything outside it. The overlay goes away after
// PREVIEW_SECONDS, or as soon as a recording starts.

/** How long a preview stays on screen, in seconds. */
export const PREVIEW_SECONDS = 6;

export class FramePreview {
  constructor(scene, element) {
    this.scene = scene;
    this.element = element;
    this.timer = 0;
    this.name = null;
  }

  /** Show the frame of one ratio and start the countdown. */
  show(name, seconds = PREVIEW_SECONDS) {
    this.name = name;
    this.scene.setFrame(name);
    this._place();
    this.element.hidden = false;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.hide(), Math.max(0, seconds) * 1000);
  }

  /**
   * Drop the overlay and the countdown, and leave the stage frame alone. A
   * recording starts with its own frame, so the preview must not clear it.
   */
  clear() {
    clearTimeout(this.timer);
    this.timer = 0;
    this.element.hidden = true;
    this.name = null;
  }

  /** Drop the overlay and give the stage back to the window shape. */
  hide() {
    this.clear();
    this.scene.setFrame(null);
  }

  /** Hold the overlay on the frame after a window resize. */
  refresh() {
    if (this.element.hidden) return;
    this._place();
  }

  _place() {
    const box = this.scene.frameRect();
    this.element.style.left = `${box.left}px`;
    this.element.style.top = `${box.top}px`;
    this.element.style.width = `${box.width}px`;
    this.element.style.height = `${box.height}px`;
  }
}