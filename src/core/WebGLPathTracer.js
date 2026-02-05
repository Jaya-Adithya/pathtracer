import {
	PerspectiveCamera,
	Scene,
	Vector2,
	Clock,
	NormalBlending,
	NoBlending,
	AdditiveBlending,
	DataTexture,
	DataUtils,
	FloatType,
	HalfFloatType,
	RGBAFormat,
	EquirectangularReflectionMapping,
	RepeatWrapping,
	ClampToEdgeWrapping,
	LinearFilter
} from 'three';
import { PathTracingSceneGenerator } from './PathTracingSceneGenerator.js';
import { PathTracingRenderer } from './PathTracingRenderer.js';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { GradientEquirectTexture } from '../textures/GradientEquirectTexture.js';
import { getIesTextures, getLights, getTextures } from './utils/sceneUpdateUtils.js';
import { ClampedInterpolationMaterial } from '../materials/fullscreen/ClampedInterpolationMaterial.js';
import { CubeToEquirectGenerator } from '../utils/CubeToEquirectGenerator.js';

function supportsFloatBlending( renderer ) {

	return renderer.extensions.get( 'EXT_float_blend' );

}

const _resolution = new Vector2();
export class WebGLPathTracer {

	get multipleImportanceSampling() {

		return Boolean( this._pathTracer.material.defines.FEATURE_MIS );

	}

	set multipleImportanceSampling( v ) {

		this._pathTracer.material.setDefine( 'FEATURE_MIS', v ? 1 : 0 );

	}

	get transmissiveBounces() {

		return this._pathTracer.material.transmissiveBounces;

	}

	set transmissiveBounces( v ) {

		this._pathTracer.material.transmissiveBounces = v;

	}

	get bounces() {

		return this._pathTracer.material.bounces;

	}

	set bounces( v ) {

		this._pathTracer.material.bounces = v;

	}

	get filterGlossyFactor() {

		return this._pathTracer.material.filterGlossyFactor;

	}

	set filterGlossyFactor( v ) {

		this._pathTracer.material.filterGlossyFactor = v;

	}

	get samples() {

		return this._pathTracer.samples;

	}

	get target() {

		return this._pathTracer.target;

	}

	get tiles() {

		return this._pathTracer.tiles;

	}

	get stableNoise() {

		return this._pathTracer.stableNoise;

	}

	set stableNoise( v ) {

		this._pathTracer.stableNoise = v;

	}

	get isCompiling() {

		return Boolean( this._pathTracer.isCompiling );

	}

	get productSaturation() {

		return this._quad.material.saturation;

	}

	set productSaturation( v ) {

		this._quad.material.saturation = v;

	}

	get productContrast() {

		return this._quad.material.contrast;

	}

	set productContrast( v ) {

		this._quad.material.contrast = v;

	}

	constructor( renderer ) {

		// members
		this._renderer = renderer;
		this._generator = new PathTracingSceneGenerator();
		this._pathTracer = new PathTracingRenderer( renderer );
		this._queueReset = false;
		this._clock = new Clock();
		this._compilePromise = null;

		this._lowResPathTracer = new PathTracingRenderer( renderer );
		this._lowResPathTracer.tiles.set( 1, 1 );
		this._quad = new FullScreenQuad( new ClampedInterpolationMaterial( {
			map: null,
			transparent: true,
			blending: NoBlending,

			premultipliedAlpha: renderer.getContextAttributes().premultipliedAlpha,
		} ) );
		this._materials = null;

		this._previousEnvironment = null;
		this._previousBackground = null;
		this._internalBackground = null;
		this._rasterEnvMap = null; // FloatType copy for scene.environment (raster PBR)
		this._previousRasterEnvMapSource = null;
		this._rasterEnvMapScheduled = false;
		this._pendingMaterialIndexUpdate = null;
		this._pendingGeometry = null;

		// options
		this.renderDelay = 100;
		this.minSamples = 5;
		this.fadeDuration = 500;
		this.enablePathTracing = true;
		this.pausePathTracing = false;
		this.dynamicLowRes = false;
		this.lowResScale = 0.25;
		this.renderScale = 1;
		this.synchronizeRenderSize = true;
		this.rasterizeScene = true;
		this.renderToCanvas = true;
		this.textureSize = new Vector2( 1024, 1024  );  // preview default; final render bumps to 4096
		this.rasterizeSceneCallback = ( scene, camera ) => {

			this._renderer.render( scene, camera );

		};

		this.renderToCanvasCallback = ( target, renderer, quad ) => {

			const currentAutoClear = renderer.autoClear;
			renderer.autoClear = false;
			quad.render( renderer );
			renderer.autoClear = currentAutoClear;

		};

		// initialize the scene so it doesn't fail
		this.setScene( new Scene(), new PerspectiveCamera() );

	}

