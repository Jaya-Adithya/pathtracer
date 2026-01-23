# Wallpaper Visibility Management System - Technical Documentation

## Overview

This document provides a comprehensive technical analysis of the wallpaper visibility management system implemented in the three-gpu-pathtracer project. The system enables dynamic switching between predefined wallpapers and custom uploaded images on a 3D model's screen mesh, with proper integration into the GPU path tracer's rendering pipeline.

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Core Components](#core-components)
3. [Mesh Discovery and Classification](#mesh-discovery-and-classification)
4. [Visibility Management System](#visibility-management-system)
5. [Path Tracer Integration](#path-tracer-integration)
6. [Custom Wallpaper Handling](#custom-wallpaper-handling)
7. [Data Flow and Execution Sequence](#data-flow-and-execution-sequence)
8. [Technical Implementation Details](#technical-implementation-details)
9. [Performance Considerations](#performance-considerations)
10. [Debugging and Logging](#debugging-and-logging)

---

## Architecture Overview

The wallpaper system operates on a **mutual exclusivity principle**: only one wallpaper mesh can be visible at any given time. This is critical for path tracing, as overlapping emissive surfaces would cause incorrect light emission and reflections.

### Key Design Principles

1. **Single Active Wallpaper**: Only one wallpaper mesh is visible at any time
2. **Path Tracer Synchronization**: The path tracer's internal scene representation must be rebuilt when visibility changes
3. **Material Property Preservation**: Custom wallpapers maintain emissive properties for proper light emission
4. **Hierarchical Visibility**: Parent groups must be visible for child meshes to render correctly

---

## Core Components

### 1. Global State Variables

```javascript
let screenMesh = null;              // Reference to the mesh used for custom wallpapers
let uploadedTexture = null;        // Three.js Texture object for custom uploaded image
let wallpaperMeshes = {};           // Map of predefined wallpaper meshes
let currentWallpaper = '';          // Currently active wallpaper identifier
```

**Purpose**: Maintain references to meshes and textures across the application lifecycle.

---

## Mesh Discovery and Classification

### 1. Screen Mesh Discovery (`findScreenMesh`)

**Location**: `index.js:596-696`

**Algorithm**:
1. **Priority Search**: First looks for exact `"screen_blank"` match
2. **Exclusion Filter**: Skips meshes with names containing `"cover"`, `"panel"`, `"back"`, or starting with `"a_"`
3. **Pattern Matching**: Searches for meshes with `"screen"` and `"blank"` in name or parent
4. **Material-Based Fallback**: If not found by name, searches for meshes with `emissiveMap` or `emissiveIntensity > 0`

**Key Features**:
- Prioritizes exact matches over partial matches
- Excludes non-screen components (covers, panels)
- Handles both single materials and material arrays

### 2. Wallpaper Mesh Discovery (`findAllWallpaperMeshes`)

**Location**: `index.js:698-801`

**Supported Wallpapers**:
- `blank_screen`: Default blank screen
- `blue_bloom`: Blue bloom wallpaper
- `aurora_borealis`: Aurora borealis effect
- `feather_light`: Feather light pattern
- `asus_1`: ASUS wallpaper variant 1
- `asus_2`: ASUS wallpaper variant 2

**Search Strategy**:
1. **Pattern-Based Matching**: Uses configurable pattern arrays for each wallpaper type
2. **Two-Pass Traversal**:
   - **First Pass**: Direct mesh matching
   - **Second Pass**: Group traversal for nested meshes
3. **Pattern Priority**: More specific patterns checked first (e.g., `"screen_blank"` before `"blank"`)

**Pattern Configuration**:
```javascript
const patterns = {
    'blank_screen': ['blank_screen', 'screen_blank', 'blank'],
    'blue_bloom': ['blue_bloom', 'bluebloom', 'blue', 'bloom'],
    'aurora_borealis': ['aurora_borealis', 'auroraborealis', 'aurora', 'borealis'],
    'feather_light': ['feather_light', 'featherlight', 'feather', 'feat', 'light'],
    'asus_1': ['asus_1', 'asus1'],
    'asus_2': ['asus_2', 'asus2'],
};
```

---

## Visibility Management System

### Core Function: `updateWallpaperVisibility`

**Location**: `index.js:803-1164`

**Signature**: `async function updateWallpaperVisibility(selectedWallpaper)`

### Execution Flow

#### Phase 1: Mesh Collection and Classification

**Step 1.1: Traverse and Collect**
- Traverses entire model using `model.traverse()`
- Identifies screen-related meshes using pattern matching:
  ```javascript
  name.includes('blank') || name.includes('blue') || 
  name.includes('bloom') || name.includes('aurora') || 
  name.includes('borealis') || name.includes('feather') || 
  name.includes('asus') || name.includes('screen') || 
  name.includes('rgb') || parentName.includes('screen')
  ```

**Step 1.2: Priority Assignment**
- Assigns priority scores based on mesh type:
  - `blank_screen`: 100 (highest)
  - `blue_bloom`: 90
  - `aurora_borealis`: 80
  - `feather_light`: 70
  - `asus_1`: 60
  - `asus_2`: 55
  - `screen_rgb`: 50
  - Generic screen elements: 10

**Step 1.3: Depth Calculation**
- Computes world position using `getWorldPosition()`
- Uses Z-coordinate as depth metric (lower Z = closer to screen/front)
- Sorts by priority (descending), then by depth (ascending)

**Step 1.4: Metadata Collection**
For each mesh, collects:
- Mesh reference
- Name and parent name
- Current visibility state
- Material properties (hasEmissiveMap, emissiveIntensity)
- World position (X, Y, Z)
- Priority and wallpaper type
- Depth (Z-coordinate)

#### Phase 2: Comprehensive Hiding

**Step 2.1: Hide All Screen Meshes**
```javascript
allScreenMeshes.forEach((info) => {
    info.mesh.visible = false;
    // ... parent group hiding logic
});
```

**Step 2.2: Parent Group Management**
- Traverses up the parent chain for each hidden mesh
- Identifies wallpaper-related groups:
  - Groups with `"wallpaper"` in name
  - Groups with `"screen"` (but not `"screenctrl"`)
  - Groups with `"rgb"` in name
- Hides parent groups that exclusively contain wallpapers
- Uses `Set` to track hidden groups and avoid duplicate operations

**Rationale**: In Three.js, if a parent group is hidden, all children are implicitly hidden regardless of their `visible` property. This ensures complete isolation of wallpaper meshes.

#### Phase 3: Target Mesh Selection

**Step 3.1: Custom Wallpaper Mode**
```javascript
if (selectedWallpaper === 'custom') {
    targetMesh = screenMesh;  // Use the screenMesh reference
    // Find in collected list for metadata
    targetMeshInfo = allScreenMeshes.find(info => info.mesh === screenMesh);
}
```

**Step 3.2: Predefined Wallpaper Mode**
```javascript
else if (wallpaperMeshes[selectedWallpaper]) {
    targetMesh = wallpaperMeshes[selectedWallpaper];
    // Update screenMesh reference for consistency
    screenMesh = selectedMesh;
}
```

#### Phase 4: Visibility Activation

**Step 4.1: Show Target Mesh**
```javascript
targetMesh.visible = true;
```

**Step 4.2: Parent Chain Visibility**
- Traverses up from target mesh to root
- Sets `visible = true` for all parent groups in the chain
- Maintains a `Set` of visible parent chains to prevent conflicts

**Step 4.3: Sibling Group Isolation**
- Traverses entire model to find wallpaper-related groups
- Hides groups that are NOT in the visible parent chain
- Prevents sibling wallpapers from appearing through group visibility

**Critical Logic**:
```javascript
model.traverse((child) => {
    if (child.isGroup) {
        const name = child.name?.toLowerCase() || '';
        if ((name.includes('wallpaper') || 
             (name.includes('screen') && name.includes('rgb')) ||
             name.includes('rgb')) &&
            !visibleParentChain.has(child) &&
            child !== targetMesh.parent) {
            child.visible = false;
        }
    }
});
```

#### Phase 5: Path Tracer Synchronization

**Step 5.1: Delay for DOM Updates**
```javascript
await new Promise(resolve => setTimeout(resolve, 10));
```
**Purpose**: Ensures Three.js visibility updates are processed before path tracer rebuild.

**Step 5.2: Scene Rebuild**
```javascript
await pathTracer.setSceneAsync(scene, activeCamera, {
    onProgress: (v) => {
        if (v === 1) {
            console.log('✅ Path tracer scene rebuilt');
        }
    }
});
```

**What Happens Internally**:
1. `setSceneAsync` calls `setScene` with async flag
2. `PathTracingSceneGenerator.setObjects(scene)` is invoked
3. `StaticGeometryGenerator` traverses the scene using `traverseVisible()`
4. Only meshes with `visible = true` are included in geometry generation
5. BVH (Bounding Volume Hierarchy) is rebuilt or refitted
6. Material indices are updated
7. Texture references are synchronized

**Why This is Critical**: The path tracer maintains its own internal representation of the scene geometry. Simply changing `visible` in Three.js doesn't automatically update the path tracer. `setSceneAsync` forces a complete rebuild, ensuring only visible meshes are included in ray tracing calculations.

---

## Path Tracer Integration

### How Path Tracer Handles Visibility

**Location**: `src/core/PathTracingSceneGenerator.js`

**Key Method**: `setObjects(scene)`

**Process**:
1. **Scene Traversal**: Uses `scene.traverseVisible()` instead of `scene.traverse()`
2. **Geometry Collection**: Only collects geometry from visible meshes
3. **BVH Construction**: Builds acceleration structure only for visible geometry
4. **Material Mapping**: Maps materials to geometry indices based on visible meshes

**TraverseVisible Behavior**:
- Skips objects where `object.visible === false`
- Recursively checks parent visibility
- Stops traversal at first hidden parent

### Material Updates

**Location**: `index.js:1262`

```javascript
pathTracer.updateMaterials();
```

**Purpose**: Synchronizes material properties (especially emissive maps and intensities) with the path tracer's internal material system.

**When Called**:
- After custom image upload
- After brightness slider changes
- After any material property modification

### Path Tracer Reset

**Location**: `index.js:1266`

```javascript
pathTracer.reset();
```

**Purpose**: Clears accumulated samples, forcing a fresh render with new visibility/material state.

**Why Needed**: Path tracing accumulates samples over time. When visibility changes, old samples become invalid and must be discarded.

---

## Custom Wallpaper Handling

### Function: `handleImageUpload`

**Location**: `index.js:1166-1302`

### Execution Flow

#### Phase 1: File Processing

**Step 1.1: File Validation**
```javascript
if (!file || !file.type.startsWith('image/')) {
    alert('Please upload an image file');
    return;
}
```

**Step 1.2: File Reading**
- Uses `FileReader` API to read file as Data URL
- Converts to `Image` object for texture creation

#### Phase 2: Texture Creation

**Step 2.1: Image Loading**
```javascript
const img = new Image();
img.onload = async () => {
    // Texture creation happens here
};
img.src = e.target.result;  // Data URL from FileReader
```

**Step 2.2: Texture Instantiation**
```javascript
const texture = new Texture(img);
texture.needsUpdate = true;
```

**Key Properties**:
- `needsUpdate = true`: Forces GPU texture upload on next render
- Texture is stored in `uploadedTexture` global variable

#### Phase 3: Material Application

**Step 3.1: Material Discovery**
```javascript
if (!screenMesh && model) {
    screenMesh = findScreenMesh(model);
}
```

**Step 3.2: Material Array Handling**
```javascript
const materials = Array.isArray(screenMesh.material)
    ? screenMesh.material
    : [screenMesh.material];
```

**Rationale**: Some meshes use material arrays for multi-material rendering. We apply the texture to all materials.

**Step 3.3: Old Texture Disposal**
```javascript
if (material.emissiveMap && material.emissiveMap !== uploadedTexture) {
    material.emissiveMap.dispose();
}
```

**Purpose**: Prevents memory leaks by disposing unused textures. Only disposes if it's not the current uploaded texture.

**Step 3.4: Emissive Properties Setup**
```javascript
material.emissiveMap = texture;
material.emissiveIntensity = params.screenBrightness;
material.emissive = new Color(0xffffff);  // White base
material.needsUpdate = true;
```

**Critical Properties**:
- **`emissiveMap`**: The texture that emits light
- **`emissiveIntensity`**: Controls light emission strength (0-5 range)
- **`emissive`**: Base color (white = full brightness from texture)
- **`needsUpdate`**: Signals Three.js to update GPU material state

**Why Emissive Map**: In path tracing, `emissiveMap` is the primary mechanism for light emission. The path tracer samples this texture to:
1. Emit light rays from the surface
2. Generate reflections in other surfaces
3. Contribute to global illumination

#### Phase 4: Visibility Update

**Step 4.1: State Update**
```javascript
params.screenWallpaper = 'custom';
currentWallpaper = 'custom';
```

**Step 4.2: Visibility Synchronization**
```javascript
await updateWallpaperVisibility('custom');
```

This ensures:
- All predefined wallpapers are hidden
- Only `screenMesh` (with custom texture) is visible
- Path tracer scene is rebuilt

#### Phase 5: Path Tracer Synchronization

**Step 5.1: Material Update**
```javascript
pathTracer.updateMaterials();
```
Synchronizes new emissive map with path tracer's material system.

**Step 5.2: Reset Accumulation**
```javascript
pathTracer.reset();
```
Clears old samples that don't reflect the new texture.

**Step 5.3: GUI Rebuild**
```javascript
buildGui();
```
Updates dropdown to show 'custom' as selected.

---

## Data Flow and Execution Sequence

### Sequence Diagram: Wallpaper Selection

```
User Selects Wallpaper
    │
    ├─> GUI onChange Event
    │       │
    │       └─> updateWallpaperVisibility(selectedWallpaper)
    │               │
    │               ├─> Phase 1: Collect All Screen Meshes
    │               │       ├─> Traverse model
    │               │       ├─> Identify screen-related meshes
    │               │       ├─> Calculate priorities and depths
    │               │       └─> Build allScreenMeshes array
    │               │
    │               ├─> Phase 2: Hide All Meshes
    │               │       ├─> Set all meshes.visible = false
    │               │       ├─> Hide parent groups
    │               │       └─> Track hidden groups in Set
    │               │
    │               ├─> Phase 3: Select Target Mesh
    │               │       ├─> If 'custom': use screenMesh
    │               │       └─> Else: use wallpaperMeshes[key]
    │               │
    │               ├─> Phase 4: Show Target
    │               │       ├─> Set targetMesh.visible = true
    │               │       ├─> Show parent chain
    │               │       └─> Hide sibling groups
    │               │
    │               └─> Phase 5: Sync Path Tracer
    │                       ├─> Delay (10ms)
    │                       └─> pathTracer.setSceneAsync()
    │                               ├─> Rebuild geometry (only visible)
    │                               ├─> Rebuild BVH
    │                               └─> Update material indices
    │
    └─> Render Update
            └─> Path tracer renders with new visibility
```

### Sequence Diagram: Custom Image Upload

```
User Uploads Image
    │
    ├─> File Input Change Event
    │       │
    │       └─> handleImageUpload(file)
    │               │
    │               ├─> FileReader.readAsDataURL()
    │               │       │
    │               │       └─> Image.onload
    │               │               │
    │               │               ├─> Create Texture
    │               │               │       └─> new Texture(img)
    │               │               │
    │               │               ├─> Find/Create screenMesh
    │               │               │       └─> findScreenMesh(model)
    │               │               │
    │               │               ├─> Apply to Materials
    │               │               │       ├─> Dispose old texture
    │               │               │       ├─> Set emissiveMap
    │               │               │       ├─> Set emissiveIntensity
    │               │               │       └─> Set emissive color
    │               │               │
    │               │               ├─> Update State
    │               │               │       ├─> params.screenWallpaper = 'custom'
    │               │               │       └─> currentWallpaper = 'custom'
    │               │               │
    │               │               ├─> Update Visibility
    │               │               │       └─> await updateWallpaperVisibility('custom')
    │               │               │
    │               │               ├─> Sync Path Tracer
    │               │               │       ├─> pathTracer.updateMaterials()
    │               │               │       └─> pathTracer.reset()
    │               │               │
    │               │               └─> Rebuild GUI
    │               │                       └─> buildGui()
    │               │
    │               └─> Render Update
    │                       └─> Path tracer renders custom texture
```

---

## Technical Implementation Details

### 1. Priority System

**Purpose**: Ensures correct mesh selection when multiple candidates exist.

**Priority Values**:
- Higher values = higher priority
- Used for sorting and selection logic
- Prevents ambiguous matches

**Implementation**:
```javascript
if (name.includes('blank') || name.includes('screen_blank')) {
    priority = 100;  // Highest priority
    wallpaperType = 'blank_screen';
}
// ... other priorities
```

### 2. Depth-Based Sorting

**Purpose**: When priorities are equal, closer meshes (lower Z) are preferred.

**Calculation**:
```javascript
child.updateMatrixWorld(true);  // Ensure world matrix is current
const worldPos = new Vector3();
child.getWorldPosition(worldPos);
const depth = worldPos.z;  // Z = depth
```

**Sorting**:
```javascript
allScreenMeshes.sort((a, b) => {
    if (b.priority !== a.priority) 
        return b.priority - a.priority;  // Higher priority first
    return a.depth - b.depth;  // Lower Z (closer) first
});
```

### 3. Parent Group Management

**Challenge**: Three.js visibility is hierarchical. If a parent is hidden, children are hidden regardless of their `visible` property.

**Solution**: Two-phase approach:
1. **Hide Phase**: Hide all wallpaper meshes AND their parent groups
2. **Show Phase**: Show target mesh AND its entire parent chain

**Implementation**:
```javascript
// Hide phase
let parent = info.mesh.parent;
while (parent && parent !== model) {
    if (isWallpaperGroup(parent)) {
        parent.visible = false;
        hiddenGroups.add(parent);
    }
    parent = parent.parent;
}

// Show phase
let parent = targetMesh.parent;
while (parent && parent !== model) {
    parent.visible = true;
    visibleParentChain.add(parent);
    parent = parent.parent;
}
```

### 4. Sibling Group Isolation

**Problem**: Even after hiding individual meshes, sibling groups might still be visible, causing conflicts.

**Solution**: Explicitly hide groups that are NOT in the visible parent chain.

```javascript
model.traverse((child) => {
    if (child.isGroup && isWallpaperGroup(child)) {
        if (!visibleParentChain.has(child) && 
            child !== targetMesh.parent) {
            child.visible = false;
        }
    }
});
```

### 5. Async/Await Pattern

**Why Async**: 
- `setSceneAsync` returns a Promise
- BVH construction can take time (especially for large models)
- We need to wait for completion before continuing

**Implementation**:
```javascript
async function updateWallpaperVisibility(selectedWallpaper) {
    // ... visibility changes ...
    
    await new Promise(resolve => setTimeout(resolve, 10));
    await pathTracer.setSceneAsync(scene, activeCamera, {
        onProgress: (v) => { /* ... */ }
    });
}
```

**Error Handling**: If `setSceneAsync` fails, the visibility changes are still applied in Three.js, but path tracer may be out of sync. The console logs help identify this.

### 6. Material Array Handling

**Challenge**: Some meshes use material arrays for multi-material rendering.

**Solution**: Normalize to array, then iterate:

```javascript
const materials = Array.isArray(screenMesh.material)
    ? screenMesh.material
    : [screenMesh.material];

materials.forEach((material, idx) => {
    material.emissiveMap = texture;
    material.emissiveIntensity = params.screenBrightness;
    // ... other properties
});
```

### 7. Texture Disposal

**Memory Management**: Three.js textures consume GPU memory. Old textures must be disposed.

**Strategy**:
```javascript
if (material.emissiveMap && material.emissiveMap !== uploadedTexture) {
    material.emissiveMap.dispose();
}
```

**Why Check `!== uploadedTexture`**: Prevents disposing the texture we just created if it's already assigned.

---

## Performance Considerations

### 1. Scene Traversal Cost

**Frequency**: Called on every wallpaper change.

**Optimization**: Single traversal collects all data needed for:
- Mesh identification
- Priority calculation
- Depth calculation
- Visibility management

**Complexity**: O(n) where n = number of objects in scene.

### 2. BVH Rebuild Cost

**When**: Every `setSceneAsync` call.

**Cost**: 
- Small models (< 10K triangles): ~10-50ms
- Medium models (10K-100K triangles): ~50-200ms
- Large models (> 100K triangles): ~200ms-2s

**Mitigation**: 
- Only rebuilds when visibility actually changes
- Uses async generation to avoid blocking
- Progress callbacks allow UI updates

### 3. Texture Upload Cost

**When**: Custom image upload.

**Cost**: Depends on image size:
- 1MP (1024x1024): ~5-10ms
- 4MP (2048x2048): ~10-20ms
- 8MP (4096x4096): ~20-50ms

**Mitigation**: 
- Textures are uploaded once
- Reused across material updates
- Disposed only when replaced

### 4. Material Update Cost

**When**: Brightness changes, texture changes.

**Cost**: Minimal (~1-5ms) - just property updates.

**Optimization**: Batch updates in single `updateMaterials()` call.

---

## Debugging and Logging

### Comprehensive Console Logging

The system includes extensive logging for debugging:

#### 1. Mesh Discovery Logs
```
✅ Found wallpaper "blank_screen" mesh: screen_blank Parent: screenCTRL
✅ Found wallpaper "blue_bloom" mesh: 01_Blue_Bloom Parent: wallpaper
```

#### 2. Visibility Update Logs
```
🎨 ========== UPDATE WALLPAPER VISIBILITY ==========
📌 Selected wallpaper: "custom"
📦 Current screenMesh: screen_blank
📋 Available wallpapers: ['blank_screen', 'blue_bloom']
```

#### 3. Mesh Collection Table
```
📊 ALL SCREEN MESHES FOUND (15 total):
   ┌─────────────────────────────────────────────────────────────────────────┐
   │ Priority │ Depth (Z) │ Visible │ Has Emissive │ Type │ Name │
   ├─────────────────────────────────────────────────────────────────────────┤
   │ 100      │ -0.49     │ ✅ YES  │ ❌ NO        │ ... │ ... │
   └─────────────────────────────────────────────────────────────────────────┘
```

#### 4. Hiding Logs
```
🔒 HIDING ALL SCREEN MESHES AND PARENT GROUPS:
   ❌ HID MESH: "screen_blank" (Priority: 100, Depth: -0.49)
   ❌ HID GROUP: "wallpaper" (contains "01_Blue_Bloom")
```

#### 5. Showing Logs
```
✅ SHOWING TARGET MESH:
   Name: "screen_blank"
   Priority: 100 (blank_screen)
   Depth (Z): -0.49 (FRONT/CLOSER)
   Has EmissiveMap: ✅ YES
   ✅ Made parent visible: "screenCTRL"
```

#### 6. Final State Logs
```
📊 FINAL STATE - VISIBLE MESHES ON SCREEN:
   ✅ 1 mesh(es) visible:
   1. "screen_blank"
      Priority: 100 (blank_screen)
      Depth: -0.49 (FRONT)
      Has EmissiveMap: ✅ YES
```

#### 7. Path Tracer Sync Logs
```
🔄 Updating path tracer scene (rebuilding with only visible meshes)...
✅ Path tracer scene rebuilt - only visible meshes included
```

### Debugging Tips

1. **Check Console Table**: The mesh collection table shows all screen-related meshes and their states
2. **Verify Priority**: Ensure target mesh has highest priority among visible meshes
3. **Check Parent Chain**: Verify all parents in chain are visible
4. **Verify Sibling Groups**: Ensure sibling wallpaper groups are hidden
5. **Path Tracer Sync**: Check that `setSceneAsync` completes successfully
6. **Material Properties**: Verify `emissiveMap` and `emissiveIntensity` are set correctly

### Common Issues and Solutions

#### Issue 1: Multiple Wallpapers Visible
**Symptom**: Multiple wallpaper meshes appear simultaneously.

**Causes**:
- Parent groups not properly hidden
- Sibling groups still visible
- Priority/depth sorting incorrect

**Solution**: Check console logs for hidden meshes. Verify parent chain visibility.

#### Issue 2: Custom Wallpaper Not Visible
**Symptom**: Custom texture uploaded but screen appears blank.

**Causes**:
- `screenMesh` not found
- Texture not applied to material
- `emissiveIntensity` set to 0
- Path tracer not synced

**Solution**: Check console for "Screen mesh found" log. Verify material properties in logs.

#### Issue 3: Path Tracer Shows Old Wallpaper
**Symptom**: Three.js shows correct wallpaper, but path tracer shows old one.

**Causes**:
- `setSceneAsync` not awaited
- BVH not rebuilt
- Material indices not updated

**Solution**: Ensure `await pathTracer.setSceneAsync()` completes. Check for errors in console.

#### Issue 4: Performance Issues
**Symptom**: Slow wallpaper switching or laggy rendering.

**Causes**:
- Large model with many meshes
- Frequent BVH rebuilds
- Large texture uploads

**Solution**: 
- Reduce model complexity if possible
- Use smaller textures for custom wallpapers
- Consider debouncing rapid wallpaper changes

---

## Conclusion

The wallpaper visibility management system provides a robust solution for dynamic wallpaper switching in a GPU path-traced environment. Key achievements:

1. **Mutual Exclusivity**: Only one wallpaper visible at a time
2. **Path Tracer Integration**: Proper synchronization with GPU path tracer
3. **Custom Wallpaper Support**: Dynamic texture upload and application
4. **Hierarchical Visibility**: Proper handling of Three.js group hierarchies
5. **Comprehensive Logging**: Extensive debugging information

The system handles edge cases such as:
- Nested meshes in groups
- Material arrays
- Parent group visibility
- Sibling group conflicts
- Async path tracer operations

This implementation ensures correct light emission, reflections, and global illumination in the path-traced rendering pipeline.

---

## References

- **Three.js Documentation**: https://threejs.org/docs/
- **WebGLPathTracer Source**: `src/core/WebGLPathTracer.js`
- **PathTracingSceneGenerator**: `src/core/PathTracingSceneGenerator.js`
- **Main Implementation**: `example/index.js`

---

**Last Updated**: 2024
**Version**: 1.0
**Author**: Technical Documentation
