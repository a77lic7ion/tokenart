// procedural-city-renderer.js
// Three.js r186 point-cloud renderer for the data from procedural-city-data.js.
//
// Two themes and per-district visibility are supported. Both rebuild the point cloud while
// preserving the camera, so the view does not jump when you toggle something.

import * as THREE from "./three.module.js";
import { OrbitControls } from "./OrbitControls.js";

// A theme owns its background, its ground-plane tint and its dot palette. Adding a theme =
// adding one entry here; nothing else needs to know about it.
export const THEMES = {
  light: {
    background: "#f4efe5",
    ground: "#f4efe5",
    // 'ripple' is the colour a dot shifts toward as the travelling wave passes over it.
    palette: { ink: "#171a1a", softInk: "#394341", soil: "#7b8178", teal: "#5faaa3", amber: "#c49a5e", ripple: "#a9551f" },
  },
  dark: {
    background: "#14171a",
    ground: "#14171a",
    palette: { ink: "#ece7dc", softInk: "#9aa39e", soil: "#6f7772", teal: "#6fbcb4", amber: "#d2a869", ripple: "#ffd9a0" },
  },
};

// The travelling ripple: a ring that spreads from the centre of the island once per cycle,
// lighting whatever it touches. See createDotMaterial() for the wave itself.
export const RIPPLE = {
  cycle: 15,      // seconds between ripples
  travel: 6,      // seconds the wave takes to cross the map
  strength: 1.15, // how much a dot swells at the wavefront (1.15 = +115%)
};

export const THEME_NAMES = Object.keys(THEMES);

export function resolveTheme(name) {
  return THEMES[name] ? name : THEME_NAMES[0];
}

/** Legend swatch colours for a theme, so the on-screen key tracks the scene. */
export function legendHex(name) {
  return THEMES[resolveTheme(name)].palette;
}

// Maps a project's accent to the colour key actually used when rendering.
export function accentKey(project) {
  return project.accent === "amber" ? "amber" : project.accent === "teal" ? "teal" : "ink";
}

function paletteFor(name) {
  const out = {};
  for (const [key, hex] of Object.entries(THEMES[resolveTheme(name)].palette)) {
    out[key] = new THREE.Color(hex);
  }
  return out;
}

function random(seed) {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

function addPoint(points, x, y, z, color, size = 2) {
  points.push({ position: [x, y, z], color: color.toArray(), size });
}

function createDotGeometry() {
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute([
    -0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0,
  ], 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  return geometry;
}

function createDotMaterial(resolutionY) {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: {
      uResolutionY: { value: resolutionY },
      // One clock drives every animated thing in the scene.
      uTime: { value: 0 },
      // Master motion switch: 1 normally, 0 when motion is not wanted (system asking for
      // reduced motion, or setPulse(false)).
      uPulse: { value: 1 },
      // Ripple shaped by the island size, so it always crosses the whole map.
      uRippleRadius: { value: 26 },
      uRippleCycle: { value: RIPPLE.cycle },
      uRippleTravel: { value: RIPPLE.travel },
      uRippleStrength: { value: RIPPLE.strength },
      uRippleColor: { value: new THREE.Color("#a9551f") },
    },
    vertexShader: `
      attribute vec3 instanceOffset;
      attribute vec3 instanceColor;
      attribute float instanceSize;
      // NOTE: do not redeclare uv - ShaderMaterial's vertex prefix already provides it.
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
        // CSS-pixel dot sizing: constant on-screen size at any depth & any devicePixelRatio.
        float worldPerPixel = 2.0 * abs(viewPosition.z) * tan(radians(16.0)) / uResolutionY;

        // ---- the ripple ----
        // A single ring spreading out from the centre of the island. It runs for uRippleTravel
        // seconds, then the map rests until the next cycle.
        float t = mod(uTime, uRippleCycle);
        float progress = clamp(t / uRippleTravel, 0.0, 1.0);
        float radius = progress * uRippleRadius;
        float distanceFromCentre = length(instanceOffset.xz);
        float band = max(1.6, uRippleRadius * 0.085);
        float offset = (distanceFromCentre - radius) / band;
        float ring = exp(-offset * offset);
        // The wave only exists while it is travelling, and loses energy as it spreads.
        float alive = step(t, uRippleTravel);
        float glow = ring * alive * uPulse * (1.0 - 0.55 * progress);

        // Dots swell and warm up as the wavefront reaches them.
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
        // A lit dot is also fully opaque, so the wave reads as light rather than a tint.
        gl_FragColor = vec4(vColor, 0.9 + 0.1 * clamp(vGlow, 0.0, 1.0));
      }
    `,
  });
}

