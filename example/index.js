import {
	ACESFilmicToneMapping,
	NoToneMapping,
	Box3,
	LoadingManager,
	Sphere,
	DoubleSide,
	Mesh,
	MeshStandardMaterial,
	PlaneGeometry,
	MeshPhysicalMaterial,
	Scene,
	PerspectiveCamera,
	OrthographicCamera,
	WebGLRenderer,
	EquirectangularReflectionMapping,
	Texture,
	Color,
	Vector3,
	SRGBColorSpace,
	LinearMipmapLinearFilter,
	LinearFilter,
	AnimationMixer,
} from 'three';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { HDRLoader } from 'three/examples/jsm/loaders/HDRLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { ColladaLoader } from 'three/examples/jsm/loaders/ColladaLoader.js';
import { LDrawLoader } from 'three/examples/jsm/loaders/LDrawLoader.js';
import { LDrawUtils } from 'three/examples/jsm/utils/LDrawUtils.js';
import { GUI } from 'three/examples/jsm/libs/lil-gui.module.min.js';
import Stats from 'three/examples/jsm/libs/stats.module.js';
import { generateRadialFloorTexture } from './utils/generateRadialFloorTexture.js';
import { GradientEquirectTexture, WebGLPathTracer } from '../src/index.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { getScaledSettings } from './utils/getScaledSettings.js';
import { LoaderElement } from './utils/LoaderElement.js';
import { ParallelMeshBVHWorker, GenerateMeshBVHWorker } from 'three-mesh-bvh/worker';
import { LDrawConditionalLineMaterial } from 'three/addons/materials/LDrawConditionalLineMaterial.js';
import { ImageRenderModal } from './ImageRenderModal.js';
import './ImageRenderModal.css';

const envMaps = {
	'Royal Esplanade': 'https://raw.githubusercontent.com/mrdoob/three.js/r150/examples/textures/equirectangular/royal_esplanade_1k.hdr',
	'Moonless Golf': 'https://raw.githubusercontent.com/mrdoob/three.js/r150/examples/textures/equirectangular/moonless_golf_1k.hdr',
	'Overpass': 'https://raw.githubusercontent.com/mrdoob/three.js/r150/examples/textures/equirectangular/pedestrian_overpass_1k.hdr',
	'Venice Sunset': 'https://raw.githubusercontent.com/mrdoob/three.js/r150/examples/textures/equirectangular/venice_sunset_1k.hdr',
	'Small Studio': 'https://raw.githubusercontent.com/gkjohnson/3d-demo-data/master/hdri/studio_small_05_1k.hdr',
	'Pfalzer Forest': 'https://raw.githubusercontent.com/gkjohnson/3d-demo-data/master/hdri/phalzer_forest_01_1k.hdr',
	'Leadenhall Market': 'https://raw.githubusercontent.com/gkjohnson/3d-demo-data/master/hdri/leadenhall_market_1k.hdr',
	'Kloppenheim': 'https://raw.githubusercontent.com/gkjohnson/3d-demo-data/master/hdri/kloppenheim_05_1k.hdr',
	'Hilly Terrain': 'https://raw.githubusercontent.com/gkjohnson/3d-demo-data/master/hdri/hilly_terrain_01_1k.hdr',
	'Circus Arena': 'https://raw.githubusercontent.com/gkjohnson/3d-demo-data/master/hdri/circus_arena_1k.hdr',
	'Chinese Garden': 'https://raw.githubusercontent.com/gkjohnson/3d-demo-data/master/hdri/chinese_garden_1k.hdr',
	'Autoshop': 'https://raw.githubusercontent.com/gkjohnson/3d-demo-data/master/hdri/autoshop_01_1k.hdr',

	'Measuring Lab': 'https://raw.githubusercontent.com/gkjohnson/3d-demo-data/master/hdri/vintage_measuring_lab_2k.hdr',
	'Whale Skeleton': 'https://raw.githubusercontent.com/gkjohnson/3d-demo-data/master/hdri/whale_skeleton_2k.hdr',
	'Hall of Mammals': 'https://raw.githubusercontent.com/gkjohnson/3d-demo-data/master/hdri/hall_of_mammals_2k.hdr',

	'Drachenfels Cellar': 'https://raw.githubusercontent.com/gkjohnson/3d-demo-data/master/hdri/drachenfels_cellar_2k.hdr',
	'Adams Place Bridge': 'https://raw.githubusercontent.com/gkjohnson/3d-demo-data/master/hdri/adams_place_bridge_2k.hdr',
	'Sepulchral Chapel Rotunda': 'https://raw.githubusercontent.com/gkjohnson/3d-demo-data/master/hdri/sepulchral_chapel_rotunda_2k.hdr',
	'Peppermint Powerplant': 'https://raw.githubusercontent.com/gkjohnson/3d-demo-data/master/hdri/peppermint_powerplant_2k.hdr',
	'Noon Grass': 'https://raw.githubusercontent.com/gkjohnson/3d-demo-data/master/hdri/noon_grass_2k.hdr',
	'Narrow Moonlit Road': 'https://raw.githubusercontent.com/gkjohnson/3d-demo-data/master/hdri/narrow_moonlit_road_2k.hdr',
	'St Peters Square Night': 'https://raw.githubusercontent.com/gkjohnson/3d-demo-data/master/hdri/st_peters_square_night_2k.hdr',
	'Brown Photostudio 01': 'https://raw.githubusercontent.com/gkjohnson/3d-demo-data/master/hdri/brown_photostudio_01_2k.hdr',
	'Rainforest Trail': 'https://raw.githubusercontent.com/gkjohnson/3d-demo-data/master/hdri/rainforest_trail_2k.hdr',
	'Brown Photostudio 07': 'https://raw.githubusercontent.com/gkjohnson/3d-demo-data/master/hdri/brown_photostudio_07_2k.hdr',
	'Brown Photostudio 06': 'https://raw.githubusercontent.com/gkjohnson/3d-demo-data/master/hdri/brown_photostudio_06_2k.hdr',
	'Dancing Hall': 'https://raw.githubusercontent.com/gkjohnson/3d-demo-data/master/hdri/dancing_hall_2k.hdr',
	'Aristea Wreck Puresky': 'https://raw.githubusercontent.com/gkjohnson/3d-demo-data/master/hdri/aristea_wreck_puresky_2k.hdr',
	'Modern Buildings 2': 'https://raw.githubusercontent.com/gkjohnson/3d-demo-data/master/hdri/modern_buildings_2_2k.hdr',
	'Thatch Chapel': 'https://raw.githubusercontent.com/gkjohnson/3d-demo-data/master/hdri/thatch_chapel_2k.hdr',
	'Vestibule': 'https://raw.githubusercontent.com/gkjohnson/3d-demo-data/master/hdri/vestibule_2k.hdr',
	'Blocky Photo Studio': 'https://raw.githubusercontent.com/gkjohnson/3d-demo-data/master/hdri/blocky_photo_studio_1k.hdr',
	'Christmas Photo Studio 07': 'https://raw.githubusercontent.com/gkjohnson/3d-demo-data/master/hdri/christmas_photo_studio_07_2k.hdr',
	'Aerodynamics Workshop': 'https://raw.githubusercontent.com/gkjohnson/3d-demo-data/master/hdri/aerodynamics_workshop_1k.hdr',

};

const params = {

	multipleImportanceSampling: true,
	acesToneMapping: true,
	// ✅ renderScale and tiles are controlled explicitly here so we can run the path tracer at very high resolution
	// We spread getScaledSettings() first so these explicit values always win.
	...getScaledSettings(),
	renderScale: 2, // 🔥 Requested: internal render scale 3x
	tiles: 2,

	model: '',

	envMap: envMaps['Aristea Wreck Puresky'],

	gradientTop: '#bfd8ff',
	gradientBottom: '#ffffff',

	environmentIntensity: 1.0,
	environmentRotation: 0,

	cameraProjection: 'Perspective',

	backgroundType: 'Gradient',
	bgGradientTop: '#111111',
	bgGradientBottom: '#000000',
	backgroundBlur: 0.0,
	transparentBackground: false,
	checkerboardTransparency: true,

	enable: true,
	bounces: 5,
	filterGlossyFactor: 0.5,
	pause: false,

	floorColor: '#111111',
	floorOpacity: 1.0,
	floorRoughness: 0.2,
	floorMetalness: 0.2,

	screenBrightness: 1, // Predefined wallpapers: 1; custom wallpaper defaults to 4.5 when selected
	screenWallpaper: 'blank_screen', // Selected wallpaper
	screenSaturation: 1, // Predefined wallpapers: 1; custom wallpaper defaults to 0.9 when selected (0 = grayscale, 1 = normal, 2 = oversaturated)

	// Animation frame control (like GLBViewer: 0–150 frames at 30fps)
	animationFrame: 35,
	// Screen on/off in Animation folder (On | Off screen)
	animationScreen: 'On',

};

