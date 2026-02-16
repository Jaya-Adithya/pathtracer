/**
 * ImageRenderModal - Modal for rendering path-traced images
 * Supports PNG, JPG, PSD formats with resolutions up to 8K (16K causes context loss)
 * Includes sample control slider for quality vs speed tradeoff
 */

export class ImageRenderModal {

	constructor( pathTracer, renderer, scene, camera ) {

		this.pathTracer = pathTracer;
		this.renderer = renderer;
		this.scene = scene;
		this.camera = camera;

		// Store original renderer size to restore later
		this.originalSize = { width: 0, height: 0 };
		this.originalPixelRatio = 1;

		// Store original path tracer settings to restore later
		this.originalSettings = {
			tiles: { x: 1, y: 1 },
			bounces: 5,
			renderScale: 1,
			filterGlossyFactor: 0.1,
			multipleImportanceSampling: true,
			toneMapping: null
		};

		// Modal state
		this.isOpen = false;
		this.isRendering = false;

		// Render settings
		this.settings = {
			resolution: '4K',
			aspectRatio: '16:9',
			format: 'PNG',
			targetSamples: 1000,
			backgroundMode: 'without',
			fileName: 'render'
		};

		// When user clicks "Stop & capture" during render, we exit the sample loop and capture at current samples
		this.stopRequested = false;

		// Resolution map
		this.resolutions = {
			'1K': { '16:9': [ 1920, 1080 ], '1:1': [ 1920, 1920 ], '4:3': [ 1920, 1440 ] },
			'2K': { '16:9': [ 2560, 1440 ], '1:1': [ 2560, 2560 ], '4:3': [ 2560, 1920 ] },
			'4K': { '16:9': [ 3840, 2160 ], '1:1': [ 3840, 3840 ], '4:3': [ 3840, 2880 ] },
			'8K': { '16:9': [ 7680, 4320 ], '1:1': [ 7680, 7680 ], '4:3': [ 7680, 5760 ] },
			// 16K removed: 15360x8640 = 132.7 MP exceeds safe 64 MP limit and causes WebGL context loss
			// Maximum safe resolution is 8K (7680x4320 = 33.2 MP)
		};

		// Get GPU maximum texture size
		const gl = this.renderer.getContext();
		this.maxTextureSize = gl.getParameter( gl.MAX_TEXTURE_SIZE );
		this.maxRenderbufferSize = gl.getParameter( gl.MAX_RENDERBUFFER_SIZE );
		this.maxSize = Math.min( this.maxTextureSize, this.maxRenderbufferSize );

		console.log( `🎮 GPU Limits: Max Texture Size: ${this.maxTextureSize}, Max Renderbuffer Size: ${this.maxRenderbufferSize}, Using: ${this.maxSize}` );

		this.createModal();
		this.attachEventListeners();

	}

	createModal() {

		const modalHTML = `
			<div id="imageRenderModal" class="image-render-modal" style="display: none;">
				<div class="modal-overlay"></div>
				<div class="modal-content">
					<div class="modal-header">
						<h2>Render Image</h2>
						<button class="close-btn" id="closeModalBtn">&times;</button>
					</div>
					<div class="modal-body">
						<div class="form-group">
							<label for="resolution">Resolution:</label>
							<select id="resolution" class="form-control">
								<option value="1K">1K (1920x1080)</option>
								<option value="2K">2K (2560x1440)</option>
								<option value="4K" selected>4K (3840x2160)</option>
								<option value="8K">8K (7680x4320)</option>
								<!-- 16K removed: Causes WebGL context loss due to memory limits. Max safe: 8K -->
							</select>
						</div>
						<div class="form-group">
							<label for="aspectRatio">Aspect Ratio:</label>
							<select id="aspectRatio" class="form-control">
								<option value="16:9" selected>16:9</option>
								<option value="1:1">1:1</option>
								<option value="4:3">4:3</option>
							</select>
						</div>
						<div class="form-group">
							<label for="format">Format:</label>
							<select id="format" class="form-control">
								<option value="PNG" selected>PNG</option>
								<option value="JPG">JPG</option>
								<option value="PSD">PSD</option>
							</select>
						</div>
						<div class="form-group">
							<label for="samples">
								Target Samples: <span id="samplesValue">1000</span>
							</label>
							<input type="range" id="samples" min="0" max="10000" step="100" value="1000" class="slider">
							<div class="slider-info">
								<span>0 (instant)</span>
								<span>10000 (high quality)</span>
							</div>
						</div>
						<div class="form-group">
							<label for="backgroundMode">Background:</label>
							<select id="backgroundMode" class="form-control">
								<option value="without" selected>Without Background</option>
								<option value="with">With Background</option>
							</select>
						</div>
						<div class="form-group">
							<label for="fileName">File Name:</label>
							<input type="text" id="fileName" value="render" class="form-control">
						</div>
						<div id="renderProgress" class="render-progress" style="display: none;">
							<div class="progress-bar">
								<div class="progress-fill" id="progressFill"></div>
							</div>
							<div class="progress-text" id="progressText">Preparing render...</div>
						</div>
					</div>
					<div class="modal-footer">
						<button id="cancelBtn" class="btn btn-secondary">Cancel</button>
						<button id="stopAndCaptureBtn" class="btn btn-warning" style="display: none;">Stop & capture</button>
						<button id="renderBtn" class="btn btn-primary">Render</button>
					</div>
				</div>
			</div>
		`;

		// Add modal to body if it doesn't exist
		if ( ! document.getElementById( 'imageRenderModal' ) ) {

			document.body.insertAdjacentHTML( 'beforeend', modalHTML );

		}

		this.modal = document.getElementById( 'imageRenderModal' );
		this.updateSamplesDisplay();

	}

