import { DataTexture, RedFormat, LinearFilter, DataUtils, HalfFloatType, Source, RepeatWrapping, RGBAFormat, FloatType, ClampToEdgeWrapping } from 'three';
import { toHalfFloatArray } from '../utils/TextureUtils.js';

function binarySearchFindClosestIndexOf( array, targetValue, offset = 0, count = array.length ) {

	let lower = offset;
	let upper = offset + count - 1;

	while ( lower < upper ) {

		const mid = ( lower + upper ) >> 1;

		if ( array[ mid ] < targetValue ) {

			lower = mid + 1;

		} else {

			upper = mid;

		}

	}

	return lower - offset;

}

function colorToLuminance( r, g, b ) {

	// https://en.wikipedia.org/wiki/Relative_luminance
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;

}

// ensures the data is all floating point values and flipY is false
function preprocessEnvMap( envMap, targetType = HalfFloatType ) {

	const map = envMap.clone();
	map.source = new Source( { ...map.image } );
	const { width, height, data } = map.image;

	// [FIX 1] Calculate stride dynamically (3 for RGB, 4 for RGBA) to prevent data corruption
	const originalStride = Math.floor( data.length / ( width * height ) );

	// Force copy and sanitization
	let newData;
	const targetStride = originalStride;

	if ( targetType === HalfFloatType ) {

		newData = new Uint16Array( data.length );

	} else {

		newData = new Float32Array( data.length );

	}

	let maxIntValue;
	if ( data instanceof Int8Array || data instanceof Int16Array || data instanceof Int32Array || data instanceof Uint8Array || data instanceof Uint16Array || data instanceof Uint32Array ) {

		maxIntValue = 2 ** ( 8 * data.BYTES_PER_ELEMENT ) - 1;

	} else {

		maxIntValue = 1;

	}

	// [FIX 2] HalfFloat Max Value. Clamp sun to this instead of 0.
	const MAX_HALF_FLOAT = 65504.0;

	for ( let i = 0, l = data.length; i < l; i ++ ) {

		let v = data[ i ];
		if ( map.type === HalfFloatType ) {

			v = DataUtils.fromHalfFloat( data[ i ] );

		}

		if ( map.type !== FloatType && map.type !== HalfFloatType ) {

			v /= maxIntValue;

		}

		// [FIX 2] Robust Sanitization: If Infinity (Sun), clamp to max value. Do not set to 0.
		if ( ! Number.isFinite( v ) ) {

			if ( v > 0 ) v = MAX_HALF_FLOAT;
			else v = 0.0;

		} else if ( v < 0 ) {

			v = 0.0;

		}

		if ( targetType === HalfFloatType ) {

			newData[ i ] = DataUtils.toHalfFloat( v );

		} else {

			newData[ i ] = v;

		}

	}

	map.image.data = newData;
	map.type = targetType;

	// remove any y flipping for cdf computation
	if ( map.flipY ) {

		const ogData = newData;
		newData = newData.slice();
		for ( let y = 0; y < height; y ++ ) {

			for ( let x = 0; x < width; x ++ ) {

				const newY = height - y - 1;
				// [FIX 3] Use calculated stride for flipping logic
				const ogIndex = targetStride * ( y * width + x );
				const newIndex = targetStride * ( newY * width + x );

				for ( let c = 0; c < targetStride; c ++ ) {

					newData[ newIndex + c ] = ogData[ ogIndex + c ];

				}

			}

		}

		map.flipY = false;
		map.image.data = newData;

	}

	return map;

}

export class EquirectHdrInfoUniform {

	constructor() {

		const blackTex = new DataTexture( toHalfFloatArray( new Float32Array( [ 0, 0, 0, 0 ] ) ), 1, 1 );
		blackTex.type = HalfFloatType;
		blackTex.format = RGBAFormat;
		blackTex.minFilter = LinearFilter;
		blackTex.magFilter = LinearFilter;
		blackTex.wrapS = RepeatWrapping;
		blackTex.wrapT = RepeatWrapping;
		blackTex.generateMipmaps = false;
		blackTex.needsUpdate = true;

		const marginalWeights = new DataTexture( toHalfFloatArray( new Float32Array( [ 0, 1 ] ) ), 1, 2 );
		marginalWeights.type = HalfFloatType;
		marginalWeights.format = RedFormat;
		marginalWeights.minFilter = LinearFilter;
		marginalWeights.magFilter = LinearFilter;
		marginalWeights.generateMipmaps = false;
		marginalWeights.needsUpdate = true;

		const conditionalWeights = new DataTexture( toHalfFloatArray( new Float32Array( [ 0, 0, 1, 1 ] ) ), 2, 2 );
		conditionalWeights.type = HalfFloatType;
		conditionalWeights.format = RedFormat;
		conditionalWeights.minFilter = LinearFilter;
		conditionalWeights.magFilter = LinearFilter;
		conditionalWeights.generateMipmaps = false;
		conditionalWeights.needsUpdate = true;

		this.map = blackTex;
		this.marginalWeights = marginalWeights;
		this.conditionalWeights = conditionalWeights;
		this.totalSum = 0;

	}

