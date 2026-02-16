export function getScaledSettings() {

	// --- GPU tier detection ---
	let gpuTier = 'medium';
	const canvas = document.createElement( 'canvas' );
	const gl = canvas.getContext( 'webgl2' ) || canvas.getContext( 'webgl' );

	if ( gl ) {

		const debugInfo = gl.getExtension( 'WEBGL_debug_renderer_info' );
		const gpuRenderer = debugInfo
			? gl.getParameter( debugInfo.UNMASKED_RENDERER_WEBGL ).toLowerCase()
			: '';

		const maxTextureSize = gl.getParameter( gl.MAX_TEXTURE_SIZE );

		// Low-end: integrated Intel, mobile Mali/Adreno (low series), software renderers
		const isLowEndGPU = /intel\s*(hd|uhd|iris)|mali|adreno\s*[0-5]\d{2}|powervr|swiftshader|llvmpipe|mesa/i.test( gpuRenderer );

		// High-end: discrete NVIDIA RTX/GTX 16+, AMD RX 5000+, Apple M2+
		const isHighEndGPU = /nvidia\s*rtx|nvidia\s*gtx\s*1[6-9]|nvidia\s*gtx\s*[2-9]|radeon\s*rx\s*[5-7]|apple\s*m[2-9]|geforce\s*rtx/i.test( gpuRenderer );

		if ( isLowEndGPU || maxTextureSize <= 4096 ) {

			gpuTier = 'low';

		} else if ( isHighEndGPU && maxTextureSize >= 8192 ) {

			gpuTier = 'high';

		}

		// Clean up temporary context
		const loseCtx = gl.getExtension( 'WEBGL_lose_context' );
		if ( loseCtx ) loseCtx.loseContext();

	} else {

		gpuTier = 'low';

	}

	// --- Mobile detection (supplement GPU tier) ---
	const aspectRatio = window.innerWidth / window.innerHeight;
	const isMobile = aspectRatio < 0.65 || ( 'ontouchstart' in window && window.innerWidth < 768 );
	if ( isMobile && gpuTier !== 'low' ) {

		gpuTier = 'low';

	}

	// --- Quality presets ---
	const presets = {
		low: {
			tiles: 5,
			renderScale: Math.max( 0.5 / window.devicePixelRatio, 0.25 ),
			bounces: 3,
			floorTextureSize: 512,
		},
		medium: {
			tiles: 3,
			renderScale: Math.max( 1 / window.devicePixelRatio, 0.5 ),
			bounces: 5,
			floorTextureSize: 1024,
		},
		high: {
			tiles: 2,
			renderScale: Math.max( 1 / window.devicePixelRatio, 0.75 ),
			bounces: 5,
			floorTextureSize: 2048,
		},
	};

	const settings = presets[ gpuTier ];
	settings.gpuTier = gpuTier;

	return settings;

}