let floorPlane, gui, stats;
let pathTracer, renderer, orthoCamera, perspectiveCamera, activeCamera;
let controls, scene, model;
let gradientMap;
let loader;
let models;
let screenMesh = null;
let uploadedTexture = null;
let uploadedImage = null; // ✅ NEW: Store original image for brightness/saturation reprocessing
let wallpaperMeshes = {}; // Store all wallpaper meshes: { 'blank_screen': mesh, 'blue_bloom': mesh, etc. }
let currentWallpaper = 'blank_screen'; // Current selected wallpaper
let imageRenderModal = null; // Image render modal instance
let animationMixer = null;
let mainAnimAction = null;
let mainAnimClip = null;
const ANIMATION_FRAME_RATE = 30;
const ANIMATION_MAX_FRAME = 150;

const orthoWidth = 2;

init();

async function waitFrame() {

	return new Promise(resolve => requestAnimationFrame(resolve));

}

async function init() {

	// Wait for the models list to be available since vite doesn't guarantee execution order
	// of module tags and we rely on the other script to define the set of models for display
	// in this example. TODO: handle this more gracefully.
	while (!window.MODEL_LIST) {

		await waitFrame();

	}

	models = window.MODEL_LIST || {};

	loader = new LoaderElement();
	loader.attach(document.body);

	// renderer
	renderer = new WebGLRenderer({ antialias: true });
	renderer.toneMapping = ACESFilmicToneMapping;
	document.body.appendChild(renderer.domElement);

	// path tracer
	pathTracer = new WebGLPathTracer(renderer);
	pathTracer.setBVHWorker(new GenerateMeshBVHWorker());
	pathTracer.physicallyCorrectLights = true;
	pathTracer.tiles.set(params.tiles, params.tiles);
	pathTracer.multipleImportanceSampling = params.multipleImportanceSampling;
	pathTracer.transmissiveBounces = 10;

	// camera
	const aspect = window.innerWidth / window.innerHeight;
	perspectiveCamera = new PerspectiveCamera(60, aspect, 0.025, 500);
	perspectiveCamera.position.set(- 1, 0.25, 1);

	const orthoHeight = orthoWidth / aspect;
	orthoCamera = new OrthographicCamera(orthoWidth / - 2, orthoWidth / 2, orthoHeight / 2, orthoHeight / - 2, 0, 100);
	orthoCamera.position.set(- 1, 0.25, 1);

	// background map
	gradientMap = new GradientEquirectTexture();
	gradientMap.topColor.set(params.bgGradientTop);
	gradientMap.bottomColor.set(params.bgGradientBottom);
	gradientMap.update();

	// controls
	controls = new OrbitControls(perspectiveCamera, renderer.domElement);
	controls.addEventListener('change', () => {

		pathTracer.updateCamera();

	});

	// scene
	scene = new Scene();
	scene.background = gradientMap;

	const floorTex = generateRadialFloorTexture(2048);
	floorPlane = new Mesh(
		new PlaneGeometry(),
		new MeshStandardMaterial({
			map: floorTex,
			transparent: true,
			color: 0x111111,
			roughness: 0.1,
			metalness: 0.0,
			side: DoubleSide,
		})
	);
	floorPlane.scale.setScalar(5);
	floorPlane.rotation.x = - Math.PI / 2;
	scene.add(floorPlane);

	stats = new Stats();
	document.body.appendChild(stats.dom);

	// Initialize image render modal (will be updated when camera changes)
	imageRenderModal = new ImageRenderModal(pathTracer, renderer, scene, activeCamera);

	updateCameraProjection(params.cameraProjection);
	onHashChange();
	updateEnvMap();
	onResize();

	animate();

	window.addEventListener('resize', onResize);
	window.addEventListener('hashchange', onHashChange);

}

function animate() {

	requestAnimationFrame(animate);

	stats.update();

	if (!model) {

		return;

	}

	if (params.enable) {

		if (!params.pause || pathTracer.samples < 1) {

			pathTracer.renderSample();

		}

	} else {

		renderer.render(scene, activeCamera);

	}

	loader.setSamples(pathTracer.samples, pathTracer.isCompiling);

}

function onParamsChange() {

	pathTracer.multipleImportanceSampling = params.multipleImportanceSampling;
	pathTracer.bounces = params.bounces;
	pathTracer.filterGlossyFactor = params.filterGlossyFactor;
	pathTracer.renderScale = params.renderScale;

	floorPlane.material.color.set(params.floorColor);
	floorPlane.material.roughness = params.floorRoughness;
	floorPlane.material.metalness = params.floorMetalness;
	floorPlane.material.opacity = params.floorOpacity;

	scene.environmentIntensity = params.environmentIntensity;
	scene.environmentRotation.y = params.environmentRotation;
	scene.backgroundBlurriness = params.backgroundBlur;

	if (params.backgroundType === 'Gradient') {

		gradientMap.topColor.set(params.bgGradientTop);
		gradientMap.bottomColor.set(params.bgGradientBottom);
		gradientMap.update();

		scene.background = gradientMap;
		scene.backgroundIntensity = 1;
		scene.environmentRotation.y = 0;

	} else {

		scene.background = scene.environment;
		scene.backgroundIntensity = params.environmentIntensity;
		scene.backgroundRotation.y = params.environmentRotation;

	}

	if (params.transparentBackground) {

		scene.background = null;
		renderer.setClearAlpha(0);

	}

	pathTracer.updateMaterials();
	pathTracer.updateEnvironment();

}

function onHashChange() {

	let hashModel = '';
	if (window.location.hash) {

		const modelName = decodeURI(window.location.hash.substring(1));
		if (modelName in models) {

			hashModel = modelName;

		}

	}

	if (!(hashModel in models)) {

		hashModel = Object.keys(models)[0];

	}

	params.model = hashModel;
	updateModel();

}

function onResize() {

	const w = window.innerWidth;
	const h = window.innerHeight;
	const dpr = window.devicePixelRatio;

	renderer.setSize(w, h);
	renderer.setPixelRatio(dpr);

	const aspect = w / h;
	perspectiveCamera.aspect = aspect;
	perspectiveCamera.updateProjectionMatrix();

	const orthoHeight = orthoWidth / aspect;
	orthoCamera.top = orthoHeight / 2;
	orthoCamera.bottom = orthoHeight / - 2;
	orthoCamera.updateProjectionMatrix();

	pathTracer.updateCamera();

}