	attachEventListeners() {

		// Close button
		document.getElementById( 'closeModalBtn' ).addEventListener( 'click', () => this.close() );
		document.getElementById( 'cancelBtn' ).addEventListener( 'click', () => this.close() );

		// Overlay click
		this.modal.querySelector( '.modal-overlay' ).addEventListener( 'click', () => this.close() );

		// Render button
		document.getElementById( 'renderBtn' ).addEventListener( 'click', () => this.handleRender() );

		// Samples slider
		document.getElementById( 'samples' ).addEventListener( 'input', ( e ) => {

			this.settings.targetSamples = parseInt( e.target.value );
			this.updateSamplesDisplay();

		} );

		// Stop & capture: stop sample accumulation and capture at current samples
		document.getElementById( 'stopAndCaptureBtn' ).addEventListener( 'click', () => {

			if ( this.isRendering ) this.stopRequested = true;

		} );

		// Settings changes
		[ 'resolution', 'aspectRatio', 'format', 'backgroundMode', 'fileName' ].forEach( id => {

			document.getElementById( id ).addEventListener( 'change', ( e ) => {

				this.settings[ id === 'fileName' ? 'fileName' : id ] = e.target.value;

			} );

		} );

		// ESC key to close
		document.addEventListener( 'keydown', ( e ) => {

			if ( e.key === 'Escape' && this.isOpen ) {

				this.close();

			}

		} );

	}

	updateSamplesDisplay() {

		const value = this.settings.targetSamples;
		document.getElementById( 'samplesValue' ).textContent = value.toLocaleString();
		document.getElementById( 'samples' ).value = value;

	}

	open() {

		if ( this.onOpen ) this.onOpen();
		this.isOpen = true;
		this.modal.style.display = 'flex';
		document.body.style.overflow = 'hidden';

	}

	close() {

		if ( this.isRendering ) {

			if ( ! confirm( 'Rendering in progress. Are you sure you want to cancel?' ) ) {

				return;

			}

			this.cancelRender();

		}

		this.isOpen = false;
		this.modal.style.display = 'none';
		document.body.style.overflow = '';
		if ( this.onClose ) this.onClose();

	}

