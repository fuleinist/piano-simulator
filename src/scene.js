import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { BOARD_W } from './layout.js';

// Camera presets. "top" is the default: a steep overhead view of the keyboard.
export const PRESETS = {
  top: { pos: [0, 46, 17], target: [0, 0, -1] },
  perform: { pos: [0, 34, 30], target: [0, 1, -1] },
  front: { pos: [0, 7, 33], target: [0, 1.5, 0] },
  side: { pos: [36, 15, 20], target: [0, 1, 0] },
  close: { pos: [6, 13, 15], target: [4, 0.5, 1] },
};

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
    const p = PRESETS[name] || PRESETS.top;
    this._goal = { pos: new THREE.Vector3(...p.pos), target: new THREE.Vector3(...p.target) };
    if (instant) {
      this.camera.position.copy(this._goal.pos);
      this.controls.target.copy(this._goal.target);
      this._goal = null;
    }
  }

  panBy(dx) {
    this.camera.position.x += dx;
    this.controls.target.x += dx;
    this._goal = null;
  }

  zoomBy(factor) {
    const dir = new THREE.Vector3().subVectors(this.camera.position, this.controls.target);
    const len = THREE.MathUtils.clamp(dir.length() * factor, this.controls.minDistance, this.controls.maxDistance);
    dir.setLength(len);
    this.camera.position.copy(this.controls.target).add(dir);
    this._goal = null;
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  update(dt) {
    if (this._goal) {
      const k = 1 - Math.pow(0.001, dt); // smooth approach
      this.camera.position.lerp(this._goal.pos, k);
      this.controls.target.lerp(this._goal.target, k);
      if (this.camera.position.distanceTo(this._goal.pos) < 0.05) this._goal = null;
    }
    this.controls.update();
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }
}