function buildGui() {

	if (gui) {

		gui.destroy();

	}

	gui = new GUI();

	gui.add(params, 'model', Object.keys(models).sort()).onChange(v => {

		window.location.hash = v;

	});

	// Animation frame control at top (like GLBViewer ControlPanel: Frames 0–150)
	if (animationMixer && mainAnimAction && mainAnimClip) {

		const animationFolder = gui.addFolder('Animation');
		const maxFrame = Math.min(ANIMATION_MAX_FRAME, Math.floor((mainAnimClip.duration || 5) * ANIMATION_FRAME_RATE));
		animationFolder.add(params, 'animationFrame', 0, maxFrame, 1).name(`Frame (0–${maxFrame})`).onChange(async (frame) => {

			const timeInSeconds = Math.min(frame / ANIMATION_FRAME_RATE, mainAnimClip.duration || 5);
			mainAnimAction.time = timeInSeconds;
			animationMixer.update(0);
			// Path tracer uses a BVH built from a snapshot of the scene; raster view uses live scene.
			// Rebuild the path tracer scene so it bakes the new pose and BVH (then it works in path tracer view).
			scene.updateMatrixWorld(true);
			try {
				await pathTracer.setSceneAsync(scene, activeCamera);
			} catch (e) {
				console.error('Failed to update path tracer scene for animation frame', e);
			}

		});
		// Include Off screen in Animation folder so user can turn display off from here
		if (screenMesh || Object.keys(wallpaperMeshes).some(key => wallpaperMeshes[key] !== null)) {

			params.animationScreen = (currentWallpaper === 'off_screen' || currentWallpaper === 'Off screen') ? 'Off screen' : 'On';
			animationFolder.add(params, 'animationScreen', ['On', 'Off screen']).name('Screen').onChange(async (value) => {

				if (value === 'Off screen') {

					currentWallpaper = 'off_screen';
					params.screenWallpaper = 'off_screen';
					await updateWallpaperVisibility('off_screen');

				} else {

					const toShow = (params.screenWallpaper === 'off_screen' || params.screenWallpaper === 'Off screen') ? 'blank_screen' : params.screenWallpaper;
					currentWallpaper = toShow;
					params.screenWallpaper = toShow;
					await updateWallpaperVisibility(toShow);

				}
				pathTracer.updateMaterials();
				pathTracer.reset();

			});

		}
		animationFolder.open();

	}

	const pathTracingFolder = gui.addFolder('Path Tracer');
	pathTracingFolder.add(params, 'enable');
	pathTracingFolder.add(params, 'pause');
	pathTracingFolder.add(params, 'multipleImportanceSampling').onChange(onParamsChange);
	pathTracingFolder.add(params, 'acesToneMapping').onChange(v => {

		renderer.toneMapping = v ? ACESFilmicToneMapping : NoToneMapping;

	});
	pathTracingFolder.add(params, 'bounces', 1, 20, 1).onChange(onParamsChange);
	pathTracingFolder.add(params, 'filterGlossyFactor', 0, 1).onChange(onParamsChange);
	// Allow very high internal resolution up to 8x (can be heavy on GPU)
	pathTracingFolder.add(params, 'renderScale', 0.1, 2.0, 0.01).onChange(() => {

		onParamsChange();

	});
	pathTracingFolder.add(params, 'tiles', 1, 10, 1).onChange(v => {

		pathTracer.tiles.set(v, v);

	});
	pathTracingFolder.add(params, 'cameraProjection', ['Perspective', 'Orthographic']).onChange(v => {

		updateCameraProjection(v);

	});
	const renderImageController = pathTracingFolder.add({
		renderImage: () => {

			if (imageRenderModal) {

				imageRenderModal.open();

			}

		}
	}, 'renderImage').name('Render Image...');

	// Add custom class to highlight the render button
	if (renderImageController && renderImageController.domElement) {

		renderImageController.domElement.classList.add('render-image-button');
		const button = renderImageController.domElement.querySelector('button');
		if (button) {

			button.classList.add('render-image-btn');

		}

	}
	pathTracingFolder.open();

	const environmentFolder = gui.addFolder('environment');
	environmentFolder.add(params, 'envMap', envMaps).name('map').onChange(updateEnvMap);
	environmentFolder.add(params, 'environmentIntensity', 0.0, 10.0).onChange(onParamsChange).name('intensity');
	environmentFolder.add(params, 'environmentRotation', 0, 2 * Math.PI).onChange(onParamsChange);
	environmentFolder.open();

	const backgroundFolder = gui.addFolder('background');
	backgroundFolder.add(params, 'backgroundType', ['Environment', 'Gradient']).onChange(onParamsChange);
	backgroundFolder.addColor(params, 'bgGradientTop').onChange(onParamsChange);
	backgroundFolder.addColor(params, 'bgGradientBottom').onChange(onParamsChange);
	backgroundFolder.add(params, 'backgroundBlur', 0, 1).onChange(onParamsChange);
	backgroundFolder.add(params, 'transparentBackground', 0, 1).onChange(onParamsChange);
	backgroundFolder.add(params, 'checkerboardTransparency').onChange(v => {

		if (v) document.body.classList.add('checkerboard');
		else document.body.classList.remove('checkerboard');

	});

	const floorFolder = gui.addFolder('floor');
	floorFolder.addColor(params, 'floorColor').onChange(onParamsChange);
	floorFolder.add(params, 'floorRoughness', 0, 1).onChange(onParamsChange);
	floorFolder.add(params, 'floorMetalness', 0, 1).onChange(onParamsChange);
	floorFolder.add(params, 'floorOpacity', 0, 1).onChange(onParamsChange);
	floorFolder.close();

	// Screen upload controls
	if (screenMesh || Object.keys(wallpaperMeshes).some(key => wallpaperMeshes[key] !== null)) {

		const screenFolder = gui.addFolder('Screen');

		// Build wallpaper options list - include "Off screen" option to hide all wallpapers
		const wallpaperOptions = ['off_screen', 'blank_screen', 'blue_bloom', 'aurora_borealis', 'feather_light', 'asus_1', 'asus_2', 'custom'];
		const availableWallpapers = wallpaperOptions.filter(option => {
			if (option === 'custom' || option === 'off_screen') return true;
			return wallpaperMeshes[option] !== null;
		});

		// Add wallpaper dropdown (includes off_screen)
		screenFolder.add(params, 'screenWallpaper', availableWallpapers).name('Wallpaper').onChange(async (value) => {

			currentWallpaper = value;
			params.screenWallpaper = value;
			// Custom wallpaper: defaults 4.5 brightness, 0.9 saturation; predefined: 1 and 1
			if (value === 'custom') {
				params.screenBrightness = 4.5;
				params.screenSaturation = 0.9;
			} else {
				params.screenBrightness = 1;
				params.screenSaturation = 1;
			}
			if (params.animationScreen !== undefined) {
				params.animationScreen = (value === 'off_screen' || value === 'Off screen') ? 'Off screen' : 'On';
			}
			await updateWallpaperVisibility(value);

		});

		// Add upload button
		screenFolder.add({
			uploadImage: () => {

				const fileInput = document.createElement('input');
				fileInput.type = 'file';
				fileInput.accept = 'image/*';
				fileInput.style.display = 'none';
				fileInput.addEventListener('change', (e) => {

					if (e.target.files[0]) {

						handleImageUpload(e.target.files[0]);

					}

				});
				fileInput.click();

			}
		}, 'uploadImage').name('Upload Custom');

		// ✅ FIX: Improved brightness control matching reference GLBViewer implementation
		// For custom wallpapers: re-processes the image with new brightness (baked into texture)
		// For predefined wallpapers: uses emissiveIntensity (immediate but slightly different)
		screenFolder.add(params, 'screenBrightness', 0, 10, 0.1).onChange(async (value) => {

			params.screenBrightness = value; // Update params

			// For custom wallpapers, reprocess the entire image with new brightness
			if (currentWallpaper === 'custom' && uploadedImage) {

				console.log(`🎨 Brightness changed to ${value} - reprocessing custom image`);
				await updateScreenTextureWithSettings();

			} else if (screenMesh && screenMesh.material) {

				// For predefined wallpapers, use emissiveIntensity (fallback behavior)
				const materials = Array.isArray(screenMesh.material)
					? screenMesh.material
					: [screenMesh.material];
				materials.forEach((material) => {

					material.emissiveIntensity = value;

					if (material.emissive) {
						material.emissive.setHex(0xffffff);
					}

					material.needsUpdate = true;

				});

				pathTracer.updateMaterials();
				pathTracer.reset();

			}

		}).name('Brightness');

		// ✅ NEW: Saturation control matching reference GLBViewer implementation
		// Re-processes the custom image with new saturation (0 = grayscale, 1 = normal, 2 = oversaturated)
		screenFolder.add(params, 'screenSaturation', 0, 2, 0.1).onChange(async (value) => {

			params.screenSaturation = value; // Update params

			// Only works for custom wallpapers with uploaded image
			if (currentWallpaper === 'custom' && uploadedImage) {

				console.log(`🎨 Saturation changed to ${value} - reprocessing custom image`);
				await updateScreenTextureWithSettings();

			} else {

				console.log(`⚠️ Saturation control only works with custom uploaded images`);

			}

		}).name('Saturation');

		screenFolder.close();

	}

}

function updateEnvMap() {

	new HDRLoader()
		.load(params.envMap, texture => {

			if (scene.environment) {

				scene.environment.dispose();

			}

			texture.mapping = EquirectangularReflectionMapping;
			scene.environment = texture;
			pathTracer.updateEnvironment();
			onParamsChange();

		});

}

function updateCameraProjection(cameraProjection) {

	// sync position
	if (activeCamera) {

		perspectiveCamera.position.copy(activeCamera.position);
		orthoCamera.position.copy(activeCamera.position);

	}

	// set active camera
	if (cameraProjection === 'Perspective') {

		activeCamera = perspectiveCamera;

	} else {

		activeCamera = orthoCamera;

	}

	controls.object = activeCamera;
	controls.update();

	pathTracer.setCamera(activeCamera);

	// Update modal camera reference
	if (imageRenderModal) {

		imageRenderModal.camera = activeCamera;

	}

}

function convertOpacityToTransmission(model, ior) {

	model.traverse(c => {

		if (c.material) {

			const material = c.material;
			if (material.opacity < 0.65 && material.opacity > 0.2) {

				const newMaterial = new MeshPhysicalMaterial();
				for (const key in material) {

					if (key in material) {

						if (material[key] === null) {

							continue;

						}

						if (material[key].isTexture) {

							newMaterial[key] = material[key];

						} else if (material[key].copy && material[key].constructor === newMaterial[key].constructor) {

							newMaterial[key].copy(material[key]);

						} else if ((typeof material[key]) === 'number') {

							newMaterial[key] = material[key];

						}

					}

				}

				newMaterial.opacity = 1.0;
				newMaterial.transmission = 1.0;
				newMaterial.ior = ior;

				const hsl = {};
				newMaterial.color.getHSL(hsl);
				hsl.l = Math.max(hsl.l, 0.35);
				newMaterial.color.setHSL(hsl.h, hsl.s, hsl.l);

				c.material = newMaterial;

			}

		}

	});

}

