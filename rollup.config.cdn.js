/**
 * CDN Rollup Config
 *
 * Builds a SINGLE self-contained UMD file that bundles three-mesh-bvh
 * into the path tracer output.  Only three.js is kept external —
 * load it from any CDN (unpkg, jsdelivr, cdnjs) before this script.
 *
 * Usage (browser):
 *   <script src="https://cdn.jsdelivr.net/npm/three@0.181.0/build/three.min.js"></script>
 *   <script src="./build/three-pathtracer.cdn.js"></script>
 *   <script>
 *     const { WebGLPathTracer, PhysicalCamera } = ThreePathTracer;
 *   </script>
 *
 * Build:
 *   npx rollup -c rollup.config.cdn.js
 *   (or: npm run build:cdn)
 */

import { nodeResolve } from '@rollup/plugin-node-resolve';

export default {
	input: './src/index.js',
	treeshake: false,

	// Only three.js is external — three-mesh-bvh is BUNDLED IN
	external: p => /^three(?!-mesh-bvh)/.test( p ),

	plugins: [
		// Resolve three-mesh-bvh from node_modules so it gets bundled
		nodeResolve(),
	],

	output: {
		name: 'ThreePathTracer',
		extend: true,
		format: 'umd',
		file: './build/three-pathtracer.cdn.js',
		sourcemap: true,

		globals: p => {

			// Everything from three.js maps to the THREE global
			if ( /^three/.test( p ) ) {

				return 'THREE';

			}

			return null;

		},
	},
};
