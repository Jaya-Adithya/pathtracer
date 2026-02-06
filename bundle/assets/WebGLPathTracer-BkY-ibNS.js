import{a as F,R as k,F as w,E as R,G as C,K as q,o as x,V as M,aq as H,C as E,t as N,aS as z,W as V,D as _,H as D,aT as W,aH as O,aL as U,aw as j,a5 as X,aU as $,aV as K}from"./MaterialBase-D0apYRZI.js";import{F as G,P as Q,h as Y,j as J,k as Z}from"./pcg.glsl-D_3-p9wz.js";import{a as I}from"./PathTracingRenderer-CqRsglCw.js";import{u as ee}from"./ggx_functions.glsl-Bslli_qd.js";const v=new M,A=new M,y=new H,T=new E;class te extends F{constructor(e=512,t=512){super(new Float32Array(e*t*4),e,t,k,w,R,C,q,x,x),this.generationCallback=null}update(){this.dispose(),this.needsUpdate=!0;const{data:e,width:t,height:r}=this.image;for(let i=0;i<t;i++)for(let a=0;a<r;a++){A.set(t,r),v.set(i/t,a/r),v.x-=.5,v.y=1-v.y,y.theta=v.x*2*Math.PI,y.phi=v.y*Math.PI,y.radius=1,this.generationCallback(y,v,A,T);const n=4*(a*t+i);e[n+0]=T.r,e[n+1]=T.g,e[n+2]=T.b,e[n+3]=1}}copy(e){return super.copy(e),this.generationCallback=e.generationCallback,this}}const B=new N;class ae extends te{constructor(e=512){super(e,e),this.topColor=new E().set(16777215),this.bottomColor=new E().set(0),this.exponent=2,this.generationCallback=(t,r,i,a)=>{B.setFromSpherical(t);const s=B.y*.5+.5;a.lerpColors(this.bottomColor,this.topColor,s**this.exponent)}}copy(e){return super.copy(e),this.topColor.copy(e.topColor),this.bottomColor.copy(e.bottomColor),this}}class re extends z{get map(){return this.uniforms.map.value}set map(e){this.uniforms.map.value=e}get opacity(){return this.uniforms.opacity.value}set opacity(e){this.uniforms&&(this.uniforms.opacity.value=e)}get saturation(){var e,t;return((t=(e=this.uniforms)==null?void 0:e.saturation)==null?void 0:t.value)??1}set saturation(e){var t;(t=this.uniforms)!=null&&t.saturation&&(this.uniforms.saturation.value=e)}get contrast(){var e,t;return((t=(e=this.uniforms)==null?void 0:e.contrast)==null?void 0:t.value)??1}set contrast(e){var t;(t=this.uniforms)!=null&&t.contrast&&(this.uniforms.contrast.value=e)}constructor(e){super({uniforms:{map:{value:null},opacity:{value:1},saturation:{value:1},contrast:{value:1}},vertexShader:`
				varying vec2 vUv;
				void main() {

					vUv = uv;
					gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );

				}
			`,fragmentShader:`
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
					#include <premultiplied_alpha_fragment>

				}
			`}),this.setValues(e)}}class ie extends z{constructor(){super({uniforms:{envMap:{value:null},flipEnvMap:{value:-1}},vertexShader:`
				varying vec2 vUv;
				void main() {

					vUv = uv;
					gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );

				}`,fragmentShader:`
				#define ENVMAP_TYPE_CUBE_UV

				uniform samplerCube envMap;
				uniform float flipEnvMap;
				varying vec2 vUv;

				#include <common>
				#include <cube_uv_reflection_fragment>

				${ee}

				void main() {

					vec3 rayDirection = equirectUvToDirection( vUv );
					rayDirection.x *= flipEnvMap;
					gl_FragColor = textureCube( envMap, rayDirection );

				}`}),this.depthWrite=!1,this.depthTest=!1}}class P{constructor(e){this._renderer=e,this._quad=new G(new ie)}generate(e,t=null,r=null){if(!e.isCubeTexture)throw new Error("CubeToEquirectMaterial: Source can only be cube textures.");const i=e.images[0],a=this._renderer,s=this._quad;t===null&&(t=4*i.height),r===null&&(r=2*i.height);const n=new V(t,r,{type:w,colorSpace:i.colorSpace}),l=i.height,u=Math.log2(l)-2,c=1/l,h=1/(3*Math.max(Math.pow(2,u),112));s.material.defines.CUBEUV_MAX_MIP=`${u}.0`,s.material.defines.CUBEUV_TEXEL_WIDTH=h,s.material.defines.CUBEUV_TEXEL_HEIGHT=c,s.material.uniforms.envMap.value=e,s.material.uniforms.flipEnvMap.value=e.isRenderTargetTexture?1:-1,s.material.needsUpdate=!0;const d=a.getRenderTarget(),m=a.autoClear;a.autoClear=!0,a.setRenderTarget(n),s.render(a),a.setRenderTarget(d),a.autoClear=m;const o=new Uint16Array(t*r*4),S=new Float32Array(t*r*4);a.readRenderTargetPixels(n,0,0,t,r,S),n.dispose();for(let b=0,L=S.length;b<L;b++)o[b]=_.toHalfFloat(S[b]);const g=new F(o,t,r,k,D);return g.minFilter=W,g.magFilter=x,g.wrapS=C,g.wrapT=C,g.mapping=R,g.needsUpdate=!0,g}dispose(){this._quad.dispose()}}function se(p){return p.extensions.get("EXT_float_blend")}const f=new M;class ue{get multipleImportanceSampling(){return!!this._pathTracer.material.defines.FEATURE_MIS}set multipleImportanceSampling(e){this._pathTracer.material.setDefine("FEATURE_MIS",e?1:0)}get transmissiveBounces(){return this._pathTracer.material.transmissiveBounces}set transmissiveBounces(e){this._pathTracer.material.transmissiveBounces=e}get bounces(){return this._pathTracer.material.bounces}set bounces(e){this._pathTracer.material.bounces=e}get filterGlossyFactor(){return this._pathTracer.material.filterGlossyFactor}set filterGlossyFactor(e){this._pathTracer.material.filterGlossyFactor=e}get samples(){return this._pathTracer.samples}get target(){return this._pathTracer.target}get tiles(){return this._pathTracer.tiles}get stableNoise(){return this._pathTracer.stableNoise}set stableNoise(e){this._pathTracer.stableNoise=e}get isCompiling(){return!!this._pathTracer.isCompiling}get productSaturation(){return this._quad.material.saturation}set productSaturation(e){this._quad.material.saturation=e}get productContrast(){return this._quad.material.contrast}set productContrast(e){this._quad.material.contrast=e}constructor(e){this._renderer=e,this._generator=new Q,this._pathTracer=new I(e),this._queueReset=!1,this._clock=new O,this._compilePromise=null,this._lowResPathTracer=new I(e),this._lowResPathTracer.tiles.set(1,1),this._quad=new G(new re({map:null,transparent:!0,blending:U,premultipliedAlpha:e.getContextAttributes().premultipliedAlpha})),this._materials=null,this._previousEnvironment=null,this._previousBackground=null,this._internalBackground=null,this._rasterEnvMap=null,this._previousRasterEnvMapSource=null,this._rasterEnvMapScheduled=!1,this._pendingMaterialIndexUpdate=null,this._pendingGeometry=null,this.renderDelay=100,this.minSamples=5,this.fadeDuration=500,this.enablePathTracing=!0,this.pausePathTracing=!1,this.dynamicLowRes=!1,this.lowResScale=.25,this.renderScale=1,this.synchronizeRenderSize=!0,this.rasterizeScene=!0,this.renderToCanvas=!0,this.textureSize=new M(1024,1024),this.rasterizeSceneCallback=(t,r)=>{this._renderer.render(t,r)},this.renderToCanvasCallback=(t,r,i)=>{const a=r.autoClear;r.autoClear=!1,i.render(r),r.autoClear=a},this.setScene(new j,new X)}setBVHWorker(e){this._generator.setBVHWorker(e)}setScene(e,t,r={}){e.updateMatrixWorld(!0),t.updateMatrixWorld();const i=this._generator;if(i.setObjects(e),this._buildAsync)return i.generateAsync(r.onProgress).then(a=>(this._updateFromResults(e,t,a),this._deferredSceneUpdates().then(()=>a)));{const a=i.generate();return this._updateFromResults(e,t,a),a.needsMaterialIndexUpdate&&a.geometry&&this._pathTracer.material.materialIndexAttribute.updateFrom(a.geometry.attributes.materialIndex),this.updateMaterials(),this.updateLights(),this.updateEnvironment(),a}}setSceneAsync(...e){this._buildAsync=!0;const t=this.setScene(...e);return this._buildAsync=!1,t}setCamera(e){this.camera=e,this.updateCamera()}compileAsync(){return this._pathTracer.compileMaterial()}updateCamera(){const e=this.camera;e.updateMatrixWorld(),this._pathTracer.setCamera(e),this._lowResPathTracer.setCamera(e),this.reset()}updateMaterials(){const e=this._pathTracer.material,t=this._renderer,r=this._materials,i=this.textureSize,a=Y(r);e.textures.setTextures(t,a,i.x,i.y),e.materials.updateFrom(r,a),e.shadowCatcherReflectionIntensity=1;for(let s=0,n=r.length;s<n;s++){const l=r[s];if(l.shadowReflectionCatcher&&l.shadowCatcherReflectionIntensity!=null){e.shadowCatcherReflectionIntensity=l.shadowCatcherReflectionIntensity;break}}this.reset()}updateLights(){const e=this.scene,t=this._renderer,r=this._pathTracer.material,i=J(e),a=Z(i);r.lights.updateFrom(i,a),r.iesProfiles.setTextures(t,a),this.reset()}updateEnvironment(){var i;const e=this.scene,t=this._pathTracer.material;if(this._internalBackground&&(this._internalBackground.dispose(),this._internalBackground=null),t.backgroundBlur=e.backgroundBlurriness,t.backgroundIntensity=e.backgroundIntensity??1,t.backgroundRotation.makeRotationFromEuler(e.backgroundRotation).invert(),e.background===null)t.backgroundMap=null,t.backgroundAlpha=0;else if(e.background.isColor){this._colorBackground=this._colorBackground||new ae(16);const a=this._colorBackground;a.topColor.equals(e.background)||(a.topColor.set(e.background),a.bottomColor.set(e.background),a.update()),t.backgroundMap=a,t.backgroundAlpha=1}else if(e.background.isCubeTexture){if(e.background!==this._previousBackground){const a=new P(this._renderer).generate(e.background);this._internalBackground=a,t.backgroundMap=a,t.backgroundAlpha=1}}else t.backgroundMap=e.background,t.backgroundAlpha=1;if(t.environmentIntensity=e.environment!==null?e.environmentIntensity??1:0,t.environmentSaturation=((i=e.userData)==null?void 0:i.environmentSaturation)??1,t.environmentRotation.makeRotationFromEuler(e.environmentRotation).invert(),this._previousEnvironment!==e.environment&&e.environment!==null)if(e.environment.isCubeTexture){const a=new P(this._renderer).generate(e.environment);t.envMapInfo.updateFrom(a)}else t.envMapInfo.updateFrom(e.environment);const r=t.envMapInfo.map;if(e.environment!==null&&r)if(r.type===D){if(this._previousRasterEnvMapSource!==r&&this._rasterEnvMap&&(this._rasterEnvMap.dispose(),this._rasterEnvMap=null),this._rasterEnvMap)e.environment=this._rasterEnvMap;else if(!this._rasterEnvMapScheduled){this._rasterEnvMapScheduled=!0;const a=this,s=r,n=e;requestAnimationFrame(function(){if(a._rasterEnvMapScheduled=!1,a._previousRasterEnvMapSource!==s||a._rasterEnvMap)return;const{width:u,height:c,data:h}=s.image,d=Math.floor(h.length/(u*c)),m=new Float32Array(u*c*4);for(let o=0;o<u*c;o++)m[4*o+0]=_.fromHalfFloat(h[d*o+0]),m[4*o+1]=_.fromHalfFloat(h[d*o+1]),m[4*o+2]=_.fromHalfFloat(h[d*o+2]),m[4*o+3]=d>=4?_.fromHalfFloat(h[d*o+3]):1;a._rasterEnvMap=new F(m,u,c,k,w,R,C,q,x,x),a._rasterEnvMap.needsUpdate=!0,a._previousRasterEnvMapSource=s,n.environment=a._rasterEnvMap})}}else this._rasterEnvMap&&(this._rasterEnvMap.dispose(),this._rasterEnvMap=null,this._previousRasterEnvMapSource=null),e.environment=r;this._previousEnvironment=e.environment,this._previousBackground=e.background,this.reset()}_updateFromResults(e,t,r){const{materials:i,geometry:a,bvh:s,bvhChanged:n,needsMaterialIndexUpdate:l}=r;this._materials=i;const c=this._pathTracer.material;return n&&(c.bvh.updateFrom(s),c.attributesArray.updateFrom(a.attributes.normal,a.attributes.tangent,a.attributes.uv,a.attributes.color)),l?(this._pendingMaterialIndexUpdate=!0,this._pendingGeometry=a):(this._pendingMaterialIndexUpdate=!1,this._pendingGeometry=null),this._previousScene=e,this.scene=e,this.camera=t,this.updateCamera(),r}_deferredSceneUpdates(){const e=this;return new Promise(t=>{requestAnimationFrame(()=>{e._pendingMaterialIndexUpdate&&e._pendingGeometry&&(e._pathTracer.material.materialIndexAttribute.updateFrom(e._pendingGeometry.attributes.materialIndex),e._pendingMaterialIndexUpdate=!1,e._pendingGeometry=null),e.updateMaterials(),e.updateLights(),requestAnimationFrame(()=>{e.updateEnvironment(),t()})})})}renderSample(){const e=this._lowResPathTracer,t=this._pathTracer,r=this._renderer,i=this._clock,a=this._quad;this._updateScale(),this._queueReset&&(t.reset(),e.reset(),this._queueReset=!1,a.material.opacity=0,i.start());const s=i.getDelta()*1e3,n=i.getElapsedTime()*1e3;if(!this.pausePathTracing&&this.enablePathTracing&&this.renderDelay<=n&&!this.isCompiling&&t.update(),t.alpha=t.material.backgroundAlpha!==1||!se(r),e.alpha=t.alpha,this.renderToCanvas){const l=this._renderer,u=this.minSamples;if(n>=this.renderDelay&&this.samples>=this.minSamples&&(this.fadeDuration!==0?a.material.opacity=Math.min(a.material.opacity+s/this.fadeDuration,1):a.material.opacity=1),!this.enablePathTracing||this.samples<u||a.material.opacity<1){if(this.dynamicLowRes&&!this.isCompiling){e.samples<1&&(e.material=t.material,e.update());const c=a.material.opacity;a.material.opacity=1-a.material.opacity,a.material.map=e.target.texture,a.render(l),a.material.opacity=c}(!this.dynamicLowRes&&this.rasterizeScene||this.dynamicLowRes&&this.isCompiling)&&this.rasterizeSceneCallback(this.scene,this.camera)}this.enablePathTracing&&a.material.opacity>0&&(a.material.opacity<1&&(a.material.blending=this.dynamicLowRes?$:K),a.material.map=t.target.texture,this.renderToCanvasCallback(t.target,l,a),a.material.blending=U)}}reset(){this._queueReset=!0,this._pathTracer.samples=0}dispose(){this._rasterEnvMap&&(this._rasterEnvMap.dispose(),this._rasterEnvMap=null,this._previousRasterEnvMapSource=null),this._quad.dispose(),this._quad.material.dispose(),this._pathTracer.dispose()}_updateScale(){if(this.synchronizeRenderSize){this._renderer.getDrawingBufferSize(f);const e=Math.floor(this.renderScale*f.x),t=Math.floor(this.renderScale*f.y);if(this._pathTracer.getSize(f),f.x!==e||f.y!==t){const r=this.lowResScale;this._pathTracer.setSize(e,t),this._lowResPathTracer.setSize(Math.floor(e*r),Math.floor(t*r))}}}}export{ae as G,ue as W};
//# sourceMappingURL=WebGLPathTracer-BkY-ibNS.js.map