// Function to find the screen mesh by traversing the model
function findScreenMesh(model) {

	let foundMesh = null;
	let priorityMesh = null; // For exact "screen_blank" match

	model.traverse((child) => {

		if (child.isMesh) {

			// Check if this mesh is part of the screen
			const name = child.name.toLowerCase();
			const parentName = child.parent?.name?.toLowerCase() || '';

			// Priority: Look for exact "screen_blank" match first
			if (name.includes('screen_blank') || name === 'screen_blank') {

				if (child.material) {

					priorityMesh = child;
					console.log('Found priority screen mesh (screen_blank):', child.name, 'Parent:', child.parent?.name);
					return; // Found the exact match, we can stop

				}

			}

			// Skip covers, panels, and other non-screen parts
			if (name.includes('cover') || name.includes('panel') || name.includes('back') || name.startsWith('a_')) {

				return; // Skip this mesh

			}

			// Secondary: Look for other screen-related meshes (but not covers)
			if (
				(name.includes('screen') && name.includes('blank')) ||
				(name.includes('blank') && parentName.includes('screen')) ||
				(name === 'blank' && parentName.includes('screen'))
			) {

				// Check if it has a material with emissive properties (likely the screen)
				if (child.material) {

					// Prefer meshes with emissive maps
					if (!foundMesh || child.material.emissiveMap) {

						foundMesh = child;
						console.log('Found screen mesh:', child.name, 'Parent:', child.parent?.name);

					}

				}

			}

		}

	});

	// Return priority mesh if found, otherwise return the found mesh
	if (priorityMesh) {

		return priorityMesh;

	}

	// If not found by name, try finding by material properties (but exclude covers/panels)
	if (!foundMesh) {

		model.traverse((child) => {

			if (child.isMesh && child.material) {

				const name = child.name.toLowerCase();
				// Skip covers, panels, and other non-screen parts
				if (name.includes('cover') || name.includes('panel') || name.includes('back')) {

					return;

				}

				const material = Array.isArray(child.material) ? child.material[0] : child.material;

				// Look for materials that already have emissive properties
				if (material.emissiveMap || material.emissiveIntensity > 0) {

					foundMesh = child;
					console.log('Found screen by material:', child.name);
					return;

				}

			}

		});

	}

	return foundMesh;

}

// Function to find all wallpaper meshes/groups
// Uses dynamic detection based on numeric prefix pattern (e.g., 01_Blue_Bloom, 03_Feather_Light)
// Similar to the reference implementation in GLBViewer.jsx
function findAllWallpaperMeshes(model) {

	const wallpapers = {
		'blank_screen': null,
		'blue_bloom': null,
		'aurora_borealis': null,
		'feather_light': null,
		'asus_1': null,
		'asus_2': null,
	};

	// Map to store all found wallpaper meshes by their actual mesh name
	const wallpaperMeshesByName = new Map();

	// Also look for screen_blank for custom wallpapers
	let wallpaperGroup = null;
	let screenBlankMesh = null;

	// First pass: Look for meshes with numeric prefix pattern (e.g., 01_Blue_Bloom, 03_Feather_Light)
	// This is the dynamic approach - detects wallpapers based on actual GLB structure
	model.traverse((child) => {

		if (child.isGroup && child.name === 'wallpaper') {
			wallpaperGroup = child;
			console.log(`✅ [WALLPAPER GROUP] Found: ${child.name}`);
		}

		if (child.isMesh && child.material) {

			const name = child.name;
			const nameLower = name.toLowerCase();
			const parentName = child.parent?.name || '';
			const parentNameLower = parentName.toLowerCase();

			// Find screen_blank for custom wallpapers
			if (name === 'screen_blank') {
				screenBlankMesh = child;
				console.log(`✅ [SCREEN BLANK] Found: ${name} (parent: ${parentName})`);
			}

			// Look for meshes with numeric prefix pattern: /^\d+_/
			// This matches patterns like: 01_Blue_Bloom, 02_Aurora_Borealis, 03_Feather_Light
			const numericPrefixMatch = name.match(/^(\d+)_(.+)/);

			if (numericPrefixMatch) {
				// Found a mesh with numeric prefix - this is likely a wallpaper
				const wallpaperName = numericPrefixMatch[2]; // The name after the prefix
				const wallpaperNameLower = wallpaperName.toLowerCase();

				// Store by actual mesh name
				wallpaperMeshesByName.set(name, child);
				console.log(`✅ [WALLPAPER MESH] Found: ${name} (parent: ${parentName})`);

				// Also try to map to normalized keys for backward compatibility
				// Extract core name (remove "vertical" prefix if present)
				let coreName = wallpaperNameLower;
				coreName = coreName.replace(/^vertical_?/i, '');
				coreName = coreName.replace(/_?vertical_?/i, '');
				coreName = coreName.replace(/__+/g, '_');
				coreName = coreName.replace(/^_+|_+$/g, '');

				// Map to known wallpaper keys based on core name
				// This allows matching "feather_light" even if the mesh is named "03_Feather_Light" or "03_feather_light"
				if (coreName.includes('blank') || coreName.includes('screen_blank')) {
					if (!wallpapers['blank_screen']) {
						wallpapers['blank_screen'] = child;
					}
				} else if (coreName.includes('blue') && coreName.includes('bloom')) {
					if (!wallpapers['blue_bloom']) {
						wallpapers['blue_bloom'] = child;
					}
				} else if (coreName.includes('aurora') || coreName.includes('borealis')) {
					if (!wallpapers['aurora_borealis']) {
						wallpapers['aurora_borealis'] = child;
					}
				} else if (coreName.includes('feather') && coreName.includes('light')) {
					// ✅ FIX: Only match if BOTH "feather" AND "light" are present
					// This prevents false matches with meshes that only have "feather" or only "light"
					if (!wallpapers['feather_light']) {
						wallpapers['feather_light'] = child;
						console.log(`✅ Mapped "${name}" to "feather_light" (core: "${coreName}")`);
					}
				} else if (coreName === 'asus_1' || coreName === 'asus1') {
					if (!wallpapers['asus_1']) {
						wallpapers['asus_1'] = child;
					}
				} else if (coreName === 'asus_2' || coreName === 'asus2') {
					if (!wallpapers['asus_2']) {
						wallpapers['asus_2'] = child;
					}
				}
			}

			// Also check for meshes inside "wallpaper" group (if parent is "wallpaper")
			// This matches the reference implementation pattern
			if (parentNameLower === 'wallpaper' && /^\d+_/.test(name)) {
				// Already handled above, but ensure it's stored
				if (!wallpaperMeshesByName.has(name)) {
					wallpaperMeshesByName.set(name, child);
					console.log(`✅ [WALLPAPER MESH] Found in wallpaper group: ${name}`);
				}
			}

		}

	});

	// Store screen_blank if found — and assign it to wallpapers['blank_screen']
	if (screenBlankMesh) {
		wallpaperMeshesByName.set('screen_blank', screenBlankMesh);
		if (!wallpapers['blank_screen']) {
			wallpapers['blank_screen'] = screenBlankMesh;
		}
	}

	// Log all found wallpapers
	console.log(`📋 Available wallpaper meshes (${wallpaperMeshesByName.size} total):`);
	wallpaperMeshesByName.forEach((mesh, name) => {
		console.log(`   - ${name}`);
	});

	// Store the map for use in updateWallpaperVisibility
	wallpaperMeshesByName._wallpaperGroup = wallpaperGroup;
	wallpaperMeshesByName._screenBlank = screenBlankMesh;

	return wallpapers;

}