	async handleRender() {

		if ( this.isRendering ) return;

		// Turn path tracer back on so canvas accumulates and we can capture (main point of render)
		if ( this.onBeforeRender ) this.onBeforeRender();

		this.isRendering = true;
		this.stopRequested = false;
		const renderBtn = document.getElementById( 'renderBtn' );
		const stopBtn = document.getElementById( 'stopAndCaptureBtn' );
		const progressDiv = document.getElementById( 'renderProgress' );
		const progressFill = document.getElementById( 'progressFill' );
		const progressText = document.getElementById( 'progressText' );

		renderBtn.disabled = true;
		renderBtn.style.display = 'none';
		if ( stopBtn ) stopBtn.style.display = 'inline-block';
		progressDiv.style.display = 'block';

		try {

			// Background mode from dropdown; PNG + "without" = auto transparent
			const isPNG = this.settings.format.toUpperCase() === 'PNG';
			const shouldCaptureBackground = this.settings.backgroundMode === 'with';
			const bgImageSrc = window.backgroundImageSrc || null;
			const bgImageW = window.backgroundImageNaturalWidth || 0;
			const bgImageH = window.backgroundImageNaturalHeight || 0;

			// Get target dimensions
			const res = this.resolutions[ this.settings.resolution ];
			let [ width, height ] = res[ this.settings.aspectRatio ];

			// If "with background" and we have image dimensions, preserve background aspect ratio
			if ( shouldCaptureBackground && bgImageSrc && bgImageW > 0 && bgImageH > 0 ) {

				const bgAspect = bgImageW / bgImageH;
				const baseAspect = width / height;

				if ( bgAspect > baseAspect ) {

					height = Math.round( width / bgAspect );

				} else {

					width = Math.round( height * bgAspect );

				}

				console.log( `🎨 [Render] Adjusted to background aspect ratio: ${width}x${height} (image: ${bgImageW}x${bgImageH})` );

			}

			// Transparent background handling
			const originalBackground = this.scene.background;
			const originalClearAlpha = this.renderer.getClearAlpha();
			let didSetTransparent = false;

			// PNG + "without background" = auto transparent PNG (no need for separate checkbox)
			if ( isPNG && ! shouldCaptureBackground ) {

				this.scene.background = null;
				this.renderer.setClearAlpha( 0 );
				this.pathTracer.updateEnvironment();
				// CRITICAL: Reset so accumulation uses new backgroundAlpha=0 (no solid floor/background)
				if ( typeof this.pathTracer.reset === 'function' ) this.pathTracer.reset();
				didSetTransparent = true;
				console.log( '🎨 [Render] PNG without background — transparent background auto-enabled, path tracer reset' );

			} else if ( shouldCaptureBackground && bgImageSrc ) {

				// "With background" selected: render transparent, composite bg image behind
				this.scene.background = null;
				this.renderer.setClearAlpha( 0 );
				this.pathTracer.updateEnvironment();
				if ( typeof this.pathTracer.reset === 'function' ) this.pathTracer.reset();
				didSetTransparent = true;
				console.log( '🎨 [Render] With background — set transparent for compositing' );

			}

			// CRITICAL: Clamp resolution to GPU limits BEFORE any operations
			const originalWidth = width;
			const originalHeight = height;

			console.log( `📐 [Render] Initial resolution: ${width}x${height}, GPU max: ${this.maxSize}` );

			// CRITICAL: Check total pixel count to prevent context loss (matches reference implementation)
			const totalPixels = width * height;
			const maxSafePixels = 4096 * 4096; // 16MP safe limit
			const maxMemoryPixels = 8192 * 8192; // 64MP absolute limit (matches reference)

			// Check pixel count limits first (prevents context loss)
			if ( totalPixels > maxMemoryPixels ) {

				// Calculate safe resolution that fits within memory limit
				const safeScale = Math.sqrt( maxMemoryPixels / totalPixels );
				const newWidth = Math.floor( width * safeScale );
				const newHeight = Math.floor( height * safeScale );

				const errorMsg = `Resolution ${this.settings.resolution} (${originalWidth}x${originalHeight}, ${totalPixels.toLocaleString()} pixels) exceeds memory limit (${maxMemoryPixels.toLocaleString()} pixels). Maximum safe resolution is 8192x8192. Clamping to ${newWidth}x${newHeight}`;
				console.error( errorMsg );
				progressText.textContent = errorMsg;
				alert( errorMsg + '\n\nPlease select a lower resolution (8K or below).' );

				width = newWidth;
				height = newHeight;

			} else if ( totalPixels > maxSafePixels ) {

				console.warn( `⚠️ High resolution detected: ${width}x${height} (${totalPixels.toLocaleString()} pixels). This may cause performance issues or context loss.` );
				progressText.textContent = `Preparing render at ${width}x${height}... (High resolution - may be slow)`;

			} else if ( width > this.maxSize || height > this.maxSize ) {

				// Check GPU texture/renderbuffer limits
				const scale = Math.min( this.maxSize / width, this.maxSize / height );
				const newWidth = Math.floor( width * scale );
				const newHeight = Math.floor( height * scale );

				console.log( `📐 [Render] Clamping: scale=${scale.toFixed( 4 )}, ${width}x${height} -> ${newWidth}x${newHeight}` );

				width = newWidth;
				height = newHeight;

				const warningMsg = `⚠️ Resolution ${this.settings.resolution} (${originalWidth}x${originalHeight}) exceeds GPU limit (${this.maxSize}). Clamping to ${width}x${height}`;
				console.warn( warningMsg );
				progressText.textContent = warningMsg;
				alert( warningMsg + '\n\nPlease select a lower resolution.' );

			} else {

				progressText.textContent = `Preparing render at ${width}x${height}...`;

			}

			// Double-check dimensions are valid (should never fail after clamping, but safety check)
			if ( width <= 0 || height <= 0 || width > this.maxSize || height > this.maxSize ) {

				throw new Error( `Invalid resolution: ${width}x${height}. Maximum supported: ${this.maxSize}x${this.maxSize}` );

			}

			console.log( `📐 [Render] Final target resolution: ${width}x${height} (clamped from ${originalWidth}x${originalHeight})` );

			// Store original renderer CSS size (NOT drawing buffer size)
			// renderer.domElement.width/height = CSS size × pixelRatio (drawing buffer)
			// renderer.setSize() expects CSS pixels and multiplies by pixelRatio internally
			this.originalPixelRatio = this.renderer.getPixelRatio();
			this.originalSize.width = Math.round( this.renderer.domElement.width / this.originalPixelRatio );
			this.originalSize.height = Math.round( this.renderer.domElement.height / this.originalPixelRatio );

			// Store original path tracer settings (to restore after rendering)
			this.originalSettings.tiles.x = this.pathTracer.tiles.x;
			this.originalSettings.tiles.y = this.pathTracer.tiles.y;
			this.originalSettings.bounces = this.pathTracer.bounces;
			this.originalSettings.renderScale = this.pathTracer.renderScale;
			this.originalSettings.filterGlossyFactor = this.pathTracer.filterGlossyFactor;
			this.originalSettings.multipleImportanceSampling = this.pathTracer.multipleImportanceSampling;
			this.originalSettings.toneMapping = this.renderer.toneMapping;
			this.originalSettings.textureSize = this.pathTracer.textureSize.clone();

			// Bump texture atlas to full 4K for final render quality
			this.pathTracer.textureSize.set( 4096, 4096 );

			// CRITICAL: Account for renderScale when checking GPU limits
			// The path tracer multiplies renderer size by renderScale to get actual render target size
			// Temporarily set renderScale to 1.0 for high-resolution renders to avoid exceeding GPU limits
			const originalRenderScale = this.pathTracer.renderScale;
			this.pathTracer.renderScale = 1.0; // Use 1:1 scale for rendering to avoid GPU limit issues

			console.log( `📐 [Render] Renderer size: ${width}x${height}, renderScale set to 1.0 for rendering (was ${originalRenderScale})` );

			// Apply optimal settings for final render quality (overrides preview settings)
			this.pathTracer.tiles.set( 1, 1 ); // Single tile for maximum rendering speed
			this.pathTracer.bounces = 30; // Maximum bounces for full GI accuracy
			this.pathTracer.filterGlossyFactor = 0; // No glossy filtering — exact reflections
			this.pathTracer.multipleImportanceSampling = true; // Always use MIS for best convergence

			// CRITICAL: Check current resolution FIRST - don't resize if not needed
			const currentWidth = this.renderer.domElement.width;
			const currentHeight = this.renderer.domElement.height;

			console.log( `📐 [Path Tracer] Current resolution: ${currentWidth}x${currentHeight}` );
			console.log( `📐 [Path Tracer] Target resolution: ${width}x${height}` );

			// STEP 1: Only resize if resolution doesn't match
			if ( currentWidth !== width || currentHeight !== height ) {

				console.log( `📐 [Path Tracer] Resolution mismatch - resizing from ${currentWidth}x${currentHeight} to ${width}x${height}` );
				progressText.textContent = `Resizing path tracer to ${width}x${height}...`;

				// Check WebGL context before resizing (prevent context loss)
				const gl = this.renderer.getContext();
				if ( gl && gl.isContextLost && gl.isContextLost() ) {

					throw new Error( 'WebGL context has been lost. Please refresh the page and try again.' );

				}

				// Resize renderer (dimensions should already be clamped, but double-check)
				if ( width > this.maxSize || height > this.maxSize ) {

					throw new Error( `Cannot resize renderer to ${width}x${height}. GPU maximum is ${this.maxSize}x${this.maxSize}. This should have been clamped earlier.` );

				}

				// Resize renderer
				this.renderer.setSize( width, height );
				this.renderer.setPixelRatio( 1 );

				// Check context after resize
				if ( gl && gl.isContextLost && gl.isContextLost() ) {

					throw new Error( `WebGL context lost after resizing to ${width}x${height}. Resolution too high for your GPU. Please try a lower resolution.` );

				}

				// Update camera aspect ratio
				if ( this.camera.isPerspectiveCamera ) {

					this.camera.aspect = width / height;
					this.camera.updateProjectionMatrix();

				} else if ( this.camera.isOrthographicCamera ) {

					// For orthographic cameras, update the frustum size
					const aspect = width / height;
					const orthoHeight = this.camera.top - this.camera.bottom;
					const orthoWidth = orthoHeight * aspect;
					this.camera.left = - orthoWidth / 2;
					this.camera.right = orthoWidth / 2;
					this.camera.updateProjectionMatrix();

				}

				// Check context before resizing path tracer
				if ( gl && gl.isContextLost && gl.isContextLost() ) {

					throw new Error( 'WebGL context lost before path tracer resize. Please try a lower resolution.' );

				}

				// Try to resize path tracer instance (EXACTLY like reference implementation)
				// Note: WebGLPathTracer doesn't have setSize, but internal _pathTracer does
				if ( this.pathTracer._pathTracer && typeof this.pathTracer._pathTracer.setSize === 'function' ) {

					this.pathTracer._pathTracer.setSize( width, height );

				} else if ( typeof this.pathTracer.setSize === 'function' ) {

					this.pathTracer.setSize( width, height );

				} else if ( typeof this.pathTracer.resize === 'function' ) {

					this.pathTracer.resize( width, height );

				} else if ( this.pathTracer.renderer && typeof this.pathTracer.renderer.setSize === 'function' ) {

					this.pathTracer.renderer.setSize( width, height );

				}

				// Check context after path tracer resize
				if ( gl && gl.isContextLost && gl.isContextLost() ) {

					throw new Error( `WebGL context lost after path tracer resize to ${width}x${height}. Resolution too high. Please try a lower resolution (8K or below).` );

				}

				// CRITICAL: Update path tracer environment/scene after resize
				// This ensures the path tracer regenerates its internal buffers
				if ( typeof this.pathTracer.updateEnvironment === 'function' ) {

					this.pathTracer.updateEnvironment();

				}

				if ( typeof this.pathTracer.setScene === 'function' ) {

					this.pathTracer.setScene( this.scene, this.camera );

				}

				// Wait a few frames for the path tracer to initialize at new resolution
				await this.waitFrames( 2 );

				// Force a sample render to kickstart accumulation at new resolution
				this.pathTracer.renderSample();
				await this.waitFrames( 1 );

			} else {

				console.log( '✅ [Path Tracer] Resolution matches - preserving current samples!' );
				progressText.textContent = 'Path tracer resolution matches - checking samples...';

			}

			// Store original path tracer state
			const originalEnablePathTracing = this.pathTracer.enablePathTracing;
			const originalPausePathTracing = this.pathTracer.pausePathTracing;
			const originalRenderToCanvas = this.pathTracer.renderToCanvas;

			// Ensure path tracer is enabled, not paused, and rendering to canvas
			this.pathTracer.enablePathTracing = true;
			this.pathTracer.pausePathTracing = false;
			this.pathTracer.renderToCanvas = true;

			// Update path tracer camera
			this.pathTracer.updateCamera();

			// Wait for target samples
			if ( this.settings.targetSamples > 0 ) {

				await this.waitForSamples( progressFill, progressText );

			} else {

				// If 0 samples requested, render at least a few to get something visible
				progressText.textContent = 'Rendering initial samples...';
				const minSamples = 10; // Minimum samples to ensure something is visible
				for ( let i = 0; i < minSamples; i ++ ) {

					this.pathTracer.renderSample();
					await this.waitFrames( 1 );

				}

			}

			// Render final sample to ensure everything is up to date
			this.pathTracer.renderSample();
			await this.waitFrames( 2 );

			progressText.textContent = 'Capturing image...';
			progressFill.style.width = '100%';

			// Ensure one final render to canvas before capture
			this.pathTracer.renderSample();
			await this.waitFrames( 1 );

			// CRITICAL: Check WebGL context before capture
			const gl = this.renderer.getContext();
			if ( gl && gl.isContextLost && gl.isContextLost() ) {

				throw new Error( `WebGL context lost before capture. Resolution ${width}x${height} is too high for your GPU. Please try a lower resolution (8K or below).` );

			}

			// Capture canvas (EXACTLY like reference implementation)
			const canvas = this.renderer.domElement;
			let imageData;

			// Verify canvas dimensions match target (matches reference check)
			if ( canvas && canvas.width === width && canvas.height === height ) {

				console.log( `📸 Capturing canvas at ${canvas.width}x${canvas.height}...` );
				imageData = await this.captureImage( canvas );

			} else {

				console.warn( `⚠️ Canvas size mismatch: expected ${width}x${height}, got ${canvas?.width}x${canvas?.height}` );

				// Fallback: try to capture anyway if canvas exists
				if ( ! canvas || canvas.width === 0 || canvas.height === 0 ) {

					throw new Error( `Canvas has zero dimensions (${canvas?.width}x${canvas?.height}). Please check renderer setup.` );

				}

				// Use actual canvas dimensions
				console.log( `📸 Capturing canvas at actual size ${canvas.width}x${canvas.height}...` );
				imageData = await this.captureImage( canvas );

			}

			// Composite the CSS background image behind the transparent path-traced render
			if ( shouldCaptureBackground && bgImageSrc ) {

				progressText.textContent = 'Compositing background image...';
				imageData = await this.compositeWithBackground( imageData, bgImageSrc, canvas.width, canvas.height );
				console.log( '🎨 [Render] Composited background image' );

			}

			// Download image
			this.downloadImage( imageData, this.settings.fileName, this.settings.format );

			progressText.textContent = 'Render complete!';

			// Restore original path tracer state (after capture)
			this.pathTracer.enablePathTracing = originalEnablePathTracing;
			this.pathTracer.pausePathTracing = originalPausePathTracing;
			this.pathTracer.renderToCanvas = originalRenderToCanvas;
			this.pathTracer.renderScale = originalRenderScale; // Restore original renderScale

			// Restore background/environment
			if ( didSetTransparent ) {

				this.scene.background = originalBackground;
				this.renderer.setClearAlpha( originalClearAlpha );
				this.pathTracer.updateEnvironment();

			}

			setTimeout( () => {

				this.close();
				this.restoreRenderer();

			}, 1000 );

		} catch ( error ) {

			console.error( 'Render error:', error );
			progressText.textContent = `Error: ${error.message}`;
			alert( `Render failed: ${error.message}` );

			// Restore background/environment on error
			if ( shouldCaptureBackground && bgImageSrc ) {

				this.scene.background = originalBackground;
				this.renderer.setClearAlpha( originalClearAlpha );
				this.pathTracer.updateEnvironment();

			}

			this.restoreRenderer();

		} finally {

			this.isRendering = false;
			this.stopRequested = false;
			renderBtn.disabled = false;
			renderBtn.textContent = 'Render';
			renderBtn.style.display = '';
			if ( document.getElementById( 'stopAndCaptureBtn' ) ) document.getElementById( 'stopAndCaptureBtn' ).style.display = 'none';

		}

	}