function createPointCloud(points, geometry, material) {
  const mesh = new THREE.Mesh(geometry.clone(), material);
  const offsets = new Float32Array(points.length * 3);
  const colors = new Float32Array(points.length * 3);
  const sizes = new Float32Array(points.length);
  points.forEach((point, index) => {
    offsets.set(point.position, index * 3);
    colors.set(point.color, index * 3);
    sizes[index] = point.size;
  });
  mesh.geometry.instanceCount = points.length;
  mesh.geometry.setAttribute("instanceOffset", new THREE.InstancedBufferAttribute(offsets, 3));
  mesh.geometry.setAttribute("instanceColor", new THREE.InstancedBufferAttribute(colors, 3));
  mesh.geometry.setAttribute("instanceSize", new THREE.InstancedBufferAttribute(sizes, 1));
  mesh.userData.pointCount = points.length;
  return mesh;
}

function sampleLine(points, from, to, count, color, width = 0.035, seed = 1) {
  for (let i = 0; i < count; i++) {
    const t = i / Math.max(1, count - 1);
    const jitter = (random(i * 7 + seed) - 0.5) * width;
    addPoint(points,
      THREE.MathUtils.lerp(from.x, to.x, t) + jitter,
      0.035 + (random(i * 11 + seed) - 0.5) * width,
      THREE.MathUtils.lerp(from.z, to.z, t) + jitter,
      color,
      1.25 + random(i * 3 + seed) * 1.2,
    );
  }
}

function sampleTerrain(points, config, pal) {
  const half = config.size / 2;
  // Density scales with the island so stipple coverage stays constant as the city expands —
  // a fixed grid would thin the ground out every time a district is added.
  const scale = Math.max(1, config.size / 34);
  const density = Math.round(22 * scale);
  const edgeCount = Math.round(1200 * scale);
  for (let ix = 0; ix < density; ix++) {
    for (let iz = 0; iz < density; iz++) {
      const x = -half + (ix / (density - 1)) * config.size;
      const z = -half + (iz / (density - 1)) * config.size;
      const edge = Math.min(ix, iz, density - 1 - ix, density - 1 - iz);
      const count = edge < 3 ? 2 : 1;
      for (let j = 0; j < count; j++) {
        const jitter = (random(ix * 101 + iz * 17 + j) - 0.5) * 0.5;
        addPoint(points, x + jitter, -0.15 - Math.max(0, 2.3 - edge) * 0.05, z + jitter,
          edge < 4 ? pal.soil : pal.softInk, 1.2 + random(j + ix * 3) * 1.4);
      }
    }
  }
  // Soil underside / eroded edge.
  for (let i = 0; i < edgeCount; i++) {
    const side = i % 4;
    const t = random(i * 3);
    const depth = random(i * 13) * 1.5;
    const halfEdge = half + 0.1;
    const x = side === 0 ? -halfEdge + t * config.size : side === 1 ? halfEdge : side === 2 ? -halfEdge + t * config.size : -halfEdge;
    const z = side === 0 ? -halfEdge : side === 1 ? -halfEdge + t * config.size : side === 2 ? halfEdge : -halfEdge + t * config.size;
    addPoint(points, x, -0.25 - depth, z, pal.soil, 1.1 + random(i) * 2);
  }
}

// Vertical growth. A district with tier > 0 is raised onto a deck this far above the one below,
// so the city can grow UP as well as out. Tier 0 is the original ground level.
const LEVEL_HEIGHT = 2.4;

