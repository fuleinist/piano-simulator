// Per-key press highlight, as plain numbers so the curve is testable in Node.
//
// White keys are lit at nearly full brightness before any highlight is added,
// so an emissive-only glow is a few percent of what they already emit and tone
// mapping flattens it back to white: the key looks unpressed. Their body colour
// has to move towards the hand colour to read as pressed, which is an albedo
// change and survives tone mapping. Black keys reflect almost nothing, so
// emissive alone already reads as neon there and their body colour is left
// alone. Pure module: no three.js imports, like layout.js and fingering.js.

/** How far an ivory key's body colour shifts towards the hand colour at full glow. */
export const WHITE_TINT = 1;
/**
 * What is left of the old emissive glow on white keys. Kept small on purpose:
 * added light desaturates the tint (measured: emissive 0.3 renders the key
 * paler than 0.15), it only has to keep the key lit in the dimmer views.
 */
export const WHITE_EMISSIVE = 0.15;
/** Black keys keep the emissive-only highlight they always had. */
export const BLACK_EMISSIVE = 0.6;

/**
 * Highlight multipliers for one key.
 * `tint` is the lerp amount from the key's base colour towards the hand colour;
 * `emissive` is the multiplier on the hand colour for `material.emissive`.
 */
export function keyHighlight(glow, black) {
  const g = Number.isFinite(glow) ? Math.min(1, Math.max(0, glow)) : 0;
  return black
    ? { tint: 0, emissive: g * BLACK_EMISSIVE }
    : { tint: g * WHITE_TINT, emissive: g * WHITE_EMISSIVE };
}