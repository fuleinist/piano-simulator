// The music clock. Pure module: the caller injects the time source, so a Node
// test can move that source by hand.
//
// A frame loop cannot own the time of the piece. A hidden tab stops drawing
// frames, a locked phone stops them too, and a frame that does arrive can be
// late. So the player reads the elapsed time from the audio clock, which the
// browser keeps for the sound it plays, and this module turns that clock into
// music seconds.

export class MusicClock {
  /**
   * @param {{ now?: () => number, speed?: number }} options `now` returns the
   *   time source in seconds, and defaults to the page clock.
   */
  constructor({ now, speed = 1 } = {}) {
    this._now = now || (() => performance.now() / 1000);
    this.speed = speed > 0 ? speed : 1;
    this.running = false;
    this._at = this._now(); // time source seconds at the start of this run
    this._from = 0; // music seconds at that point
    this._held = 0; // music seconds while the clock is stopped
  }

  /** The music time at the current value of the time source. */
  read() {
    if (!this.running) return this._held;
    const elapsed = this._now() - this._at;
    return this._from + (elapsed > 0 ? elapsed * this.speed : 0);
  }

  /**
   * The time source value at which a music time plays. The player schedules
   * ahead, so it needs the mapping as well as the reading.
   */
  clockFor(time) {
    return this._at + (time - this._from) / this.speed;
  }

  play() {
    if (this.running) return;
    this._at = this._now();
    this._from = this._held;
    this.running = true;
  }

  /** Stop the clock. A later play continues from the time it stopped at. */
  pause() {
    if (!this.running) return;
    this._held = this.read();
    this.running = false;
  }

  /** Move the clock to a music time, and keep running from there. */
  seek(time) {
    this._held = time > 0 ? time : 0;
    this._at = this._now();
    this._from = this._held;
  }

  /** Change the speed without moving the time the piece is at. */
  setSpeed(speed) {
    const time = this.read();
    this.speed = speed > 0 ? speed : 1;
    this._at = this._now();
    this._from = time;
    this._held = time;
  }
}