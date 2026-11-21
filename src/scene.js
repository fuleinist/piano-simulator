import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { BOARD_W } from './layout.js';
import { FRAMES, frameSize, fitBox } from './frames.js';

// Camera presets. "top" is the default: a true 90° overhead view, with the
// camera directly above its target, so the keys read at their real width and
// a hand span can be judged by eye. Presets marked `follow` shift along the
// keys with the hands, so the player stays in frame at either end of the
// keyboard.
export const PRESETS = {
  // pos.x/z equal target.x/z: the view direction is exactly (0, -1, 0).
  top: { pos: [0, 46, 0], target: [0, 0, 0] },
  perform: { pos: [0, 34, 30], target: [0, 1, -1] },
  front: { pos: [0, 7, 33], target: [0, 1.5, 0], follow: true },
  side: { pos: [36, 15, 20], target: [0, 1, 0], follow: true },
  close: { pos: [6, 13, 15], target: [4, 0.5, 1], follow: true },
};

// How far a following preset may slide from its anchor, in scene units.
const FOLLOW_LIMIT = 22;

// The vertical axis of the scene, for a pan.
const UP = new THREE.Vector3(0, 1, 0);

// The camera animation is over once it sits this close to the goal, in scene
// units. From then on nothing may touch the camera.
const ARRIVE = 0.02;

// The paper takes the top of the window, so the stage sits below centre: the
// whole view slides up the screen, which moves the piano down and leaves the
// band clear of the keys. A share of the visible height, so it holds at any
// window shape.
const VIEW_LIFT = 0.11;