	setBVHWorker( worker ) {

		this._generator.setBVHWorker( worker );

	}

	setScene( scene, camera, options = {} ) {

		scene.updateMatrixWorld( true );
		camera.updateMatrixWorld();

		const generator = this._generator;
		generator.setObjects( scene );

		if ( this._buildAsync ) {

			return generator.generateAsync( options.onProgress ).then( result => {

				this._updateFromResults( scene, camera, result );
				return this._deferredSceneUpdates().then( () => result );

			} );

		} else {

			const result = generator.generate();
			this._updateFromResults( scene, camera, result );
			if ( result.needsMaterialIndexUpdate && result.geometry ) {

				this._pathTracer.material.materialIndexAttribute.updateFrom( result.geometry.attributes.materialIndex );

			}
			this.updateMaterials();
			this.updateLights();
			this.updateEnvironment();
			return result;

		}

	}

	setSceneAsync( ...args ) {

		this._buildAsync = true;
		const result = this.setScene( ...args );
		this._buildAsync = false;

		return result;

	}

	setCamera( camera ) {

		this.camera = camera;
		this.updateCamera();

	}

	/**
	 * Compile the path tracing material (e.g. after setScene) so the first frame doesn't do compile + path trace together.
	 * Reduces GPU load on initial load. Returns a promise that resolves when compilation is done.
	 */
	compileAsync() {

		return this._pathTracer.compileMaterial();

	}

	updateCamera() {

		const camera = this.camera;
		camera.updateMatrixWorld();

		this._pathTracer.setCamera( camera );
		this._lowResPathTracer.setCamera( camera );
		this.reset();

	}

	updateMaterials() {

		const material = this._pathTracer.material;
		const renderer = this._renderer;
		const materials = this._materials;
		const textureSize = this.textureSize;

		// reduce texture sources here - we don't want to do this in the
		// textures array because we need to pass the textures array into the
		// material target
		const textures = getTextures( materials );
		material.textures.setTextures( renderer, textures, textureSize.x, textureSize.y );
		material.materials.updateFrom( materials, textures );
		// Copy shadow catcher reflection intensity from any floor material that uses it
		material.shadowCatcherReflectionIntensity = 1.0;
		for ( let i = 0, l = materials.length; i < l; i ++ ) {
			const m = materials[ i ];
			if ( m.shadowReflectionCatcher && m.shadowCatcherReflectionIntensity != null ) {
				material.shadowCatcherReflectionIntensity = m.shadowCatcherReflectionIntensity;
				break;
			}
		}
		this.reset();

	}

	updateLights() {

		const scene = this.scene;
		const renderer = this._renderer;
		const material = this._pathTracer.material;

		const lights = getLights( scene );
		const iesTextures = getIesTextures( lights );
		material.lights.updateFrom( lights, iesTextures );
		material.iesProfiles.setTextures( renderer, iesTextures );
		this.reset();

	}