	cancelRender() {

		this.isRendering = false;
		this.stopRequested = false;
		this.restoreRenderer();
		document.getElementById( 'renderProgress' ).style.display = 'none';
		document.getElementById( 'renderBtn' ).style.display = '';
		const stopBtn = document.getElementById( 'stopAndCaptureBtn' );
		if ( stopBtn ) stopBtn.style.display = 'none';

	}

	async waitFrames( count ) {

		for ( let i = 0; i < count; i ++ ) {

			await new Promise( resolve => requestAnimationFrame( resolve ) );

		}

	}

	async waitForSamples( progressFill, progressText ) {

		return new Promise( ( resolve ) => {

			const targetSamples = this.settings.targetSamples;
			let lastUpdate = 0;

			const checkSamples = () => {

				if ( ! this.isRendering ) {

					resolve();
					return;

				}

				// User clicked "Stop & capture": exit loop and capture at current samples
				if ( this.stopRequested ) {

					const currentSamples = Math.floor( this.pathTracer.samples );
					progressText.textContent = `Stopped at ${currentSamples.toLocaleString()} samples — capturing...`;
					resolve();
					return;

				}

				const currentSamples = Math.floor( this.pathTracer.samples );
				const progress = Math.min( 100, ( currentSamples / targetSamples ) * 100 );

				// Update progress bar
				progressFill.style.width = `${progress}%`;

				// Update text (throttle to avoid too many updates)
				const now = Date.now();
				if ( now - lastUpdate > 100 ) {

					progressText.textContent = `Rendering... ${currentSamples.toLocaleString()} / ${targetSamples.toLocaleString()} samples (${Math.round( progress )}%)`;
					lastUpdate = now;

				}

				if ( currentSamples >= targetSamples ) {

					resolve();

				} else {

					// Continue rendering - ensure path tracer is enabled
					if ( this.pathTracer.enablePathTracing && ! this.pathTracer.pausePathTracing ) {

						this.pathTracer.renderSample();

					}

					requestAnimationFrame( checkSamples );

				}

			};

			checkSamples();

		} );

	}