// Function to show/hide wallpapers based on selection
async function updateWallpaperVisibility(selectedWallpaper) {

	if (!model) {

		console.error('❌ updateWallpaperVisibility: model is null!');
		return;

	}

	console.log(`\n🎨 ========== UPDATE WALLPAPER VISIBILITY ==========`);
	console.log(`📌 Selected wallpaper: "${selectedWallpaper}"`);
	console.log(`📦 Current screenMesh:`, screenMesh ? screenMesh.name : 'null');
	console.log(`📋 Available wallpapers:`, Object.keys(wallpaperMeshes).filter(k => wallpaperMeshes[k] !== null));

	// First, collect ALL screen-related meshes with their positions and priority
	const allScreenMeshes = [];
	model.traverse((child) => {

		if (child.isMesh) {

			const name = child.name.toLowerCase();
			const parentName = child.parent?.name?.toLowerCase() || '';

			// Check if this is a wallpaper mesh (NOT screen component meshes)
			// Screen components like screen_panel, screen_backlight, screen_filter, screen_mirror, screen_bezel should NOT be collected
			const isScreenComponent = name.includes('screen_panel') ||
				name.includes('screen_backlight') ||
				name.includes('screen_filter') ||
				name.includes('screen_mirror') ||
				name.includes('screen_bezel') ||
				name.includes('display008') ||
				name.includes('display006') ||
				name.includes('display005') ||
				name.includes('display007') ||
				parentName.includes('screen_backlight') ||
				parentName.includes('screen_filter') ||
				parentName.includes('screen_mirror') ||
				parentName.includes('screen_rgb') ||
				(parentName.includes('displayctrl') && !parentName.includes('wallpaper'));

			// ✅ DYNAMIC DETECTION: Use actual found wallpaper meshes instead of hardcoded patterns
			// Check if this mesh is one of the found wallpaper meshes
			const originalName = child.name; // Keep original case for matching
			const isFoundWallpaper = Object.values(wallpaperMeshes).some(mesh => mesh === child);
			const hasNumericPrefix = /^\d+_/.test(originalName);
			const isInWallpaperGroup = parentName === 'wallpaper';
			const isScreenBlank = originalName === 'screen_blank';

			// Collect meshes that are:
			// 1. Found wallpapers from findAllWallpaperMeshes
			// 2. Meshes with numeric prefix (dynamic wallpaper detection)
			// 3. screen_blank for custom wallpapers
			// 4. Meshes in wallpaper group
			// 5. screen_rgb meshes (legacy support)
			const isWallpaperMesh = !isScreenComponent && (
				isFoundWallpaper ||
				(hasNumericPrefix && (isInWallpaperGroup || true)) || // Allow numeric prefix anywhere
				isScreenBlank ||
				(name.includes('rgb') && parentName.includes('screen') && !parentName.includes('screenctrl'))
			);

			if (isWallpaperMesh) {

				// Get world position to determine depth/priority (Z position = distance from camera/screen)
				child.updateMatrixWorld(true);
				const worldPos = new Vector3();
				child.getWorldPosition(worldPos);

				// ✅ DYNAMIC PRIORITY: Determine wallpaper type based on actual found meshes
				let priority = 0;
				let wallpaperType = 'unknown';

				// Check against found wallpaper meshes first (most reliable)
				if (wallpaperMeshes['blank_screen'] === child || isScreenBlank) {
					priority = 100;
					wallpaperType = 'blank_screen';
				} else if (wallpaperMeshes['blue_bloom'] === child) {
					priority = 90;
					wallpaperType = 'blue_bloom';
				} else if (wallpaperMeshes['aurora_borealis'] === child) {
					priority = 80;
					wallpaperType = 'aurora_borealis';
				} else if (wallpaperMeshes['feather_light'] === child) {
					// ✅ FIX: Use the actual found mesh instead of pattern matching
					priority = 70;
					wallpaperType = 'feather_light';
				} else if (wallpaperMeshes['asus_1'] === child) {
					priority = 60;
					wallpaperType = 'asus_1';
				} else if (wallpaperMeshes['asus_2'] === child) {
					priority = 55;
					wallpaperType = 'asus_2';
				} else if (name.includes('rgb') && parentName.includes('screen') && !parentName.includes('screenctrl')) {
					priority = 50;
					wallpaperType = 'screen_rgb';
				} else if (hasNumericPrefix) {
					// Dynamic wallpaper with numeric prefix - extract core name for type
					const match = originalName.match(/^\d+_(.+)/);
					if (match) {
						let coreName = match[1].toLowerCase();
						coreName = coreName.replace(/^vertical_?/i, '');
						coreName = coreName.replace(/_?vertical_?/i, '');
						coreName = coreName.replace(/__+/g, '_');
						coreName = coreName.replace(/^_+|_+$/g, '');

						// Map to known types based on core name
						if (coreName.includes('blank')) {
							priority = 100;
							wallpaperType = 'blank_screen';
						} else if (coreName.includes('blue') && coreName.includes('bloom')) {
							priority = 90;
							wallpaperType = 'blue_bloom';
						} else if (coreName.includes('aurora') || coreName.includes('borealis')) {
							priority = 80;
							wallpaperType = 'aurora_borealis';
						} else if (coreName.includes('feather') && coreName.includes('light')) {
							// ✅ FIX: Require BOTH "feather" AND "light" to prevent false matches
							priority = 70;
							wallpaperType = 'feather_light';
						} else if (coreName === 'asus_1' || coreName === 'asus1') {
							priority = 60;
							wallpaperType = 'asus_1';
						} else if (coreName === 'asus_2' || coreName === 'asus2') {
							priority = 55;
							wallpaperType = 'asus_2';
						} else {
							priority = 40;
							wallpaperType = coreName; // Use core name as type
						}
					} else {
						priority = 40;
						wallpaperType = 'wallpaper';
					}
				} else if (isInWallpaperGroup) {
					priority = 40;
					wallpaperType = 'wallpaper';
				} else {
					priority = 10;
				}

				allScreenMeshes.push({
					mesh: child,
					name: child.name,
					parent: child.parent?.name || 'none',
					visible: child.visible,
					hasMaterial: !!child.material,
					hasEmissiveMap: !!(child.material && child.material.emissiveMap),
					worldPosition: { x: worldPos.x.toFixed(2), y: worldPos.y.toFixed(2), z: worldPos.z.toFixed(2) },
					priority: priority,
					wallpaperType: wallpaperType,
					depth: worldPos.z // Z position = depth (lower Z = closer to screen/front)
				});

			}

		}

	});

	// Sort by priority (higher first), then by depth (lower Z = closer to screen = higher priority)
	allScreenMeshes.sort((a, b) => {
		if (b.priority !== a.priority) return b.priority - a.priority;
		return a.depth - b.depth; // Lower Z = closer to screen
	});

	console.log(`\n📊 ALL SCREEN MESHES FOUND (${allScreenMeshes.length} total):`);
	console.log(`   Sorted by Priority (higher = more important) → Depth (lower Z = closer to screen)`);
	console.log(`   ┌─────────────────────────────────────────────────────────────────────────────────────────┐`);
	console.log(`   │ Priority │ Depth (Z) │ Visible │ Has Emissive │ Type              │ Name                │`);
	console.log(`   ├─────────────────────────────────────────────────────────────────────────────────────────┤`);

	allScreenMeshes.forEach((info, idx) => {

		const priorityStr = String(info.priority).padStart(3);
		const depthStr = info.depth.toFixed(2).padStart(8);
		const visibleStr = (info.visible ? '✅ YES' : '❌ NO ').padEnd(7);
		const emissiveStr = (info.hasEmissiveMap ? '✅ YES' : '❌ NO ').padEnd(12);
		const typeStr = info.wallpaperType.padEnd(18);
		const nameStr = (info.name.length > 20 ? info.name.substring(0, 17) + '...' : info.name).padEnd(20);

		console.log(`   │ ${priorityStr}     │ ${depthStr} │ ${visibleStr} │ ${emissiveStr} │ ${typeStr} │ ${nameStr} │`);

	});

	console.log(`   └─────────────────────────────────────────────────────────────────────────────────────────┘`);

	// Hide ALL screen meshes first - also hide their parent groups if they only contain wallpapers
	console.log(`\n🔒 HIDING ALL SCREEN MESHES AND PARENT GROUPS:`);
	const hiddenGroups = new Set();
	const hiddenMeshesList = [];

	allScreenMeshes.forEach((info) => {

		const wasVisible = info.mesh.visible;
		info.mesh.visible = false;
		hiddenMeshesList.push(info);

		// Also hide parent groups that might contain wallpapers
		// IMPORTANT: Only hide groups that are specifically wallpaper groups, NOT screen component groups
		let parent = info.mesh.parent;
		while (parent && parent !== model) {

			const parentName = parent.name?.toLowerCase() || '';
			// Only hide groups that are specifically wallpaper groups
			// Do NOT hide screenCTRL, displayCTRL, or screen component groups (screen_backlight, screen_filter, etc.)
			if (parentName.includes('wallpaper')) {

				if (!hiddenGroups.has(parent)) {

					const wasGroupVisible = parent.visible;
					parent.visible = false;
					hiddenGroups.add(parent);
					if (wasGroupVisible) {

						console.log(`   ❌ HID GROUP: "${parent.name}" (contains "${info.name}")`);

					}

				}

			}
			parent = parent.parent;

		}

		if (wasVisible) {

			console.log(`   ❌ HID MESH: "${info.name}" (Priority: ${info.priority}, Depth: ${info.depth.toFixed(2)})`);

		}

	});

	console.log(`   📊 Summary: Hid ${hiddenMeshesList.length} meshes and ${hiddenGroups.size} groups`);

	// Show ONLY the selected wallpaper
	let targetMesh = null;
	let targetMeshInfo = null;

	// ✅ FIX: Handle "Off screen" mode - hide ALL wallpapers, don't show anything
	const isScreenOff = selectedWallpaper === 'off_screen' || selectedWallpaper === 'Off screen' || !selectedWallpaper;

	if (isScreenOff) {

		console.log(`\n📴 SCREEN OFF MODE - Hiding all wallpapers`);
		console.log(`   All ${hiddenMeshesList.length} meshes remain hidden`);
		console.log(`   No target mesh will be shown`);
		// Don't set targetMesh - all wallpapers stay hidden
		// This is the correct behavior for "Off screen"

	} else if (selectedWallpaper === 'custom') {

		console.log(`\n🎯 CUSTOM WALLPAPER MODE`);
		console.log(`   screenMesh exists:`, !!screenMesh);
		console.log(`   screenMesh name:`, screenMesh?.name);

		// Find the screenMesh in our collected list
		if (screenMesh) {

			targetMeshInfo = allScreenMeshes.find(info => info.mesh === screenMesh);
			targetMesh = screenMesh;

			if (targetMeshInfo) {

				console.log(`   📍 Found screenMesh in list: Priority ${targetMeshInfo.priority}, Depth ${targetMeshInfo.depth.toFixed(2)}`);

			} else {

				console.log(`   ⚠️ screenMesh not found in collected list, using directly`);

			}

		} else {

			console.error(`   ❌ screenMesh is null! Cannot show custom wallpaper.`);
			console.log(`   💡 Trying to find best screen mesh from collected list...`);

			// Try to find the highest priority mesh with emissive map
			targetMeshInfo = allScreenMeshes.find(info => info.hasEmissiveMap || info.priority > 50);
			if (targetMeshInfo) {

				targetMesh = targetMeshInfo.mesh;
				screenMesh = targetMesh;
				console.log(`   ✅ Using fallback mesh: "${targetMesh.name}"`);

			}

		}

	} else if (wallpaperMeshes[selectedWallpaper]) {

		const selectedMesh = wallpaperMeshes[selectedWallpaper];
		console.log(`\n🎯 PREDEFINED WALLPAPER MODE: "${selectedWallpaper}"`);
		console.log(`   Selected mesh: "${selectedMesh.name}"`);

		// Find it in our collected list
		targetMeshInfo = allScreenMeshes.find(info => info.mesh === selectedMesh);
		targetMesh = selectedMesh;

		if (targetMeshInfo) {

			console.log(`   📍 Found in list: Priority ${targetMeshInfo.priority}, Depth ${targetMeshInfo.depth.toFixed(2)}`);

		}

		// Update screenMesh reference
		screenMesh = selectedMesh;

	} else {

		console.warn(`\n⚠️ Wallpaper "${selectedWallpaper}" not found in wallpaperMeshes!`);
		console.log(`   Available keys:`, Object.keys(wallpaperMeshes));
		console.log(`   Values:`, Object.entries(wallpaperMeshes).map(([k, v]) => `${k}: ${v ? v.name : 'null'}`));

	}

	// Show the target mesh
	if (targetMesh) {

		targetMesh.visible = true;
		console.log(`\n✅ SHOWING TARGET MESH:`);
		console.log(`   Name: "${targetMesh.name}"`);
		if (targetMeshInfo) {

			console.log(`   Priority: ${targetMeshInfo.priority} (${targetMeshInfo.wallpaperType})`);
			console.log(`   Depth (Z): ${targetMeshInfo.depth.toFixed(2)} (${targetMeshInfo.depth < 0 ? 'FRONT/CLOSER' : 'BACK/FARTHER'})`);
			console.log(`   Position: (${targetMeshInfo.worldPosition.x}, ${targetMeshInfo.worldPosition.y}, ${targetMeshInfo.worldPosition.z})`);

		}
		console.log(`   Has EmissiveMap: ${targetMeshInfo?.hasEmissiveMap ? '✅ YES' : '❌ NO'}`);
		console.log(`   ✅ Set visible = true`);

		// Predefined wallpapers: apply default brightness (1) and saturation (1) so they display correctly when switching from custom
		const isPredefined = selectedWallpaper !== 'custom' && !isScreenOff && wallpaperMeshes[selectedWallpaper];
		if (isPredefined && targetMesh.material) {
			const materials = Array.isArray(targetMesh.material) ? targetMesh.material : [targetMesh.material];
			materials.forEach((material) => {
				material.emissiveIntensity = params.screenBrightness;
				if (material.emissive) material.emissive.setHex(0xffffff);
				material.needsUpdate = true;
			});
			if (pathTracer) {
				pathTracer.updateMaterials();
				pathTracer.reset();
			}
		}

		// Also make sure parent groups are visible - but ONLY the chain leading to targetMesh
		let parent = targetMesh.parent;
		let parentCount = 0;
		const visibleParentChain = new Set();

		while (parent && parent !== model) {

			parent.visible = true;
			visibleParentChain.add(parent);
			console.log(`   ✅ Made parent visible: "${parent.name}"`);
			parent = parent.parent;
			parentCount++;
			if (parentCount > 10) break; // Safety limit

		}

		// IMPORTANT: Hide any sibling groups that might contain other wallpapers
		// Traverse the model and hide any wallpaper groups that are NOT in the visible chain
		// ONLY hide wallpaper groups, NOT screen component groups
		model.traverse((child) => {

			if (child.isGroup) {

				const name = child.name?.toLowerCase() || '';
				// Only hide groups that are specifically wallpaper groups
				// Do NOT hide screenCTRL, displayCTRL, or screen component groups
				if (name.includes('wallpaper') &&
					!visibleParentChain.has(child) &&
					child !== targetMesh.parent) {

					child.visible = false;
					console.log(`   🔒 Hid sibling group: "${child.name}" (not in visible chain)`);

				}

			}

		});

	} else {

		console.error(`   ❌ No target mesh found! Cannot show wallpaper.`);

	}

	// Verify final state - show what's actually visible now
	console.log(`\n📊 FINAL STATE - VISIBLE MESHES ON SCREEN:`);
	const visibleMeshes = allScreenMeshes.filter(info => info.mesh.visible);

	if (visibleMeshes.length === 0) {

		console.log(`   ⚠️ NO MESHES ARE VISIBLE! This is a problem.`);

	} else {

		console.log(`   ✅ ${visibleMeshes.length} mesh(es) visible:`);
		visibleMeshes.forEach((info, idx) => {

			console.log(`   ${idx + 1}. "${info.name}"`);
			console.log(`      Priority: ${info.priority} (${info.wallpaperType})`);
			console.log(`      Depth: ${info.depth.toFixed(2)} (${info.depth < 0 ? 'FRONT' : 'BACK'})`);
			console.log(`      Has EmissiveMap: ${info.hasEmissiveMap ? '✅ YES' : '❌ NO'}`);
			console.log(`      Parent: "${info.parent}"`);

		});

	}

	// Show hidden meshes for reference
	const hiddenMeshes = allScreenMeshes.filter(info => !info.mesh.visible);
	if (hiddenMeshes.length > 0) {

		console.log(`\n   🔒 ${hiddenMeshes.length} mesh(es) HIDDEN (should not appear):`);
		hiddenMeshes.slice(0, 5).forEach((info) => {

			console.log(`      - "${info.name}" (Priority: ${info.priority}, Type: ${info.wallpaperType})`);

		});
		if (hiddenMeshes.length > 5) {

			console.log(`      ... and ${hiddenMeshes.length - 5} more`);

		}

	}

	// Force update the path tracer scene to reflect visibility changes
	// IMPORTANT: Use setSceneAsync to ensure visibility is properly respected
	console.log(`\n🔄 Updating path tracer scene (rebuilding with only visible meshes)...`);

	// Small delay to ensure visibility updates are processed
	await new Promise(resolve => setTimeout(resolve, 10));

	// Ensure current animation pose and world matrices are up-to-date before rebuilding
	// Without this, the path tracer may capture a stale skeleton pose
	if (animationMixer && mainAnimAction) {
		animationMixer.update(0);
	}
	scene.updateMatrixWorld(true);

	// Rebuild the scene - this will use traverseVisible() which only includes visible meshes
	await pathTracer.setSceneAsync(scene, activeCamera, {
		onProgress: (v) => {

			if (v === 1) {

				console.log(`✅ Path tracer scene rebuilt - only visible meshes included\n`);

			}

		}
	});

}