function sampleBuildingSurface(points, building, color, seed, baseY = 0) {
  const { center, footprint, height, completeness, family } = building;
  const baseCount = Math.floor(120 + 440 * completeness);
  const width = footprint.width;
  const depth = footprint.depth;
  const rotation = building.orientation;
  const rotate = (x, z) => ({
    x: center.x + x * Math.cos(rotation) - z * Math.sin(rotation),
    z: center.z + x * Math.sin(rotation) + z * Math.cos(rotation),
  });

  for (let i = 0; i < baseCount; i++) {
    const face = i % 6;
    const u = random(i * 5 + seed) - 0.5;
    const v = random(i * 11 + seed) - 0.5;
    const level = random(i * 17 + seed);
    const edgeBias = Math.pow(random(i * 19 + seed), 0.52);
    const edge = edgeBias > 0.66 ? 0.5 : 0.38 + edgeBias * 0.1;
    let localX = u * width;
    let localY = level * height;
    let localZ = v * depth;
    if (face === 0) localZ = edge * depth;
    if (face === 1) localZ = -edge * depth;
    if (face === 2) localX = edge * width;
    if (face === 3) localX = -edge * width;
    if (face === 4) localY = height * edgeBias;
    if (face === 5) localY = 0.05;
    const rotated = rotate(localX, localZ);
    addPoint(points, rotated.x, baseY + 0.06 + localY, rotated.z, color, 1.15 + random(i + 3) * 1.8);

    if (family === "tower" && i % 5 === 0) {
      const tower = rotate(localX * 0.25, localZ * 0.25);
      addPoint(points, tower.x, baseY + 0.08 + height + random(i) * 0.7, tower.z, color, 1.2 + random(i) * 1.3);
    }
    if (family === "dome" && i % 4 === 0) {
      const domeT = random(i * 23 + seed);
      const domeRadius = Math.min(width, depth) * 0.42;
      const angle = random(i * 29 + seed) * Math.PI * 2;
      const domeR = domeRadius * Math.sqrt(domeT);
      const dome = rotate(Math.cos(angle) * domeR, Math.sin(angle) * domeR);
      addPoint(points, dome.x, baseY + 0.08 + height + Math.sqrt(Math.max(0, domeRadius ** 2 - domeR ** 2)) * 0.6, dome.z, color, 1.3 + random(i) * 1.4);
    }
  }
}

function sampleTrees(points, trees, seed, pal, baseY = 0) {
  trees.forEach((tree, index) => {
    const trunkCount = Math.max(5, Math.floor(10 * tree.completeness));
    for (let i = 0; i < trunkCount; i++) {
      const t = i / trunkCount;
      addPoint(points, tree.position.x + (random(i + seed) - 0.5) * 0.06, baseY + 0.05 + t * tree.height, tree.position.z + (random(i * 2 + seed) - 0.5) * 0.06, pal.softInk, 1.1 + random(i) * 1.2);
    }
    const leafCount = Math.floor(18 * tree.completeness);
    for (let i = 0; i < leafCount; i++) {
      const angle = random(i * 5 + index + seed) * Math.PI * 2;
      const radius = Math.sqrt(random(i * 7 + seed)) * tree.canopy;
      addPoint(points,
        tree.position.x + Math.cos(angle) * radius,
        baseY + 0.05 + tree.height + (random(i * 13 + seed) - 0.5) * tree.canopy,
        tree.position.z + Math.sin(angle) * radius,
        pal.ink,
        1.1 + random(i * 2 + seed) * 1.6,
      );
    }
  });
}

/**
 * A raised platform for a district on an upper tier: a stippled rim, a sparse deck grid, and
 * support columns running down to the level below. Without the rim a raised district just looks
 * like buildings floating in the air.
 */
