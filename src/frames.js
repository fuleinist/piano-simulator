// Recording frame geometry. Pure module: no browser globals and no Three.js,
// so Node tests can check the ratios and the fit.
//
// A frame sets two things: the pixel size of the saved video, and the shape the
// stage takes while it records.

/** The video shapes the recorder offers. */
export const FRAMES = {
  '16:9': { width: 1920, height: 1080 },
  '9:16': { width: 1080, height: 1920 },
};

export const DEFAULT_FRAME = '16:9';

/** Frame size in pixels. An unknown name falls back to the default shape. */
export function frameSize(name) {
  return FRAMES[name] || FRAMES[DEFAULT_FRAME];
}

/** Width divided by height. A landscape frame is above 1, a portrait below 1. */
export function frameAspect(name) {
  const { width, height } = frameSize(name);
  return width / height;
}

/**
 * Largest box of one aspect that fits inside a window, in CSS pixels. The
 * caller centres the box, so the stage shows the true recording frame.
 */
export function fitBox(windowWidth, windowHeight, aspect) {
  if (!(aspect > 0) || !(windowWidth > 0) || !(windowHeight > 0)) {
    return { width: 0, height: 0 };
  }
  return windowWidth / windowHeight > aspect
    ? { width: windowHeight * aspect, height: windowHeight }
    : { width: windowWidth, height: windowWidth / aspect };
}