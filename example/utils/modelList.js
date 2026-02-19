/**
 * Shared model list for all examples. Import this to get the same GLB/model options as the main index.
 * Asset paths are relative to this file (example/utils/), so ../assets/ points to example/assets/.
 */
import { MeshPhysicalMaterial, Color, DoubleSide, Mesh, CylinderGeometry, Box3 } from 'three';
import { FogVolumeMaterial } from '../../src/index.js';

function assetUrl( path ) {

	return new URL( path, import.meta.url ).href;

}

export const MODEL_LIST = {
	'HP Blank Screen': {
		url: assetUrl( '../assets/HP_IN_Blank screen.glb' ),
		credit: 'Custom Model',
	},
	'Flexera Studio': {
		url: assetUrl( '../assets/Flexera_Studio_4.glb' ),
		credit: 'Custom Model',
	},
	'Flexera Folding': {
		url: assetUrl( '../assets/Flexera_Folding_studioX_01.glb' ),
		credit: 'Custom Model',
	},
	'Flexera Folding PT New': {
		url: assetUrl( '../assets/Flexera_Folding_PT_V2.glb' ),
		credit: 'Custom Model',
	},
	'Flexera Studio Wood Sring PT': {
		url: assetUrl( '../assets/Flexera_Studio_Wood_Spring_PT.glb' ),
		credit: 'Custom Model',
	},
	

	'Flexera PT V3': {
		url: assetUrl( 'https://flexera-studio-assets.s3.us-east-1.amazonaws.com/Flexera_Folding_PT_V3.glb' ),
		credit: 'Custom Model',
	},
	
	'Flexera PT V4': {
		url: assetUrl( '../assets/Flexera_Folding_PT_V3-2.glb' ),
		credit: 'Custom Model',
	},
	'ITUS': {
		url: assetUrl( '../assets/ITUS_3.glb' ),
		credit: 'Custom Model',
	},
	'ASUS P5 V5': {
		url: assetUrl( '../assets/ASUS_P5_V5_noLogo.glb' ),
		credit: 'Custom Model',
	},
	'Headphone Static': {
		url: assetUrl( '../assets/Headphone_Static.glb' ),
		credit: 'Custom Model',
	},
	'Flexera Folding V5': {
		url: assetUrl( '../assets/Flexera_Folding_PT_V5.glb' ),
		credit: 'Custom Model',
	},
	'M2020 Rover': {
		url: 'https://raw.githubusercontent.com/gkjohnson/3d-demo-data/main/models/nasa-m2020/Perseverance.glb',
		credit: 'Model credit NASA / JPL-Caltech',
	},
	'M2020 Helicopter': {
		url: 'https://raw.githubusercontent.com/gkjohnson/3d-demo-data/main/models/nasa-m2020/Ingenuity.glb',
		credit: 'Model credit NASA / JPL-Caltech',
	},
	'Stalenhag Winter': {
		url: 'https://raw.githubusercontent.com/gkjohnson/3d-demo-data/main/models/colourdrafts/scene.glb',
		credit: 'Model by "ganzhugav" on Sketchfab',
		bounces: 3,
		postProcess( model ) {
			const box = new Box3();
			box.setFromObject( model );
			const fog = new Mesh( new CylinderGeometry( 0.5, 0.5, 1, 20 ), new FogVolumeMaterial( { color: 0xaaaaaa, density: 1 } ) );
			fog.scale.subVectors( box.max, box.min );
			fog.scale.x += 0.1;
			fog.scale.y += 0.01;
			fog.scale.z += 0.1;
			fog.scale.x = fog.scale.z = Math.max( fog.scale.x, fog.scale.z );
			box.getCenter( fog.position );
			fog.position.y += 0.02;
			model.traverse( c => {
				if ( c.material && c.material.emissive.r < 0.1 ) c.material.emissive.set( 0 );
			} );
			model.add( fog );
		},
	},
	'Gelatinous Cube': {
		url: 'https://raw.githubusercontent.com/gkjohnson/3d-demo-data/main/models/gelatinous-cube/scene.gltf',
		credit: 'Model by "glenatron" on Sketchfab.',
		rotation: [ 0, - Math.PI / 8, 0.0 ],
		opacityToTransmission: true,
		bounces: 8,
		postProcess( model ) {
			const toRemove = [];
			model.traverse( c => {
				if ( c.material ) {
					if ( c.material instanceof MeshPhysicalMaterial ) {
						const material = c.material;
						material.metalness = 0.0;
						material.ior = 1.2;
						material.map = null;
						c.geometry.computeVertexNormals();
					} else if ( c.material.opacity < 1.0 ) toRemove.push( c );
				}
			} );
			toRemove.forEach( c => c.parent.remove( c ) );
		},
	},
	'Octopus Tea': {
		url: 'https://raw.githubusercontent.com/gkjohnson/3d-demo-data/main/models/octopus-tea/scene.gltf',
		credit: 'Model by "AzTiZ" on Sketchfab.',
		opacityToTransmission: true,
		bounces: 8,
		postProcess( model ) {
			const toRemove = [];
			model.updateMatrixWorld();
			model.traverse( c => {
				if ( c.material ) {
					c.material.emissiveIntensity = 0;
					if ( c.material instanceof MeshPhysicalMaterial ) {
						const material = c.material;
						material.metalness = 0.0;
						if ( material.transmission === 1.0 ) {
							material.roughness = 0.0;
							material.metalness = 0.0;
							if ( c.name.includes( '29' ) ) {
								material.ior = 1.52;
								material.color.set( 0xffffff );
							} else material.ior = 1.2;
						}
					} else if ( c.material.opacity < 1.0 ) toRemove.push( c );
				}
			} );
			toRemove.forEach( c => c.parent.remove( c ) );
		},
	},
	'Scifi Toad': {
		url: 'https://raw.githubusercontent.com/gkjohnson/3d-demo-data/main/models/scifi-toad/scene.gltf',
		credit: 'Model by "YuryTheCreator" on Sketchfab.',
		opacityToTransmission: true,
		bounces: 8,
		postProcess( model ) {
			model.traverse( c => {
				if ( c.material && c.material instanceof MeshPhysicalMaterial ) {
					const material = c.material;
					material.metalness = 0.0;
					material.ior = 1.645;
					material.color.lerp( new Color( 0xffffff ), 0.65 );
				}
			} );
		},
	},
	'Halo Twist Ring': {
		url: 'https://raw.githubusercontent.com/gkjohnson/3d-demo-data/main/models/ring-twist-halo/scene.glb',
		credit: 'Model credit NASA / JPL-Caltech',
		opacityToTransmission: true,
		bounces: 15,
		postProcess( model ) {
			model.traverse( c => {
				if ( c.material && c.material instanceof MeshPhysicalMaterial && c.material.transmission === 1.0 ) {
					const material = c.material;
					material.metalness = 0.0;
					material.ior = 1.8;
					material.color.set( 0xffffff );
				}
			} );
		},
	},
	'Damaged Helmet': {
		url: 'https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Models/master/2.0/DamagedHelmet/glTF/DamagedHelmet.gltf',
		credit: 'glTF Sample Model.',
	},
	'Flight Helmet': {
		url: 'https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Models/master/2.0/FlightHelmet/glTF/FlightHelmet.gltf',
		credit: 'glTF Sample Model.',
	},
	'Statue': {
		url: 'https://raw.githubusercontent.com/gkjohnson/3d-demo-data/main/models/threedscans/Le_Transi_De_Rene_De_Chalon.glb',
		credit: 'Model courtesy of threedscans.com.',
	},
	'Crab Sculpture': {
		url: 'https://raw.githubusercontent.com/gkjohnson/3d-demo-data/main/models/threedscans/Crab.glb',
		rotation: [ - 2 * Math.PI / 4, 0, 0 ],
		credit: 'Model courtesy of threedscans.com.',
		bounces: 15,
		floorColor: '#eeeeee',
		floorRoughness: 1.0,
		floorMetalness: 0.0,
		gradientTop: '#eeeeee',
		gradientBot: '#eeeeee',
		postProcess( model ) {
			const mat = new MeshPhysicalMaterial( {
				roughness: 0.05,
				transmission: 1,
				ior: 1.2,
				attenuationDistance: 0.06,
				attenuationColor: 0x46dfea,
			} );
			model.traverse( c => { if ( c.material ) c.material = mat; } );
		},
	},
	'Elbow Crab Sculpture': {
		url: 'https://raw.githubusercontent.com/gkjohnson/3d-demo-data/main/models/threedscans/Elbow_Crab.glb',
		rotation: [ 2.5 * Math.PI / 4, Math.PI, 0 ],
		credit: 'Model courtesy of threedscans.com.',
		bounces: 15,
		floorColor: '#eeeeee',
		floorRoughness: 1.0,
		floorMetalness: 0.0,
		gradientTop: '#eeeeee',
		gradientBot: '#eeeeee',
		postProcess( model ) {
			const mat = new MeshPhysicalMaterial( {
				color: 0xcc8888,
				roughness: 0.25,
				transmission: 1,
				ior: 1.5,
				side: DoubleSide,
			} );
			model.traverse( c => { if ( c.material ) c.material = mat; } );
		},
	},
	'Japanese Bridge Garden': {
		url: 'https://raw.githubusercontent.com/gkjohnson/3d-demo-data/main/models/japanese-bridge-garden/scene.glb',
		credit: 'Model by "kristenlee" on Sketchfab.',
	},
	'Imaginary Friend Room': {
		url: 'https://raw.githubusercontent.com/gkjohnson/3d-demo-data/main/models/imaginary-friend-room/scene.glb',
		credit: 'Model by "Iman Aliakbar" on Sketchfab.',
	},
	'Botanists Study': {
		url: 'https://raw.githubusercontent.com/gkjohnson/3d-demo-data/main/models/botanists-study/scene.gltf',
		credit: 'Model by "riikkakilpelainen" on Sketchfab.',
	},
	'Botanists Greenhouse': {
		url: 'https://raw.githubusercontent.com/gkjohnson/3d-demo-data/main/models/botanists-greenhouse/scene.gltf',
		credit: 'Model by "riikkakilpelainen" on Sketchfab.',
	},
	'Low Poly Rocket': {
		url: 'https://raw.githubusercontent.com/gkjohnson/3d-demo-data/main/models/lowpoly-space/space_exploration.glb',
		credit: 'Model by "The Sinking Sun" on Sketchfab',
		rotation: [ 0, - Math.PI / 3, 0.0 ],
	},
	'Astraia': {
		url: 'https://raw.githubusercontent.com/gkjohnson/3d-demo-data/main/models/astraia/scene.gltf',
		credit: 'Model by "Quentin Otani" on Sketchfab',
		removeEmission: true,
		postProcess( model ) {
			const toRemove = [];
			model.traverse( c => { if ( c.name.includes( 'ROND' ) ) toRemove.push( c ); } );
			toRemove.forEach( c => c.parent.remove( c ) );
		},
	},
};

/** Default model key when no hash or invalid selection (prefer custom models first). */
export const DEFAULT_MODEL_KEY = 'Headphone Static' in MODEL_LIST ? 'Headphone Static' : Object.keys( MODEL_LIST )[ 0 ];
