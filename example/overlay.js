import {
	ACESFilmicToneMapping,
	Box3,
	BoxGeometry,
	Color,
	CylinderGeometry,
	EquirectangularReflectionMapping,
	Mesh,
	MeshBasicMaterial,
	MeshStandardMaterial,
	PerspectiveCamera,
	Scene,
	WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { WebGLPathTracer } from '../src/index.js';
import { HDRLoader } from 'three/examples/jsm/loaders/HDRLoader.js';
import { GUI } from 'three/examples/jsm/libs/lil-gui.module.min.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { ParallelMeshBVHWorker } from 'three-mesh-bvh/worker';
import { getScaledSettings } from './utils/getScaledSettings.js';
import { LoaderElement } from './utils/LoaderElement.js';
import { MODEL_LIST, DEFAULT_MODEL_KEY } from './utils/modelList.js';

const ENV_URL = 'https://raw.githubusercontent.com/mrdoob/three.js/r150/examples/textures/equirectangular/royal_esplanade_1k.hdr';

let pathTracer, renderer, controls, scene, camera;
let overlayScene, floatingObjects, currentModel = null;
let loader;

const params = {

	model: DEFAULT_MODEL_KEY,
	// path tracer settings
	bounces: 5,
	renderScale: 1 / window.devicePixelRatio,
	filterGlossyFactor: 0.5,
	tiles: 1,
	multipleImportanceSampling: true,

	enabled: true,

	...getScaledSettings(),

};

init();

async function init() {

	loader = new LoaderElement();
	loader.attach( document.body );

	// renderer
	renderer = new WebGLRenderer( { antialias: true } );
	renderer.toneMapping = ACESFilmicToneMapping;
	document.body.appendChild( renderer.domElement );

	// path tracer
	pathTracer = new WebGLPathTracer( renderer );
	pathTracer.tiles.set( params.tiles, params.tiles );
	pathTracer.setBVHWorker( new ParallelMeshBVHWorker() );

	// camera
	camera = new PerspectiveCamera( 75, window.innerWidth / window.innerHeight, 0.025, 500 );
	camera.position.set( 2.996, 3.795, 0.697 );

	// controls
	controls = new OrbitControls( camera, renderer.domElement );
	controls.target.set( 0.311, 1.13, 0.489 );
	controls.addEventListener( 'change', () => pathTracer.updateCamera() );
	controls.update();

	// init scene
	scene = new Scene();

	// init overlayScene
	overlayScene = new Scene();

	// load the env
	const envTexture = await new HDRLoader().loadAsync( ENV_URL );
	envTexture.mapping = EquirectangularReflectionMapping;
	scene.background = envTexture;
	scene.environment = envTexture;

	async function loadAndSetModel( modelKey ) {

		const entry = MODEL_LIST[ modelKey ];
		if ( ! entry || ! entry.url ) return;
		if ( currentModel ) scene.remove( currentModel );
		loader.setPercentage( 0 );
		const dracoLoader = new DRACOLoader();
		dracoLoader.setDecoderPath( 'https://www.gstatic.com/draco/versioned/decoders/1.5.7/' );
		const gltf = await new GLTFLoader()
			.setDRACOLoader( dracoLoader )
			.setMeshoptDecoder( MeshoptDecoder )
			.loadAsync( entry.url );
		dracoLoader.dispose();
		const model = gltf.scene;
		if ( entry.postProcess ) entry.postProcess( model );
		model.traverse( c => {

			if ( c.material ) c.material.map = null;

		} );
		model.updateMatrixWorld( true );
		const box = new Box3();
		box.setFromObject( model );
		model.position.y -= box.min.y;
		scene.add( model );
		currentModel = model;
		scene.updateMatrixWorld( true );
		await pathTracer.setSceneAsync( scene, camera, { onProgress: v => loader.setPercentage( v ) } );
		loader.setCredits( entry.credit || '' );

	}

	await loadAndSetModel( params.model );

	// set the floor
	const floorGeom = new CylinderGeometry( 3.5, 3.5, 0.05, 60 );
	const floorMat = new MeshStandardMaterial( { color: new Color( 0x999999 ), metalness: 0.2, roughness: 0.02 } );
	const floor = new Mesh( floorGeom, floorMat );
	floor.position.y = - 0.025;
	scene.add( floor );

	// set floating Objects
	floatingObjects = [];
	const sampleMesh = new Mesh( new CylinderGeometry( 0.5, 0.5, 0.5, 32 ), new MeshBasicMaterial( { color: 0xff0000 } ) );
	const sampleMesh2 = new Mesh( new BoxGeometry( 0.3, 0.3, 0.3 ), new MeshBasicMaterial( { color: 0x00ff00 } ) );
	sampleMesh.position.set( - 1, 0, 1 );
	sampleMesh2.position.set( 1, 0, - 1 );
	floatingObjects.push( sampleMesh, sampleMesh2 );
	overlayScene.add( sampleMesh, sampleMesh2 );

	// initialize scene
	await pathTracer.setSceneAsync( scene, camera, {
		onProgress: v => {

			loader.setPercentage( v );

		}
	} );

	// gui
	const gui = new GUI();
	gui.add( params, 'model', Object.keys( MODEL_LIST ).sort() ).onChange( async ( v ) => {

		await loadAndSetModel( v );

	} );
	const ptFolder = gui.addFolder( 'Path Tracer' );
	ptFolder.add( params, 'tiles', 1, 4, 1 ).onChange( value => {

		pathTracer.tiles.set( value, value );

	} );
	ptFolder.add( params, 'filterGlossyFactor', 0, 1 ).onChange( onParamsChange );
	ptFolder.add( params, 'bounces', 1, 15, 1 ).onChange( onParamsChange );
	ptFolder.add( params, 'renderScale', 0.1, 1 ).onChange( onParamsChange );
	ptFolder.add( params, 'multipleImportanceSampling' ).onChange( onParamsChange );
	ptFolder.close();

	onParamsChange();
	onResize();
	window.addEventListener( 'resize', onResize );

	animate();

}

function onParamsChange() {

	pathTracer.filterGlossyFactor = params.filterGlossyFactor;
	pathTracer.bounces = params.bounces;
	pathTracer.renderScale = params.renderScale;
	pathTracer.multipleImportanceSampling = params.multipleImportanceSampling;

}

function onResize() {

	renderer.setSize( window.innerWidth, window.innerHeight );
	renderer.setPixelRatio( window.devicePixelRatio );
	camera.aspect = window.innerWidth / window.innerHeight;
	camera.updateProjectionMatrix();

	pathTracer.updateCamera();

}

// it's a dummy material for rendering depth only
const depthMaterial = new MeshBasicMaterial( { colorWrite: false } );

function updateFloatingObjects() {

	for ( let i = 0; i < floatingObjects.length; i ++ ) {

		const obj = floatingObjects[ i ];
		// controlled y value by sin value
		obj.position.y = Math.sin( Date.now() * 0.001 + i );

	}

}

function animate() {

	requestAnimationFrame( animate );

	updateFloatingObjects();
	pathTracer.renderSample();

	const originalAutoClear = renderer.autoClear;
	const originalBackground = scene.background;
	renderer.autoClear = false;
	scene.background = null;
	scene.overrideMaterial = depthMaterial;
	renderer.clearDepth();
	// render depth of the scene
	renderer.render( scene, camera );
	scene.overrideMaterial = null;
	scene.background = originalBackground;

	// render real time floating objects
	renderer.render( overlayScene, camera );
	renderer.autoClear = originalAutoClear;

	loader.setSamples( pathTracer.samples, pathTracer.isCompiling );

}