// ✅ NEW: Apply brightness and saturation to image canvas before creating texture
// This matches the reference GLBViewer shader implementation:
// - brightness: multiplies color values (1.0 = normal, 0.5 = darker, 2.0 = brighter)
// - saturation: interpolates between grayscale and original (0 = grayscale, 1 = normal, 2 = oversaturated)
function applyBrightnessSaturationToImage(img, brightness, saturation) {

	const canvas = document.createElement('canvas');
	canvas.width = img.width;
	canvas.height = img.height;
	const ctx = canvas.getContext('2d');
	ctx.drawImage(img, 0, 0);

	const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
	const data = imageData.data;

	// Convert brightness from 0-10 range to shader range (0-2.0)
	// Reference uses brightness directly as multiplier
	const brightnessMultiplier = brightness / 5.0; // 0-10 -> 0-2.0, with 5.0 being normal (1.0x)

	for (let i = 0; i < data.length; i += 4) {

		let r = data[i] / 255;
		let g = data[i + 1] / 255;
		let b = data[i + 2] / 255;

		// 1. Apply brightness (multiply color values)
		r *= brightnessMultiplier;
		g *= brightnessMultiplier;
		b *= brightnessMultiplier;

		// 2. Apply saturation using luma (same coefficients as reference shader)
		// luma = dot(color, vec3(0.299, 0.587, 0.114))
		const luma = 0.299 * r + 0.587 * g + 0.114 * b;

		// mix(gray, color, saturation) = gray + saturation * (color - gray)
		r = luma + saturation * (r - luma);
		g = luma + saturation * (g - luma);
		b = luma + saturation * (b - luma);

		// Clamp values to 0-255 range
		data[i] = Math.max(0, Math.min(255, Math.round(r * 255)));
		data[i + 1] = Math.max(0, Math.min(255, Math.round(g * 255)));
		data[i + 2] = Math.max(0, Math.min(255, Math.round(b * 255)));
		// Alpha (data[i + 3]) remains unchanged

	}

	ctx.putImageData(imageData, 0, 0);
	return canvas;

}

