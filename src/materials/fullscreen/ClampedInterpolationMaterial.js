import { ShaderMaterial } from 'three';

// Material that tone maps a texture before performing interpolation to prevent
// unexpected high values during texture stretching interpolation.
// Emulates browser image stretching
export class ClampedInterpolationMaterial extends ShaderMaterial {

	get map() {

		return this.uniforms.map.value;

	}

	set map( v ) {

		this.uniforms.map.value = v;

	}

	get opacity() {

		return this.uniforms.opacity.value;

	}

	set opacity( v ) {

		if ( this.uniforms ) {

			this.uniforms.opacity.value = v;

		}

	}

	get saturation() {

		return this.uniforms?.saturation?.value ?? 1;

	}

	set saturation( v ) {

		if ( this.uniforms?.saturation ) this.uniforms.saturation.value = v;

	}

	get contrast() {

		return this.uniforms?.contrast?.value ?? 1;

	}

	set contrast( v ) {

		if ( this.uniforms?.contrast ) this.uniforms.contrast.value = v;

	}

	constructor( params ) {

		super( {
			uniforms: {

				map: { value: null },
				opacity: { value: 1 },
				saturation: { value: 1 },
				contrast: { value: 1 },

			},

			vertexShader: /* glsl */`
				varying vec2 vUv;
				void main() {

					vUv = uv;
					gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );

				}
			`,

			fragmentShader: /* glsl */`
				uniform sampler2D map;
				uniform float opacity;
				uniform float saturation;
				uniform float contrast;
				varying vec2 vUv;

				vec4 clampedTexelFatch( sampler2D map, ivec2 px, int lod ) {

					vec4 res = texelFetch( map, ivec2( px.x, px.y ), 0 );

					#if defined( TONE_MAPPING )

					res.xyz = toneMapping( res.xyz );

					#endif

			  		return linearToOutputTexel( res );

				}

				void main() {

					vec2 size = vec2( textureSize( map, 0 ) );
					vec2 pxUv = vUv * size;
					vec2 pxCurr = floor( pxUv );
					vec2 pxFrac = fract( pxUv ) - 0.5;
					vec2 pxOffset;
					pxOffset.x = pxFrac.x > 0.0 ? 1.0 : - 1.0;
					pxOffset.y = pxFrac.y > 0.0 ? 1.0 : - 1.0;

					vec2 pxNext = clamp( pxOffset + pxCurr, vec2( 0.0 ), size - 1.0 );
					vec2 alpha = abs( pxFrac );

					vec4 p1 = mix(
						clampedTexelFatch( map, ivec2( pxCurr.x, pxCurr.y ), 0 ),
						clampedTexelFatch( map, ivec2( pxNext.x, pxCurr.y ), 0 ),
						alpha.x
					);

					vec4 p2 = mix(
						clampedTexelFatch( map, ivec2( pxCurr.x, pxNext.y ), 0 ),
						clampedTexelFatch( map, ivec2( pxNext.x, pxNext.y ), 0 ),
						alpha.x
					);

					gl_FragColor = mix( p1, p2, alpha.y );

					// product saturation (1 = unchanged, 0 = grayscale, >1 = more vivid)
					float lum = dot( gl_FragColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) );
					gl_FragColor.rgb = mix( vec3( lum ), gl_FragColor.rgb, saturation );

					// product contrast (1 = unchanged, >1 = more contrast)
					gl_FragColor.rgb = ( gl_FragColor.rgb - 0.5 ) * contrast + 0.5;
					gl_FragColor.rgb = clamp( gl_FragColor.rgb, 0.0, 1.0 );

					gl_FragColor.a *= opacity;
					// Output straight alpha (no premultiply) so canvas and PNG export match viewer expectations.

				}
			`
		} );

		this.setValues( params );

	}

}