	updateEnvironment() {

		const scene = this.scene;
		const material = this._pathTracer.material;

		if ( this._internalBackground ) {

			this._internalBackground.dispose();
			this._internalBackground = null;

		}

		// update scene background
		material.backgroundBlur = scene.backgroundBlurriness;
		material.backgroundIntensity = scene.backgroundIntensity ?? 1;
		material.backgroundRotation.makeRotationFromEuler( scene.backgroundRotation ).invert();
		if ( scene.background === null ) {

			material.backgroundMap = null;
			material.backgroundAlpha = 0;

		} else if ( scene.background.isColor ) {

			this._colorBackground = this._colorBackground || new GradientEquirectTexture( 16 );

			const colorBackground = this._colorBackground;
			if ( ! colorBackground.topColor.equals( scene.background ) ) {

				// set the texture color
				colorBackground.topColor.set( scene.background );
				colorBackground.bottomColor.set( scene.background );
				colorBackground.update();

			}

			// assign to material
			material.backgroundMap = colorBackground;
			material.backgroundAlpha = 1;

		} else if ( scene.background.isCubeTexture ) {

			if ( scene.background !== this._previousBackground ) {

				const background = new CubeToEquirectGenerator( this._renderer ).generate( scene.background );
				this._internalBackground = background;
				material.backgroundMap = background;
				material.backgroundAlpha = 1;

			}

		} else {

			material.backgroundMap = scene.background;
			material.backgroundAlpha = 1;

		}

		// update scene environment
		material.environmentIntensity = scene.environment !== null ? ( scene.environmentIntensity ?? 1 ) : 0;
		material.environmentSaturation = scene.userData?.environmentSaturation ?? 1;
		material.environmentRotation.makeRotationFromEuler( scene.environmentRotation ).invert();
		if ( this._previousEnvironment !== scene.environment ) {

			if ( scene.environment !== null ) {

				if ( scene.environment.isCubeTexture ) {

					const environment = new CubeToEquirectGenerator( this._renderer ).generate( scene.environment );
					material.envMapInfo.updateFrom( environment );

				} else {

					// TODO: Consider setting this to the highest supported bit depth by checking for
					// OES_texture_float_linear or OES_texture_half_float_linear. Requires changes to
					// the equirect uniform
					material.envMapInfo.updateFrom( scene.environment );

				}

			}

		}

		// Use sanitized env map for raster view so Infinity/NaN in raw HDR don't cause black materials.
		// Raster PBR (WebGLRenderer) often fails with HalfFloatType env maps; use a FloatType copy.
		const sanitizedMap = material.envMapInfo.map;
		if ( scene.environment !== null && sanitizedMap ) {

			if ( sanitizedMap.type === HalfFloatType ) {

				// Reuse or create FloatType copy for raster view (deferred to avoid blocking first frame with CPU-heavy fromHalfFloat loop)
				if ( this._previousRasterEnvMapSource !== sanitizedMap && this._rasterEnvMap ) {

					this._rasterEnvMap.dispose();
					this._rasterEnvMap = null;

				}
				if ( ! this._rasterEnvMap ) {

					if ( ! this._rasterEnvMapScheduled ) {

						this._rasterEnvMapScheduled = true;
						const self = this;
						const source = sanitizedMap;
						const sc = scene;
						requestAnimationFrame( function buildRasterEnvMap() {

							self._rasterEnvMapScheduled = false;
							if ( self._previousRasterEnvMapSource !== source || self._rasterEnvMap ) return;

							const { width, height, data } = source.image;
							const stride = Math.floor( data.length / ( width * height ) );
							const floatData = new Float32Array( width * height * 4 );
							for ( let i = 0; i < width * height; i ++ ) {

								floatData[ 4 * i + 0 ] = DataUtils.fromHalfFloat( data[ stride * i + 0 ] );
								floatData[ 4 * i + 1 ] = DataUtils.fromHalfFloat( data[ stride * i + 1 ] );
								floatData[ 4 * i + 2 ] = DataUtils.fromHalfFloat( data[ stride * i + 2 ] );
								floatData[ 4 * i + 3 ] = stride >= 4 ? DataUtils.fromHalfFloat( data[ stride * i + 3 ] ) : 1.0;

							}
							self._rasterEnvMap = new DataTexture( floatData, width, height, RGBAFormat, FloatType, EquirectangularReflectionMapping, RepeatWrapping, ClampToEdgeWrapping, LinearFilter, LinearFilter );
							self._rasterEnvMap.needsUpdate = true;
							self._previousRasterEnvMapSource = source;
							sc.environment = self._rasterEnvMap;

						} );

					}
					// This frame: raster may use HalfFloat (one-frame delay); path tracer uses envMapInfo.map as-is

				} else {

					scene.environment = this._rasterEnvMap;

				}

			} else {

				if ( this._rasterEnvMap ) {

					this._rasterEnvMap.dispose();
					this._rasterEnvMap = null;
					this._previousRasterEnvMapSource = null;

				}
				scene.environment = sanitizedMap;

			}

		}

		this._previousEnvironment = scene.environment;
		this._previousBackground = scene.background;
		this.reset();

	}

	_updateFromResults( scene, camera, results ) {

		const {
			materials,
			geometry,
			bvh,
			bvhChanged,
			needsMaterialIndexUpdate,
		} = results;

		this._materials = materials;

		const pathTracer = this._pathTracer;
		const material = pathTracer.material;

		if ( bvhChanged ) {

			material.bvh.updateFrom( bvh );
			material.attributesArray.updateFrom(
				geometry.attributes.normal,
				geometry.attributes.tangent,
				geometry.attributes.uv,
				geometry.attributes.color,
			);

		}

		// Defer material index + materials/lights/env to staggered rAFs (reduces GPU exhaustion on initial load)
		if ( needsMaterialIndexUpdate ) {

			this._pendingMaterialIndexUpdate = true;
			this._pendingGeometry = geometry;

		} else {

			this._pendingMaterialIndexUpdate = false;
			this._pendingGeometry = null;

		}

		// save previously used items
		this._previousScene = scene;
		this.scene = scene;
		this.camera = camera;

		this.updateCamera();

		return results;

	}

