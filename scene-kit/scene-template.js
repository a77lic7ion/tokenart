// scene-kit/scene-template.js
//
// A Scene Template is a hand-authored description of a specific place. Unlike city.json (which
// says "a district goes here and the code invents the buildings"), a template names every
// structure: a dome *here*, a spire *there*, a bridge between them. The renderer's job is to
// draw what the template says — nothing is invented.
//
// This file: the template format, a handful of structure builders, and a SceneRenderer that
// draws the whole thing with the SAME instanced-quad + ShaderMaterial as the city. The lock
// stays: CSS-px dot sizing, circular discard, one draw call.
//
// Author a template -> render it. That is the whole deal.

import * as THREE from "../three.module.js";
import { OrbitControls } from "../OrbitControls.js";

// ---------------------------------------------------------------------------
// Template registry. Author new scenes by adding one entry here. Coordinates are
// [x, y, z] with y = 0 at ground level, up is +y.
// ---------------------------------------------------------------------------

const RIPPLE = { cycle: 15, travel: 6, strength: 1.15 };

export const SCENE_TEMPLATES = {
  // Proof of concept: a floating deep-space station. Hex docking platform, a great dome,
  // a communications spire, three minor domes, a connecting conduit between the main dome
  // and the nearest minor dome, a comms array held on masts, and a glowing core.
  "deep-space-station": {
    label: "Deep Space Station",
    summary: "Proof of concept: hex platform, great dome, comms spire, minor domes.",
    background: "#06080d",
    palette: {
      hull: "#cfd6dd",
      structure: "#9aa39e",
      accent: "#d2a869",
      glow: "#6fd6ff",
    },
    camera: [34, 26, 38],
    ambient: 0.04,
    structures: [
      { type: "dock-platform", id: "dock", position: [0, 0, 0], radius: 22, segments: 6 },
      { type: "dome", id: "main-dome", position: [0, 0.4, 0], radius: 7.2, ribCount: 9, baseHeight: 1.2, ribs: true, glowCore: true },
      { type: "spire", id: "comms-spire", position: [11, 0, -6], baseRadius: 1.1, topRadius: 0.45, height: 19, segments: 16, taper: 0.7 },
      { type: "dome", id: "minor-dome-n", position: [-9, 0.2, 7], radius: 3.4, ribs: true },
      { type: "dome", id: "minor-dome-e", position: [12, 0.2, 8], radius: 2.8, ribs: true },
      { type: "dome", id: "minor-dome-s", position: [-11, 0.2, -8], radius: 3.0, ribs: true },
      { type: "conduit", id: "conduit-main-n", from: [0, 0.4, 0], to: [-9, 0.2, 7], radius: 0.7, supports: 5 },
      { type: "mast-array", id: "comms-array", position: [15, 0, -10], count: 5, span: 6, height: 8 },
      { type: "hull-bell", id: "engine-bell", position: [6, -1.2, 12], radius: 3.2, depth: 2.6, segments: 18 },
    ],
  },
};

// ---------------------------------------------------------------------------
// Structure builders. Each returns an array of point specs:
//   { position:[x,y,z], color:[r,g,b], size }
// in LOCAL space — the SceneRenderer positions them via the template's `position`.
// Everything here is surface-biased stippling (edges/corners denser than faces),
// the same rule the city follows.
// ---------------------------------------------------------------------------

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (1664525 * s + 1013904223) >>> 0; return s / 4294967296; };
}

function push(out, x, y, z, color, size) {
  out.push({ position: [x, y, z], color, size });
}

const BUILDERS = {
  "dock-platform": hexPlatform,
  dome,
  spire,
  conduit,
  "mast-array": mastArray,
  "hull-bell": hullBell,
};

