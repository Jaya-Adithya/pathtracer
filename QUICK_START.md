# Quick Start Guide

## Running the Project

1. **Install dependencies** (if not already done):
   ```bash
   npm install
   ```

2. **Start the development server**:
   ```bash
   npm start
   ```

3. **Open in browser**:
   - The server will start on `http://localhost:5173` (or another port if 5173 is busy)
   - Navigate to `http://localhost:5173/index.html` in your browser

## Using the Image Render Modal

1. **Load a model**: Select a model from the dropdown in the GUI
2. **Open render modal**: Click "Render Image..." button in the "Path Tracer" GUI folder
3. **Configure settings**:
   - **Resolution**: Choose from 1K to 16K (start with 4K for testing)
   - **Aspect Ratio**: 16:9, 1:1, or 4:3
   - **Format**: PNG (recommended), JPG, or PSD
   - **Target Samples**: 0-10000 (1000 is a good starting point)
     - 0 = instant capture
     - Higher = better quality but slower
   - **File Name**: Enter desired filename
4. **Render**: Click "Render" button
5. **Wait**: Watch the progress bar as samples accumulate
6. **Download**: Image automatically downloads when complete

## Troubleshooting

- **Server won't start**: Make sure port 5173 is available, or check the terminal for the actual port
- **Modal doesn't open**: Check browser console (F12) for errors
- **Render fails**: Ensure path tracer is enabled and scene is loaded
- **Memory errors**: Try lower resolution or fewer samples
- **Canvas is blank**: Make sure path tracer has rendered at least a few samples

## Project Structure

- `example/index.html` - Main example page
- `example/index.js` - Main example code with GUI
- `example/ImageRenderModal.js` - Image render modal component
- `example/ImageRenderModal.css` - Modal styling

## Features Implemented

✅ PNG, JPG, PSD format support  
✅ Resolutions up to 16K  
✅ Sample control slider (0-10000)  
✅ Real-time progress tracking  
✅ Aspect ratio options (16:9, 1:1, 4:3)  
✅ Automatic renderer restoration  