	/**
	 * sRGB encode (linear 0–1 → display 0–1). Matches Three.js linearToOutputTexel for sRGB.
	 */
	_sRGBEncode( x ) {

		return x <= 0.0031308 ? x * 12.92 : 1.055 * Math.pow( x, 1 / 2.4 ) - 0.055;

	}

	/**
	 * ACES Filmic tone mapping (matches Three.js tonemapping_pars_fragment.glsl.js).
	 * Input/output: linear RGB 0–1. Uses exposure / 0.6 as in Three.js #19621.
	 */
	_ACESFilmicToneMapping( r, g, b, exposure ) {

		const scale = ( exposure ?? 1.0 ) / 0.6;
		let x = r * scale, y = g * scale, z = b * scale;
		// ACESInputMat (row-major for JS)
		const ACESInputMat = [
			[ 0.59719, 0.35458, 0.04823 ],
			[ 0.07600, 0.90834, 0.01566 ],
			[ 0.02840, 0.13383, 0.83777 ],
		];
		let r1 = ACESInputMat[ 0 ][ 0 ] * x + ACESInputMat[ 0 ][ 1 ] * y + ACESInputMat[ 0 ][ 2 ] * z;
		let g1 = ACESInputMat[ 1 ][ 0 ] * x + ACESInputMat[ 1 ][ 1 ] * y + ACESInputMat[ 1 ][ 2 ] * z;
		let b1 = ACESInputMat[ 2 ][ 0 ] * x + ACESInputMat[ 2 ][ 1 ] * y + ACESInputMat[ 2 ][ 2 ] * z;
		// RRTAndODTFit
		const fit = ( v ) => {

			const a = v * ( v + 0.0245786 ) - 0.000090537;
			const b = v * ( 0.983729 * v + 0.4329510 ) + 0.238081;
			return Math.max( 0, Math.min( 1, a / b ) );

		};
		r1 = fit( r1 ); g1 = fit( g1 ); b1 = fit( b1 );
		// ACESOutputMat
		const ACESOutputMat = [
			[ 1.60475, - 0.53108, - 0.07367 ],
			[ - 0.10208, 1.10813, - 0.00605 ],
			[ - 0.00327, - 0.07276, 1.07602 ],
		];
		x = ACESOutputMat[ 0 ][ 0 ] * r1 + ACESOutputMat[ 0 ][ 1 ] * g1 + ACESOutputMat[ 0 ][ 2 ] * b1;
		y = ACESOutputMat[ 1 ][ 0 ] * r1 + ACESOutputMat[ 1 ][ 1 ] * g1 + ACESOutputMat[ 1 ][ 2 ] * b1;
		z = ACESOutputMat[ 2 ][ 0 ] * r1 + ACESOutputMat[ 2 ][ 1 ] * g1 + ACESOutputMat[ 2 ][ 2 ] * b1;
		return {
			r: Math.max( 0, Math.min( 1, x ) ),
			g: Math.max( 0, Math.min( 1, y ) ),
			b: Math.max( 0, Math.min( 1, z ) ),
		};

	}