function hexPlatform(out, p, seed) {
  const r = rng(seed);
  const { radius } = p;
  const hull = p.colorSet("hull"), structure = p.colorSet("structure");
  // Top surface: rings of points denser toward the rim (silhouette-over-fill).
  for (let ring = 0; ring < 18; ring++) {
    const t = ring / 17;
    const rad = radius * t;
    const circumference = 2 * Math.PI * Math.max(0.4, rad);
    const count = Math.max(8, Math.round(circumference * 1.6));
    const edgeBoost = t > 0.7 ? 1.8 : 1.0;
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 + r() * 0.2;
      const jitter = (r() - 0.5) * 0.35 * edgeBoost;
      push(out, Math.cos(a) * rad + jitter, 0.05 + r() * 0.04, Math.sin(a) * rad + jitter,
        hull, 1.1 + r() * 1.4 * edgeBoost);
    }
  }
  // Rim: a hard stippled edge, denser than the face.
  const rimCount = Math.round(radius * 7);
  for (let i = 0; i < rimCount; i++) {
    const a = (i / rimCount) * Math.PI * 2;
    const rr = radius + (r() - 0.5) * 0.2;
    push(out, Math.cos(a) * rr, 0.02 + r() * 0.06, Math.sin(a) * rr, structure, 1.3);
    push(out, Math.cos(a) * rr, -0.4 - r() * 0.2, Math.sin(a) * rr, structure, 1.0);
  }
  // Underside bell: a concave dish, denser at the rim, sparser at the centre.
  for (let i = 0; i < 520; i++) {
    const a = r() * Math.PI * 2;
    const rr = Math.pow(r(), 0.65) * radius * 0.95;
    const depth = Math.pow(rr / radius, 2) * 1.5;
    push(out, Math.cos(a) * rr, -0.3 - depth, Math.sin(a) * rr, structure, 0.9 + r() * 1.2);
  }
}

function dome(out, p, seed) {
  const r = rng(seed);
  const { radius, ribCount = 0, baseHeight = 0, ribs = false, glowCore = false } = p;
  const hull = p.colorSet("hull"), accent = p.colorSet("accent"), glow = p.colorSet("glow");
  const phiMax = Math.PI / 2 + 0.3;
  const latSteps = 26;
  const longSteps = Math.round(radius * 5);
  for (let i = 0; i < latSteps; i++) {
    const phi = (i / (latSteps - 1)) * phiMax;
    const y = Math.cos(phi);
    const ringR = Math.sin(phi);
    const isRib = ribs && ribCount > 0 && i % Math.max(1, Math.round(latSteps / ribCount)) === 0;
    const edgeBoost = i < 3 || i > latSteps - 4 ? 1.9 : 1.0;
    for (let j = 0; j < longSteps; j++) {
      const theta = (j / longSteps) * Math.PI * 2;
      const rr = radius * ringR;
      const ribBoost = isRib ? 2.0 : 1.0;
      push(out, Math.cos(theta) * rr, baseHeight + y * radius * 0.92, Math.sin(theta) * rr,
        isRib ? accent : hull, 1.1 + r() * 1.2 * edgeBoost * ribBoost);
    }
  }
  if (glowCore) {
    for (let i = 0; i < 240; i++) {
      const a = r() * Math.PI * 2;
      const rr = Math.pow(r(), 0.5) * radius * 0.28;
      const y = radius * 0.32 + r() * 0.3;
      push(out, Math.cos(a) * rr, baseHeight + y, Math.sin(a) * rr, glow, 1.4 + r() * 1.6);
    }
  }
}

function spire(out, p, seed) {
  const r = rng(seed);
  const { baseRadius, topRadius, height, taper } = p;
  const structure = p.colorSet("structure"), accent = p.colorSet("accent");
  const steps = 90;
  for (let i = 0; i < steps; i++) {
    const t = i / (steps - 1);
    const rad = baseRadius + (topRadius - baseRadius) * Math.pow(t, taper || 1);
    const y = t * height;
    const count = Math.max(6, Math.round(rad * 6));
    const edgeBoost = i < 3 || i > steps - 4 ? 1.7 : 1.0;
    for (let j = 0; j < count; j++) {
      const a = (j / count) * Math.PI * 2;
      push(out, Math.cos(a) * rad, y, Math.sin(a) * rad, structure, 1.0 + r() * 1.0 * edgeBoost);
    }
  }
  for (let i = 0; i < 60; i++) {
    push(out, (r() - 0.5) * 0.6, height + r() * 0.8, (r() - 0.5) * 0.6, accent, 1.0 + r() * 1.6);
  }
}

