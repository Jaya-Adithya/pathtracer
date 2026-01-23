# Image Rendering System Implementation Plan

## Analysis Summary

### Reference Implementation (ImageRenderModal.jsx)
The reference implementation shows a sophisticated image rendering system with:

1. **Path Tracer Integration:**
   - Uses `pathTracer.samples` to track current sample count
   - Waits for target samples using `pathTracingSettings.initialSamples` (from slider)
   - Resizes renderer and path tracer to target resolution before capture
   - Monitors sample progress and updates UI

2. **Canvas Capture:**
   - Uses `canvas.toDataURL('image/png', 1.0)` for PNG
   - Uses `canvas.toBlob()` for other formats
   - Handles format conversion (PNG → JPG, PSD)
   - Supports transparency for PNG, forces background for JPG/PSD

3. **Resolution Support:**
   - 1K: 1920x1080 (16:9), 1920x1920 (1:1)
   - 2K: 2560x1440 (16:9), 2560x2560 (1:1)
   - 4K: 3840x2160 (16:9), 3840x3840 (1:1)
   - 8K: 7680x4320 (16:9), 7680x7680 (1:1)
   - 16K: 15360x8640 (16:9), 15360x15360 (1:1)

4. **Format Support:**
   - PNG: Supports transparency, lossless
   - JPG: No transparency, requires background
   - PSD: Requires background, uses canvas-to-PSD conversion

5. **Sample Control:**
   - Slider controls target samples (0-10000+)
   - 0 samples = immediate capture
   - Higher samples = better quality but longer render time
   - Progress tracking shows current/target samples

## Implementation Plan

### Phase 1: Core Modal Component
- Create `ImageRenderModal.js` component
- Add format selector (PNG, JPG, PSD)
- Add resolution selector (1K-16K)
- Add aspect ratio selector (16:9, 1:1, 4:3)
- Add sample slider (0-10000, step 100)

### Phase 2: Rendering Logic
- Implement path tracer sample waiting
- Add renderer resize logic
- Implement canvas capture
- Add format conversion (PNG → JPG/PSD)

### Phase 3: UI Integration
- Add "Render Image" button to GUI
- Create modal overlay with controls
- Add progress indicator
- Add download functionality

### Phase 4: Format-Specific Features
- PNG: Preserve transparency
- JPG: Force background, quality slider
- PSD: Background required, layer support

## Technical Details

### Sample Waiting Logic
```javascript
const waitForSamples = async (pathTracer, targetSamples) => {
  return new Promise((resolve) => {
    const checkSamples = () => {
      const current = Math.floor(pathTracer.samples);
      if (current >= targetSamples) {
        resolve();
      } else {
        requestAnimationFrame(checkSamples);
      }
    };
    checkSamples();
  });
};
```

### Canvas Capture
```javascript
// Resize renderer
renderer.setSize(targetWidth, targetHeight);
renderer.setPixelRatio(1);

// Wait for samples
await waitForSamples(pathTracer, targetSamples);

// Capture canvas
const canvas = renderer.domElement;
const dataUrl = canvas.toDataURL('image/png', 1.0);
```

### Format Conversion
- PNG: Direct capture
- JPG: Convert PNG to JPG using canvas (requires background)
- PSD: Use canvas-to-PSD library or server-side conversion

## File Structure
```
example/
  ├── ImageRenderModal.js       # Main modal component
  ├── ImageRenderModal.css      # Modal styles
  └── utils/
      └── imageExport.js        # Format conversion utilities
```

## Integration Points
- Add to `example/index.js`: Import modal, add render button
- Add to `example/index.html`: Include modal HTML/CSS
- Connect to existing `pathTracer` instance
- Use existing `renderer` and `scene` references