function sampleDeck(points, project, tier, pal, seed) {
  const y = tier * LEVEL_HEIGHT;
  const halfWidth = project.size.width / 2;
  const halfDepth = project.size.depth / 2;
  const inset = 0.55;
  const w = Math.max(0.5, halfWidth - inset);
  const d = Math.max(0.5, halfDepth - inset);
  const corners = [
    { x: project.origin.x - w, z: project.origin.z - d },
    { x: project.origin.x + w, z: project.origin.z - d },
    { x: project.origin.x + w, z: project.origin.z + d },
    { x: project.origin.x - w, z: project.origin.z + d },
  ];

  // Rim: denser points along the deck edge, sparse across the middle — the same
  // silhouette-over-fill rule the rest of the scene follows.
  for (let edge = 0; edge < 4; edge++) {
    const from = corners[edge];
    const to = corners[(edge + 1) % 4];
    const span = Math.hypot(to.x - from.x, to.z - from.z);
    const count = Math.round(span * 13);
    for (let i = 0; i < count; i++) {
      const t = i / count;
      addPoint(points,
        THREE.MathUtils.lerp(from.x, to.x, t) + (random(i * 3 + seed + edge) - 0.5) * 0.09,
        y + (random(i * 7 + seed) - 0.5) * 0.06,
        THREE.MathUtils.lerp(from.z, to.z, t) + (random(i * 11 + seed + edge) - 0.5) * 0.09,
        pal.softInk, 1.05 + random(i + edge) * 1.1);
    }
  }

  // Deck grid: lightly inset, deliberately sparser than the rim.
  for (let gx = -2; gx <= 2; gx++) {
    for (let gz = -2; gz <= 2; gz++) {
      const x = project.origin.x + (gx / 2) * w * 0.82;
      const z = project.origin.z + (gz / 2) * d * 0.82;
      for (let k = 0; k < 3; k++) {
        addPoint(points,
          x + (random(gx * 31 + gz * 17 + k + seed) - 0.5) * 0.3,
          y - 0.02,
          z + (random(gx * 13 + gz * 29 + k + seed) - 0.5) * 0.3,
          pal.soil, 0.95 + random(k + gx) * 0.9);
      }
    }
  }

  // Support columns at each corner, plus a midpoint on the long sides.
  const columns = [...corners];
  columns.push({ x: project.origin.x, z: project.origin.z - d });
  columns.push({ x: project.origin.x, z: project.origin.z + d });
  for (const column of columns) {
    const height = y - 0.1;
    const steps = Math.max(6, Math.round(height * 7));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      addPoint(points,
        column.x + (random(i * 5 + seed + column.x) - 0.5) * 0.07,
        t * height,
        column.z + (random(i * 9 + seed + column.z) - 0.5) * 0.07,
        pal.softInk, 1.0 + random(i) * 0.9);
    }
  }
}