function conduit(out, p, seed) {
  const r = rng(seed);
  const [ax, ay, az] = p.from;
  const [bx, by, bz] = p.to;
  const dx = bx - ax, dy = by - ay, dz = bz - az;
  const len = Math.hypot(dx, dy, dz);
  const structure = p.colorSet("structure");
  const steps = Math.max(8, Math.round(len * 1.8));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = ax + dx * t, y = ay + dy * t, z = az + dz * t;
    const rad = p.radius || 0.6;
    const count = 7;
    for (let j = 0; j < count; j++) {
      const a = (j / count) * Math.PI * 2;
      push(out, x + Math.cos(a) * rad, y + Math.sin(a) * rad, z, structure, 0.8 + r() * 0.7);
    }
  }
  const strutCount = p.supports || 0;
  for (let s = 1; s <= strutCount; s++) {
    const t = s / (strutCount + 1);
    const x = ax + dx * t, z = az + dz * t;
    const yGround = -3.2;
    const yTop = ay + dy * t;
    const sub = 8;
    for (let i = 0; i <= sub; i++) {
      const tt = i / sub;
      push(out, x + (r() - 0.5) * 0.06, yTop + (yGround - yTop) * tt, z + (r() - 0.5) * 0.06, structure, 0.8);
    }
  }
}

function mastArray(out, p, seed) {
  const r = rng(seed);
  const { count, span, height } = p;
  const [ox, , oz] = p.position;
  const structure = p.colorSet("structure"), glow = p.colorSet("glow");
  for (let m = 0; m < count; m++) {
    const t = count > 1 ? m / (count - 1) : 0.5;
    const x = ox + (t - 0.5) * span;
    const z = oz + (r() - 0.5) * 0.5;
    const steps = Math.round(height * 1.6);
    for (let i = 0; i < steps; i++) {
      const tt = i / steps;
      push(out, x + (r() - 0.5) * 0.06, tt * height, z + (r() - 0.5) * 0.06, structure, 0.85);
    }
    push(out, x, height + 0.2, z, glow, 1.8 + r());
  }
}

function hullBell(out, p, seed) {
  const r = rng(seed);
  const { radius, depth } = p;
  const hull = p.colorSet("hull");
  const steps = 30;
  for (let i = 0; i < steps; i++) {
    const t = i / (steps - 1);
    const y = -t * depth;
    const rad = radius * Math.sqrt(1 - t) * 1.05;
    const count = Math.round(rad * 5);
    for (let j = 0; j < count; j++) {
      const a = (j / count) * Math.PI * 2;
      push(out, Math.cos(a) * rad, y, Math.sin(a) * rad, hull, 0.9 + r() * 1.2);
    }
  }
}

// ---------------------------------------------------------------------------
// SceneRenderer: turns a template into one instanced point cloud with the SAME
// locked shader (CSS-px sizing, circular discard, one draw call).
// ---------------------------------------------------------------------------

function buildPoints(template) {
  const points = [];
  const palette = Object.values(template.palette);
  const colorFor = (name) => {
    const c = template.palette[name] || template.palette.hull;
    const col = new THREE.Color(c);
    return [col.r, col.g, col.b];
  };

  const colorCache = {};
  const col = (name) => {
    if (!colorCache[name]) colorCache[name] = colorFor(name);
    return colorCache[name];
  };

  template.structures.forEach((spec, idx) => {
    const builder = BUILDERS[spec.type];
    if (!builder) return;
    const localPoints = [];
    const colorName = spec.color || "hull";
    const specWithColor = { ...spec, color: col(colorName), colorSet: col };
    builder(localPoints, specWithColor, idx * 997 + 17);
    // Place them in world space.
    const [ox, oy, oz] = spec.position || [0, 0, 0];
    for (const pt of localPoints) {
      points.push({
        position: [pt.position[0] + ox, pt.position[1] + oy, pt.position[2] + oz],
        color: pt.color,
        size: pt.size,
      });
    }
  });
  return points;
}

export function createSceneRenderer({ container, template, cameraPosition }) {
  const points = buildPoints(template);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(template.background || "#06080d");

  const camera = new THREE.PerspectiveCamera(32, innerWidth / innerHeight, 0.1, 600);
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  container.appendChild(renderer.domElement);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.07;
  controls.target.set(0, 4, 0);

  // One shared quad + shader, exactly like the city. Reuse the same material factory.
  const geometry = createDotGeometry();
  const material = createDotMaterial(innerHeight, template.palette.glow || "#ffffff");
  const mesh = createPointCloud(points, geometry, material);
  scene.add(mesh);

  // Subtle ground glow to place it in space.
  const ambient = new THREE.AmbientLight(0xffffff, template.ambient ?? 0.04);
  scene.add(ambient);

  camera.position.set(...(cameraPosition || template.camera || [30, 24, 30]));

  const reduceMotion =
    typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  let pulsing = !reduceMotion;
  material.uniforms.uPulse.value = pulsing ? 1 : 0;

  const resize = () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
    material.uniforms.uResolutionY.value = innerHeight;
  };
  addEventListener("resize", resize);

  let raf = 0;
  const animate = () => {
    raf = requestAnimationFrame(animate);
    if (pulsing) material.uniforms.uTime.value = performance.now() / 1000;
    controls.update();
    renderer.render(scene, camera);
  };
  animate();

  return {
    scene, camera, renderer, controls,
    get pointCount() { return points.length; },
    get template() { return template; },
    setPulse(on) {
      pulsing = !!on;
      material.uniforms.uPulse.value = pulsing ? 1 : 0;
    },
    dispose() {
      cancelAnimationFrame(raf);
      removeEventListener("resize", resize);
      controls.dispose();
      renderer.dispose();
      geometry.dispose();
      material.dispose();
      mesh.geometry.dispose();
      container.removeChild(renderer.domElement);
    },
  };
}

