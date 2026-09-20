import * as THREE from "three";
import {
  CSS3DRenderer,
  CSS3DObject,
} from "three/addons/renderers/CSS3DRenderer.js";
import { dimensions, type Monitor } from "./model";
export class DesktopScene {
  private scene = new THREE.Scene();
  private cssScene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(45, 1, 0.1, 150);
  private gl: THREE.WebGLRenderer | null = null;
  private css = new CSS3DRenderer();
  private objects = new Map<
    string,
    { css: CSS3DObject; mesh: THREE.Mesh; edges: THREE.LineSegments }
  >();
  private dirty = true;
  private view = 1;
  private orbit = 0;
  private y = 1.4;
  private baseDistance = 10;
  private observer: ResizeObserver;
  private frame = 0;
  private disposed = false;
  constructor(private host: HTMLElement) {
    try {
      this.gl = new THREE.WebGLRenderer({ antialias: true, alpha: true });
      this.gl.setPixelRatio(Math.min(devicePixelRatio, 1.75));
      this.gl.domElement.className = "world-canvas";
      host.append(this.gl.domElement);
    } catch {
      host.classList.add("no-webgl");
    }
    this.scene.fog = new THREE.FogExp2("#10191d", 0.035);
    const grid = new THREE.GridHelper(100, 100, "#384940", "#202c2b");
    grid.position.y = -1.8;
    this.scene.add(grid);
    const mat = new THREE.MeshBasicMaterial({
      color: "#15221f",
      transparent: true,
      opacity: 0.5,
    });
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(150, 150), mat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -1.82;
    this.scene.add(floor);
    this.css.domElement.className = "css-world";
    host.append(this.css.domElement);
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(host);
    let last: { x: number; y: number } | null = null;
    host.addEventListener("pointerdown", (e) => {
      if (e.target === host || e.target === this.css.domElement || e.altKey) {
        last = { x: e.clientX, y: e.clientY };
        host.setPointerCapture(e.pointerId);
        e.preventDefault();
      }
    });
    host.addEventListener("pointermove", (e) => {
      if (!last) return;
      this.orbit = Math.max(
        -0.65,
        Math.min(0.65, this.orbit + (e.clientX - last.x) * 0.003),
      );
      this.y = Math.max(-1, Math.min(5, this.y + (e.clientY - last.y) * 0.008));
      last = { x: e.clientX, y: e.clientY };
      this.updateCamera();
    });
    host.addEventListener("pointerup", () => (last = null));
    host.addEventListener("pointercancel", () => (last = null));
    host.addEventListener(
      "wheel",
      (e) => {
        if (e.target === host || e.target === this.css.domElement || e.altKey) {
          e.preventDefault();
          this.zoom(e.deltaY * 0.001);
        }
      },
      { passive: false },
    );
    const tick = () => {
      if (this.disposed) return;
      this.frame = requestAnimationFrame(tick);
      if (this.dirty && !document.hidden) {
        this.gl?.render(this.scene, this.camera);
        this.css.render(this.cssScene, this.camera);
        this.dirty = false;
      }
    };
    tick();
    this.resize();
  }
  wireSpatial(bar: HTMLElement, handle: HTMLElement, m: Monitor, enabled: () => boolean, changed: () => void, finished: () => void) {
    for (const [target, resizing] of [[bar, false], [handle, true]] as const) {
      let start: { x: number; y: number; offset: number; height: number; diagonal: number; scale: number; width: number } | null = null;
      target.addEventListener('pointerdown', e => {
        if (!enabled() || e.altKey || e.button !== 0 || (!resizing && (e.target as HTMLElement).closest('button,input,select'))) return;
        const o = this.objects.get(m.id); if (!o) return;
        const depth = o.css.position.distanceTo(this.camera.position);
        start = { x: e.clientX, y: e.clientY, offset: m.offset, height: m.height, diagonal: m.diagonal,
          scale: 2 * depth * Math.tan(THREE.MathUtils.degToRad(22.5)) / this.host.clientHeight,
          width: Math.max(40, o.css.element.getBoundingClientRect().width) };
        target.setPointerCapture(e.pointerId); e.preventDefault(); e.stopPropagation();
        document.body.classList.add('window-dragging');
      });
      target.addEventListener('pointermove', e => {
        if (!start) return;
        const dx = e.clientX - start.x, dy = e.clientY - start.y;
        if (resizing) m.diagonal = Math.max(20, Math.min(Number.MAX_SAFE_INTEGER, start.diagonal * (1 + (dx + dy) / start.width)));
        else { m.offset = Math.max(-3, Math.min(3, start.offset + dx * start.scale)); m.height = Math.max(-2, Math.min(3, start.height - dy * start.scale)); }
        changed();
      });
      const finish = () => { if (!start) return; start = null; document.body.classList.remove('window-dragging'); finished(); };
      target.addEventListener('pointerup', finish); target.addEventListener('pointercancel', finish); target.addEventListener('lostpointercapture', finish);
    }
  }
  resize() {
    const w = this.host.clientWidth,
      h = this.host.clientHeight;
    if (!w || !h) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.gl?.setSize(w, h);
    this.css.setSize(w, h);
    this.updateCamera();
  }
  private updateCamera() {
    const d = this.baseDistance * this.view;
    this.camera.position.set(
      Math.sin(this.orbit) * d,
      this.y,
      Math.cos(this.orbit) * d,
    );
    this.camera.lookAt(0, 0.7, -0.4);
    this.dirty = true;
  }
  zoom(delta: number) {
    this.view = Math.max(0.5, Math.min(2, this.view + delta));
    this.updateCamera();
  }
  reset() {
    this.view = 1;
    this.orbit = 0;
    this.y = 1.4;
    this.updateCamera();
  }
  update(
    monitors: Monitor[],
    elements: Map<string, HTMLElement>,
    selected: string,
    arc: number,
  ) {
    for (const [key, o] of this.objects)
      if (!monitors.some((m) => m.id === key)) {
        this.cssScene.remove(o.css);
        this.scene.remove(o.mesh, o.edges);
        o.mesh.geometry.dispose();
        (o.mesh.material as THREE.Material).dispose();
        o.edges.geometry.dispose();
        (o.edges.material as THREE.Material).dispose();
        this.objects.delete(key);
      }
    // Stable layout/camera framing: enlarging a window must not zoom everything out.
    const widths = monitors.map((m) => dimensions({ ...m, diagonal: 32 }).w);
    const total =
      widths.reduce((a, b) => a + b, 0) + (monitors.length - 1) * 0.24;
    let x = -total / 2;
    monitors.forEach((m, i) => {
      const { w, h } = dimensions(m);
      let o = this.objects.get(m.id);
      if (!o) {
        const wrapper = document.createElement("div");
        wrapper.className = "monitor-anchor";
        wrapper.dataset.anchorId = m.id;
        wrapper.append(elements.get(m.id)!);
        const css = new CSS3DObject(wrapper);
        const mesh = new THREE.Mesh(
          new THREE.BoxGeometry(1, 1, 0.06),
          new THREE.MeshBasicMaterial({ color: "#1d2b2a" }),
        );
        const edges = new THREE.LineSegments(
          new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 0.065)),
          new THREE.LineBasicMaterial({ color: "#536357" }),
        );
        o = { css, mesh, edges };
        this.objects.set(m.id, o);
        this.cssScene.add(css);
        this.scene.add(mesh, edges);
      }
      const cx = x + widths[i] / 2;
      x += widths[i] + 0.24;
      const yaw = THREE.MathUtils.degToRad(
        (i - (monitors.length - 1) / 2) * -arc + m.yaw,
      );
      const z = -m.distance - Math.abs(cx) * 0.1;
      const pos = new THREE.Vector3(cx + m.offset, 0.9 + m.height, z);
      o.css.position.copy(pos);
      o.css.rotation.set(THREE.MathUtils.degToRad(m.pitch), yaw, 0);
      o.css.scale.setScalar(w / 600);
      o.css.element.style.width = "600px";
      o.css.element.style.height = `${(600 * h) / w}px`;
      elements.get(m.id)!.classList.toggle("selected", m.id === selected);
      o.mesh.position.copy(pos);
      o.mesh.position.z -= 0.075;
      o.mesh.rotation.copy(o.css.rotation);
      o.mesh.scale.set(w + 0.035, h + 0.035, 1);
      o.edges.position.copy(o.mesh.position);
      o.edges.rotation.copy(o.mesh.rotation);
      o.edges.scale.copy(o.mesh.scale);
      (o.edges.material as THREE.LineBasicMaterial).color.set(
        m.id === selected ? "#c2ed90" : "#536357",
      );
    });
    this.baseDistance = Math.max(
      6.6,
      (total /
        (2 * Math.tan(THREE.MathUtils.degToRad(22.5)) * this.camera.aspect)) *
        1.13,
      (Math.max(...monitors.map((m) => dimensions({ ...m, diagonal: 32 }).h)) /
        (2 * Math.tan(THREE.MathUtils.degToRad(22.5)))) *
        1.4,
    );
    this.updateCamera();
  }
  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    this.observer.disconnect();
    this.scene.traverse((o) => {
      if (o instanceof THREE.Mesh || o instanceof THREE.LineSegments) {
        o.geometry.dispose();
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        mats.forEach((m) => m.dispose());
      }
    });
    this.gl?.dispose();
  }
}