	dispose() {

		this.marginalWeights.dispose();
		this.conditionalWeights.dispose();
		this.map.dispose();

	}

	updateFrom( hdr ) {

		const map = preprocessEnvMap( hdr );
		map.wrapS = RepeatWrapping;
		map.wrapT = ClampToEdgeWrapping;

		const { width, height, data } = map.image;

		if ( ! width || ! height || ! data ) {

			console.error( 'EquirectHdrInfoUniform: Invalid texture data', map.image );
			return;

		}

		// [FIX 1] Calculate Stride dynamically here as well
		const stride = Math.floor( data.length / ( width * height ) );

		const pdfConditional = new Float32Array( width * height );
		const cdfConditional = new Float32Array( width * height );

		const pdfMarginal = new Float32Array( height );
		const cdfMarginal = new Float32Array( height );

		let totalSumValue = 0.0;
		let cumulativeWeightMarginal = 0.0;
		for ( let y = 0; y < height; y ++ ) {

			let cumulativeRowWeight = 0.0;
			for ( let x = 0; x < width; x ++ ) {

				const i = y * width + x;

				// [FIX 1] Use stride here instead of hardcoded 4
				let r = DataUtils.fromHalfFloat( data[ stride * i + 0 ] );
				let g = DataUtils.fromHalfFloat( data[ stride * i + 1 ] );
				let b = DataUtils.fromHalfFloat( data[ stride * i + 2 ] );

				// Redundant safety check (already handled in preprocess, but good for safety)
				if ( ! Number.isFinite( r ) || r < 0 ) {

					r = 0;

				}

				if ( ! Number.isFinite( g ) || g < 0 ) {

					g = 0;

				}

				if ( ! Number.isFinite( b ) || b < 0 ) {

					b = 0;

				}

				let weight = colorToLuminance( r, g, b );
				if ( ! Number.isFinite( weight ) || weight < 0 ) weight = 0;
				cumulativeRowWeight += weight;
				totalSumValue += weight;

				pdfConditional[ i ] = weight;
				cdfConditional[ i ] = cumulativeRowWeight;

			}

			if ( cumulativeRowWeight !== 0 ) {

				for ( let i = y * width, l = y * width + width; i < l; i ++ ) {

					pdfConditional[ i ] /= cumulativeRowWeight;
					cdfConditional[ i ] /= cumulativeRowWeight;

				}

			}

			cumulativeWeightMarginal += cumulativeRowWeight;

			pdfMarginal[ y ] = cumulativeRowWeight;
			cdfMarginal[ y ] = cumulativeWeightMarginal;

		}

		if ( cumulativeWeightMarginal !== 0 ) {

			for ( let i = 0, l = pdfMarginal.length; i < l; i ++ ) {

				pdfMarginal[ i ] /= cumulativeWeightMarginal;
				cdfMarginal[ i ] /= cumulativeWeightMarginal;

			}

		}

		const marginalDataArray = new Uint16Array( height );
		const conditionalDataArray = new Uint16Array( width * height );

		for ( let i = 0; i < height; i ++ ) {

			const dist = ( i + 1 ) / height;
			const row = binarySearchFindClosestIndexOf( cdfMarginal, dist );
			marginalDataArray[ i ] = DataUtils.toHalfFloat( ( row + 0.5 ) / height );

		}

		for ( let y = 0; y < height; y ++ ) {

			for ( let x = 0; x < width; x ++ ) {

				const i = y * width + x;
				const dist = ( x + 1 ) / width;
				const col = binarySearchFindClosestIndexOf( cdfConditional, dist, y * width, width );
				conditionalDataArray[ i ] = DataUtils.toHalfFloat( ( col + 0.5 ) / width );

			}

		}

		this.dispose();

		const { marginalWeights, conditionalWeights } = this;
		marginalWeights.image = { width: height, height: 1, data: marginalDataArray };
		marginalWeights.needsUpdate = true;

		conditionalWeights.image = { width, height, data: conditionalDataArray };
		conditionalWeights.needsUpdate = true;

		this.totalSum = Number.isFinite( totalSumValue ) ? totalSumValue : 0;

		if ( this.totalSum === 0 ) {

			console.warn( 'EquirectHdrInfoUniform: totalSum is 0. The environment map appears to be black or empty.', { width, height } );

		}

		this.map = map;

	}

}