// --- duplicated here to keep scene-kit self-contained; locked shader, no changes ---
function createDotGeometry() {
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute([
    -0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0,
  ], 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  return g;
}

function createPointCloud(points, geometry, material) {
  const mesh = new THREE.Mesh(geometry.clone(), material);
  const offsets = new Float32Array(points.length * 3);
  const colors = new Float32Array(points.length * 3);
  const sizes = new Float32Array(points.length);
  points.forEach((pt, i) => {
    offsets.set(pt.position, i * 3);
    colors.set(pt.color, i * 3);
    sizes[i] = pt.size;
  });
  mesh.geometry.instanceCount = points.length;
  mesh.geometry.setAttribute("instanceOffset", new THREE.InstancedBufferAttribute(offsets, 3));
  mesh.geometry.setAttribute("instanceColor", new THREE.InstancedBufferAttribute(colors, 3));
  mesh.geometry.setAttribute("instanceSize", new THREE.InstancedBufferAttribute(sizes, 1));
  return mesh;
}

function createDotMaterial(resolutionY, glowColor) {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: {
      uResolutionY: { value: resolutionY },
      uTime: { value: 0 },
      uPulse: { value: 1 },
      uRippleRadius: { value: 40 },
      uRippleCycle: { value: RIPPLE.cycle },
      uRippleTravel: { value: RIPPLE.travel },
      uRippleStrength: { value: RIPPLE.strength },
      uRippleColor: { value: new THREE.Color(glowColor || "#6fd6ff") },
    },
    vertexShader: `
      attribute vec3 instanceOffset;
      attribute vec3 instanceColor;
      attribute float instanceSize;
      varying vec3 vColor;
      varying vec2 vUv;
      varying float vGlow;
      uniform float uResolutionY;
      uniform float uTime;
      uniform float uPulse;
      uniform float uRippleRadius;
      uniform float uRippleCycle;
      uniform float uRippleTravel;
      uniform float uRippleStrength;
      uniform vec3 uRippleColor;
      void main() {
        vec4 viewPosition = modelViewMatrix * vec4(instanceOffset, 1.0);
        float worldPerPixel = 2.0 * abs(viewPosition.z) * tan(radians(16.0)) / uResolutionY;
        float t = mod(uTime, uRippleCycle);
        float progress = clamp(t / uRippleTravel, 0.0, 1.0);
        float radius = progress * uRippleRadius;
        float distanceFromCentre = length(instanceOffset.xz);
        float band = max(1.6, uRippleRadius * 0.085);
        float offset = (distanceFromCentre - radius) / band;
        float ring = exp(-offset * offset);
        float alive = step(t, uRippleTravel);
        float glow = ring * alive * uPulse * (1.0 - 0.55 * progress);
        float swell = 1.0 + glow * uRippleStrength;
        viewPosition.xy += position.xy * instanceSize * swell * worldPerPixel;
        gl_Position = projectionMatrix * viewPosition;
        vColor = mix(instanceColor, uRippleColor, clamp(glow, 0.0, 1.0) * 0.9);
        vUv = uv;
        vGlow = glow;
      }
    `,
    fragmentShader: `
      varying vec3 vColor;
      varying vec2 vUv;
      varying float vGlow;
      void main() {
        vec2 centered = vUv - 0.5;
        if (dot(centered, centered) > 0.25) discard;
        gl_FragColor = vec4(vColor, 0.9 + 0.1 * clamp(vGlow, 0.0, 1.0));
      }
    `,
  });
}