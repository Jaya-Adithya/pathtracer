import {
	ACESFilmicToneMapping,
	Scene,
	EquirectangularReflectionMapping,
	WebGLRenderer,
	PerspectiveCamera,
	CubeTextureLoader,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { HDRLoader } from 'three/examples/jsm/loaders/HDRLoader.js';
import { ParallelMeshBVHWorker } from 'three-mesh-bvh/worker';
import { getScaledSettings } from './utils/getScaledSettings.js';
import { LoaderElement } from './utils/LoaderElement.js';
import { MODEL_LIST, DEFAULT_MODEL_KEY } from './utils/modelList.js';
import { WebGLPathTracer } from '..';
import { GUI } from 'three/examples/jsm/libs/lil-gui.module.min.js';

const ENV_URL = 'https://raw.githubusercontent.com/gkjohnson/3d-demo-data/master/hdri/chinese_garden_1k.hdr';
const DESCRIPTION = 'Simple path tracing example scene setup with background blur.';

let pathTracer, renderer, controls;
let camera, scene, currentModel = null;
let loader;
const params = { model: DEFAULT_MODEL_KEY };

init();

async function init() {

	const { tiles, renderScale } = getScaledSettings();

	loader = new LoaderElement();
	loader.attach( document.body );

	// renderer
	renderer = new WebGLRenderer( { antialias: true } );
	renderer.toneMapping = ACESFilmicToneMapping;
	document.body.appendChild( renderer.domElement );

	// path tracer
	pathTracer = new WebGLPathTracer( renderer );
	pathTracer.filterGlossyFactor = 0.5;
	pathTracer.renderScale = renderScale;
	pathTracer.tiles.set( tiles, tiles );
	pathTracer.setBVHWorker( new ParallelMeshBVHWorker() );

	// camera
	camera = new PerspectiveCamera( 75, 1, 0.025, 500 );
	camera.position.set( 8, 9, 24 );

	// scene
	scene = new Scene();
	scene.backgroundBlurriness = 0.05;

	// controls
	controls = new OrbitControls( camera, renderer.domElement );
	controls.target.y = 10;
	controls.addEventListener( 'change', () => pathTracer.updateCamera() );
	controls.update();

	// load the appropriate env
	let envPromise;
	if ( window.location.hash.includes( 'cube' ) ) {

		const path = 'https://raw.githubusercontent.com/mrdoob/three.js/master/examples/textures/cube/SwedishRoyalCastle/';
		const format = '.jpg';
		const envUrls = [
			path + 'px' + format, path + 'nx' + format,
			path + 'py' + format, path + 'ny' + format,
			path + 'pz' + format, path + 'nz' + format
		];
		envPromise = new CubeTextureLoader().loadAsync( envUrls );

		scene.environmentIntensity = 5;
		scene.backgroundIntensity = 5;

	} else {

		envPromise = new HDRLoader().loadAsync( ENV_URL ).then( tex => {

			tex.mapping = EquirectangularReflectionMapping;
			return tex;

		} );

	}

	const envTexture = await envPromise;
	scene.background = envTexture;
	scene.environment = envTexture;

	async function loadAndSetModel( modelKey ) {

		const entry = MODEL_LIST[ modelKey ];
		if ( ! entry || ! entry.url ) return;
		if ( currentModel ) scene.remove( currentModel );
		loader.setPercentage( 0 );
		const dracoLoader = new DRACOLoader();
		dracoLoader.setDecoderPath( 'https://www.gstatic.com/draco/versioned/decoders/1.5.7/' );
		const gltf = await new GLTFLoader().setDRACOLoader( dracoLoader ).loadAsync( entry.url );
		dracoLoader.dispose();
		const model = gltf.scene;
		if ( entry.postProcess ) entry.postProcess( model );
		scene.add( model );
		currentModel = model;
		scene.updateMatrixWorld( true );
		await pathTracer.setSceneAsync( scene, camera, { onProgress: v => loader.setPercentage( v ) } );
		loader.setCredits( entry.credit || '' );
	}

	await loadAndSetModel( params.model );

	loader.setDescription( DESCRIPTION );
	window.addEventListener( 'resize', onResize );

	const gui = new GUI();
	gui.add( params, 'model', Object.keys( MODEL_LIST ).sort() ).onChange( async ( v ) => { await loadAndSetModel( v ); } );

	onResize();
	animate();

}

function onResize() {

	// update resolution
	renderer.setSize( window.innerWidth, window.innerHeight );
	renderer.setPixelRatio( window.devicePixelRatio );

	camera.aspect = window.innerWidth / window.innerHeight;
	camera.updateProjectionMatrix();

	// update camera
	pathTracer.updateCamera();

}

function animate() {

	requestAnimationFrame( animate );

	pathTracer.renderSample();

	loader.setSamples( pathTracer.samples, pathTracer.isCompiling );

}