	/**
	 * Apply saturation and contrast (matches ClampedInterpolationMaterial) so export matches canvas.
	 * r, g, b in 0–1 (sRGB). Modifies in place.
	 */
	_applySaturationContrast( r, g, b, saturation, contrast ) {

		const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
		let R = lum + ( r - lum ) * saturation;
		let G = lum + ( g - lum ) * saturation;
		let B = lum + ( b - lum ) * saturation;
		R = ( R - 0.5 ) * contrast + 0.5;
		G = ( G - 0.5 ) * contrast + 0.5;
		B = ( B - 0.5 ) * contrast + 0.5;
		return {
			r: Math.max( 0, Math.min( 1, R ) ),
			g: Math.max( 0, Math.min( 1, G ) ),
			b: Math.max( 0, Math.min( 1, B ) ),
		};

	}

	/**
	 * Capture PNG from the path tracer's render target (linear HDR) when possible.
	 * Applies the same pipeline as the display quad: tone mapping, sRGB, saturation, contrast.
	 * "Without background" export then matches canvas; "with background" was already correct (composited).
	 */
	capturePNGWithAlpha( canvas ) {

		const w = canvas.width;
		const h = canvas.height;
		const exposure = this.renderer.toneMappingExposure ?? 1.0;
		const saturation = ( this.pathTracer?.productSaturation != null ) ? this.pathTracer.productSaturation : 1.0;
		const contrast = ( this.pathTracer?.productContrast != null ) ? this.pathTracer.productContrast : 1.0;

		const target = this.pathTracer?.target;
		const canReadTarget = target && typeof this.renderer.readRenderTargetPixels === 'function';

		if ( canReadTarget && target.width > 0 && target.height > 0 ) {

			const tw = target.width;
			const th = target.height;
			const floatBuf = new Float32Array( tw * th * 4 );
			this.renderer.readRenderTargetPixels( target, 0, 0, tw, th, floatBuf );
			// readRenderTargetPixels: origin bottom-left; ImageData is top-left — flip Y
			const out = new Uint8ClampedArray( tw * th * 4 );
			for ( let y = 0; y < th; y ++ ) {

				const srcRow = th - 1 - y;
				for ( let x = 0; x < tw; x ++ ) {

					const i = ( srcRow * tw + x ) * 4;
					const r = floatBuf[ i ], g = floatBuf[ i + 1 ], b = floatBuf[ i + 2 ], a = floatBuf[ i + 3 ];
					const tonemapped = this._ACESFilmicToneMapping( r, g, b, exposure );
					let sr = this._sRGBEncode( tonemapped.r );
					let sg = this._sRGBEncode( tonemapped.g );
					let sb = this._sRGBEncode( tonemapped.b );
					const satContrast = this._applySaturationContrast( sr, sg, sb, saturation, contrast );
					sr = satContrast.r; sg = satContrast.g; sb = satContrast.b;
					const dstIdx = ( y * tw + x ) * 4;
					out[ dstIdx ] = Math.round( Math.max( 0, Math.min( 255, sr * 255 ) ) );
					out[ dstIdx + 1 ] = Math.round( Math.max( 0, Math.min( 255, sg * 255 ) ) );
					out[ dstIdx + 2 ] = Math.round( Math.max( 0, Math.min( 255, sb * 255 ) ) );
					out[ dstIdx + 3 ] = Math.round( Math.max( 0, Math.min( 255, a * 255 ) ) );

				}

			}
			const tempCanvas = document.createElement( 'canvas' );
			tempCanvas.width = tw;
			tempCanvas.height = th;
			const ctx = tempCanvas.getContext( '2d' );
			ctx.putImageData( new ImageData( out, tw, th ), 0, 0 );
			if ( tw === w && th === h ) {

				return tempCanvas.toDataURL( 'image/png', 1.0 );

			}
			// Scale to requested export size (canvas dimensions)
			const finalCanvas = document.createElement( 'canvas' );
			finalCanvas.width = w;
			finalCanvas.height = h;
			const finalCtx = finalCanvas.getContext( '2d' );
			finalCtx.drawImage( tempCanvas, 0, 0, tw, th, 0, 0, w, h );
			return finalCanvas.toDataURL( 'image/png', 1.0 );

		}

		// Fallback: read from canvas (export may look dimmer than canvas display)
		console.warn( '📸 [Capture] Using canvas readPixels (path tracer target unavailable or zero size)' );
		const gl = this.renderer.getContext();
		const pixels = new Uint8Array( w * h * 4 );
		gl.readPixels( 0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels );
		const flipped = new Uint8ClampedArray( w * h * 4 );
		for ( let y = 0; y < h; y ++ ) {

			const srcRow = h - 1 - y;
			for ( let i = 0; i < w * 4; i ++ ) flipped[ y * w * 4 + i ] = pixels[ srcRow * w * 4 + i ];

		}
		const tempCanvas = document.createElement( 'canvas' );
		tempCanvas.width = w;
		tempCanvas.height = h;
		const ctx = tempCanvas.getContext( '2d' );
		ctx.putImageData( new ImageData( flipped, w, h ), 0, 0 );
		return tempCanvas.toDataURL( 'image/png', 1.0 );

	}