	// Staggered updates across two frames: rAF1 = material index + materials + lights; rAF2 = env. Reduces GPU exhaustion on initial load.
	_deferredSceneUpdates() {

		const self = this;
		return new Promise( ( resolve ) => {

			requestAnimationFrame( () => {

				if ( self._pendingMaterialIndexUpdate && self._pendingGeometry ) {

					self._pathTracer.material.materialIndexAttribute.updateFrom( self._pendingGeometry.attributes.materialIndex );
					self._pendingMaterialIndexUpdate = false;
					self._pendingGeometry = null;

				}
				self.updateMaterials();
				self.updateLights();

				requestAnimationFrame( () => {

					self.updateEnvironment();
					resolve();

				} );

			} );

		} );

	}

	renderSample() {

		const lowResPathTracer = this._lowResPathTracer;
		const pathTracer = this._pathTracer;
		const renderer = this._renderer;
		const clock = this._clock;
		const quad = this._quad;

		this._updateScale();

		if ( this._queueReset ) {

			pathTracer.reset();
			lowResPathTracer.reset();
			this._queueReset = false;

			quad.material.opacity = 0;
			clock.start();

		}

		// render the path tracing sample after enough time has passed
		const delta = clock.getDelta() * 1e3;
		const elapsedTime = clock.getElapsedTime() * 1e3;
		if ( ! this.pausePathTracing && this.enablePathTracing && this.renderDelay <= elapsedTime && ! this.isCompiling ) {

			pathTracer.update();

		}

		// when alpha is enabled we use a manual blending system rather than
		// rendering with a blend function
		pathTracer.alpha = pathTracer.material.backgroundAlpha !== 1 || ! supportsFloatBlending( renderer );
		lowResPathTracer.alpha = pathTracer.alpha;

		if ( this.renderToCanvas ) {

			const renderer = this._renderer;
			const minSamples = this.minSamples;

			if ( elapsedTime >= this.renderDelay && this.samples >= this.minSamples ) {

				if ( this.fadeDuration !== 0 ) {

					quad.material.opacity = Math.min( quad.material.opacity + delta / this.fadeDuration, 1 );

				} else {

					quad.material.opacity = 1;

				}

			}

			// render the fallback if we haven't rendered enough samples, are paused, or are occluded
			if ( ! this.enablePathTracing || this.samples < minSamples || quad.material.opacity < 1 ) {

				if ( this.dynamicLowRes && ! this.isCompiling ) {

					if ( lowResPathTracer.samples < 1 ) {

						lowResPathTracer.material = pathTracer.material;
						lowResPathTracer.update();

					}

					const currentOpacity = quad.material.opacity;
					quad.material.opacity = 1 - quad.material.opacity;
					quad.material.map = lowResPathTracer.target.texture;
					quad.render( renderer );
					quad.material.opacity = currentOpacity;

				}

				if ( ! this.dynamicLowRes && this.rasterizeScene || this.dynamicLowRes && this.isCompiling ) {

					this.rasterizeSceneCallback( this.scene, this.camera );

				}

			}


			if ( this.enablePathTracing && quad.material.opacity > 0 ) {

				if ( quad.material.opacity < 1 ) {

					// use additive blending when the low res texture is rendered so we can fade the
					// background out while the full res fades in
					quad.material.blending = this.dynamicLowRes ? AdditiveBlending : NormalBlending;

				}

				quad.material.map = pathTracer.target.texture;
				this.renderToCanvasCallback( pathTracer.target, renderer, quad );
				quad.material.blending = NoBlending;

			}

		}

	}

	reset() {

		this._queueReset = true;
		this._pathTracer.samples = 0;

	}

	dispose() {

		if ( this._rasterEnvMap ) {

			this._rasterEnvMap.dispose();
			this._rasterEnvMap = null;
			this._previousRasterEnvMapSource = null;

		}
		this._quad.dispose();
		this._quad.material.dispose();
		this._pathTracer.dispose();

	}

	_updateScale() {

		// update the path tracer scale if it has changed
		if ( this.synchronizeRenderSize ) {

			this._renderer.getDrawingBufferSize( _resolution );

			const w = Math.floor( this.renderScale * _resolution.x );
			const h = Math.floor( this.renderScale * _resolution.y );

			this._pathTracer.getSize( _resolution );
			if ( _resolution.x !== w || _resolution.y !== h ) {

				const lowResScale = this.lowResScale;
				this._pathTracer.setSize( w, h );
				this._lowResPathTracer.setSize( Math.floor( w * lowResScale ), Math.floor( h * lowResScale ) );

			}

		}

	}

}