export class Scene {
  constructor(canvas) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.06;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x07090f);
    this.scene.fog = new THREE.Fog(0x07090f, 70, 160);

    this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 400);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 7;
    this.controls.maxDistance = 110;
    this.controls.maxPolarAngle = 1.48;
    this.controls.screenSpacePanning = false;

    this._lights();
    this._environment();
    this._floor();

    // Camera state. `_base` is the view the camera settles on: a preset
    // anchor, or the view that the player moved it to. `_followX` is the
    // slide along the keys that keeps the hands in frame.
    this._base = { pos: new THREE.Vector3(), target: new THREE.Vector3(), follow: false };
    this._followX = 0;
    this._focusX = null;

    // True while the camera travels to a new anchor.
    this._settling = false;

    // Recording frame: null while the stage fills the window.
    this._frameName = null;

    // A gesture owns the camera while it runs, so a preset animation must not
    // pull the view back under the pointer. A gesture also cancels a follow
    // and any travel that is still in flight. When the gesture ends, the idle
    // frame takes the view it reached as the anchor (see update), so a drag,
    // a wheel zoom, or a pan stays where the player put it.
    this._dragging = false;
    this.controls.addEventListener('start', () => {
      this._dragging = true;
      this._base.follow = false;
      this._settling = false;
      this._followX = 0;
    });
    this.controls.addEventListener('end', () => { this._dragging = false; });

    this.setPreset('top', true);
    this.resize();
  }

  _environment() {
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.55;
    pmrem.dispose();
  }

  _lights() {
    this.scene.add(new THREE.HemisphereLight(0x93a7cc, 0x0c0f16, 0.55));

    const key = new THREE.DirectionalLight(0xfff0da, 2.4);
    key.position.set(20, 44, 26);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    const c = key.shadow.camera;
    c.left = -32; c.right = 32; c.top = 24; c.bottom = -24; c.near = 1; c.far = 130;
    key.shadow.bias = -0.0004;
    key.shadow.normalBias = 0.02;
    this.scene.add(key);

    const rim = new THREE.DirectionalLight(0x5f7dff, 0.9);
    rim.position.set(-24, 18, -34);
    this.scene.add(rim);

    const warm = new THREE.PointLight(0xffb877, 0.5, 60, 2);
    warm.position.set(0, 12, 10);
    this.scene.add(warm);
  }

  _floor() {
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(320, 320),
      new THREE.MeshStandardMaterial({ color: 0x0a0d15, roughness: 0.55, metalness: 0.25 })
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -1.7;
    floor.receiveShadow = true;
    this.scene.add(floor);
  }

  setPreset(name, instant = false) {
    const key = PRESETS[name] ? name : 'top';
    const p = PRESETS[key];
    this._base.pos.set(...p.pos);
    this._base.target.set(...p.target);
    this._base.follow = Boolean(p.follow);
    this._followX = 0;
    if (instant) {
      // The anchor carries no lift, so the camera takes the lift here. The
      // idle frame reads the anchor back off the camera, so the two must
      // start in step.
      const lift = this._lift(this._base.pos, this._base.target);
      this.camera.position.copy(this._base.pos).add(lift);
      this.controls.target.copy(this._base.target).add(lift);
      this._settling = false;
    } else {
      // A preset replaces every gesture: the pan, the zoom, and the tilt all
      // come back to the anchor. The travel starts on the next frame.
      this._settling = true;
    }
  }

  /**
   * Set the recording frame, or clear it with null.
   *
   * A set frame gives the canvas the frame's shape at the frame's pixel size,
   * and shows it centred in the window. The camera takes the same shape, so
   * the saved video has no letterbox.
   *
   * The frame never moves the camera. A view the player has zoomed, panned, or
   * turned stays where it is, so a frame change cannot throw the work away.
   */
  setFrame(name) {
    this._frameName = name && FRAMES[name] ? name : null;

    // The frame is recorded at its own pixel size, so the window pixel ratio
    // must not multiply it.
    if (this._frameName) this.renderer.setPixelRatio(1);
    else this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.resize();
  }

  // Centre of the playing hands, in scene units. Following presets slide to it.
  setFocus(x) {
    this._focusX = Number.isFinite(x) ? x : null;
  }

  /**
   * Take the camera as it stands as the new anchor. The lift belongs to the
   * view and not to the anchor, so it comes off first. An idle frame calls
   * this on every frame, so the anchor can never drift from the picture on
   * screen and a preset change always starts from that picture.
   */
  _syncBaseFromCamera() {
    const pos = new THREE.Vector3().copy(this.camera.position);
    const target = new THREE.Vector3().copy(this.controls.target);
    const lift = this._lift(pos, target);
    this._base.pos.copy(pos).sub(lift);
    this._base.target.copy(target).sub(lift);
  }

  /**
   * Take the view on screen as the anchor. A follow slide and the run of the
   * keys belong to the view, so they fold into the anchor first: the next step
   * starts from the picture the player sees.
   */
  _takeView() {
    if (this._followX) {
      this._base.pos.x += this._followX;
      this._base.target.x += this._followX;
      this._followX = 0;
    }
    this._base.follow = false;
  }

  /** Move the view along the keys, in scene units. */
  panBy(dx) {
    this._takeView();
    this._base.pos.x += dx;
    this._base.target.x += dx;
    this._settling = true;
  }

  /**
   * Spin the view around its target about the vertical axis, by `deg` degrees.
   * The camera keeps its distance and its target, so only the angle changes.
   * A positive angle swings the camera to its own left.
   */
  orbitBy(deg) {
    this._takeView();
    const offset = new THREE.Vector3().subVectors(this._base.pos, this._base.target);
    offset.applyAxisAngle(UP, THREE.MathUtils.degToRad(deg));
    this._base.pos.copy(this._base.target).add(offset);
    this._settling = true;
  }

  zoomBy(factor) {
    this._takeView();
    const dir = new THREE.Vector3().subVectors(this._base.pos, this._base.target);
    const len = THREE.MathUtils.clamp(dir.length() * factor, this.controls.minDistance, this.controls.maxDistance);
    dir.setLength(len);
    this._base.pos.copy(this._base.target).add(dir);
    this._settling = true;
  }

  /**
   * The frame's box on the page, in CSS pixels. With no frame set, the box is
   * the whole window.
   */
  frameRect() {
    const vw = window.innerWidth, vh = window.innerHeight;
    if (!this._frameName) return { left: 0, top: 0, width: vw, height: vh };
    const { width, height } = frameSize(this._frameName);
    const box = fitBox(vw, vh, width / height);
    return {
      left: (vw - box.width) / 2,
      top: (vh - box.height) / 2,
      width: box.width,
      height: box.height,
    };
  }

  resize() {
    const vw = window.innerWidth, vh = window.innerHeight;
    const canvas = this.renderer.domElement;

    if (this._frameName) {
      // Draw at the video's own pixel size, then show that bitmap in the
      // largest box of the same shape that fits the window.
      const { width, height } = frameSize(this._frameName);
      const box = this.frameRect();
      this.renderer.setSize(width, height, false);
      canvas.classList.add('framed');
      canvas.style.width = `${box.width}px`;
      canvas.style.height = `${box.height}px`;
      this.camera.aspect = width / height;
    } else {
      canvas.classList.remove('framed');
      this.renderer.setSize(vw, vh);
      this.camera.aspect = vw / vh;
    }
    this.camera.updateProjectionMatrix();
  }

  update(dt) {
    // Slide a following preset along the keys toward the hands.
    const follow = this._base.follow && this._focusX !== null;
    const wantX = follow
      ? THREE.MathUtils.clamp(this._focusX - this._base.target.x, -FOLLOW_LIMIT, FOLLOW_LIMIT)
      : 0;
    this._followX += (wantX - this._followX) * (1 - Math.pow(0.02, dt));

    // A gesture owns the camera while it runs.
    if (this._dragging) {
      this.controls.update();
      return;
    }

    // Only a preset change in flight or a follow moves the camera. An idle
    // frame leaves a drag, a wheel zoom, or a step where it is, and keeps the
    // anchor on the view that the player sees, so the next preset change
    // starts from that view.
    if (!this._settling && !follow) {
      this.controls.update();
      this._syncBaseFromCamera();
      return;
    }

    const k = 1 - Math.pow(0.001, dt); // smooth approach
    const goalPos = new THREE.Vector3(
      this._base.pos.x + this._followX,
      this._base.pos.y,
      this._base.pos.z,
    );
    const goalTarget = new THREE.Vector3(
      this._base.target.x + this._followX,
      this._base.target.y,
      this._base.target.z,
    );
    // Slide the whole view up the screen axis. The camera and its target move
    // together, so the angle never changes: only what sits in the frame.
    const lift = this._lift(goalPos, goalTarget);
    goalPos.add(lift);
    goalTarget.add(lift);

    // Land on the goal exactly, then stop touching the camera. A lerp that
    // keeps running would undo the next gesture.
    const arrived = this._settling
      && this.camera.position.distanceToSquared(goalPos) <= ARRIVE * ARRIVE
      && this.controls.target.distanceToSquared(goalTarget) <= ARRIVE * ARRIVE;
    if (arrived) {
      this.camera.position.copy(goalPos);
      this.controls.target.copy(goalTarget);
      this._settling = false;
    } else {
      this.camera.position.lerp(goalPos, k);
      this.controls.target.lerp(goalTarget, k);
    }
    this.controls.update();
  }

  /** The screen axes of the view, for a step across the picture. */
  _screenAxes(dir) {
    const view = dir.clone().normalize();
    const right = new THREE.Vector3().crossVectors(view, new THREE.Vector3(0, 1, 0));
    // A straight-down view gives no right vector, so pick the key axis.
    if (right.lengthSq() < 1e-8) right.set(1, 0, 0);
    right.normalize();
    const up = new THREE.Vector3().crossVectors(right, view).normalize();
    return { right, up };
  }

  /** The height of the window at the focus distance, in scene units. */
  _visibleHeight(distance) {
    return 2 * distance * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
  }

  /** The world vector that moves the view up the screen by VIEW_LIFT. */
  _lift(pos, target) {
    const dir = new THREE.Vector3().subVectors(target, pos).normalize();
    const { up } = this._screenAxes(dir);
    return up.multiplyScalar(this._visibleHeight(pos.distanceTo(target)) * VIEW_LIFT);
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }
}
