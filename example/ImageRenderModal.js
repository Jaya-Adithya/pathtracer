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

	}

	async handleRender() {

		if ( this.isRendering ) return;

		this.isRendering = true;
		const renderBtn = document.getElementById( 'renderBtn' );
		const progressDiv = document.getElementById( 'renderProgress' );
		const progressFill = document.getElementById( 'progressFill' );
		const progressText = document.getElementById( 'progressText' );

		renderBtn.disabled = true;
		renderBtn.textContent = 'Rendering...';
		progressDiv.style.display = 'block';

		try {

			// Background mode
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

			// For background capture, ensure scene background is null (transparent)
			// so we can composite the background image behind the render
			let originalBackground = null;
			let originalClearAlpha = 1;
			if ( shouldCaptureBackground && bgImageSrc ) {

				originalBackground = this.scene.background;
				originalClearAlpha = this.renderer.getClearAlpha();
				this.scene.background = null;
				this.renderer.setClearAlpha( 0 );
				this.pathTracer.updateEnvironment();
				console.log( `🎨 [Render] Set transparent background for compositing` );

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
				
				console.log( `📐 [Render] Clamping: scale=${scale.toFixed(4)}, ${width}x${height} -> ${newWidth}x${newHeight}` );
				
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

			// Store original renderer size
			this.originalSize.width = this.renderer.domElement.width;
			this.originalSize.height = this.renderer.domElement.height;
			this.originalPixelRatio = this.renderer.getPixelRatio();

			// Store original path tracer settings (to restore after rendering)
			this.originalSettings.tiles.x = this.pathTracer.tiles.x;
			this.originalSettings.tiles.y = this.pathTracer.tiles.y;
			this.originalSettings.bounces = this.pathTracer.bounces;
			this.originalSettings.renderScale = this.pathTracer.renderScale;
			this.originalSettings.filterGlossyFactor = this.pathTracer.filterGlossyFactor;
			this.originalSettings.multipleImportanceSampling = this.pathTracer.multipleImportanceSampling;
			this.originalSettings.toneMapping = this.renderer.toneMapping;

			// CRITICAL: Account for renderScale when checking GPU limits
			// The path tracer multiplies renderer size by renderScale to get actual render target size
			// Temporarily set renderScale to 1.0 for high-resolution renders to avoid exceeding GPU limits
			const originalRenderScale = this.pathTracer.renderScale;
			this.pathTracer.renderScale = 1.0; // Use 1:1 scale for rendering to avoid GPU limit issues
			
			console.log( `📐 [Render] Renderer size: ${width}x${height}, renderScale set to 1.0 for rendering (was ${originalRenderScale})` );

			// Apply optimal settings for rendering
			// Set tiles to 1 for maximum rendering speed (faster than higher tile counts)
			// Keep all other settings (bounces, renderScale, filterGlossyFactor, etc.) 
			// from the GUI controls - these are already applied and should be preserved
			this.pathTracer.tiles.set( 1, 1 );

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

				console.log( `✅ [Path Tracer] Resolution matches - preserving current samples!` );
				progressText.textContent = `Path tracer resolution matches - checking samples...`;

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

			// If "with background", composite the background image behind the render
			if ( shouldCaptureBackground && bgImageSrc ) {

				progressText.textContent = 'Compositing background image...';
				imageData = await this.compositeWithBackground( imageData, bgImageSrc, canvas.width, canvas.height );
				console.log( `🎨 [Render] Composited background image` );

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
			if ( shouldCaptureBackground && bgImageSrc && originalBackground !== null ) {

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
			if ( shouldCaptureBackground && bgImageSrc && originalBackground !== null ) {

				this.scene.background = originalBackground;
				this.renderer.setClearAlpha( originalClearAlpha );
				this.pathTracer.updateEnvironment();

			}

			this.restoreRenderer();

		} finally {

			this.isRendering = false;
			renderBtn.disabled = false;
			renderBtn.textContent = 'Render';

		}

	}

	cancelRender() {

		this.isRendering = false;
		this.restoreRenderer();
		document.getElementById( 'renderProgress' ).style.display = 'none';

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

	async captureImage( canvas ) {

		const format = this.settings.format.toUpperCase();

		if ( format === 'PNG' ) {

			return canvas.toDataURL( 'image/png', 1.0 );

		} else if ( format === 'JPG' || format === 'JPEG' ) {

			// Convert PNG to JPG (requires background)
			return this.convertToJPG( canvas );

		} else if ( format === 'PSD' ) {

			// For PSD, we'll export as PNG with .psd extension
			// Full PSD support would require a library like psd.js
			console.warn( 'PSD format not fully supported, exporting as PNG with .psd extension' );
			return canvas.toDataURL( 'image/png', 1.0 );

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
		if ( this.originalSettings.toneMapping !== null ) {

			this.renderer.toneMapping = this.originalSettings.toneMapping;

		}

		// Restore original renderer size
		if ( this.originalSize.width > 0 && this.originalSize.height > 0 ) {

			this.renderer.setSize( this.originalSize.width, this.originalSize.height );
			this.renderer.setPixelRatio( this.originalPixelRatio );

			// Update camera aspect (restore original)
			if ( this.camera.isPerspectiveCamera ) {

				const aspect = this.originalSize.width / this.originalSize.height;
				this.camera.aspect = aspect;
				this.camera.updateProjectionMatrix();

			} else if ( this.camera.isOrthographicCamera ) {

				// For orthographic cameras, restore original frustum
				// Note: Original frustum values aren't stored, so this is a best-effort restore
				// The camera should be restored by the main application
				this.camera.updateProjectionMatrix();

			}

			// Update path tracer camera
			this.pathTracer.updateCamera();

		}

	}

}