// ✅ NEW: Helper to update screen texture with current brightness/saturation settings
async function updateScreenTextureWithSettings() {

	if (!uploadedImage || !screenMesh || !screenMesh.material) {

		console.warn('⚠️ Cannot update screen texture - missing image or screenMesh');
		return;

	}

	console.log(`🔄 Updating screen texture with brightness: ${params.screenBrightness}, saturation: ${params.screenSaturation}`);

	// Apply brightness and saturation to stored original image
	const processedCanvas = applyBrightnessSaturationToImage(
		uploadedImage,
		params.screenBrightness,
		params.screenSaturation
	);

	// Create new texture from processed canvas
	const texture = new Texture(processedCanvas);

	// ✅ FIX: flipY = false to match reference GLBViewer implementation
	texture.flipY = false;

	// ✅ FIX: Proper color space for correct color reproduction
	texture.colorSpace = SRGBColorSpace;

	// ✅ FIX: Enable mipmaps for better quality in PathTracer
	texture.generateMipmaps = true;
	texture.minFilter = LinearMipmapLinearFilter;
	texture.magFilter = LinearFilter;

	// ✅ FIX: Anisotropic filtering for sharper textures at angles
	texture.anisotropy = 16;

	texture.needsUpdate = true;

	// Apply to materials
	const materials = Array.isArray(screenMesh.material)
		? screenMesh.material
		: [screenMesh.material];

	materials.forEach((material) => {

		// Dispose old texture if exists
		if (material.emissiveMap && material.emissiveMap !== uploadedTexture) {

			material.emissiveMap.dispose();

		}

		material.emissiveMap = texture;
		// Keep emissiveIntensity at 1.0 since brightness is now baked into the texture
		material.emissiveIntensity = 1.0;
		material.emissive = new Color(0xffffff);
		// Match predefined wallpapers: glossy screen look (low roughness, no metalness)
		material.roughness = 1;
		material.metalness = 1;
		material.needsUpdate = true;

	});

	// Store the new texture reference
	uploadedTexture = texture;

	// Update path tracer
	pathTracer.updateMaterials();
	pathTracer.reset();

	console.log(`✅ Screen texture updated successfully`);

}

// Function to handle image upload
async function handleImageUpload(file) {

	console.log(`\n📤 ========== IMAGE UPLOAD STARTED ==========`);
	console.log(`📁 File:`, file.name, `(${file.type}, ${(file.size / 1024).toFixed(2)} KB)`);

	if (!file || !file.type.startsWith('image/')) {

		alert('Please upload an image file');
		return;

	}

	const reader = new FileReader();
	reader.onload = async (e) => {

		console.log(`✅ File read successfully`);

		const img = new Image();
		img.onload = async () => {

			console.log(`✅ Image loaded: ${img.width}x${img.height}`);

			// ✅ NEW: Store the original image for later brightness/saturation updates
			uploadedImage = img;
			console.log(`✅ Stored original image for brightness/saturation processing`);

			// Custom wallpaper defaults: 4.5 brightness, 0.9 saturation
			params.screenBrightness = 4.5;
			params.screenSaturation = 0.9;

			// Find the screen mesh if not already found
			if (!screenMesh && model) {

				console.log(`🔍 screenMesh not found, searching...`);
				screenMesh = findScreenMesh(model);
				console.log(`🔍 Found screenMesh:`, screenMesh ? screenMesh.name : 'null');

			}

			console.log(`\n📊 BEFORE APPLYING TEXTURE:`);
			console.log(`   screenMesh:`, screenMesh ? screenMesh.name : 'null');
			console.log(`   screenMesh.visible:`, screenMesh?.visible);
			console.log(`   screenMesh.material exists:`, !!screenMesh?.material);
			console.log(`   currentWallpaper:`, currentWallpaper);
			console.log(`   params.screenWallpaper:`, params.screenWallpaper);

			if (screenMesh && screenMesh.material) {

				// ✅ NEW: Apply brightness and saturation to the image before creating texture
				console.log(`\n   🎨 Applying brightness: ${params.screenBrightness}, saturation: ${params.screenSaturation}`);
				const processedCanvas = applyBrightnessSaturationToImage(
					img,
					params.screenBrightness,
					params.screenSaturation
				);

				// Create texture from processed image
				const texture = new Texture(processedCanvas);

				// ✅ FIX: flipY = false to match reference GLBViewer implementation
				texture.flipY = false;

				// ✅ FIX: Proper color space for correct color reproduction
				texture.colorSpace = SRGBColorSpace;

				// ✅ FIX: Enable mipmaps for better quality in PathTracer
				texture.generateMipmaps = true;
				texture.minFilter = LinearMipmapLinearFilter;
				texture.magFilter = LinearFilter;

				// ✅ FIX: Anisotropic filtering for sharper textures at angles
				texture.anisotropy = 16;

				texture.needsUpdate = true;
				console.log(`✅ Texture created with proper quality settings (flipY: false, colorSpace: sRGB, mipmaps: enabled, brightness/saturation applied)`);

				// Handle array materials (if mesh has multiple materials)
				const materials = Array.isArray(screenMesh.material)
					? screenMesh.material
					: [screenMesh.material];

				console.log(`   Materials count:`, materials.length);

				// Store the uploaded texture
				uploadedTexture = texture;
				console.log(`   ✅ Stored uploadedTexture`);

				materials.forEach((material, idx) => {

					console.log(`\n   📝 Processing material ${idx + 1}:`);
					console.log(`      Has emissiveMap:`, !!material.emissiveMap);
					console.log(`      emissiveIntensity:`, material.emissiveIntensity);

					// Dispose old texture if exists (but not if it's the one we just uploaded)
					if (material.emissiveMap && material.emissiveMap !== uploadedTexture) {

						console.log(`      🗑️ Disposing old emissiveMap`);
						material.emissiveMap.dispose();

					}

					// Set the new emissive map (same texture for all materials)
					material.emissiveMap = texture;
					// ✅ FIX: Set emissiveIntensity to 1.0 since brightness is baked into texture
					material.emissiveIntensity = 1.0;
					material.emissive = new Color(0xffffff); // White base
					// Match predefined wallpapers: glossy screen look (low roughness, no metalness)
					material.roughness = 1;
					material.metalness = 1;
					material.needsUpdate = true;

					console.log(`      ✅ Applied new emissiveMap`);
					console.log(`      ✅ Set emissiveIntensity to: 1.0 (brightness baked into texture)`);
					console.log(`      ✅ Set emissive color to white`);
					console.log(`      ✅ Set roughness=0, metalness=0 for glossy screen`);
					console.log(`      ✅ Set needsUpdate = true`);

				});

				// Set wallpaper to custom
				params.screenWallpaper = 'custom';
				currentWallpaper = 'custom';
				console.log(`\n   ✅ Set params.screenWallpaper = 'custom'`);
				console.log(`   ✅ Set currentWallpaper = 'custom'`);

				// Hide all predefined wallpapers and show custom
				console.log(`\n   🎨 Calling updateWallpaperVisibility('custom')...`);
				await updateWallpaperVisibility('custom');

				// Update the path tracer with new materials
				console.log(`\n   🔄 Updating path tracer materials...`);
				pathTracer.updateMaterials();

				// Reset rendering to see changes immediately
				console.log(`   🔄 Resetting path tracer...`);
				pathTracer.reset();

				// Rebuild GUI to update the screen folder
				console.log(`   🔄 Rebuilding GUI...`);
				buildGui();

				console.log(`\n✅ ========== IMAGE UPLOAD COMPLETE ==========\n`);

			} else {

				console.error(`\n❌ ========== IMAGE UPLOAD FAILED ==========`);
				console.error(`   screenMesh:`, screenMesh);
				console.error(`   screenMesh.material:`, screenMesh?.material);
				console.error(`   model:`, model);
				alert('Screen mesh not found in model. Check console for details.');

			}

		};
		img.onerror = () => {

			console.error('❌ Failed to load image');
			alert('Failed to load image file');

		};
		img.src = e.target.result;

	};
	reader.onerror = () => {

		console.error('❌ Failed to read file');
		alert('Failed to read file');

	};
	reader.readAsDataURL(file);

}


