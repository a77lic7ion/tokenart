// scene-kit/image-to-dots.js
//
// Converts an image into a point cloud you can fly around. The core idea: dots are sampled
// proportionally to the image's tonal value, so bright areas get dense dots and dark areas
// get sparse ones — shading gradients survive as dot-density gradients. Edges get an extra
// boost so silhouettes and detail lines stay crisp.
//
// Two modes:
//   "trace" — dots cluster where the image has content (edges, ink, bright areas),
//             sparse where it's blank/dark. Reads as a stippled drawing of the source.
//   "flat"  — uniform scatter, the same density everywhere. Reads as texture.
//
// The output is the same instanced-quad format as everything else.

import * as THREE from "../three.module.js";

export function imageToPoints(image, {
  mode = "trace",
  density = 0.5,         // 0..1 — fraction of pixels that become dots at full tone
  edgeWeight = 1.8,      // how much edges attract dots in "trace" mode
  invert = false,        // if your image is white-on-black
  maxDimension = 28,     // world size: longer side fits in this many units
  maxDots = 150000,      // cap total dots for performance
} = {}) {
  const iw = image.naturalWidth || image.width;
  const ih = image.naturalHeight || image.height;

  // Decide the sampling resolution: we want to read the full image for shading detail, but
  // cap the total pixel count so the CDF build stays fast.
  const totalPixels = iw * ih;
  const skip = Math.max(1, Math.ceil(Math.sqrt(totalPixels / (maxDots * 2))));
  const sw = Math.ceil(iw / skip);
  const sh = Math.ceil(ih / skip);

  // Draw the image at sampling resolution.
  const canvas = document.createElement("canvas");
  canvas.width = sw;
  canvas.height = sh;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(image, 0, 0, sw, sh);
  const data = ctx.getImageData(0, 0, sw, sh).data;
  const n = sw * sh;

  // Per-pixel tonal value.
  const tone = new Float32Array(n);
  let tmin = 1, tmax = 0;
  for (let i = 0; i < n; i++) {
    const r = data[i * 4] / 255, g = data[i * 4 + 1] / 255, b = data[i * 4 + 2] / 255;
    const luma = 0.299 * r + 0.587 * g + 0.114 * b;
    const v = invert ? 1 - luma : luma;
    tone[i] = v;
    if (v < tmin) tmin = v;
    if (v > tmax) tmax = v;
  }

  // Edge detection.
  const edges = new Float32Array(n);
  let emax = 0;
  for (let y = 1; y < sh - 1; y++) {
    for (let x = 1; x < sw - 1; x++) {
      const i = y * sw + x;
      const gx = Math.abs(tone[i + 1] - tone[i - 1]);
      const gy = Math.abs(tone[i + sw] - tone[i - sw]);
      const e = Math.hypot(gx, gy);
      edges[i] = e;
      if (e > emax) emax = e;
    }
  }

  // Per-pixel sampling probability, proportional to tone + edges.
  const prob = new Float32Array(n);
  let psum = 0;
  const tr = tmax - tmin;
  for (let i = 0; i < n; i++) {
    const tnorm = tr > 0 ? (tone[i] - tmin) / tr : 0;
    const enorm = emax > 0 ? edges[i] / emax : 0;
    let p;
    if (mode === "trace") {
      p = (0.05 + 0.95 * tnorm) * (1 + enorm * edgeWeight);
    } else {
      p = 0.5;
    }
    prob[i] = p;
    psum += p;
  }

  // CDF for proportional sampling.
  const cdf = new Float32Array(n);
  let cum = 0;
  for (let i = 0; i < n; i++) {
    cum += prob[i] / psum;
    cdf[i] = cum;
  }

  // World scale: longer side of the image maps to maxDimension world units.
  const worldPerPixel = maxDimension / Math.max(iw, ih);
  const totalDots = Math.min(maxDots, Math.round(n * density));

  const points = [];
  const palette = new THREE.Color();
  const rng = seedFn(1701);

  for (let d = 0; d < totalDots; d++) {
    const u = rng();
    let lo = 0, hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cdf[mid] < u) lo = mid + 1; else hi = mid;
    }
    const idx = lo;
    if (data[idx * 4 + 3] < 8) continue;   // skip near-transparent

    const r = data[idx * 4] / 255, g = data[idx * 4 + 1] / 255, b = data[idx * 4 + 2] / 255;
    palette.setRGB(r, g, b);

    const sx = idx % sw;
    const sy = (idx / sw) | 0;

    // Jitter the dot position so it doesn't sit on a rigid grid.
    const jx = (rng() - 0.5) * 0.6;
    const jy = (rng() - 0.5) * 0.6;

    const wx = (sx - sw / 2 + jx) * worldPerPixel * skip;
    const wz = (sy - sh / 2 + jy) * worldPerPixel * skip;

    points.push({
      position: [wx, 0.02, wz],
      color: [palette.r, palette.g, palette.b],
      size: 0.7 + edges[idx] * 1.2,
    });
  }
  return points;
}

function seedFn(seed) {
  let s = seed >>> 0;
  return () => { s = (1664525 * s + 1013904223) >>> 0; return s / 4294967296; };
}