	async captureImage( canvas ) {

		const format = this.settings.format.toUpperCase();

		if ( format === 'PNG' ) {

			return this.capturePNGWithAlpha( canvas );

		} else if ( format === 'JPG' || format === 'JPEG' ) {

			// Convert PNG to JPG (requires background)
			return this.convertToJPG( canvas );

		} else if ( format === 'PSD' ) {

			// For PSD, we'll export as PNG with .psd extension (alpha preserved)
			console.warn( 'PSD format not fully supported, exporting as PNG with .psd extension' );
			return this.capturePNGWithAlpha( canvas );

		}

		throw new Error( `Unsupported format: ${format}` );

	}

	/**
	 * Composite a background image behind the path-traced render.
	 * The render has transparent background; we draw the bg image first,
	 * then the render on top, preserving alpha compositing.
	 * Returns a data URL of the composited image.
	 */
	async compositeWithBackground( renderDataUrl, bgImageSrc, width, height ) {

		return new Promise( ( resolve, reject ) => {

			const bgImg = new Image();
			bgImg.onload = () => {

				const tempCanvas = document.createElement( 'canvas' );
				tempCanvas.width = width;
				tempCanvas.height = height;
				const ctx = tempCanvas.getContext( '2d' );

				// Draw background image — fill canvas using "contain" logic (same as CSS object-fit: contain)
				const bgAspect = bgImg.width / bgImg.height;
				const canvasAspect = width / height;
				let drawW, drawH, drawX, drawY;

				if ( bgAspect > canvasAspect ) {

					// Image is wider — fit to width
					drawW = width;
					drawH = width / bgAspect;
					drawX = 0;
					drawY = ( height - drawH ) / 2;

				} else {

					// Image is taller — fit to height
					drawH = height;
					drawW = height * bgAspect;
					drawX = ( width - drawW ) / 2;
					drawY = 0;

				}

				// Black background fill for letterbox areas
				ctx.fillStyle = '#000000';
				ctx.fillRect( 0, 0, width, height );

				// Draw background image
				ctx.drawImage( bgImg, drawX, drawY, drawW, drawH );

				// Draw the path-traced render on top (with alpha compositing)
				const renderImg = new Image();
				renderImg.onload = () => {

					ctx.drawImage( renderImg, 0, 0, width, height );

					const format = this.settings.format.toUpperCase();
					if ( format === 'JPG' || format === 'JPEG' ) {

						resolve( tempCanvas.toDataURL( 'image/jpeg', 0.95 ) );

					} else {

						resolve( tempCanvas.toDataURL( 'image/png', 1.0 ) );

					}

				};

				renderImg.onerror = reject;
				renderImg.src = renderDataUrl;

			};

			bgImg.onerror = reject;
			bgImg.src = bgImageSrc;

		} );

	}

