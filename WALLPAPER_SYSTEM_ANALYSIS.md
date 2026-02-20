# Wallpaper System — Full Technical Analysis

This document describes **every piece of detail** about how wallpapers are handled in the pathtracer example: from discovery, visibility, custom uploads, path-tracer sync, and live updates **without** scene rebuild where applicable.

---

## Table of Contents

1. [Global State and Parameters](#1-global-state-and-parameters)
2. [End-to-End Flow: From Model Load to Display](#2-end-to-end-flow-from-model-load-to-display)
3. [Wallpaper Mesh Discovery (`findAllWallpaperMeshes`)](#3-wallpaper-mesh-discovery-findallwallpapermeshes)
4. [Screen Mesh for Custom Wallpapers (`findScreenMesh`)](#4-screen-mesh-for-custom-wallpapers-findscreenmesh)
5. [Making Only the Selected Wallpaper Visible (`updateWallpaperVisibility`)](#5-making-only-the-selected-wallpaper-visible-updatewallpapervisibility)
6. [Custom Wallpaper Handling](#6-custom-wallpaper-handling)
7. [Path Tracer Scene: Visibility and When Rebuild Happens](#7-path-tracer-scene-visibility-and-when-rebuild-happens)
8. [Live Updates Without Scene Rebuild](#8-live-updates-without-scene-rebuild)
9. [Display Modes and GUI](#9-display-modes-and-gui)
10. [Summary Tables](#10-summary-tables)

---

## 1. Global State and Parameters

**Location:** `example/index.js` (around lines 158–189, 186–189)

| Variable | Type | Purpose |
|----------|------|---------|
| `params.screenWallpaper` | string | Current selection: `'off_screen'`, `'blank_screen'`, `'blue_bloom'`, `'aurora_borealis'`, `'feather_light'`, `'asus_1'`, `'asus_2'`, `'custom'`. Default `'blank_screen'`. |
| `params.screenBrightness` | number (0–10) | Predefined: 1. Custom: default 4.5. Drives emissive or baked brightness. |
| `params.screenSaturation` | number (0–2) | Predefined: 1. Custom: default 0.9. Only applied to custom (baked into texture). |
| `screenMesh` | `THREE.Mesh \| null` | The **single** mesh used for custom wallpaper (texture applied here). Set to `wallpaperMeshes['blank_screen']` or from `findScreenMesh(model)`. |
| `uploadedTexture` | `THREE.Texture \| null` | Current custom wallpaper texture (after brightness/saturation). |
| `uploadedImage` | `HTMLImageElement \| null` | **Original** uploaded image; used to re-apply brightness/saturation without re-upload. |
| `wallpaperMeshes` | `Record<string, THREE.Mesh \| null>` | Map of logical keys to meshes: `blank_screen`, `blue_bloom`, `aurora_borealis`, `feather_light`, `asus_1`, `asus_2`. Filled by `findAllWallpaperMeshes(model)`. |
| `currentWallpaper` | string | In-memory active wallpaper key; kept in sync with `params.screenWallpaper`. |

All “screen” meshes (predefined wallpapers + `screen_blank`) are **screen-facing quads/planes** in the GLB. Only **one** of them is ever visible at a time so the path tracer sees a single emissive screen.

---

## 2. End-to-End Flow: From Model Load to Display

**Location:** Model load and scene build in `example/index.js` (around 3542–3652).

1. **Model loaded**  
   GLB is loaded; `model` is the root of the product (e.g. laptop).

2. **Discover wallpapers**  
   `wallpaperMeshes = findAllWallpaperMeshes(model)`  
   - Finds `screen_blank` and all `\d+_Name` meshes (e.g. `01_Blue_Bloom`).  
   - Fills `wallpaperMeshes` with keys like `blank_screen`, `blue_bloom`, etc.

3. **Choose screen mesh for custom**  
   `screenMesh = wallpaperMeshes['blank_screen'] || findScreenMesh(model)`  
   - Custom wallpaper is always applied to this **one** mesh (`screen_blank` when available).

4. **Set initial visibility (no path tracer yet)**  
   - All wallpaper meshes (numeric prefix or `screen_blank`) are set `visible = false`.  
   - Group named `'wallpaper'` is set `visible = false`.  
   - Only `wallpaperMeshes[currentWallpaper]` is set `visible = true`, and its parent chain is made visible.  
   - This is done **inline** (no `updateWallpaperVisibility`), so the **first** path tracer build already sees the correct visibility.

5. **Build path tracer scene once**  
   `pathTracer.setSceneAsync(scene, activeCamera, …)`  
   - Uses `traverseVisible()`: only visible meshes (including the one visible wallpaper) are in the BVH/materials.  
   - No second rebuild; visibility was set before this.

6. **User changes wallpaper later**  
   - GUI dropdown → `updateWallpaperVisibility(value)` → hide all, show one, then **`setSceneAsync`** so path tracer geometry/BVH matches visibility again.

So: **initial load** sets visibility then builds the path tracer once. **Later wallpaper changes** go through `updateWallpaperVisibility` and trigger a **scene rebuild** (`setSceneAsync`). **Brightness/saturation** (and material-only changes) use **no** scene rebuild — see §8.

---

## 3. Wallpaper Mesh Discovery (`findAllWallpaperMeshes`)

**Location:** `example/index.js` ~2334–2503.

**Purpose:** Build the map of logical wallpaper keys to actual meshes so the rest of the app can “show only this one” and “hide the rest.”

**Algorithm:**

1. **Single traverse** over `model`:
   - If `child.isGroup && child.name === 'wallpaper'` → store as `wallpaperGroup` (for logging / future use).
   - If `child.isMesh` and name is `'screen_blank'` → store as `screenBlankMesh` (used for custom and often as `blank_screen`).
   - If mesh name matches **numeric prefix** `^\d+_(.+)$` (e.g. `01_Blue_Bloom`, `03_Feather_Light`):
     - Store in a by-name map.
     - Normalize the suffix to a “core name” (lowercase, strip `vertical`, collapse underscores).
     - Map core name to one of: `blank_screen`, `blue_bloom`, `aurora_borealis`, `feather_light`, `asus_1`, `asus_2` using substring/equality rules (e.g. “feather” + “light” → `feather_light`), and assign to `wallpapers[key]` if not already set.

2. **After traverse:**  
   If `screenBlankMesh` exists, set `wallpapers['blank_screen'] = screenBlankMesh` when not already set.

**Return value:**  
Object `{ blank_screen, blue_bloom, aurora_borealis, feather_light, asus_1, asus_2 }` with values either a `THREE.Mesh` or `null`.  
So: **every predefined wallpaper + the “blank” screen** are identified here; the same `screen_blank` mesh is later used for **custom** wallpaper texture.

**Exclusions:**  
Discovery does **not** consider `screen_panel`, `screen_backlight`, `screen_filter`, etc.; those are filtered later in `updateWallpaperVisibility` when collecting “screen meshes” so only wallpaper-like meshes are toggled.

---

## 4. Screen Mesh for Custom Wallpapers (`findScreenMesh`)

**Location:** `example/index.js` ~2231–2330.

**Purpose:** Fallback when `wallpaperMeshes['blank_screen']` is null — find **one** mesh that will receive the custom wallpaper texture.

**Logic:**

1. **Priority:** Exact name match for `screen_blank` (case-insensitive) with material → return that mesh.
2. **Otherwise:** Look for meshes whose name/parent suggest “screen” + “blank” (e.g. name includes “blank” and parent includes “screen”), prefer one with `emissiveMap`.
3. **Exclude:** name contains `cover`, `panel`, `back`, or starts with `a_`.
4. **Last resort:** Any mesh (except excluded) with `emissiveMap` or `emissiveIntensity > 0`.

In practice, **after** `findAllWallpaperMeshes`, `screenMesh` is set to `wallpaperMeshes['blank_screen'] || findScreenMesh(model)`, so the “screen” for custom is usually the same as the blank_screen mesh.

---

## 5. Making Only the Selected Wallpaper Visible (`updateWallpaperVisibility`)

**Location:** `example/index.js` ~2506–3019.

This is the function that enforces “only one wallpaper visible on the screen” and then syncs the path tracer. It is used when:
- User picks a wallpaper from the dropdown (including “Off screen” and “custom”).
- User uploads a custom image (then calls `updateWallpaperVisibility('custom')`).
- Animation “Screen” is set to “Off screen” or “On” (which sets wallpaper then calls this).

**Steps in detail:**

### 5.1 Collect all “screen” meshes (wallpaper candidates)

- **Traverse** `model` for every `child.isMesh`.
- **Exclude** “screen component” meshes (e.g. `screen_panel`, `screen_backlight`, `screen_filter`, `screen_mirror`, `screen_bezel`, certain `display*`, or parent name conditions like `displayctrl` without wallpaper).
- **Include** a mesh if any of:
  - It is in `wallpaperMeshes` (any key).
  - Name has numeric prefix `^\d+_`.
  - Name is `screen_blank`.
  - Or legacy: name/parent suggest `rgb` + screen (and not screenctrl).

So the list is **all** wallpaper-like meshes (blank, predefined, and the same mesh used for custom), not physical screen parts.

For each included mesh we compute:
- World position (for depth).
- **Priority** (e.g. blank_screen 100, blue_bloom 90, aurora 80, feather_light 70, asus_1 60, asus_2 55, screen_rgb 50, generic 40/10).
- **Depth** = world Z (used to break ties: smaller Z = “in front”).
- Sort by **priority desc**, then **depth asc**.

Result: `allScreenMeshes[]` with `{ mesh, name, parent, visible, hasEmissiveMap, worldPosition, priority, wallpaperType, depth }`.

### 5.2 Hide all wallpaper meshes and their wallpaper parent groups

- For **every** entry in `allScreenMeshes`:
  - Set `info.mesh.visible = false`.
  - Walk **up** the parent chain; for any parent whose name (lowercase) **includes** `'wallpaper'`, set `parent.visible = false` and add to a `hiddenGroups` set (so we don’t hide the same group twice).

So: every wallpaper mesh is hidden, and any group named “wallpaper” that contains them is hidden. This avoids one visible parent accidentally showing multiple wallpaper meshes.

### 5.3 Choose the single target mesh to show

- **`off_screen` / `Off screen`:**  
  `targetMesh = null`. Nothing is shown; all stay hidden.

- **`custom`:**  
  `targetMesh = screenMesh` (the mesh that has the custom texture). If `screenMesh` is null, fallback: use first mesh in `allScreenMeshes` with `hasEmissiveMap` or priority > 50, and set `screenMesh` to that mesh.

- **Predefined key (e.g. `blank_screen`, `blue_bloom`, …):**  
  If `wallpaperMeshes[selectedWallpaper]` exists, `targetMesh = wallpaperMeshes[selectedWallpaper]`, and **`screenMesh` is updated** to that mesh (so that mesh is also the “current screen” for any later custom upload or brightness tweak).

### 5.4 Show only the target mesh and its parent chain

- If `targetMesh` is not null:
  - `targetMesh.visible = true`.
  - For **predefined** (non-custom, non–off_screen): apply default material settings (e.g. `emissiveIntensity = params.screenBrightness`, emissive color white, `needsUpdate = true`), then `pathTracer.updateMaterials()` and `resetPathTracerAndResumeIfAutoPaused()` so the path tracer uses the new material without changing geometry.
  - Walk from `targetMesh.parent` up to `model`; set every ancestor `visible = true` and add to `visibleParentChain`.
  - **Sibling groups:** traverse the model again; for any **group** whose name includes `'wallpaper'` and that is **not** in `visibleParentChain` and is not the direct parent of `targetMesh`, set `visible = false`. So only the branch leading to the selected wallpaper is visible; other wallpaper branches stay hidden.

Result: **exactly one** wallpaper mesh is visible, with its full parent chain visible, and no other wallpaper branch visible.

### 5.5 Sync path tracer with new visibility (scene rebuild)

- Short delay (10 ms) so visibility updates are applied.
- If there is an animation mixer, `animationMixer.update(0)` and `scene.updateMatrixWorld(true)`.
- **`pathTracer.setSceneAsync(scene, activeCamera, { onProgress })`** is called.

So: **every** call to `updateWallpaperVisibility` (except when it bails early) ends with a **full scene rebuild** via `setSceneAsync`. That rebuild uses `traverseVisible()` in the path tracer pipeline, so only the currently visible meshes (including the one visible wallpaper) are in the BVH and material set. So “selected wallpaper only visible” is achieved by (1) Three.js visibility and (2) path tracer rebuild so its internal scene matches that visibility.

---

## 6. Custom Wallpaper Handling

**Locations:**  
- Upload: `handleImageUpload` ~3146–3318.  
- Texture helper: `updateScreenTextureWithSettings` ~3073–3144.  
- Brightness/saturation on image: `applyBrightnessSaturationToImage` ~3024–3070.

### 6.1 Upload flow (`handleImageUpload`)

1. Validate file type (image).
2. `FileReader.readAsDataURL` → on load create `Image`, set `img.src = result`.
3. On `img.onload`:
   - Store **original** image: `uploadedImage = img` (for later brightness/saturation without re-upload).
   - Set custom defaults: `params.screenBrightness = 4.5`, `params.screenSaturation = 0.9`.
   - Resolve `screenMesh` (already set from initial load, or `findScreenMesh(model)`).
   - Build texture from **processed** image: `applyBrightnessSaturationToImage(img, params.screenBrightness, params.screenSaturation)` → canvas → `new THREE.Texture(processedCanvas)` with `flipY = false`, `colorSpace = SRGBColorSpace`, mipmaps, anisotropy, `needsUpdate = true`.
   - Apply to **all** materials of `screenMesh` (array or single):
     - Dispose previous `emissiveMap` if different from the new texture.
     - `emissiveMap = texture`, `emissiveIntensity = 1.0` (brightness is baked), `emissive = 0xffffff`, roughness/metalness set for screen look, `needsUpdate = true`.
   - `uploadedTexture = texture`.
   - Set state: `params.screenWallpaper = 'custom'`, `currentWallpaper = 'custom'`.
   - **Visibility:** `await updateWallpaperVisibility('custom')` → hides all other wallpapers, shows only `screenMesh`, then **setSceneAsync** (scene rebuild).
   - **Path tracer:** `pathTracer.updateMaterials()`, `resetPathTracerAndResumeIfAutoPaused()`.
   - **GUI:** `buildGui()` so dropdown and controls reflect “custom”.

So custom wallpaper = **one** mesh (`screenMesh`), **one** texture (with brightness/saturation baked in), visibility via `updateWallpaperVisibility('custom')`, then material sync and reset. Geometry is rebuilt once in `updateWallpaperVisibility` via `setSceneAsync`.

### 6.2 Brightness/saturation on the image

- **`applyBrightnessSaturationToImage(img, brightness, saturation)`**  
  Draws `img` to a canvas, gets `ImageData`, and per pixel:
  - Brightness: scale RGB by `brightness / 5` (0–10 → 0–2).
  - Saturation: luma `0.299*R + 0.587*G + 0.114*B`, then `mix(luma, color, saturation)`.
  - Clamp and write back. Returns the canvas (used to create a new texture).

- **`updateScreenTextureWithSettings()`**  
  Uses `uploadedImage` and current `params.screenBrightness` / `params.screenSaturation` to:
  - Call `applyBrightnessSaturationToImage(uploadedImage, params.screenBrightness, params.screenSaturation)`.
  - Create a **new** texture from the resulting canvas (same texture settings as upload).
  - Replace `emissiveMap` on all materials of `screenMesh`, dispose old texture if different, set `emissiveIntensity = 1.0`, then `pathTracer.updateMaterials()` and `resetPathTracerAndResumeIfAutoPaused()`.

So custom wallpaper “live” brightness/saturation = **re-bake texture** + **material update** + **path tracer reset**. No `setSceneAsync` (no scene rebuild).

---

## 7. Path Tracer Scene: Visibility and When Rebuild Happens

**Relevant code:**  
- `src/core/utils/StaticGeometryGenerator.js`: `flatTraverseMeshes` uses `object.traverseVisible(o => { if (o.isMesh) cb(o); })`.  
- `src/core/PathTracingSceneGenerator.js`: light collection uses `if (c.visible)` when traversing.  
- Scene build uses the static geometry generator, which only sees **visible** meshes.

So the path tracer’s **geometry** (and thus BVH and material indices) is built from **visible** objects only. Hiding all wallpapers and showing one in Three.js is not enough by itself: the path tracer must **rebuild** so its internal scene is updated. That rebuild is **`pathTracer.setSceneAsync(scene, activeCamera, …)`**.

**When `setSceneAsync` is used (full scene rebuild):**

- After **model load**: once, with visibility already set so only the selected wallpaper is visible.
- On **every** `updateWallpaperVisibility(...)` call (wallpaper dropdown change, “Off screen”, custom upload calling `updateWallpaperVisibility('custom')`, Animation “Screen” On/Off that changes wallpaper).

**When only material/accumulation updates are used (no rebuild):**

- **Brightness** change:
  - **Custom:** `updateScreenTextureWithSettings()` → new texture on `screenMesh` → `updateMaterials()` + `resetPathTracerAndResumeIfAutoPaused()` (no `setSceneAsync`).
  - **Predefined:** set `emissiveIntensity` (and emissive color) on materials → `updateMaterials()` (and optionally reset) — no `setSceneAsync`.
- **Saturation** change (custom only): same as custom brightness — `updateScreenTextureWithSettings()` → `updateMaterials()` + reset; no `setSceneAsync`.

So: **visibility changes** → **scene rebuild**. **Material/texture-only changes** (brightness/saturation) → **no scene rebuild**, only `updateMaterials()` and possibly `reset()`.

---

## 8. Live Updates Without Scene Rebuild

These updates change how the **current** wallpaper looks without changing **which** mesh is visible, so they don’t need to change BVH/geometry.

### 8.1 Custom wallpaper: brightness slider

- **Handler:** `params.screenBrightness` onChange (~1952–1987).
- **Action:**  
  If `currentWallpaper === 'custom' && uploadedImage`:  
  `await updateScreenTextureWithSettings()` → re-run `applyBrightnessSaturationToImage(uploadedImage, params.screenBrightness, params.screenSaturation)` → new texture → assign to `screenMesh.material` → `pathTracer.updateMaterials()`, `resetPathTracerAndResumeIfAutoPaused()`.  
  **No `setSceneAsync`.**  
  If predefined: set `emissiveIntensity` on `screenMesh` materials and call `pathTracer.updateMaterials()` (no reset required for accumulation if only intensity changes; code may still call reset in some paths).

### 8.2 Custom wallpaper: saturation slider

- **Handler:** `params.screenSaturation` onChange (~1991–2008).
- **Action:**  
  Only if `currentWallpaper === 'custom' && uploadedImage`:  
  `await updateScreenTextureWithSettings()` (same as above: re-bake texture with new saturation, apply to `screenMesh`, `updateMaterials()` + reset).  
  **No `setSceneAsync`.**

### 8.3 Predefined wallpaper: brightness only

- **Handler:** Same `screenBrightness` onChange; branch for non-custom.
- **Action:**  
  Set `material.emissiveIntensity = value` (and emissive color white) on all materials of `screenMesh`, `material.needsUpdate = true`, then `pathTracer.updateMaterials()`.  
  **No `setSceneAsync`.**  
  Saturation has no effect for predefined (only custom uses saturation).

So “live updates immediately without scene rebuild” = **material and/or texture updates** plus **path tracer `updateMaterials()` and optionally `reset()`**. Geometry/BVH stay as-is.

---

## 9. Display Modes and GUI

### 9.1 Wallpaper dropdown (Screen folder)

- **Visibility of folder:** Only if at least one entry in `wallpaperMeshes` is non-null.
- **Options:** `['off_screen', 'blank_screen', 'blue_bloom', 'aurora_borealis', 'feather_light', 'asus_1', 'asus_2', 'custom']`, filtered so that predefined options are only shown when `wallpaperMeshes[option] !== null`; `custom` and `off_screen` always shown when folder exists.
- **onChange:**  
  Update `currentWallpaper` and `params.screenWallpaper`.  
  If `custom`: set `params.screenBrightness = 4.5`, `params.screenSaturation = 0.9`; else set both to 1.  
  Sync `params.animationScreen` with “Off screen” when value is `off_screen`/`Off screen`, else “On”.  
  Then `await updateWallpaperVisibility(value)` (which does hide-all → show-one → `setSceneAsync`).

### 9.2 “Off screen”

- Treated as a display mode: **no** wallpaper mesh is shown.  
- In `updateWallpaperVisibility('off_screen')`: `targetMesh` is left null, so after “hide all” step nothing is shown.  
- Path tracer is rebuilt so its scene contains **no** screen emissive mesh (all wallpaper geometry is excluded by `traverseVisible`).

### 9.3 Animation “Screen” (On / Off screen)

- **Visibility of control:** Only when wallpaper meshes were detected (same condition as Screen folder).
- **Values:** `'On' | 'Off screen'`.
- **onChange:**  
  If “Off screen”: set `currentWallpaper = 'off_screen'`, `params.screenWallpaper = 'off_screen'`, `await updateWallpaperVisibility('off_screen')`.  
  If “On”: set wallpaper to `params.screenWallpaper` (or `blank_screen` if current was off), then `updateWallpaperVisibility(toShow)`.  
  Then `pathTracer.updateMaterials()` and `resetPathTracerAndResumeIfAutoPaused()`.

So both the Screen dropdown and the Animation “Screen” control drive the same visibility logic and path tracer rebuild when the **visible** wallpaper changes.

### 9.4 Upload Custom button

- Creates a file input, accepts images; on change calls `handleImageUpload(file)` which applies texture, sets custom, calls `updateWallpaperVisibility('custom')`, then `updateMaterials()`, reset, and `buildGui()`.

---

## 10. Summary Tables

### When is the path tracer scene rebuilt (`setSceneAsync`)?

| Action | Rebuild? |
|--------|----------|
| Model load (initial) | Yes, once after visibility set |
| Wallpaper dropdown change (any, including off_screen / custom) | Yes, inside `updateWallpaperVisibility` |
| Animation “Screen” On/Off | Yes, via `updateWallpaperVisibility` |
| Custom image upload | Yes, via `updateWallpaperVisibility('custom')` |
| Brightness slider (custom or predefined) | No |
| Saturation slider (custom only) | No |

### How is “only one wallpaper visible” achieved?

| Layer | Mechanism |
|-------|-----------|
| Three.js | All wallpaper-like meshes and their `'wallpaper'` parent groups are set `visible = false`; only the selected mesh and its parent chain are set `visible = true`; sibling wallpaper groups are explicitly hidden. |
| Path tracer | After visibility change, `setSceneAsync` is called; the generator uses `traverseVisible()`, so only visible meshes (including the one visible wallpaper) are in the BVH and materials. |

### Custom vs predefined: what differs?

| Aspect | Predefined | Custom |
|--------|------------|--------|
| Mesh | One of `wallpaperMeshes[key]` | Always `screenMesh` (usually `blank_screen`) |
| Content | From GLB materials | `emissiveMap` = texture from uploaded image (with brightness/saturation baked) |
| Brightness | `emissiveIntensity` (live) | Baked into texture; change = new texture + `updateMaterials()` + reset |
| Saturation | N/A (1) | Baked into texture; change = new texture + `updateMaterials()` + reset |
| Default brightness/saturation | 1 / 1 | 4.5 / 0.9 |

### Data flow (one sentence per step)

1. **Discovery:** `findAllWallpaperMeshes(model)` → `wallpaperMeshes`; `screenMesh = wallpaperMeshes['blank_screen'] || findScreenMesh(model)`.
2. **Initial visibility:** All wallpaper meshes and `'wallpaper'` groups hidden; only `wallpaperMeshes[params.screenWallpaper]` and its parents shown.
3. **First build:** `setSceneAsync` → path tracer sees only visible meshes.
4. **User selects wallpaper:** Dropdown/Animation → `updateWallpaperVisibility(value)` → hide all, show one, parent chain visible, sibling groups hidden → `setSceneAsync`.
5. **User uploads image:** Texture from image (with brightness/saturation) → apply to `screenMesh` → `updateWallpaperVisibility('custom')` → `setSceneAsync` → `updateMaterials()` + reset + `buildGui()`.
6. **User changes brightness/saturation (custom):** `applyBrightnessSaturationToImage` → new texture on `screenMesh` → `updateMaterials()` + reset; **no** `setSceneAsync`.

This is the full picture of how wallpapers are handled from start to end, how the selected wallpaper is the only visible one, how custom wallpapers and live updates work, and when the path tracer scene is rebuilt versus only updated in materials.