async function updateModel() {

	if (gui) {

		document.body.classList.remove('checkerboard');
		gui.destroy();
		gui = null;

	}

	const modelInfo = models[params.model];

	renderer.domElement.style.visibility = 'hidden';
	loader.setPercentage(0);

	if (model) {

		model.traverse(c => {

			if (c.material) {

				const material = c.material;
				for (const key in material) {

					if (material[key] && material[key].isTexture) {

						material[key].dispose();

					}

				}

			}

		});

		scene.remove(model);
		model = null;

	}

	let loadResult;
	try {

		loadResult = await loadModel(modelInfo.url, v => {

			loader.setPercentage(0.5 * v);

		});

	} catch (err) {

		loader.setCredits('Failed to load model:' + err.message);
		loader.setPercentage(1);
		return;

	}

	// Support both { scene, animations } and legacy plain scene return
	model = loadResult.scene ?? loadResult;
	const animations = loadResult.animations ?? [];

	if (!model) {

		return;

	}

	// update after model load
	// TODO: clean up
	if (modelInfo.removeEmission) {

		model.traverse(c => {

			if (c.material) {

				c.material.emissiveMap = null;
				c.material.emissiveIntensity = 0;

			}

		});

	}

	if (modelInfo.opacityToTransmission) {

		convertOpacityToTransmission(model, modelInfo.ior || 1.5);

	}

	model.traverse(c => {

		if (c.material) {

			// set the thickness so we render the material as a volumetric object
			c.material.thickness = 1.0;

		}

	});

	if (modelInfo.postProcess) {

		modelInfo.postProcess(model);

	}

	// rotate model after so it doesn't affect the bounding sphere scale
	if (modelInfo.rotation) {

		model.rotation.set(...modelInfo.rotation);

	}

	// center the model
	const box = new Box3();
	box.setFromObject(model);
	model.position
		.addScaledVector(box.min, - 0.5)
		.addScaledVector(box.max, - 0.5);

	const sphere = new Sphere();
	box.getBoundingSphere(sphere);

	model.scale.setScalar(1 / sphere.radius);
	model.position.multiplyScalar(1 / sphere.radius);
	box.setFromObject(model);
	floorPlane.position.y = box.min.y;

	scene.add(model);

	// 1. Find all wallpaper meshes BEFORE building the path tracer scene
	wallpaperMeshes = findAllWallpaperMeshes(model);
	console.log('📋 Found wallpapers:', Object.keys(wallpaperMeshes).filter(key => wallpaperMeshes[key] !== null));

	// 2. Find the screen mesh (default to blank_screen)
	screenMesh = wallpaperMeshes['blank_screen'] || findScreenMesh(model);
	if (screenMesh) {

		console.log('✅ Screen mesh found:', screenMesh.name);

	} else {

		console.warn('⚠️ Screen mesh not found - upload may not work');

	}

	// 3. Set wallpaper visibility (hides non-selected wallpapers) BEFORE scene build
	//    This avoids building the BVH twice — once with all visible, then again after hiding.
	currentWallpaper = params.screenWallpaper || 'blank_screen';
	{

		// Inline visibility setup without setSceneAsync (we'll do that once below)
		// Hide all wallpaper meshes first
		model.traverse((child) => {

			if (child.isMesh && child.material) {

				const name = child.name;
				const isWallpaper = /^\d+_/.test(name) || name === 'screen_blank';
				if (isWallpaper) {

					child.visible = false;

				}

			}
			if (child.isGroup && child.name?.toLowerCase() === 'wallpaper') {

				child.visible = false;

			}

		});

		// Show only the selected wallpaper
		const targetMesh = wallpaperMeshes[currentWallpaper];
		if (targetMesh) {

			targetMesh.visible = true;
			// Make parent chain visible
			let parent = targetMesh.parent;
			while (parent && parent !== model) {

				parent.visible = true;
				parent = parent.parent;

			}
			console.log(`✅ Initial wallpaper "${currentWallpaper}" visible: ${targetMesh.name}`);

		} else {

			console.warn(`⚠️ Initial wallpaper "${currentWallpaper}" not found, all wallpapers hidden`);

		}

	}

	// 4. Animation: setup mixer and pose BEFORE building the path tracer scene
	if (animationMixer) {

		animationMixer.stopAllAction();
		animationMixer.uncacheRoot(model);
		animationMixer = null;
		mainAnimAction = null;
		mainAnimClip = null;

	}
	if (animations.length > 0) {

		animationMixer = new AnimationMixer(model);
		const expectedNames = ['mainAnim', 'Animation'];
		let mainClip = animations.find(c => expectedNames.includes(c.name))
			|| animations.find(c => c.name.toLowerCase().includes('main'))
			|| animations[0];
		mainAnimClip = mainClip;
		mainAnimAction = animationMixer.clipAction(mainClip);
		mainAnimAction.play();
		mainAnimAction.paused = true;
		const timeInSeconds = Math.min(params.animationFrame / ANIMATION_FRAME_RATE, mainClip.duration || 5);
		mainAnimAction.time = timeInSeconds;
		params.animationFrame = Math.min(Math.round(timeInSeconds * ANIMATION_FRAME_RATE), ANIMATION_MAX_FRAME);
		animationMixer.update(0);

	}

	// 5. Now build the path tracer scene ONCE with correct visibility + animation pose
	scene.updateMatrixWorld(true);
	await pathTracer.setSceneAsync(scene, activeCamera, {

		onProgress: v => loader.setPercentage(0.5 + 0.5 * v),

	});

	loader.setPercentage(1);
	loader.setCredits(modelInfo.credit || '');
	params.bounces = modelInfo.bounces || 5;
	params.floorColor = modelInfo.floorColor || '#111111';
	params.floorRoughness = modelInfo.floorRoughness || 0.2;
	params.floorMetalness = modelInfo.floorMetalness || 0.2;
	params.bgGradientTop = modelInfo.gradientTop || '#111111';
	params.bgGradientBottom = modelInfo.gradientBot || '#000000';

	buildGui();
	onParamsChange();

	renderer.domElement.style.visibility = 'visible';
	if (params.checkerboardTransparency) {

		document.body.classList.add('checkerboard');

	}

}

async function loadModel(url, onProgress) {

	// TODO: clean up
	const manager = new LoadingManager();
	if (/dae$/i.test(url)) {

		const complete = new Promise(resolve => manager.onLoad = resolve);
		const res = await new ColladaLoader(manager).loadAsync(url, progress => {

			if (progress.total !== 0 && progress.total >= progress.loaded) {

				onProgress(progress.loaded / progress.total);

			}

		});
		await complete;

		res.scene.scale.setScalar(1);
		res.scene.traverse(c => {

			const { material } = c;
			if (material && material.isMeshPhongMaterial) {

				c.material = new MeshStandardMaterial({

					color: material.color,
					roughness: material.roughness || 0,
					metalness: material.metalness || 0,
					map: material.map || null,

				});

			}

		});

		return { scene: res.scene, animations: [] };

	} else if (/(gltf|glb)$/i.test(url)) {

		const dracoLoader = new DRACOLoader(manager);
		dracoLoader.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.7/');

		const complete = new Promise(resolve => manager.onLoad = resolve);
		const gltf = await new GLTFLoader(manager)
			.setDRACOLoader(dracoLoader)
			.setMeshoptDecoder(MeshoptDecoder)
			.loadAsync(url, progress => {

				if (progress.total !== 0 && progress.total >= progress.loaded) {

					onProgress(progress.loaded / progress.total);

				}

			});
		await complete;

		return { scene: gltf.scene, animations: gltf.animations || [] };

	} else if (/mpd$/i.test(url)) {

		manager.onProgress = (url, loaded, total) => {

			onProgress(loaded / total);

		};

		const complete = new Promise(resolve => manager.onLoad = resolve);
		const ldrawLoader = new LDrawLoader(manager);
		ldrawLoader.setConditionalLineMaterial(LDrawConditionalLineMaterial);
		await ldrawLoader.preloadMaterials('https://raw.githubusercontent.com/gkjohnson/ldraw-parts-library/master/colors/ldcfgalt.ldr');
		const result = await ldrawLoader
			.setPartsLibraryPath('https://raw.githubusercontent.com/gkjohnson/ldraw-parts-library/master/complete/ldraw/')
			.loadAsync(url);
		await complete;

		const model = LDrawUtils.mergeObject(result);
		model.rotation.set(Math.PI, 0, 0);

		const toRemove = [];
		model.traverse(c => {

			if (c.isLineSegments) {

				toRemove.push(c);

			}

			if (c.isMesh) {

				c.material.roughness *= 0.25;

			}

		});

		toRemove.forEach(c => {

			c.parent.remove(c);

		});

		return { scene: model, animations: [] };

	}

}