	convertToJPG( canvas, quality = 0.95 ) {

		// Create a temporary canvas with white background
		const tempCanvas = document.createElement( 'canvas' );
		tempCanvas.width = canvas.width;
		tempCanvas.height = canvas.height;
		const ctx = tempCanvas.getContext( '2d' );

		// Fill with white background
		ctx.fillStyle = '#FFFFFF';
		ctx.fillRect( 0, 0, tempCanvas.width, tempCanvas.height );

		// Draw original canvas on top
		ctx.drawImage( canvas, 0, 0 );

		// Convert to JPG
		return tempCanvas.toDataURL( 'image/jpeg', quality );

	}

	downloadImage( dataUrl, fileName, format ) {

		const link = document.createElement( 'a' );
		link.download = `${fileName}.${format.toLowerCase()}`;
		link.href = dataUrl;
		document.body.appendChild( link );
		link.click();
		document.body.removeChild( link );

	}

	restoreRenderer() {

		// Restore original path tracer settings
		this.pathTracer.tiles.set( this.originalSettings.tiles.x, this.originalSettings.tiles.y );
		this.pathTracer.bounces = this.originalSettings.bounces;
		this.pathTracer.renderScale = this.originalSettings.renderScale; // Restore original renderScale
		this.pathTracer.filterGlossyFactor = this.originalSettings.filterGlossyFactor;
		this.pathTracer.multipleImportanceSampling = this.originalSettings.multipleImportanceSampling;
		if ( this.originalSettings.textureSize ) {

			this.pathTracer.textureSize.copy( this.originalSettings.textureSize );
			// Repack texture atlas at preview resolution
			if ( typeof this.pathTracer.updateMaterials === 'function' ) {

				this.pathTracer.updateMaterials();

			}

		}

		if ( this.originalSettings.toneMapping !== null ) {

			this.renderer.toneMapping = this.originalSettings.toneMapping;

		}

		// Restore renderer to current window size (most robust — handles resize during render)
		const restoreW = window.innerWidth;
		const restoreH = window.innerHeight;
		const restoreDPR = window.devicePixelRatio;
		if ( restoreW > 0 && restoreH > 0 ) {

			this.renderer.setPixelRatio( restoreDPR );
			this.renderer.setSize( restoreW, restoreH );

			// Update camera aspect (restore to current window)
			if ( this.camera.isPerspectiveCamera ) {

				const aspect = restoreW / restoreH;
				this.camera.aspect = aspect;
				this.camera.updateProjectionMatrix();

			} else if ( this.camera.isOrthographicCamera ) {

				// For orthographic cameras, restore original frustum
				// Note: Original frustum values aren't stored, so this is a best-effort restore
				// The camera should be restored by the main application
				this.camera.updateProjectionMatrix();

			}

			// Resize path tracer back to match the restored canvas drawing buffer
			const drawW = restoreW * restoreDPR;
			const drawH = restoreH * restoreDPR;
			const w = Math.floor( this.originalSettings.renderScale * drawW );
			const h = Math.floor( this.originalSettings.renderScale * drawH );
			if ( this.pathTracer._pathTracer && typeof this.pathTracer._pathTracer.setSize === 'function' ) {

				this.pathTracer._pathTracer.setSize( w, h );
				const lowResScale = this.pathTracer.lowResScale != null ? this.pathTracer.lowResScale : 0.25;
				if ( this.pathTracer._lowResPathTracer && typeof this.pathTracer._lowResPathTracer.setSize === 'function' ) {

					this.pathTracer._lowResPathTracer.setSize( Math.floor( w * lowResScale ), Math.floor( h * lowResScale ) );

				}

			} else if ( typeof this.pathTracer.setSize === 'function' ) {

				this.pathTracer.setSize( w, h );

			} else if ( typeof this.pathTracer.resize === 'function' ) {

				this.pathTracer.resize( w, h );

			}

			// Update path tracer camera
			this.pathTracer.updateCamera();

		}

		// Re-sync path tracer with scene (background, env map, clear alpha) so the live canvas
		// shows the correct background/wallpaper again after render
		if ( typeof this.pathTracer.updateEnvironment === 'function' ) {

			this.pathTracer.updateEnvironment();

		}

		// Force clean restart so the preview begins accumulating from scratch
		this.pathTracer.reset();

	}

}
