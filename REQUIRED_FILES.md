# Required Files: Main App + Path Tracer + DOF

Only these files are required for the **main path tracer app** (index) with **DOF** to work. Everything else in the repo can be removed.

---

## 1. Main entry (example)

| File | Purpose |
|------|--------|
| `example/index.html` | HTML entry; loads `index.js` as module |
| `example/index.js` | Main app: scene, GUI, path tracer, DOF, model loading, render modal |

---

## 2. Example dependencies (used only by index.js)

| File | Purpose |
|------|--------|
| `example/ImageRenderModal.js` | Modal for high-quality “Render Image” (resolution, samples, PNG/JPG) |
| `example/ImageRenderModal.css` | Styles for the render modal |
| `example/utils/modelList.js` | Model list and asset URLs (GLB/DAE/LDR), uses `FogVolumeMaterial` from src |
| `example/utils/getScaledSettings.js` | Device-aware defaults (tiles, renderScale, gpuTier) |
| `example/utils/LoaderElement.js` | Loading overlay (progress, credits) |
| `example/utils/generateRadialFloorTexture.js` | Radial floor texture for the scene |

---

## 3. Path tracer + DOF library (src/)

The whole `src/` tree is the path tracer and DOF. **Keep all of `src/`** — it is one unit (path tracer + DOF together).

- **Core:** `WebGLPathTracer`, `PathTracingSceneGenerator`, `PathTracingRenderer`, scene/BVH/utils
- **DOF:** `PhysicalCamera`, `PhysicalCameraUniform`, DOF in `camera_util_functions.glsl.js`, `shape_sampling_functions.glsl.js` (aperture)
- **Objects:** `PhysicalCamera`, `EquirectCamera`, `PhysicalSpotLight`, `ShapedAreaLight`
- **Textures:** `GradientEquirectTexture`, `ProceduralEquirectTexture`, blue noise, etc.
- **Materials:** path tracing material, denoise, fog volume, fullscreen/surface materials
- **Uniforms:** camera (DOF), materials, lights, BVH, stratified sampling, etc.
- **Shaders:** BSDF, BVH, sampling (including aperture/DOF), structs, common, rand
- **Utils:** bufferToHash, TextureUtils, SobolNumberMapGenerator, CubeToEquirectGenerator (BlurredEnvMapGenerator, macroify, UVUnwrapper, detectors were removed as unused)

**Summary:** Do not delete any file under `src/`; the main app imports `GradientEquirectTexture`, `WebGLPathTracer`, and `PhysicalCamera` from `../src/index.js`, and the library is built from the full `src/` tree.

---

## 4. Assets

| Path | Purpose |
|------|--------|
| `example/assets/*.glb` (and any other models referenced in `modelList.js`) | Models loaded by the main app (e.g. HP Blank Screen, Flexera, ITUS, etc.) |

Keep every asset that `modelList.js` points to (local paths or ensure remote URLs are valid).

---

## 5. Build and config (root)

| File | Purpose |
|------|--------|
| `package.json` | Scripts (build, lint, start), deps, peer deps |
| `rollup.config.js` | Builds `build/index.umd.cjs` and `build/index.module.js` from `src/` |
| `vite.config.js` | Dev server and build for the example (root: `example/`) |
| `build/` | Output of `npm run build` (optional to keep in git; can be regenerated) |

---

## 6. Optional (can remove if you want minimal repo)

- `rollup.config.cdn.js` and `build/three-pathtracer.cdn.js` — CDN bundle of pathtracer + DOF (three-mesh-bvh inlined). Optional; only needed for “single script + three.js” usage.
- `example/package.json` — Only if you use a separate npm install in `example/`; root `package.json` is enough for typical setup.

---

## Files to REMOVE (not required for main + pathtracer + DOF)

- **Other examples:**  
  `renderVideo.js`, `renderVideo.html`, `cdn-example.html`,  
  `basic.js`, `basic.html`, `depthOfField.js`, `depthOfField.html`,  
  `hdr.js`, `hdr.html`, `overlay.js`, `overlay.html`,  
  `spotLights.js`, `spotLights.html`, `graphing.js`, `graphing.html`,  
  `aoRender.js`, `aoRender.html`, `lkg.js`, `lkg.html`,  
  `skinnedMesh.js`, `skinnedMesh.html`, `lego.html`,  
  `screenshotList.js`, `screenshotList.html`,  
  `viewerTest.js`, `viewerTest.html`, `viewer.js`, `viewer.html`,  
  `materialDatabase.js`, `materialDatabase.html`,  
  `materialBall.js`, `materialBall.html`,  
  `interior.js`, `interior.html`, `fog.js`, `fog.html`,  
  `areaLight.js`, `areaLight.html`, `primitives.js`, `primitives.html`,  
  `hub.html`
- **Example utils/materials/libs not used by index.js:**  
  `example/utils/HDRImageGenerator.js`,  
  `example/utils/MaterialOrbSceneLoader.js`,  
  `example/materials/QuiltPreviewMaterial.js`,  
  `example/libs/libultrahdr.js`

After removal, the app that “just works” is: **main file (index.html + index.js) + path tracer + DOF** (all of `src/`) + the listed example deps and assets.