export function createCityRenderer({
  container,
  cityData,
  theme = "light",
  visibleIds = null,          // null = every district visible
  cameraPosition = [27, 24, 30],
}) {
  const state = {
    theme: resolveTheme(theme),
    visible: visibleIds ? new Set(visibleIds) : null,
  };

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(32, innerWidth / innerHeight, 0.1, 400);
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  container.appendChild(renderer.domElement);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.07;
  controls.target.set(0, 0.5, 0);

  // The island grows as districts are added and as fresh usage arrives, so the framing and the
  // orbit limits are derived from the current island size rather than captured once. Recomputed
  // whenever the city data changes.
  let islandScale = 1;
  let defaultCamera = [27, 24, 30];
  let framingApplied = false;
  function recomputeFraming() {
    islandScale = Math.max(1, (cityData.config?.size ?? 34) / 34);
    defaultCamera = [27, 24, 30].map((value) => value * islandScale);
    controls.minDistance = 14 * Math.min(islandScale, 1.6);
    controls.maxDistance = 70 * islandScale;
    if (!framingApplied) {
      camera.position.set(...(cameraPosition ? cameraPosition.map((v) => v * islandScale) : defaultCamera));
      framingApplied = true;
    }
  }
  recomputeFraming();

  const geometry = createDotGeometry();
  const material = createDotMaterial(innerHeight);

  // The constant breathing is on by default, but never against the system's wishes: if the user
  // has asked for reduced motion, the wave is simply left at zero.
  const reduceMotion =
    typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  let pulsing = !reduceMotion;
  material.uniforms.uPulse.value = pulsing ? 1 : 0;

  // A subtle ground plane makes the point cloud feel placed on terrain instead of floating.
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(cityData.config.size + 3, cityData.config.size + 3),
    new THREE.MeshBasicMaterial({ color: 0xf4efe5, transparent: true, opacity: 0.18, depthWrite: false }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.26;
  scene.add(ground);

  let city = null;
  let pointCount = 0;
  let lastCounts = {};
  let revealedCount = 0;
  let fullPointCount = 0;
  let building = false;
  let buildStart = 0;
  let buildDuration = 5000;

  /** Rebuild the point cloud in place. The camera is untouched, so toggles never jump the view. */
  function rebuild({ animate = false } = {}) {
    const pal = paletteFor(state.theme);
    const definition = THEMES[state.theme];
    scene.background = new THREE.Color(definition.background);
    ground.material.color = new THREE.Color(definition.ground);

    // Size the ripple to the island so it always sweeps the whole map, and re-tint it with the
    // theme — a wave has to read as light on cream ground and on charcoal.
    material.uniforms.uRippleRadius.value = (cityData.config?.size ?? 34) * 0.8;
    material.uniforms.uRippleColor.value.copy(pal.ripple);

    const points = [];
    const counts = {};

    sampleTerrain(points, cityData.config, pal);
    cityData.roads.forEach((road, index) => {
      sampleLine(points, road.from, road.to,
        road.kind === "boulevard" ? 220 : 85,
        road.kind === "boulevard" ? pal.ink : pal.softInk,
        road.width, index * 31 + 1);
    });

    cityData.districts.forEach((district, districtIndex) => {
      if (state.visible && !state.visible.has(district.id)) {
        counts[district.id] = 0;
        return;
      }
      const before = points.length;
      const color = pal[accentKey(district.project)];
      // Vertical growth: a district may sit on an upper tier. Sideways growth is handled by
      // fitConfig() in the data layer, which sizes the island to hold every district.
      const tier = Math.max(0, Math.round(district.project.tier ?? 0));
      const baseY = tier * LEVEL_HEIGHT;
      if (tier > 0) sampleDeck(points, district.project, tier, pal, districtIndex * 137 + 11);
      district.buildings.forEach((building, buildingIndex) =>
        sampleBuildingSurface(points, building, color, districtIndex * 901 + buildingIndex * 17, baseY));
      sampleTrees(points, district.trees, districtIndex * 701, pal, baseY);
      counts[district.id] = points.length - before;
    });

    if (city) {
      scene.remove(city);
      city.geometry.dispose();
    }
    city = createPointCloud(points, geometry, material);
    scene.add(city);

    pointCount = points.length;
    lastCounts = counts;
    fullPointCount = points.length;

    if (animate) {
      revealedCount = 0;
      building = true;
      buildStart = performance.now();
      city.geometry.instanceCount = 0; // the reveal loop ramps this up
    } else {
      // Toggling a theme or a district must be instant — not a five-second re-enactment.
      revealedCount = fullPointCount;
      building = false;
      city.geometry.instanceCount = fullPointCount;
    }
  }

  rebuild({ animate: true });

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
    // Ease the city into existence: terrain → roads → buildings, stippled into place.
    if (building && city) {
      const elapsed = performance.now() - buildStart;
      const t = Math.min(1, elapsed / buildDuration);
      // easeOutCubic — fast start, gentle landing
      const eased = 1 - Math.pow(1 - t, 3);
      revealedCount = Math.round(eased * fullPointCount);
      city.geometry.instanceCount = revealedCount;
      if (t >= 1) building = false;
    }
    // Drive the breathing clock. Kept here so every animated thing shares one time source.
    if (pulsing) material.uniforms.uTime.value = performance.now() / 1000;
    controls.update();
    renderer.render(scene, camera);
  };
  animate();

  function triggerBuild() {
    fullPointCount = city.geometry.attributes.instanceOffset.count;
    revealedCount = 0;
    building = true;
    buildStart = performance.now();
    city.geometry.instanceCount = 0;
  }

  return {
    scene,
    camera,
    renderer,
    controls,
    get city() { return city; },
    get pointCount() { return pointCount; },
    get theme() { return state.theme; },
    get visible() { return state.visible ? [...state.visible] : null; },
    get districtPointCounts() { return { ...lastCounts }; },
    get islandScale() { return islandScale; },
    get defaultCamera() { return [...defaultCamera]; },
    /**
     * Swap in freshly generated city data — after a collect, or after an edit to city.json.
     * This exists so callers never have to dispose and recreate the renderer, which would lose
     * the camera and means copying properties onto a sealed object (they are getters; it throws).
     */
    setCityData(next) {
      cityData = next;
      recomputeFraming();
      rebuild({ animate: true });
    },
    /** Render flat dot data from a Stipple Forge template */
    setDots(dots, name, opts = {}) {
      // dots: [[x, z, r, g, b, size], ...]
      // opts: { mode, edges, seed, stats, tiling } — v2 template metadata
      // dots: [[x, z, r, g, b, size], ...]
      // Scale sizes up so stipple dots are visible at TokenArt camera distance
      const sizeScale = 8.0;
      const points = dots.map(d => ({
        position: [d[0], 0.1, d[1]],
        color: [d[2], d[3], d[4]],
        size: Math.max(0.5, (d[5] || 1.0) * sizeScale),
      }));
      // Dispose old city mesh
      if (city) { city.geometry.dispose(); city.material.dispose(); }
      city = createPointCloud(points, geometry, material);
      scene.add(city);
      // Don't call rebuild() — it would overwrite our dots with procedural city data
      if (animate) {
        revealedCount = 0;
        building = true;
        buildStart = performance.now();
        city.geometry.instanceCount = 0;
      } else {
        revealedCount = points.length;
        building = false;
        city.geometry.instanceCount = points.length;
      }
      pointCount = points.length;
      fullPointCount = points.length;
      // Frame camera for flat dots: zoom out to see the full spread
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (const d of dots) {
        if (d[0] < minX) minX = d[0]; if (d[0] > maxX) maxX = d[0];
        if (d[1] < minZ) minZ = d[1]; if (d[1] > maxZ) maxZ = d[1];
      }
      const spreadX = maxX - minX || 1;
      const spreadZ = maxZ - minZ || 1;
      const maxSpread = Math.max(spreadX, spreadZ);
      const dist = Math.max(maxSpread * 1.5, 20);
      camera.position.set(dist * 0.6, dist * 0.5, dist * 0.6);
      controls.target.set((minX + maxX) / 2, 0, (minZ + maxZ) / 2);
      controls.update();
    },
    /** Print-preview mode: orthographic projection, no ripple, physical dimensions */
    setPrintPreview(dots, widthMm = 254, heightMm = 169.33, dpi = 300) {
      const points = dots.map(d => ({
        position: [d[0], 0.0, d[1]],
        color: [d[2], d[3], d[4]],
        size: Math.max(0.5, d[5] || 1.0),
      }));
      if (city) { city.geometry.dispose(); city.material.dispose(); }
      city = createPointCloud(points, geometry, material);
      scene.add(city);
      // Switch to orthographic camera for print-accurate preview
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (const d of dots) {
        if (d[0] < minX) minX = d[0]; if (d[0] > maxX) maxX = d[0];
        if (d[1] < minZ) minZ = d[1]; if (d[1] > maxZ) maxZ = d[1];
      }
      const spreadX = maxX - minX || 1;
      const spreadZ = maxZ - minZ || 1;
      const maxSpread = Math.max(spreadX, spreadZ);
      const aspect = widthMm / heightMm;
      const viewSize = Math.max(maxSpread, 20);
      camera.left = -viewSize * aspect / 2;
      camera.right = viewSize * aspect / 2;
      camera.top = viewSize / 2;
      camera.bottom = -viewSize / 2;
      camera.position.set(0, 0, 50);
      camera.lookAt(0, 0, 0);
      controls.target.set(0, 0, 0);
      controls.update();
      // Disable ripple and animation for print preview
      pulsing = false;
      material.uniforms.uPulse.value = 0;
      revealedCount = points.length;
      building = false;
      city.geometry.instanceCount = points.length;
      pointCount = points.length;
      fullPointCount = points.length;
    },
    setTheme(name) {
      if (!THEMES[name] || name === state.theme) return;
      state.theme = name;
      rebuild();
    },
    /** ids = array of district ids; null/undefined restores "all visible". */
    setVisible(ids) {
      state.visible = ids ? new Set(ids) : null;
      rebuild();
    },
    triggerBuild,
    /**
     * Turn the travelling ripple on or off. It is on unless the system asked for reduced
     * motion. Exposed so a UI control can switch it, and so stills can be captured frozen.
     */
    setPulse(on) {
      pulsing = !!on;
      material.uniforms.uPulse.value = pulsing ? 1 : 0;
    },
    get pulsing() { return pulsing; },
    dispose() {
      cancelAnimationFrame(raf);
      removeEventListener("resize", resize);
      controls.dispose();
      renderer.dispose();
      geometry.dispose();
      material.dispose();
      if (city) city.geometry.dispose();
      ground.geometry.dispose();
      ground.material.dispose();
      container.removeChild(renderer.domElement);
    },
  };
}