(function (global, factory) {
	typeof exports === 'object' && typeof module !== 'undefined' ? factory(exports, require('three'), require('three/examples/jsm/postprocessing/Pass.js')) :
	typeof define === 'function' && define.amd ? define(['exports', 'three', 'three/examples/jsm/postprocessing/Pass.js'], factory) :
	(global = typeof globalThis !== 'undefined' ? globalThis : global || self, factory(global.ThreePathTracer = global.ThreePathTracer || {}, global.THREE, global.THREE));
})(this, (function (exports, three, Pass_js) { 'use strict';

	// Split strategy constants
	const CENTER = 0;
	const AVERAGE = 1;
	const SAH = 2;

	// Traversal constants
	const NOT_INTERSECTED = 0;
	const INTERSECTED = 1;
	const CONTAINED = 2;

	// SAH cost constants
	// TODO: hone these costs more. The relative difference between them should be the
	// difference in measured time to perform a primitive intersection vs traversing
	// bounds.
	// TODO: could be tuned per primitive type (triangles vs lines vs points)
	const PRIMITIVE_INTERSECT_COST = 1.25;
	const TRAVERSAL_COST = 1;


	// Build constants
	const BYTES_PER_NODE = 6 * 4 + 4 + 4;
	const UINT32_PER_NODE = BYTES_PER_NODE / 4;
	const IS_LEAFNODE_FLAG = 0xFFFF;

	// Bit masks for 32 bit node data
	const LEAFNODE_MASK_32 = IS_LEAFNODE_FLAG << 16;

	// EPSILON for computing floating point error during build
	// https://en.wikipedia.org/wiki/Machine_epsilon#Values_for_standard_hardware_floating_point_arithmetics
	const FLOAT32_EPSILON = Math.pow( 2, - 24 );

	const SKIP_GENERATION = Symbol( 'SKIP_GENERATION' );

	const DEFAULT_OPTIONS = {
		strategy: CENTER,
		maxDepth: 40,
		maxLeafSize: 10,
		useSharedArrayBuffer: false,
		setBoundingBox: true,
		onProgress: null,
		indirect: false,
		verbose: true,
		range: null,
		[ SKIP_GENERATION ]: false,
	};

	function arrayToBox( nodeIndex32, array, target ) {

		target.min.x = array[ nodeIndex32 ];
		target.min.y = array[ nodeIndex32 + 1 ];
		target.min.z = array[ nodeIndex32 + 2 ];

		target.max.x = array[ nodeIndex32 + 3 ];
		target.max.y = array[ nodeIndex32 + 4 ];
		target.max.z = array[ nodeIndex32 + 5 ];

		return target;

	}

	function makeEmptyBounds( target ) {

		target[ 0 ] = target[ 1 ] = target[ 2 ] = Infinity;
		target[ 3 ] = target[ 4 ] = target[ 5 ] = - Infinity;

	}

	function getLongestEdgeIndex( bounds ) {

		let splitDimIdx = - 1;
		let splitDist = - Infinity;

		for ( let i = 0; i < 3; i ++ ) {

			const dist = bounds[ i + 3 ] - bounds[ i ];
			if ( dist > splitDist ) {

				splitDist = dist;
				splitDimIdx = i;

			}

		}

		return splitDimIdx;

	}

	// copies bounds a into bounds b
	function copyBounds( source, target ) {

		target.set( source );

	}

	// sets bounds target to the union of bounds a and b
	function unionBounds( a, b, target ) {

		let aVal, bVal;
		for ( let d = 0; d < 3; d ++ ) {

			const d3 = d + 3;

			// set the minimum values
			aVal = a[ d ];
			bVal = b[ d ];
			target[ d ] = aVal < bVal ? aVal : bVal;

			// set the max values
			aVal = a[ d3 ];
			bVal = b[ d3 ];
			target[ d3 ] = aVal > bVal ? aVal : bVal;

		}

	}

	// expands the given bounds by the provided primitive bounds
	function expandByPrimitiveBounds( startIndex, primitiveBounds, bounds ) {

		for ( let d = 0; d < 3; d ++ ) {

			const tCenter = primitiveBounds[ startIndex + 2 * d ];
			const tHalf = primitiveBounds[ startIndex + 2 * d + 1 ];

			const tMin = tCenter - tHalf;
			const tMax = tCenter + tHalf;

			if ( tMin < bounds[ d ] ) {

				bounds[ d ] = tMin;

			}

			if ( tMax > bounds[ d + 3 ] ) {

				bounds[ d + 3 ] = tMax;

			}

		}

	}

	// compute bounds surface area
	function computeSurfaceArea( bounds ) {

		const d0 = bounds[ 3 ] - bounds[ 0 ];
		const d1 = bounds[ 4 ] - bounds[ 1 ];
		const d2 = bounds[ 5 ] - bounds[ 2 ];

		return 2 * ( d0 * d1 + d1 * d2 + d2 * d0 );

	}

	function IS_LEAF( n16, uint16Array ) {

		return uint16Array[ n16 + 15 ] === IS_LEAFNODE_FLAG;

	}

	function OFFSET( n32, uint32Array ) {

		return uint32Array[ n32 + 6 ];

	}

	function COUNT( n16, uint16Array ) {

		return uint16Array[ n16 + 14 ];

	}

	// Returns the uint32-aligned offset of the left child node for performance
	function LEFT_NODE( n32 ) {

		return n32 + UINT32_PER_NODE;

	}

	// Returns the uint32-aligned offset of the right child node for performance
	function RIGHT_NODE( n32, uint32Array ) {

		// stored value is relative offset from parent, convert to absolute uint32 index
		const relativeOffset = uint32Array[ n32 + 6 ];
		return n32 + relativeOffset * UINT32_PER_NODE;

	}

	function SPLIT_AXIS( n32, uint32Array ) {

		return uint32Array[ n32 + 7 ];

	}

	function BOUNDING_DATA_INDEX( n32 ) {

		return n32;

	}

	// computes the union of the bounds of all of the given primitives and puts the resulting box in "target".
	// A bounding box is computed for the centroids of the primitives, as well, and placed in "centroidTarget".
	// These are computed together to avoid redundant accesses to bounds array.
	function getBounds( primitiveBounds, offset, count, target, centroidTarget ) {

		let minx = Infinity;
		let miny = Infinity;
		let minz = Infinity;
		let maxx = - Infinity;
		let maxy = - Infinity;
		let maxz = - Infinity;

		let cminx = Infinity;
		let cminy = Infinity;
		let cminz = Infinity;
		let cmaxx = - Infinity;
		let cmaxy = - Infinity;
		let cmaxz = - Infinity;

		const boundsOffset = primitiveBounds.offset || 0;
		for ( let i = ( offset - boundsOffset ) * 6, end = ( offset + count - boundsOffset ) * 6; i < end; i += 6 ) {

			const cx = primitiveBounds[ i + 0 ];
			const hx = primitiveBounds[ i + 1 ];
			const lx = cx - hx;
			const rx = cx + hx;
			if ( lx < minx ) minx = lx;
			if ( rx > maxx ) maxx = rx;
			if ( cx < cminx ) cminx = cx;
			if ( cx > cmaxx ) cmaxx = cx;

			const cy = primitiveBounds[ i + 2 ];
			const hy = primitiveBounds[ i + 3 ];
			const ly = cy - hy;
			const ry = cy + hy;
			if ( ly < miny ) miny = ly;
			if ( ry > maxy ) maxy = ry;
			if ( cy < cminy ) cminy = cy;
			if ( cy > cmaxy ) cmaxy = cy;

			const cz = primitiveBounds[ i + 4 ];
			const hz = primitiveBounds[ i + 5 ];
			const lz = cz - hz;
			const rz = cz + hz;
			if ( lz < minz ) minz = lz;
			if ( rz > maxz ) maxz = rz;
			if ( cz < cminz ) cminz = cz;
			if ( cz > cmaxz ) cmaxz = cz;

		}

		target[ 0 ] = minx;
		target[ 1 ] = miny;
		target[ 2 ] = minz;

		target[ 3 ] = maxx;
		target[ 4 ] = maxy;
		target[ 5 ] = maxz;

		centroidTarget[ 0 ] = cminx;
		centroidTarget[ 1 ] = cminy;
		centroidTarget[ 2 ] = cminz;

		centroidTarget[ 3 ] = cmaxx;
		centroidTarget[ 4 ] = cmaxy;
		centroidTarget[ 5 ] = cmaxz;

	}

	const BIN_COUNT = 32;
	const binsSort = ( a, b ) => a.candidate - b.candidate;
	const sahBins = /* @__PURE__ */ new Array( BIN_COUNT ).fill().map( () => {

		return {

			count: 0,
			bounds: new Float32Array( 6 ),
			rightCacheBounds: new Float32Array( 6 ),
			leftCacheBounds: new Float32Array( 6 ),
			candidate: 0,

		};

	} );
	const leftBounds = /* @__PURE__ */ new Float32Array( 6 );

	function getOptimalSplit( nodeBoundingData, centroidBoundingData, primitiveBounds, offset, count, strategy ) {

		let axis = - 1;
		let pos = 0;

		// Center
		if ( strategy === CENTER ) {

			axis = getLongestEdgeIndex( centroidBoundingData );
			if ( axis !== - 1 ) {

				pos = ( centroidBoundingData[ axis ] + centroidBoundingData[ axis + 3 ] ) / 2;

			}

		} else if ( strategy === AVERAGE ) {

			axis = getLongestEdgeIndex( nodeBoundingData );
			if ( axis !== - 1 ) {

				pos = getAverage( primitiveBounds, offset, count, axis );

			}

		} else if ( strategy === SAH ) {

			const rootSurfaceArea = computeSurfaceArea( nodeBoundingData );
			let bestCost = PRIMITIVE_INTERSECT_COST * count;

			// iterate over all axes
			const boundsOffset = primitiveBounds.offset || 0;
			const cStart = ( offset - boundsOffset ) * 6;
			const cEnd = ( offset + count - boundsOffset ) * 6;
			for ( let a = 0; a < 3; a ++ ) {

				const axisLeft = centroidBoundingData[ a ];
				const axisRight = centroidBoundingData[ a + 3 ];
				const axisLength = axisRight - axisLeft;
				const binWidth = axisLength / BIN_COUNT;

				// If we have fewer primitives than we're planning to split then just check all
				// the primitive positions because it will be faster.
				if ( count < BIN_COUNT / 4 ) {

					// initialize the bin candidates
					const truncatedBins = [ ...sahBins ];
					truncatedBins.length = count;

					// set the candidates
					let b = 0;
					for ( let c = cStart; c < cEnd; c += 6, b ++ ) {

						const bin = truncatedBins[ b ];
						bin.candidate = primitiveBounds[ c + 2 * a ];
						bin.count = 0;

						const {
							bounds,
							leftCacheBounds,
							rightCacheBounds,
						} = bin;
						for ( let d = 0; d < 3; d ++ ) {

							rightCacheBounds[ d ] = Infinity;
							rightCacheBounds[ d + 3 ] = - Infinity;

							leftCacheBounds[ d ] = Infinity;
							leftCacheBounds[ d + 3 ] = - Infinity;

							bounds[ d ] = Infinity;
							bounds[ d + 3 ] = - Infinity;

						}

						expandByPrimitiveBounds( c, primitiveBounds, bounds );

					}

					truncatedBins.sort( binsSort );

					// remove redundant splits
					let splitCount = count;
					for ( let bi = 0; bi < splitCount; bi ++ ) {

						const bin = truncatedBins[ bi ];
						while ( bi + 1 < splitCount && truncatedBins[ bi + 1 ].candidate === bin.candidate ) {

							truncatedBins.splice( bi + 1, 1 );
							splitCount --;

						}

					}

					// find the appropriate bin for each primitive and expand the bounds.
					for ( let c = cStart; c < cEnd; c += 6 ) {

						const center = primitiveBounds[ c + 2 * a ];
						for ( let bi = 0; bi < splitCount; bi ++ ) {

							const bin = truncatedBins[ bi ];
							if ( center >= bin.candidate ) {

								expandByPrimitiveBounds( c, primitiveBounds, bin.rightCacheBounds );

							} else {

								expandByPrimitiveBounds( c, primitiveBounds, bin.leftCacheBounds );
								bin.count ++;

							}

						}

					}

					// expand all the bounds
					for ( let bi = 0; bi < splitCount; bi ++ ) {

						const bin = truncatedBins[ bi ];
						const leftCount = bin.count;
						const rightCount = count - bin.count;

						// check the cost of this split
						const leftBounds = bin.leftCacheBounds;
						const rightBounds = bin.rightCacheBounds;

						let leftProb = 0;
						if ( leftCount !== 0 ) {

							leftProb = computeSurfaceArea( leftBounds ) / rootSurfaceArea;

						}

						let rightProb = 0;
						if ( rightCount !== 0 ) {

							rightProb = computeSurfaceArea( rightBounds ) / rootSurfaceArea;

						}

						const cost = TRAVERSAL_COST + PRIMITIVE_INTERSECT_COST * (
							leftProb * leftCount + rightProb * rightCount
						);

						if ( cost < bestCost ) {

							axis = a;
							bestCost = cost;
							pos = bin.candidate;

						}

					}

				} else {

					// reset the bins
					for ( let i = 0; i < BIN_COUNT; i ++ ) {

						const bin = sahBins[ i ];
						bin.count = 0;
						bin.candidate = axisLeft + binWidth + i * binWidth;

						const bounds = bin.bounds;
						for ( let d = 0; d < 3; d ++ ) {

							bounds[ d ] = Infinity;
							bounds[ d + 3 ] = - Infinity;

						}

					}

					// iterate over all center positions
					for ( let c = cStart; c < cEnd; c += 6 ) {

						const triCenter = primitiveBounds[ c + 2 * a ];
						const relativeCenter = triCenter - axisLeft;

						// in the partition function if the centroid lies on the split plane then it is
						// considered to be on the right side of the split
						let binIndex = ~ ~ ( relativeCenter / binWidth );
						if ( binIndex >= BIN_COUNT ) binIndex = BIN_COUNT - 1;

						const bin = sahBins[ binIndex ];
						bin.count ++;

						expandByPrimitiveBounds( c, primitiveBounds, bin.bounds );

					}

					// cache the unioned bounds from right to left so we don't have to regenerate them each time
					const lastBin = sahBins[ BIN_COUNT - 1 ];
					copyBounds( lastBin.bounds, lastBin.rightCacheBounds );
					for ( let i = BIN_COUNT - 2; i >= 0; i -- ) {

						const bin = sahBins[ i ];
						const nextBin = sahBins[ i + 1 ];
						unionBounds( bin.bounds, nextBin.rightCacheBounds, bin.rightCacheBounds );

					}

					let leftCount = 0;
					for ( let i = 0; i < BIN_COUNT - 1; i ++ ) {

						const bin = sahBins[ i ];
						const binCount = bin.count;
						const bounds = bin.bounds;

						const nextBin = sahBins[ i + 1 ];
						const rightBounds = nextBin.rightCacheBounds;

						// don't do anything with the bounds if the new bounds have no primitives
						if ( binCount !== 0 ) {

							if ( leftCount === 0 ) {

								copyBounds( bounds, leftBounds );

							} else {

								unionBounds( bounds, leftBounds, leftBounds );

							}

						}

						leftCount += binCount;

						// check the cost of this split
						let leftProb = 0;
						let rightProb = 0;

						if ( leftCount !== 0 ) {

							leftProb = computeSurfaceArea( leftBounds ) / rootSurfaceArea;

						}

						const rightCount = count - leftCount;
						if ( rightCount !== 0 ) {

							rightProb = computeSurfaceArea( rightBounds ) / rootSurfaceArea;

						}

						const cost = TRAVERSAL_COST + PRIMITIVE_INTERSECT_COST * (
							leftProb * leftCount + rightProb * rightCount
						);

						if ( cost < bestCost ) {

							axis = a;
							bestCost = cost;
							pos = bin.candidate;

						}

					}

				}

			}

		} else {

			console.warn( `BVH: Invalid build strategy value ${ strategy } used.` );

		}

		return { axis, pos };

	}

	// returns the average coordinate on the specified axis of all the provided primitives
	function getAverage( primitiveBounds, offset, count, axis ) {

		let avg = 0;
		const boundsOffset = primitiveBounds.offset;
		for ( let i = offset, end = offset + count; i < end; i ++ ) {

			avg += primitiveBounds[ ( i - boundsOffset ) * 6 + axis * 2 ];

		}

		return avg / count;

	}

	class BVHNode {

		constructor() {

			// internal nodes have boundingData, left, right, and splitAxis
			// leaf nodes have offset and count (referring to primitives in the mesh geometry)

			this.boundingData = new Float32Array( 6 );

		}

	}

	// reorders the partition buffer such that for `count` elements after `offset`, elements on the left side of the split
	// will be on the left and elements on the right side of the split will be on the right. returns the index
	// of the first element on the right side, or offset + count if there are no elements on the right side.
	function partition( buffer, stride, primitiveBounds, offset, count, split ) {

		let left = offset;
		let right = offset + count - 1;
		const pos = split.pos;
		const axisOffset = split.axis * 2;
		const boundsOffset = primitiveBounds.offset || 0;

		// hoare partitioning, see e.g. https://en.wikipedia.org/wiki/Quicksort#Hoare_partition_scheme
		while ( true ) {

			while ( left <= right && primitiveBounds[ ( left - boundsOffset ) * 6 + axisOffset ] < pos ) {

				left ++;

			}

			// if a primitive center lies on the partition plane it is considered to be on the right side
			while ( left <= right && primitiveBounds[ ( right - boundsOffset ) * 6 + axisOffset ] >= pos ) {

				right --;

			}

			if ( left < right ) {

				// we need to swap all of the information associated with the primitives at index
				// left and right; that's the elements in the partition buffer and the bounds
				for ( let i = 0; i < stride; i ++ ) {

					let t0 = buffer[ left * stride + i ];
					buffer[ left * stride + i ] = buffer[ right * stride + i ];
					buffer[ right * stride + i ] = t0;

				}

				// swap bounds
				for ( let i = 0; i < 6; i ++ ) {

					const l = left - boundsOffset;
					const r = right - boundsOffset;
					const tb = primitiveBounds[ l * 6 + i ];
					primitiveBounds[ l * 6 + i ] = primitiveBounds[ r * 6 + i ];
					primitiveBounds[ r * 6 + i ] = tb;

				}

				left ++;
				right --;

			} else {

				return left;

			}

		}

	}

	let float32Array, uint32Array, uint16Array, uint8Array;
	const MAX_POINTER = Math.pow( 2, 32 );

	function countNodes( node ) {

		if ( 'count' in node ) {

			return 1;

		} else {

			return 1 + countNodes( node.left ) + countNodes( node.right );

		}

	}

	function populateBuffer( byteOffset, node, buffer ) {

		float32Array = new Float32Array( buffer );
		uint32Array = new Uint32Array( buffer );
		uint16Array = new Uint16Array( buffer );
		uint8Array = new Uint8Array( buffer );

		return _populateBuffer( byteOffset, node );

	}

	// pack structure
	// boundingData  				: 6 float32
	// right / offset 				: 1 uint32
	// splitAxis / isLeaf + count 	: 1 uint32 / 2 uint16
	function _populateBuffer( byteOffset, node ) {

		const node32Index = byteOffset / 4;
		const node16Index = byteOffset / 2;
		const isLeaf = 'count' in node;
		const boundingData = node.boundingData;
		for ( let i = 0; i < 6; i ++ ) {

			float32Array[ node32Index + i ] = boundingData[ i ];

		}

		if ( isLeaf ) {

			if ( node.buffer ) {

				uint8Array.set( new Uint8Array( node.buffer ), byteOffset );
				return byteOffset + node.buffer.byteLength;

			} else {

				uint32Array[ node32Index + 6 ] = node.offset;
				uint16Array[ node16Index + 14 ] = node.count;
				uint16Array[ node16Index + 15 ] = IS_LEAFNODE_FLAG;
				return byteOffset + BYTES_PER_NODE;

			}

		} else {

			const { left, right, splitAxis } = node;

			// fill in the left node contents
			const leftByteOffset = byteOffset + BYTES_PER_NODE;
			let rightByteOffset = _populateBuffer( leftByteOffset, left );

			// calculate relative offset from parent to right child
			const currentNodeIndex = byteOffset / BYTES_PER_NODE;
			const rightNodeIndex = rightByteOffset / BYTES_PER_NODE;
			const relativeRightIndex = rightNodeIndex - currentNodeIndex;

			// check if the relative offset is too high
			if ( relativeRightIndex > MAX_POINTER ) {

				throw new Error( 'MeshBVH: Cannot store relative child node offset greater than 32 bits.' );

			}

			// fill in the right node contents (store as relative offset)
			uint32Array[ node32Index + 6 ] = relativeRightIndex;
			uint32Array[ node32Index + 7 ] = splitAxis;

			// return the next available buffer pointer
			return _populateBuffer( rightByteOffset, right );

		}

	}

	function buildTree( bvh, primitiveBounds, offset, count, options ) {

		// expand variables
		const {
			maxDepth,
			verbose,
			maxLeafSize,
			strategy,
			onProgress,
		} = options;

		const partitionBuffer = bvh.primitiveBuffer;
		const partitionStride = bvh.primitiveBufferStride;

		// generate intermediate variables
		const cacheCentroidBoundingData = new Float32Array( 6 );
		let reachedMaxDepth = false;

		const root = new BVHNode();
		getBounds( primitiveBounds, offset, count, root.boundingData, cacheCentroidBoundingData );
		splitNode( root, offset, count, cacheCentroidBoundingData );
		return root;

		function triggerProgress( primitivesProcessed ) {

			if ( onProgress ) {

				onProgress( primitivesProcessed / count );

			}

		}

		// either recursively splits the given node, creating left and right subtrees for it, or makes it a leaf node,
		// recording the offset and count of its primitives and writing them into the reordered geometry index.
		function splitNode( node, offset, count, centroidBoundingData = null, depth = 0 ) {

			if ( ! reachedMaxDepth && depth >= maxDepth ) {

				reachedMaxDepth = true;
				if ( verbose ) {

					console.warn( `BVH: Max depth of ${ maxDepth } reached when generating BVH. Consider increasing maxDepth.` );

				}

			}

			// early out if we've met our capacity
			if ( count <= maxLeafSize || depth >= maxDepth ) {

				triggerProgress( offset + count );
				node.offset = offset;
				node.count = count;
				return node;

			}

			// Find where to split the volume
			const split = getOptimalSplit( node.boundingData, centroidBoundingData, primitiveBounds, offset, count, strategy );
			if ( split.axis === - 1 ) {

				triggerProgress( offset + count );
				node.offset = offset;
				node.count = count;
				return node;

			}

			const splitOffset = partition( partitionBuffer, partitionStride, primitiveBounds, offset, count, split );

			// create the two new child nodes
			if ( splitOffset === offset || splitOffset === offset + count ) {

				triggerProgress( offset + count );
				node.offset = offset;
				node.count = count;

			} else {

				node.splitAxis = split.axis;

				// create the left child and compute its bounding box
				const left = new BVHNode();
				const lstart = offset;
				const lcount = splitOffset - offset;
				node.left = left;

				getBounds( primitiveBounds, lstart, lcount, left.boundingData, cacheCentroidBoundingData );
				splitNode( left, lstart, lcount, cacheCentroidBoundingData, depth + 1 );

				// repeat for right
				const right = new BVHNode();
				const rstart = splitOffset;
				const rcount = count - lcount;
				node.right = right;

				getBounds( primitiveBounds, rstart, rcount, right.boundingData, cacheCentroidBoundingData );
				splitNode( right, rstart, rcount, cacheCentroidBoundingData, depth + 1 );

			}

			return node;

		}

	}

	function buildPackedTree( bvh, options ) {

		const BufferConstructor = options.useSharedArrayBuffer ? SharedArrayBuffer : ArrayBuffer;

		// get the range of buffer data to construct / arrange
		const rootRanges = bvh.getRootRanges( options.range );
		const firstRange = rootRanges[ 0 ];
		const lastRange = rootRanges[ rootRanges.length - 1 ];
		const fullRange = {
			offset: firstRange.offset,
			count: lastRange.offset + lastRange.count - firstRange.offset,
		};

		// construct the primitive bounds for sorting
		const primitiveBounds = new Float32Array( 6 * fullRange.count );
		primitiveBounds.offset = fullRange.offset;
		bvh.computePrimitiveBounds( fullRange.offset, fullRange.count, primitiveBounds );

		// Build BVH roots
		bvh._roots = rootRanges.map( range => {

			const root = buildTree( bvh, primitiveBounds, range.offset, range.count, options );
			const nodeCount = countNodes( root );
			const buffer = new BufferConstructor( BYTES_PER_NODE * nodeCount );
			populateBuffer( 0, root, buffer );
			return buffer;

		} );

	}

	class PrimitivePool {

		constructor( getNewPrimitive ) {

			this._getNewPrimitive = getNewPrimitive;
			this._primitives = [];

		}

		getPrimitive() {

			const primitives = this._primitives;
			if ( primitives.length === 0 ) {

				return this._getNewPrimitive();

			} else {

				return primitives.pop();

			}

		}

		releasePrimitive( primitive ) {

			this._primitives.push( primitive );

		}

	}

	class _BufferStack {

		constructor() {

			this.float32Array = null;
			this.uint16Array = null;
			this.uint32Array = null;

			const stack = [];
			let prevBuffer = null;
			this.setBuffer = buffer => {

				if ( prevBuffer ) {

					stack.push( prevBuffer );

				}

				prevBuffer = buffer;
				this.float32Array = new Float32Array( buffer );
				this.uint16Array = new Uint16Array( buffer );
				this.uint32Array = new Uint32Array( buffer );

			};

			this.clearBuffer = () => {

				prevBuffer = null;
				this.float32Array = null;
				this.uint16Array = null;
				this.uint32Array = null;

				if ( stack.length !== 0 ) {

					this.setBuffer( stack.pop() );

				}

			};

		}

	}

	const BufferStack = /* @__PURE__ */ new _BufferStack();

	let _box1$1, _box2$1;
	const boxStack = [];
	const boxPool = /* @__PURE__ */ new PrimitivePool( () => new three.Box3() );

	function shapecast( bvh, root, intersectsBounds, intersectsRange, boundsTraverseOrder, nodeOffset ) {

		// setup
		_box1$1 = boxPool.getPrimitive();
		_box2$1 = boxPool.getPrimitive();
		boxStack.push( _box1$1, _box2$1 );
		BufferStack.setBuffer( bvh._roots[ root ] );

		const result = shapecastTraverse( 0, bvh.geometry, intersectsBounds, intersectsRange, boundsTraverseOrder, nodeOffset );

		// cleanup
		BufferStack.clearBuffer();
		boxPool.releasePrimitive( _box1$1 );
		boxPool.releasePrimitive( _box2$1 );
		boxStack.pop();
		boxStack.pop();

		const length = boxStack.length;
		if ( length > 0 ) {

			_box2$1 = boxStack[ length - 1 ];
			_box1$1 = boxStack[ length - 2 ];

		}

		return result;

	}

	function shapecastTraverse(
		nodeIndex32,
		geometry,
		intersectsBoundsFunc,
		intersectsRangeFunc,
		nodeScoreFunc = null,
		nodeIndexOffset = 0, // offset for unique node identifier
		depth = 0
	) {

		const { float32Array, uint16Array, uint32Array } = BufferStack;
		let nodeIndex16 = nodeIndex32 * 2;

		const isLeaf = IS_LEAF( nodeIndex16, uint16Array );
		if ( isLeaf ) {

			const offset = OFFSET( nodeIndex32, uint32Array );
			const count = COUNT( nodeIndex16, uint16Array );
			arrayToBox( BOUNDING_DATA_INDEX( nodeIndex32 ), float32Array, _box1$1 );
			return intersectsRangeFunc( offset, count, false, depth, nodeIndexOffset + nodeIndex32 / UINT32_PER_NODE, _box1$1 );

		} else {

			const left = LEFT_NODE( nodeIndex32 );
			const right = RIGHT_NODE( nodeIndex32, uint32Array );
			let c1 = left;
			let c2 = right;

			let score1, score2;
			let box1, box2;
			if ( nodeScoreFunc ) {

				box1 = _box1$1;
				box2 = _box2$1;

				// bounding data is not offset
				arrayToBox( BOUNDING_DATA_INDEX( c1 ), float32Array, box1 );
				arrayToBox( BOUNDING_DATA_INDEX( c2 ), float32Array, box2 );

				score1 = nodeScoreFunc( box1 );
				score2 = nodeScoreFunc( box2 );

				if ( score2 < score1 ) {

					c1 = right;
					c2 = left;

					const temp = score1;
					score1 = score2;
					score2 = temp;

					box1 = box2;
					// box2 is always set before use below

				}

			}

			// Check box 1 intersection
			if ( ! box1 ) {

				box1 = _box1$1;
				arrayToBox( BOUNDING_DATA_INDEX( c1 ), float32Array, box1 );

			}

			const isC1Leaf = IS_LEAF( c1 * 2, uint16Array );
			const c1Intersection = intersectsBoundsFunc( box1, isC1Leaf, score1, depth + 1, nodeIndexOffset + c1 / UINT32_PER_NODE );

			let c1StopTraversal;
			if ( c1Intersection === CONTAINED ) {

				const offset = getLeftOffset( c1 );
				const end = getRightEndOffset( c1 );
				const count = end - offset;

				c1StopTraversal = intersectsRangeFunc( offset, count, true, depth + 1, nodeIndexOffset + c1 / UINT32_PER_NODE, box1 );

			} else {

				c1StopTraversal =
					c1Intersection &&
					shapecastTraverse(
						c1,
						geometry,
						intersectsBoundsFunc,
						intersectsRangeFunc,
						nodeScoreFunc,
						nodeIndexOffset,
						depth + 1
					);

			}

			if ( c1StopTraversal ) return true;

			// Check box 2 intersection
			// cached box2 will have been overwritten by previous traversal
			box2 = _box2$1;
			arrayToBox( BOUNDING_DATA_INDEX( c2 ), float32Array, box2 );

			const isC2Leaf = IS_LEAF( c2 * 2, uint16Array );
			const c2Intersection = intersectsBoundsFunc( box2, isC2Leaf, score2, depth + 1, nodeIndexOffset + c2 / UINT32_PER_NODE );

			let c2StopTraversal;
			if ( c2Intersection === CONTAINED ) {

				const offset = getLeftOffset( c2 );
				const end = getRightEndOffset( c2 );
				const count = end - offset;

				c2StopTraversal = intersectsRangeFunc( offset, count, true, depth + 1, nodeIndexOffset + c2 / UINT32_PER_NODE, box2 );

			} else {

				c2StopTraversal =
					c2Intersection &&
					shapecastTraverse(
						c2,
						geometry,
						intersectsBoundsFunc,
						intersectsRangeFunc,
						nodeScoreFunc,
						nodeIndexOffset,
						depth + 1
					);

			}

			if ( c2StopTraversal ) return true;

			return false;

			// Define these inside the function so it has access to the local variables needed
			// when converting to the buffer equivalents
			function getLeftOffset( nodeIndex32 ) {

				const { uint16Array, uint32Array } = BufferStack;
				let nodeIndex16 = nodeIndex32 * 2;

				// traverse until we find a leaf
				while ( ! IS_LEAF( nodeIndex16, uint16Array ) ) {

					nodeIndex32 = LEFT_NODE( nodeIndex32 );
					nodeIndex16 = nodeIndex32 * 2;

				}

				return OFFSET( nodeIndex32, uint32Array );

			}

			function getRightEndOffset( nodeIndex32 ) {

				const { uint16Array, uint32Array } = BufferStack;
				let nodeIndex16 = nodeIndex32 * 2;

				// traverse until we find a leaf
				while ( ! IS_LEAF( nodeIndex16, uint16Array ) ) {

					// adjust offset to point to the right node
					nodeIndex32 = RIGHT_NODE( nodeIndex32, uint32Array );
					nodeIndex16 = nodeIndex32 * 2;

				}

				// return the end offset of the triangle range
				return OFFSET( nodeIndex32, uint32Array ) + COUNT( nodeIndex16, uint16Array );

			}

		}

	}

	function getVertexCount( geo ) {

		return geo.index ? geo.index.count : geo.attributes.position.count;

	}

	function getTriCount( geo ) {

		return getVertexCount( geo ) / 3;

	}

	function getIndexArray( vertexCount, BufferConstructor = ArrayBuffer ) {

		if ( vertexCount > 65535 ) {

			return new Uint32Array( new BufferConstructor( 4 * vertexCount ) );

		} else {

			return new Uint16Array( new BufferConstructor( 2 * vertexCount ) );

		}

	}

	// ensures that an index is present on the geometry
	function ensureIndex( geo, options ) {

		if ( ! geo.index ) {

			const vertexCount = geo.attributes.position.count;
			const BufferConstructor = options.useSharedArrayBuffer ? SharedArrayBuffer : ArrayBuffer;
			const index = getIndexArray( vertexCount, BufferConstructor );
			geo.setIndex( new three.BufferAttribute( index, 1 ) );

			for ( let i = 0; i < vertexCount; i ++ ) {

				index[ i ] = i;

			}

		}

	}

	// Computes the set of { offset, count } ranges which need independent BVH roots. Each
	// region in the geometry index that belongs to a different set of material groups requires
	// a separate BVH root, so that triangles indices belonging to one group never get swapped
	// with triangle indices belongs to another group. For example, if the groups were like this:
	//
	// [-------------------------------------------------------------]
	// |__________________|
	//   g0 = [0, 20]  |______________________||_____________________|
	//                      g1 = [16, 40]           g2 = [41, 60]
	//
	// we would need four BVH roots: [0, 15], [16, 20], [21, 40], [41, 60].
	function getFullPrimitiveRange( geo, range, stride ) {

		const primitiveCount = getVertexCount( geo ) / stride;
		const drawRange = range ? range : geo.drawRange;
		const start = drawRange.start / stride;
		const end = ( drawRange.start + drawRange.count ) / stride;

		const offset = Math.max( 0, start );
		const count = Math.min( primitiveCount, end ) - offset;
		return {
			offset: Math.floor( offset ),
			count: Math.floor( count ),
		};

	}

	function getPrimitiveGroupRanges( geo, stride ) {

		return geo.groups.map( group => ( {
			offset: group.start / stride,
			count: group.count / stride,
		} ));

	}

	// Function that extracts a set of mutually exclusive ranges representing the primitives being
	// drawn as determined by the geometry groups, draw range, and user specified range
	function getRootPrimitiveRanges( geo, range, stride ) {

		const drawRange = getFullPrimitiveRange( geo, range, stride );
		const primitiveRanges = getPrimitiveGroupRanges( geo, stride );
		if ( ! primitiveRanges.length ) {

			return [ drawRange ];

		}

		const ranges = [];
		const drawRangeStart = drawRange.offset;
		const drawRangeEnd = drawRange.offset + drawRange.count;

		// Create events for group boundaries
		const primitiveCount = getVertexCount( geo ) / stride;
		const events = [];
		for ( const group of primitiveRanges ) {

			// Account for cases where group size is set to Infinity
			const { offset, count } = group;
			const groupStart = offset;
			const groupCount = isFinite( count ) ? count : ( primitiveCount - offset );
			const groupEnd = ( offset + groupCount );

			// Only add events if the group intersects with the draw range
			if ( groupStart < drawRangeEnd && groupEnd > drawRangeStart ) {

				events.push( { pos: Math.max( drawRangeStart, groupStart ), isStart: true } );
				events.push( { pos: Math.min( drawRangeEnd, groupEnd ), isStart: false } );

			}

		}

		// Sort events by position, with 'end' events before 'start' events at the same position
		events.sort( ( a, b ) => {

			if ( a.pos !== b.pos ) {

				return a.pos - b.pos;

			} else {

				return a.type === 'end' ? - 1 : 1;

			}

		} );

		// sweep through events and create ranges where activeGroups > 0
		let activeGroups = 0;
		let lastPos = null;
		for ( const event of events ) {

			const newPos = event.pos;
			if ( activeGroups !== 0 && newPos !== lastPos ) {

				ranges.push( {
					offset: lastPos,
					count: newPos - lastPos,
				} );

			}

			activeGroups += event.isStart ? 1 : - 1;
			lastPos = newPos;

		}

		return ranges;

	}

	const tempBox = /* @__PURE__ */ new three.Box3();

	class BVH {

		constructor() {

			this._roots = null;
			this.primitiveBuffer = null;
			this.primitiveBufferStride = null;

		}

		init( options ) {

			options = {
				...DEFAULT_OPTIONS,
				...options,
			};

			buildPackedTree( this, options );

		}

		getRootRanges( range ) {

			// TODO: can we avoid passing options in here
			return getRootPrimitiveRanges( this.geometry, range, this.primitiveStride );

		}

		raycastObject3D( /* object, raycaster, intersects = [] */ ) {

			throw new Error( 'BVH: raycastObject3D() not implemented' );

		}

		shiftPrimitiveOffsets( offset ) {

			const indirectBuffer = this._indirectBuffer;
			if ( indirectBuffer ) {

				// the offsets are embedded in the indirect buffer
				for ( let i = 0, l = indirectBuffer.length; i < l; i ++ ) {

					indirectBuffer[ i ] += offset;

				}

			} else {

				// offsets are embedded in the leaf nodes
				const roots = this._roots;
				for ( let rootIndex = 0; rootIndex < roots.length; rootIndex ++ ) {

					const root = roots[ rootIndex ];
					const uint32Array = new Uint32Array( root );
					const uint16Array = new Uint16Array( root );
					const totalNodes = root.byteLength / BYTES_PER_NODE;
					for ( let node = 0; node < totalNodes; node ++ ) {

						const node32Index = UINT32_PER_NODE * node;
						const node16Index = 2 * node32Index;
						if ( IS_LEAF( node16Index, uint16Array ) ) {

							// offset value
							uint32Array[ node32Index + 6 ] += offset;

						}

					}

				}

			}

		}

		traverse( callback, rootIndex = 0 ) {

			const buffer = this._roots[ rootIndex ];
			const uint32Array = new Uint32Array( buffer );
			const uint16Array = new Uint16Array( buffer );
			_traverse( 0 );

			function _traverse( node32Index, depth = 0 ) {

				const node16Index = node32Index * 2;
				const isLeaf = IS_LEAF( node16Index, uint16Array );
				if ( isLeaf ) {

					const offset = uint32Array[ node32Index + 6 ];
					const count = uint16Array[ node16Index + 14 ];
					callback( depth, isLeaf, new Float32Array( buffer, node32Index * 4, 6 ), offset, count );

				} else {

					const left = LEFT_NODE( node32Index );
					const right = RIGHT_NODE( node32Index, uint32Array );
					const splitAxis = SPLIT_AXIS( node32Index, uint32Array );
					const stopTraversal = callback( depth, isLeaf, new Float32Array( buffer, node32Index * 4, 6 ), splitAxis );

					if ( ! stopTraversal ) {

						_traverse( left, depth + 1 );
						_traverse( right, depth + 1 );

					}

				}

			}

		}

		getBoundingBox( target ) {

			target.makeEmpty();

			const roots = this._roots;
			roots.forEach( buffer => {

				arrayToBox( 0, new Float32Array( buffer ), tempBox );
				target.union( tempBox );

			} );

			return target;

		}

		// Base shapecast implementation that can be used by subclasses
		// TODO: see if we can get rid of "iterateFunc" here as well as the primitive so the function
		// API aligns with the "shapecast" implementation
		shapecast( callbacks ) {

			let {
				boundsTraverseOrder,
				intersectsBounds,
				intersectsRange,
				intersectsPrimitive,
				scratchPrimitive,
				iterate,
			} = callbacks;

			// wrap the intersectsRange function
			if ( intersectsRange && intersectsPrimitive ) {

				const originalIntersectsRange = intersectsRange;
				intersectsRange = ( offset, count, contained, depth, nodeIndex ) => {

					if ( ! originalIntersectsRange( offset, count, contained, depth, nodeIndex ) ) {

						return iterate( offset, count, this, intersectsPrimitive, contained, depth, scratchPrimitive );

					}

					return true;

				};

			} else if ( ! intersectsRange ) {

				if ( intersectsPrimitive ) {

					intersectsRange = ( offset, count, contained, depth ) => {

						return iterate( offset, count, this, intersectsPrimitive, contained, depth, scratchPrimitive );

					};

				} else {

					intersectsRange = ( offset, count, contained ) => {

						return contained;

					};

				}

			}

			// run shapecast
			let result = false;
			let nodeOffset = 0;
			const roots = this._roots;
			for ( let i = 0, l = roots.length; i < l; i ++ ) {

				const root = roots[ i ];
				result = shapecast( this, i, intersectsBounds, intersectsRange, boundsTraverseOrder, nodeOffset );

				if ( result ) {

					break;

				}

				nodeOffset += root.byteLength / BYTES_PER_NODE;

			}

			return result;

		}

	}

	class SeparatingAxisBounds {

		constructor() {

			this.min = Infinity;
			this.max = - Infinity;

		}

		setFromPointsField( points, field ) {

			let min = Infinity;
			let max = - Infinity;
			for ( let i = 0, l = points.length; i < l; i ++ ) {

				const p = points[ i ];
				const val = p[ field ];
				min = val < min ? val : min;
				max = val > max ? val : max;

			}

			this.min = min;
			this.max = max;

		}

		setFromPoints( axis, points ) {

			let min = Infinity;
			let max = - Infinity;
			for ( let i = 0, l = points.length; i < l; i ++ ) {

				const p = points[ i ];
				const val = axis.dot( p );
				min = val < min ? val : min;
				max = val > max ? val : max;

			}

			this.min = min;
			this.max = max;

		}

		isSeparated( other ) {

			return this.min > other.max || other.min > this.max;

		}

	}

	SeparatingAxisBounds.prototype.setFromBox = ( function () {

		const p = /* @__PURE__ */ new three.Vector3();
		return function setFromBox( axis, box ) {

			const boxMin = box.min;
			const boxMax = box.max;
			let min = Infinity;
			let max = - Infinity;
			for ( let x = 0; x <= 1; x ++ ) {

				for ( let y = 0; y <= 1; y ++ ) {

					for ( let z = 0; z <= 1; z ++ ) {

						p.x = boxMin.x * x + boxMax.x * ( 1 - x );
						p.y = boxMin.y * y + boxMax.y * ( 1 - y );
						p.z = boxMin.z * z + boxMax.z * ( 1 - z );

						const val = axis.dot( p );
						min = Math.min( val, min );
						max = Math.max( val, max );

					}

				}

			}

			this.min = min;
			this.max = max;

		};

	} )();

	const areIntersecting = ( function () {

		const cacheSatBounds = /* @__PURE__ */ new SeparatingAxisBounds();
		return function areIntersecting( shape1, shape2 ) {

			const points1 = shape1.points;
			const satAxes1 = shape1.satAxes;
			const satBounds1 = shape1.satBounds;

			const points2 = shape2.points;
			const satAxes2 = shape2.satAxes;
			const satBounds2 = shape2.satBounds;

			// check axes of the first shape
			for ( let i = 0; i < 3; i ++ ) {

				const sb = satBounds1[ i ];
				const sa = satAxes1[ i ];
				cacheSatBounds.setFromPoints( sa, points2 );
				if ( sb.isSeparated( cacheSatBounds ) ) return false;

			}

			// check axes of the second shape
			for ( let i = 0; i < 3; i ++ ) {

				const sb = satBounds2[ i ];
				const sa = satAxes2[ i ];
				cacheSatBounds.setFromPoints( sa, points1 );
				if ( sb.isSeparated( cacheSatBounds ) ) return false;

			}

		};

	} )();

	const closestPointLineToLine = ( function () {

		// https://github.com/juj/MathGeoLib/blob/master/src/Geometry/Line.cpp#L56
		const dir1 = /* @__PURE__ */ new three.Vector3();
		const dir2 = /* @__PURE__ */ new three.Vector3();
		const v02 = /* @__PURE__ */ new three.Vector3();
		return function closestPointLineToLine( l1, l2, result ) {

			const v0 = l1.start;
			const v10 = dir1;
			const v2 = l2.start;
			const v32 = dir2;

			v02.subVectors( v0, v2 );
			dir1.subVectors( l1.end, l1.start );
			dir2.subVectors( l2.end, l2.start );

			// float d0232 = v02.Dot(v32);
			const d0232 = v02.dot( v32 );

			// float d3210 = v32.Dot(v10);
			const d3210 = v32.dot( v10 );

			// float d3232 = v32.Dot(v32);
			const d3232 = v32.dot( v32 );

			// float d0210 = v02.Dot(v10);
			const d0210 = v02.dot( v10 );

			// float d1010 = v10.Dot(v10);
			const d1010 = v10.dot( v10 );

			// float denom = d1010*d3232 - d3210*d3210;
			const denom = d1010 * d3232 - d3210 * d3210;

			let d, d2;
			if ( denom !== 0 ) {

				d = ( d0232 * d3210 - d0210 * d3232 ) / denom;

			} else {

				d = 0;

			}

			d2 = ( d0232 + d * d3210 ) / d3232;

			result.x = d;
			result.y = d2;

		};

	} )();

	const closestPointsSegmentToSegment = ( function () {

		// https://github.com/juj/MathGeoLib/blob/master/src/Geometry/LineSegment.cpp#L187
		const paramResult = /* @__PURE__ */ new three.Vector2();
		const temp1 = /* @__PURE__ */ new three.Vector3();
		const temp2 = /* @__PURE__ */ new three.Vector3();
		return function closestPointsSegmentToSegment( l1, l2, target1, target2 ) {

			closestPointLineToLine( l1, l2, paramResult );

			let d = paramResult.x;
			let d2 = paramResult.y;
			if ( d >= 0 && d <= 1 && d2 >= 0 && d2 <= 1 ) {

				l1.at( d, target1 );
				l2.at( d2, target2 );

				return;

			} else if ( d >= 0 && d <= 1 ) {

				// Only d2 is out of bounds.
				if ( d2 < 0 ) {

					l2.at( 0, target2 );

				} else {

					l2.at( 1, target2 );

				}

				l1.closestPointToPoint( target2, true, target1 );
				return;

			} else if ( d2 >= 0 && d2 <= 1 ) {

				// Only d is out of bounds.
				if ( d < 0 ) {

					l1.at( 0, target1 );

				} else {

					l1.at( 1, target1 );

				}

				l2.closestPointToPoint( target1, true, target2 );
				return;

			} else {

				// Both u and u2 are out of bounds.
				let p;
				if ( d < 0 ) {

					p = l1.start;

				} else {

					p = l1.end;

				}

				let p2;
				if ( d2 < 0 ) {

					p2 = l2.start;

				} else {

					p2 = l2.end;

				}

				const closestPoint = temp1;
				const closestPoint2 = temp2;
				l1.closestPointToPoint( p2, true, temp1 );
				l2.closestPointToPoint( p, true, temp2 );

				if ( closestPoint.distanceToSquared( p2 ) <= closestPoint2.distanceToSquared( p ) ) {

					target1.copy( closestPoint );
					target2.copy( p2 );
					return;

				} else {

					target1.copy( p );
					target2.copy( closestPoint2 );
					return;

				}

			}

		};

	} )();


	const sphereIntersectTriangle = ( function () {

		// https://stackoverflow.com/questions/34043955/detect-collision-between-sphere-and-triangle-in-three-js
		const closestPointTemp = /* @__PURE__ */ new three.Vector3();
		const projectedPointTemp = /* @__PURE__ */ new three.Vector3();
		const planeTemp = /* @__PURE__ */ new three.Plane();
		const lineTemp = /* @__PURE__ */ new three.Line3();
		return function sphereIntersectTriangle( sphere, triangle ) {

			const { radius, center } = sphere;
			const { a, b, c } = triangle;

			// phase 1
			lineTemp.start = a;
			lineTemp.end = b;
			const closestPoint1 = lineTemp.closestPointToPoint( center, true, closestPointTemp );
			if ( closestPoint1.distanceTo( center ) <= radius ) return true;

			lineTemp.start = a;
			lineTemp.end = c;
			const closestPoint2 = lineTemp.closestPointToPoint( center, true, closestPointTemp );
			if ( closestPoint2.distanceTo( center ) <= radius ) return true;

			lineTemp.start = b;
			lineTemp.end = c;
			const closestPoint3 = lineTemp.closestPointToPoint( center, true, closestPointTemp );
			if ( closestPoint3.distanceTo( center ) <= radius ) return true;

			// phase 2
			const plane = triangle.getPlane( planeTemp );
			const dp = Math.abs( plane.distanceToPoint( center ) );
			if ( dp <= radius ) {

				const pp = plane.projectPoint( center, projectedPointTemp );
				const cp = triangle.containsPoint( pp );
				if ( cp ) return true;

			}

			return false;

		};

	} )();

	const componentKeys = [ 'x', 'y', 'z' ];
	const ZERO_EPSILON = 1e-15;
	const ZERO_EPSILON_SQR = ZERO_EPSILON * ZERO_EPSILON;
	function isNearZero( value ) {

		return Math.abs( value ) < ZERO_EPSILON;

	}

	class ExtendedTriangle extends three.Triangle {

		constructor( ...args ) {

			super( ...args );

			this.isExtendedTriangle = true;
			this.satAxes = new Array( 4 ).fill().map( () => new three.Vector3() );
			this.satBounds = new Array( 4 ).fill().map( () => new SeparatingAxisBounds() );
			this.points = [ this.a, this.b, this.c ];
			this.plane = new three.Plane();
			this.isDegenerateIntoSegment = false;
			this.isDegenerateIntoPoint = false;
			this.degenerateSegment = new three.Line3();
			this.needsUpdate = true;

		}

		intersectsSphere( sphere ) {

			return sphereIntersectTriangle( sphere, this );

		}

		update() {

			const a = this.a;
			const b = this.b;
			const c = this.c;
			const points = this.points;

			const satAxes = this.satAxes;
			const satBounds = this.satBounds;

			const axis0 = satAxes[ 0 ];
			const sab0 = satBounds[ 0 ];
			this.getNormal( axis0 );
			sab0.setFromPoints( axis0, points );

			const axis1 = satAxes[ 1 ];
			const sab1 = satBounds[ 1 ];
			axis1.subVectors( a, b );
			sab1.setFromPoints( axis1, points );

			const axis2 = satAxes[ 2 ];
			const sab2 = satBounds[ 2 ];
			axis2.subVectors( b, c );
			sab2.setFromPoints( axis2, points );

			const axis3 = satAxes[ 3 ];
			const sab3 = satBounds[ 3 ];
			axis3.subVectors( c, a );
			sab3.setFromPoints( axis3, points );

			const lengthAB = axis1.length();
			const lengthBC = axis2.length();
			const lengthCA = axis3.length();

			this.isDegenerateIntoPoint = false;
			this.isDegenerateIntoSegment = false;

			if ( lengthAB < ZERO_EPSILON ) {

				if ( lengthBC < ZERO_EPSILON || lengthCA < ZERO_EPSILON ) {

					this.isDegenerateIntoPoint = true;

				} else {

					this.isDegenerateIntoSegment = true;
					this.degenerateSegment.start.copy( a );
					this.degenerateSegment.end.copy( c );

				}

			} else if ( lengthBC < ZERO_EPSILON ) {

				if ( lengthCA < ZERO_EPSILON ) {

					this.isDegenerateIntoPoint = true;

				} else {

					this.isDegenerateIntoSegment = true;
					this.degenerateSegment.start.copy( b );
					this.degenerateSegment.end.copy( a );

				}

			} else if ( lengthCA < ZERO_EPSILON ) {

				this.isDegenerateIntoSegment = true;
				this.degenerateSegment.start.copy( c );
				this.degenerateSegment.end.copy( b );

			}

			this.plane.setFromNormalAndCoplanarPoint( axis0, a );

			this.needsUpdate = false;

		}

	}

	ExtendedTriangle.prototype.closestPointToSegment = ( function () {

		const point1 = /* @__PURE__ */ new three.Vector3();
		const point2 = /* @__PURE__ */ new three.Vector3();
		const edge = /* @__PURE__ */ new three.Line3();

		return function distanceToSegment( segment, target1 = null, target2 = null ) {

			const { start, end } = segment;
			const points = this.points;
			let distSq;
			let closestDistanceSq = Infinity;

			// check the triangle edges
			for ( let i = 0; i < 3; i ++ ) {

				const nexti = ( i + 1 ) % 3;
				edge.start.copy( points[ i ] );
				edge.end.copy( points[ nexti ] );

				closestPointsSegmentToSegment( edge, segment, point1, point2 );

				distSq = point1.distanceToSquared( point2 );
				if ( distSq < closestDistanceSq ) {

					closestDistanceSq = distSq;
					if ( target1 ) target1.copy( point1 );
					if ( target2 ) target2.copy( point2 );

				}

			}

			// check end points
			this.closestPointToPoint( start, point1 );
			distSq = start.distanceToSquared( point1 );
			if ( distSq < closestDistanceSq ) {

				closestDistanceSq = distSq;
				if ( target1 ) target1.copy( point1 );
				if ( target2 ) target2.copy( start );

			}

			this.closestPointToPoint( end, point1 );
			distSq = end.distanceToSquared( point1 );
			if ( distSq < closestDistanceSq ) {

				closestDistanceSq = distSq;
				if ( target1 ) target1.copy( point1 );
				if ( target2 ) target2.copy( end );

			}

			return Math.sqrt( closestDistanceSq );

		};

	} )();

	ExtendedTriangle.prototype.intersectsTriangle = ( function () {

		const saTri2 = /* @__PURE__ */ new ExtendedTriangle();
		const cachedSatBounds = /* @__PURE__ */ new SeparatingAxisBounds();
		const cachedSatBounds2 = /* @__PURE__ */ new SeparatingAxisBounds();
		const tmpVec = /* @__PURE__ */ new three.Vector3();
		const dir1 = /* @__PURE__ */ new three.Vector3();
		const dir2 = /* @__PURE__ */ new three.Vector3();
		const tempDir = /* @__PURE__ */ new three.Vector3();
		const edge1 = /* @__PURE__ */ new three.Line3();
		const edge2 = /* @__PURE__ */ new three.Line3();
		const tempPoint = /* @__PURE__ */ new three.Vector3();
		const bounds1 = /* @__PURE__ */ new three.Vector2();
		const bounds2 = /* @__PURE__ */ new three.Vector2();

		function coplanarIntersectsTriangle( self, other, target, suppressLog ) {

			// Perform separating axis intersection test only for coplanar triangles
			// There should be at least one non-degenerate triangle when calling this
			// Otherwise we won't know the plane normal
			const planeNormal = tmpVec;
			if ( ! self.isDegenerateIntoPoint && ! self.isDegenerateIntoSegment ) {

				planeNormal.copy( self.plane.normal );

			} else {

				planeNormal.copy( other.plane.normal );

			}

			const satBounds1 = self.satBounds;
			const satAxes1 = self.satAxes;
			for ( let i = 1; i < 4; i ++ ) {

				const sb = satBounds1[ i ];
				const sa = satAxes1[ i ];
				cachedSatBounds.setFromPoints( sa, other.points );
				if ( sb.isSeparated( cachedSatBounds ) ) return false;

				tempDir.copy( planeNormal ).cross( sa );
				cachedSatBounds.setFromPoints( tempDir, self.points );
				cachedSatBounds2.setFromPoints( tempDir, other.points );
				if ( cachedSatBounds.isSeparated( cachedSatBounds2 ) ) return false;

			}

			const satBounds2 = other.satBounds;
			const satAxes2 = other.satAxes;
			for ( let i = 1; i < 4; i ++ ) {

				const sb = satBounds2[ i ];
				const sa = satAxes2[ i ];
				cachedSatBounds.setFromPoints( sa, self.points );
				if ( sb.isSeparated( cachedSatBounds ) ) return false;

				tempDir.crossVectors( planeNormal, sa );
				cachedSatBounds.setFromPoints( tempDir, self.points );
				cachedSatBounds2.setFromPoints( tempDir, other.points );
				if ( cachedSatBounds.isSeparated( cachedSatBounds2 ) ) return false;

			}

			if ( target ) {

				// TODO find two points that intersect on the edges and make that the result
				if ( ! suppressLog ) {

					console.warn( 'ExtendedTriangle.intersectsTriangle: Triangles are coplanar which does not support an output edge. Setting edge to 0, 0, 0.' );

				}

				target.start.set( 0, 0, 0 );
				target.end.set( 0, 0, 0 );

			}

			return true;

		}

		function findSingleBounds( a, b, c, aProj, bProj, cProj, aDist, bDist, cDist, bounds, edge ) {

			let t = aDist / ( aDist - bDist );
			bounds.x = aProj + ( bProj - aProj ) * t;
			edge.start.subVectors( b, a ).multiplyScalar( t ).add( a );

			t = aDist / ( aDist - cDist );
			bounds.y = aProj + ( cProj - aProj ) * t;
			edge.end.subVectors( c, a ).multiplyScalar( t ).add( a );

		}

		/**
		 * Calculates intersection segment of a triangle with intersection line.
		 * Intersection line is snapped to its biggest component.
		 * And triangle points are passed as a projection on that component.
		 * @returns whether this is a coplanar case or not
		 */
		function findIntersectionLineBounds( self, aProj, bProj, cProj, abDist, acDist, aDist, bDist, cDist, bounds, edge ) {

			if ( abDist > 0 ) {

				// then bcDist < 0
				findSingleBounds( self.c, self.a, self.b, cProj, aProj, bProj, cDist, aDist, bDist, bounds, edge );

			} else if ( acDist > 0 ) {

				findSingleBounds( self.b, self.a, self.c, bProj, aProj, cProj, bDist, aDist, cDist, bounds, edge );

			} else if ( bDist * cDist > 0 || aDist != 0 ) {

				findSingleBounds( self.a, self.b, self.c, aProj, bProj, cProj, aDist, bDist, cDist, bounds, edge );

			} else if ( bDist != 0 ) {

				findSingleBounds( self.b, self.a, self.c, bProj, aProj, cProj, bDist, aDist, cDist, bounds, edge );

			} else if ( cDist != 0 ) {

				findSingleBounds( self.c, self.a, self.b, cProj, aProj, bProj, cDist, aDist, bDist, bounds, edge );

			} else {

				return true;

			}

			return false;

		}

		function intersectTriangleSegment( triangle, degenerateTriangle, target, suppressLog ) {

			const segment = degenerateTriangle.degenerateSegment;
			const startDist = triangle.plane.distanceToPoint( segment.start );
			const endDist = triangle.plane.distanceToPoint( segment.end );
			if ( isNearZero( startDist ) ) {

				if ( isNearZero( endDist ) ) {

					return coplanarIntersectsTriangle( triangle, degenerateTriangle, target, suppressLog );

				} else {

					// Is this fine to modify target even if there might be no intersection?
					if ( target ) {

						target.start.copy( segment.start );
						target.end.copy( segment.start );

					}

					return triangle.containsPoint( segment.start );

				}

			} else if ( isNearZero( endDist ) ) {

				if ( target ) {

					target.start.copy( segment.end );
					target.end.copy( segment.end );

				}

				return triangle.containsPoint( segment.end );

			} else {

				if ( triangle.plane.intersectLine( segment, tmpVec ) != null ) {

					if ( target ) {

						target.start.copy( tmpVec );
						target.end.copy( tmpVec );

					}

					return triangle.containsPoint( tmpVec );

				} else {

					return false;

				}

			}

		}

		function intersectTrianglePoint( triangle, degenerateTriangle, target ) {

			const point = degenerateTriangle.a;

			if ( isNearZero( triangle.plane.distanceToPoint( point ) ) && triangle.containsPoint( point ) ) {

				if ( target ) {

					target.start.copy( point );
					target.end.copy( point );

				}

				return true;

			} else {

				return false;

			}

		}

		function intersectSegmentPoint( segmentTri, pointTri, target ) {

			const segment = segmentTri.degenerateSegment;
			const point = pointTri.a;

			segment.closestPointToPoint( point, true, tmpVec );

			if ( point.distanceToSquared( tmpVec ) < ZERO_EPSILON_SQR ) {

				if ( target ) {

					target.start.copy( point );
					target.end.copy( point );

				}

				return true;

			} else {

				return false;

			}

		}

		function handleDegenerateCases( self, other, target, suppressLog ) {

			if ( self.isDegenerateIntoSegment ) {

				if ( other.isDegenerateIntoSegment ) {

					// TODO: replace with Line.distanceSqToLine3 after r179
					const segment1 = self.degenerateSegment;
					const segment2 = other.degenerateSegment;
					const delta1 = dir1;
					const delta2 = dir2;
					segment1.delta( delta1 );
					segment2.delta( delta2 );
					const startDelta = tmpVec.subVectors( segment2.start, segment1.start );

					const denom = delta1.x * delta2.y - delta1.y * delta2.x;
					if ( isNearZero( denom ) ) {

						return false;

					}

					const t = ( startDelta.x * delta2.y - startDelta.y * delta2.x ) / denom;
					const u = - ( delta1.x * startDelta.y - delta1.y * startDelta.x ) / denom;

					if ( t < 0 || t > 1 || u < 0 || u > 1 ) {

						return false;

					}

					const z1 = segment1.start.z + delta1.z * t;
					const z2 = segment2.start.z + delta2.z * u;

					if ( isNearZero( z1 - z2 ) ) {

						if ( target ) {

							target.start.copy( segment1.start ).addScaledVector( delta1, t );
							target.end.copy( segment1.start ).addScaledVector( delta1, t );

						}

						return true;

					} else {

						return false;

					}

				} else if ( other.isDegenerateIntoPoint ) {

					return intersectSegmentPoint( self, other, target );

				} else {

					return intersectTriangleSegment( other, self, target, suppressLog );

				}

			} else if ( self.isDegenerateIntoPoint ) {

				if ( other.isDegenerateIntoPoint ) {

					if ( other.a.distanceToSquared( self.a ) < ZERO_EPSILON_SQR ) {

						if ( target ) {

							target.start.copy( self.a );
							target.end.copy( self.a );

						}

						return true;

					} else {

						return false;

					}

				} else if ( other.isDegenerateIntoSegment ) {

					return intersectSegmentPoint( other, self, target );

				} else {

					return intersectTrianglePoint( other, self, target );

				}

			} else {

				if ( other.isDegenerateIntoPoint ) {

					return intersectTrianglePoint( self, other, target );

				} else if ( other.isDegenerateIntoSegment ) {

					return intersectTriangleSegment( self, other, target, suppressLog );

				} /* else this is a general triangle-traingle case, so return undefined */

			}

		}

		/* TODO: If the triangles are coplanar and intersecting the target is nonsensical. It should at least
		 * be a line contained by both triangles if not a different special case somehow represented in the return result.
		 *
		 * General triangle intersection code is based on Moller's algorithm from here: https://web.stanford.edu/class/cs277/resources/papers/Moller1997b.pdf
		 * Reference implementation from here: https://github.com/erich666/jgt-code/blob/master/Volume_08/Number_1/Shen2003/tri_tri_test/include/Moller97.c#L570
		 * All degeneracies are handled before the general algorithm.
		 * Coplanar check is different from Moller's and based on SAT tests.
		 */
		return function intersectsTriangle( other, target = null, suppressLog = false ) {

			if ( this.needsUpdate ) {

				this.update();

			}

			if ( ! other.isExtendedTriangle ) {

				saTri2.copy( other );
				saTri2.update();
				other = saTri2;

			} else if ( other.needsUpdate ) {

				other.update();

			}

			const res = handleDegenerateCases( this, other, target, suppressLog );
			if ( res !== undefined ) {

				return res;

			}

			const plane1 = this.plane;
			const plane2 = other.plane;

			let a1Dist = plane2.distanceToPoint( this.a );
			let b1Dist = plane2.distanceToPoint( this.b );
			let c1Dist = plane2.distanceToPoint( this.c );

			if ( isNearZero( a1Dist ) )
				a1Dist = 0;

			if ( isNearZero( b1Dist ) )
				b1Dist = 0;

			if ( isNearZero( c1Dist ) )
				c1Dist = 0;

			const a1b1Dist = a1Dist * b1Dist;
			const a1c1Dist = a1Dist * c1Dist;
			if ( a1b1Dist > 0 && a1c1Dist > 0 ) {

				return false;

			}

			let a2Dist = plane1.distanceToPoint( other.a );
			let b2Dist = plane1.distanceToPoint( other.b );
			let c2Dist = plane1.distanceToPoint( other.c );

			if ( isNearZero( a2Dist ) )
				a2Dist = 0;

			if ( isNearZero( b2Dist ) )
				b2Dist = 0;

			if ( isNearZero( c2Dist ) )
				c2Dist = 0;

			const a2b2Dist = a2Dist * b2Dist;
			const a2c2Dist = a2Dist * c2Dist;
			if ( a2b2Dist > 0 && a2c2Dist > 0 ) {

				return false;

			}

			dir1.copy( plane1.normal );
			dir2.copy( plane2.normal );
			const intersectionLine = dir1.cross( dir2 );

			let componentIndex = 0;
			let maxComponent = Math.abs( intersectionLine.x );
			const comp1 = Math.abs( intersectionLine.y );
			if ( comp1 > maxComponent ) {

				maxComponent = comp1;
				componentIndex = 1;

			}

			const comp2 = Math.abs( intersectionLine.z );
			if ( comp2 > maxComponent ) {

				componentIndex = 2;

			}

			const key = componentKeys[ componentIndex ];
			const a1Proj = this.a[ key ];
			const b1Proj = this.b[ key ];
			const c1Proj = this.c[ key ];

			const a2Proj = other.a[ key ];
			const b2Proj = other.b[ key ];
			const c2Proj = other.c[ key ];

			if ( findIntersectionLineBounds( this, a1Proj, b1Proj, c1Proj, a1b1Dist, a1c1Dist, a1Dist, b1Dist, c1Dist, bounds1, edge1 ) ) {

				return coplanarIntersectsTriangle( this, other, target, suppressLog );

			}

			if ( findIntersectionLineBounds( other, a2Proj, b2Proj, c2Proj, a2b2Dist, a2c2Dist, a2Dist, b2Dist, c2Dist, bounds2, edge2 ) ) {

				return coplanarIntersectsTriangle( this, other, target, suppressLog );

			}

			if ( bounds1.y < bounds1.x ) {

				const tmp = bounds1.y;
				bounds1.y = bounds1.x;
				bounds1.x = tmp;

				tempPoint.copy( edge1.start );
				edge1.start.copy( edge1.end );
				edge1.end.copy( tempPoint );

			}

			if ( bounds2.y < bounds2.x ) {

				const tmp = bounds2.y;
				bounds2.y = bounds2.x;
				bounds2.x = tmp;

				tempPoint.copy( edge2.start );
				edge2.start.copy( edge2.end );
				edge2.end.copy( tempPoint );

			}

			if ( bounds1.y < bounds2.x || bounds2.y < bounds1.x ) {

				return false;

			}

			if ( target ) {

				if ( bounds2.x > bounds1.x ) {

					target.start.copy( edge2.start );

				} else {

					target.start.copy( edge1.start );

				}

				if ( bounds2.y < bounds1.y ) {

					target.end.copy( edge2.end );

				} else {

					target.end.copy( edge1.end );

				}

			}

			return true;

		};

	} )();


	ExtendedTriangle.prototype.distanceToPoint = ( function () {

		const target = /* @__PURE__ */ new three.Vector3();
		return function distanceToPoint( point ) {

			this.closestPointToPoint( point, target );
			return point.distanceTo( target );

		};

	} )();


	ExtendedTriangle.prototype.distanceToTriangle = ( function () {

		const point = /* @__PURE__ */ new three.Vector3();
		const point2 = /* @__PURE__ */ new three.Vector3();
		const cornerFields = [ 'a', 'b', 'c' ];
		const line1 = /* @__PURE__ */ new three.Line3();
		const line2 = /* @__PURE__ */ new three.Line3();

		return function distanceToTriangle( other, target1 = null, target2 = null ) {

			const lineTarget = target1 || target2 ? line1 : null;
			if ( this.intersectsTriangle( other, lineTarget ) ) {

				if ( target1 || target2 ) {

					if ( target1 ) lineTarget.getCenter( target1 );
					if ( target2 ) lineTarget.getCenter( target2 );

				}

				return 0;

			}

			let closestDistanceSq = Infinity;

			// check all point distances
			for ( let i = 0; i < 3; i ++ ) {

				let dist;
				const field = cornerFields[ i ];
				const otherVec = other[ field ];
				this.closestPointToPoint( otherVec, point );

				dist = otherVec.distanceToSquared( point );

				if ( dist < closestDistanceSq ) {

					closestDistanceSq = dist;
					if ( target1 ) target1.copy( point );
					if ( target2 ) target2.copy( otherVec );

				}


				const thisVec = this[ field ];
				other.closestPointToPoint( thisVec, point );

				dist = thisVec.distanceToSquared( point );

				if ( dist < closestDistanceSq ) {

					closestDistanceSq = dist;
					if ( target1 ) target1.copy( thisVec );
					if ( target2 ) target2.copy( point );

				}

			}

			for ( let i = 0; i < 3; i ++ ) {

				const f11 = cornerFields[ i ];
				const f12 = cornerFields[ ( i + 1 ) % 3 ];
				line1.set( this[ f11 ], this[ f12 ] );
				for ( let i2 = 0; i2 < 3; i2 ++ ) {

					const f21 = cornerFields[ i2 ];
					const f22 = cornerFields[ ( i2 + 1 ) % 3 ];
					line2.set( other[ f21 ], other[ f22 ] );

					closestPointsSegmentToSegment( line1, line2, point, point2 );

					const dist = point.distanceToSquared( point2 );
					if ( dist < closestDistanceSq ) {

						closestDistanceSq = dist;
						if ( target1 ) target1.copy( point );
						if ( target2 ) target2.copy( point2 );

					}

				}

			}

			return Math.sqrt( closestDistanceSq );

		};

	} )();

	class OrientedBox {

		constructor( min, max, matrix ) {

			this.isOrientedBox = true;
			this.min = new three.Vector3();
			this.max = new three.Vector3();
			this.matrix = new three.Matrix4();
			this.invMatrix = new three.Matrix4();
			this.points = new Array( 8 ).fill().map( () => new three.Vector3() );
			this.satAxes = new Array( 3 ).fill().map( () => new three.Vector3() );
			this.satBounds = new Array( 3 ).fill().map( () => new SeparatingAxisBounds() );
			this.alignedSatBounds = new Array( 3 ).fill().map( () => new SeparatingAxisBounds() );
			this.needsUpdate = false;

			if ( min ) this.min.copy( min );
			if ( max ) this.max.copy( max );
			if ( matrix ) this.matrix.copy( matrix );

		}

		set( min, max, matrix ) {

			this.min.copy( min );
			this.max.copy( max );
			this.matrix.copy( matrix );
			this.needsUpdate = true;

		}

		copy( other ) {

			this.min.copy( other.min );
			this.max.copy( other.max );
			this.matrix.copy( other.matrix );
			this.needsUpdate = true;

		}

	}

	OrientedBox.prototype.update = ( function () {

		return function update() {

			const matrix = this.matrix;
			const min = this.min;
			const max = this.max;

			const points = this.points;
			for ( let x = 0; x <= 1; x ++ ) {

				for ( let y = 0; y <= 1; y ++ ) {

					for ( let z = 0; z <= 1; z ++ ) {

						const i = ( ( 1 << 0 ) * x ) | ( ( 1 << 1 ) * y ) | ( ( 1 << 2 ) * z );
						const v = points[ i ];
						v.x = x ? max.x : min.x;
						v.y = y ? max.y : min.y;
						v.z = z ? max.z : min.z;

						v.applyMatrix4( matrix );

					}

				}

			}

			const satBounds = this.satBounds;
			const satAxes = this.satAxes;
			const minVec = points[ 0 ];
			for ( let i = 0; i < 3; i ++ ) {

				const axis = satAxes[ i ];
				const sb = satBounds[ i ];
				const index = 1 << i;
				const pi = points[ index ];

				axis.subVectors( minVec, pi );
				sb.setFromPoints( axis, points );

			}

			const alignedSatBounds = this.alignedSatBounds;
			alignedSatBounds[ 0 ].setFromPointsField( points, 'x' );
			alignedSatBounds[ 1 ].setFromPointsField( points, 'y' );
			alignedSatBounds[ 2 ].setFromPointsField( points, 'z' );

			this.invMatrix.copy( this.matrix ).invert();
			this.needsUpdate = false;

		};

	} )();

	OrientedBox.prototype.intersectsBox = ( function () {

		const aabbBounds = /* @__PURE__ */ new SeparatingAxisBounds();
		return function intersectsBox( box ) {

			// TODO: should this be doing SAT against the AABB?
			if ( this.needsUpdate ) {

				this.update();

			}

			const min = box.min;
			const max = box.max;
			const satBounds = this.satBounds;
			const satAxes = this.satAxes;
			const alignedSatBounds = this.alignedSatBounds;

			aabbBounds.min = min.x;
			aabbBounds.max = max.x;
			if ( alignedSatBounds[ 0 ].isSeparated( aabbBounds ) ) return false;

			aabbBounds.min = min.y;
			aabbBounds.max = max.y;
			if ( alignedSatBounds[ 1 ].isSeparated( aabbBounds ) ) return false;

			aabbBounds.min = min.z;
			aabbBounds.max = max.z;
			if ( alignedSatBounds[ 2 ].isSeparated( aabbBounds ) ) return false;

			for ( let i = 0; i < 3; i ++ ) {

				const axis = satAxes[ i ];
				const sb = satBounds[ i ];
				aabbBounds.setFromBox( axis, box );
				if ( sb.isSeparated( aabbBounds ) ) return false;

			}

			return true;

		};

	} )();

	OrientedBox.prototype.intersectsTriangle = ( function () {

		const saTri = /* @__PURE__ */ new ExtendedTriangle();
		const pointsArr = /* @__PURE__ */ new Array( 3 );
		const cachedSatBounds = /* @__PURE__ */ new SeparatingAxisBounds();
		const cachedSatBounds2 = /* @__PURE__ */ new SeparatingAxisBounds();
		const cachedAxis = /* @__PURE__ */ new three.Vector3();
		return function intersectsTriangle( triangle ) {

			if ( this.needsUpdate ) {

				this.update();

			}

			if ( ! triangle.isExtendedTriangle ) {

				saTri.copy( triangle );
				saTri.update();
				triangle = saTri;

			} else if ( triangle.needsUpdate ) {

				triangle.update();

			}

			const satBounds = this.satBounds;
			const satAxes = this.satAxes;

			pointsArr[ 0 ] = triangle.a;
			pointsArr[ 1 ] = triangle.b;
			pointsArr[ 2 ] = triangle.c;

			for ( let i = 0; i < 3; i ++ ) {

				const sb = satBounds[ i ];
				const sa = satAxes[ i ];
				cachedSatBounds.setFromPoints( sa, pointsArr );
				if ( sb.isSeparated( cachedSatBounds ) ) return false;

			}

			const triSatBounds = triangle.satBounds;
			const triSatAxes = triangle.satAxes;
			const points = this.points;
			for ( let i = 0; i < 3; i ++ ) {

				const sb = triSatBounds[ i ];
				const sa = triSatAxes[ i ];
				cachedSatBounds.setFromPoints( sa, points );
				if ( sb.isSeparated( cachedSatBounds ) ) return false;

			}

			// check crossed axes
			for ( let i = 0; i < 3; i ++ ) {

				const sa1 = satAxes[ i ];
				for ( let i2 = 0; i2 < 4; i2 ++ ) {

					const sa2 = triSatAxes[ i2 ];
					cachedAxis.crossVectors( sa1, sa2 );
					cachedSatBounds.setFromPoints( cachedAxis, pointsArr );
					cachedSatBounds2.setFromPoints( cachedAxis, points );
					if ( cachedSatBounds.isSeparated( cachedSatBounds2 ) ) return false;

				}

			}

			return true;

		};

	} )();

	OrientedBox.prototype.closestPointToPoint = ( function () {

		return function closestPointToPoint( point, target1 ) {

			if ( this.needsUpdate ) {

				this.update();

			}

			target1
				.copy( point )
				.applyMatrix4( this.invMatrix )
				.clamp( this.min, this.max )
				.applyMatrix4( this.matrix );

			return target1;

		};

	} )();

	OrientedBox.prototype.distanceToPoint = ( function () {

		const target = new three.Vector3();
		return function distanceToPoint( point ) {

			this.closestPointToPoint( point, target );
			return point.distanceTo( target );

		};

	} )();

	OrientedBox.prototype.distanceToBox = ( function () {

		const xyzFields = [ 'x', 'y', 'z' ];
		const segments1 = /* @__PURE__ */ new Array( 12 ).fill().map( () => new three.Line3() );
		const segments2 = /* @__PURE__ */ new Array( 12 ).fill().map( () => new three.Line3() );

		const point1 = /* @__PURE__ */ new three.Vector3();
		const point2 = /* @__PURE__ */ new three.Vector3();

		// early out if we find a value below threshold
		return function distanceToBox( box, threshold = 0, target1 = null, target2 = null ) {

			if ( this.needsUpdate ) {

				this.update();

			}

			if ( this.intersectsBox( box ) ) {

				if ( target1 || target2 ) {

					box.getCenter( point2 );
					this.closestPointToPoint( point2, point1 );
					box.closestPointToPoint( point1, point2 );

					if ( target1 ) target1.copy( point1 );
					if ( target2 ) target2.copy( point2 );

				}

				return 0;

			}

			const threshold2 = threshold * threshold;
			const min = box.min;
			const max = box.max;
			const points = this.points;


			// iterate over every edge and compare distances
			let closestDistanceSq = Infinity;

			// check over all these points
			for ( let i = 0; i < 8; i ++ ) {

				const p = points[ i ];
				point2.copy( p ).clamp( min, max );

				const dist = p.distanceToSquared( point2 );
				if ( dist < closestDistanceSq ) {

					closestDistanceSq = dist;
					if ( target1 ) target1.copy( p );
					if ( target2 ) target2.copy( point2 );

					if ( dist < threshold2 ) return Math.sqrt( dist );

				}

			}

			// generate and check all line segment distances
			let count = 0;
			for ( let i = 0; i < 3; i ++ ) {

				for ( let i1 = 0; i1 <= 1; i1 ++ ) {

					for ( let i2 = 0; i2 <= 1; i2 ++ ) {

						const nextIndex = ( i + 1 ) % 3;
						const nextIndex2 = ( i + 2 ) % 3;

						// get obb line segments
						const index = i1 << nextIndex | i2 << nextIndex2;
						const index2 = 1 << i | i1 << nextIndex | i2 << nextIndex2;
						const p1 = points[ index ];
						const p2 = points[ index2 ];
						const line1 = segments1[ count ];
						line1.set( p1, p2 );


						// get aabb line segments
						const f1 = xyzFields[ i ];
						const f2 = xyzFields[ nextIndex ];
						const f3 = xyzFields[ nextIndex2 ];
						const line2 = segments2[ count ];
						const start = line2.start;
						const end = line2.end;

						start[ f1 ] = min[ f1 ];
						start[ f2 ] = i1 ? min[ f2 ] : max[ f2 ];
						start[ f3 ] = i2 ? min[ f3 ] : max[ f2 ];

						end[ f1 ] = max[ f1 ];
						end[ f2 ] = i1 ? min[ f2 ] : max[ f2 ];
						end[ f3 ] = i2 ? min[ f3 ] : max[ f2 ];

						count ++;

					}

				}

			}

			// check all the other boxes point
			for ( let x = 0; x <= 1; x ++ ) {

				for ( let y = 0; y <= 1; y ++ ) {

					for ( let z = 0; z <= 1; z ++ ) {

						point2.x = x ? max.x : min.x;
						point2.y = y ? max.y : min.y;
						point2.z = z ? max.z : min.z;

						this.closestPointToPoint( point2, point1 );
						const dist = point2.distanceToSquared( point1 );
						if ( dist < closestDistanceSq ) {

							closestDistanceSq = dist;
							if ( target1 ) target1.copy( point1 );
							if ( target2 ) target2.copy( point2 );

							if ( dist < threshold2 ) return Math.sqrt( dist );

						}

					}

				}

			}

			for ( let i = 0; i < 12; i ++ ) {

				const l1 = segments1[ i ];
				for ( let i2 = 0; i2 < 12; i2 ++ ) {

					const l2 = segments2[ i2 ];
					closestPointsSegmentToSegment( l1, l2, point1, point2 );
					const dist = point1.distanceToSquared( point2 );
					if ( dist < closestDistanceSq ) {

						closestDistanceSq = dist;
						if ( target1 ) target1.copy( point1 );
						if ( target2 ) target2.copy( point2 );

						if ( dist < threshold2 ) return Math.sqrt( dist );

					}

				}

			}

			return Math.sqrt( closestDistanceSq );

		};

	} )();

	class ExtendedTrianglePoolBase extends PrimitivePool {

		constructor() {

			super( () => new ExtendedTriangle() );

		}

	}

	const ExtendedTrianglePool = /* @__PURE__ */ new ExtendedTrianglePoolBase();

	const temp = /* @__PURE__ */ new three.Vector3();
	const temp1$2 = /* @__PURE__ */ new three.Vector3();

	function closestPointToPoint(
		bvh,
		point,
		target = { },
		minThreshold = 0,
		maxThreshold = Infinity,
	) {

		// early out if under minThreshold
		// skip checking if over maxThreshold
		// set minThreshold = maxThreshold to quickly check if a point is within a threshold
		// returns Infinity if no value found
		const minThresholdSq = minThreshold * minThreshold;
		const maxThresholdSq = maxThreshold * maxThreshold;
		let closestDistanceSq = Infinity;
		let closestDistanceTriIndex = null;
		bvh.shapecast(

			{

				boundsTraverseOrder: box => {

					temp.copy( point ).clamp( box.min, box.max );
					return temp.distanceToSquared( point );

				},

				intersectsBounds: ( box, isLeaf, score ) => {

					return score < closestDistanceSq && score < maxThresholdSq;

				},

				intersectsTriangle: ( tri, triIndex ) => {

					tri.closestPointToPoint( point, temp );
					const distSq = point.distanceToSquared( temp );
					if ( distSq < closestDistanceSq ) {

						temp1$2.copy( temp );
						closestDistanceSq = distSq;
						closestDistanceTriIndex = triIndex;

					}

					if ( distSq < minThresholdSq ) {

						return true;

					} else {

						return false;

					}

				},

			}

		);

		if ( closestDistanceSq === Infinity ) return null;

		const closestDistance = Math.sqrt( closestDistanceSq );

		if ( ! target.point ) target.point = temp1$2.clone();
		else target.point.copy( temp1$2 );
		target.distance = closestDistance,
		target.faceIndex = closestDistanceTriIndex;

		return target;

	}

	const IS_GT_REVISION_169 = parseInt( three.REVISION ) >= 169;
	const IS_LT_REVISION_161 = parseInt( three.REVISION ) <= 161;

	// Ripped and modified From THREE.js Mesh raycast
	// https://github.com/mrdoob/three.js/blob/0aa87c999fe61e216c1133fba7a95772b503eddf/src/objects/Mesh.js#L115
	const _vA = /* @__PURE__ */ new three.Vector3();
	const _vB = /* @__PURE__ */ new three.Vector3();
	const _vC = /* @__PURE__ */ new three.Vector3();

	const _uvA = /* @__PURE__ */ new three.Vector2();
	const _uvB = /* @__PURE__ */ new three.Vector2();
	const _uvC = /* @__PURE__ */ new three.Vector2();

	const _normalA = /* @__PURE__ */ new three.Vector3();
	const _normalB = /* @__PURE__ */ new three.Vector3();
	const _normalC = /* @__PURE__ */ new three.Vector3();

	const _intersectionPoint = /* @__PURE__ */ new three.Vector3();
	function checkIntersection( ray, pA, pB, pC, point, side, near, far ) {

		let intersect;
		if ( side === three.BackSide ) {

			intersect = ray.intersectTriangle( pC, pB, pA, true, point );

		} else {

			intersect = ray.intersectTriangle( pA, pB, pC, side !== three.DoubleSide, point );

		}

		if ( intersect === null ) return null;

		const distance = ray.origin.distanceTo( point );

		if ( distance < near || distance > far ) return null;

		return {

			distance: distance,
			point: point.clone(),

		};

	}

	function checkBufferGeometryIntersection( ray, position, normal, uv, uv1, a, b, c, side, near, far ) {

		_vA.fromBufferAttribute( position, a );
		_vB.fromBufferAttribute( position, b );
		_vC.fromBufferAttribute( position, c );

		const intersection = checkIntersection( ray, _vA, _vB, _vC, _intersectionPoint, side, near, far );

		if ( intersection ) {

			if ( uv ) {

				_uvA.fromBufferAttribute( uv, a );
				_uvB.fromBufferAttribute( uv, b );
				_uvC.fromBufferAttribute( uv, c );

				intersection.uv = new three.Vector2();
				const res = three.Triangle.getInterpolation( _intersectionPoint, _vA, _vB, _vC, _uvA, _uvB, _uvC, intersection.uv );
				if ( ! IS_GT_REVISION_169 ) {

					intersection.uv = res;

				}

			}

			if ( uv1 ) {

				_uvA.fromBufferAttribute( uv1, a );
				_uvB.fromBufferAttribute( uv1, b );
				_uvC.fromBufferAttribute( uv1, c );

				intersection.uv1 = new three.Vector2();
				const res = three.Triangle.getInterpolation( _intersectionPoint, _vA, _vB, _vC, _uvA, _uvB, _uvC, intersection.uv1 );
				if ( ! IS_GT_REVISION_169 ) {

					intersection.uv1 = res;

				}

				if ( IS_LT_REVISION_161 ) {

					intersection.uv2 = intersection.uv1;

				}

			}

			if ( normal ) {

				_normalA.fromBufferAttribute( normal, a );
				_normalB.fromBufferAttribute( normal, b );
				_normalC.fromBufferAttribute( normal, c );

				intersection.normal = new three.Vector3();
				const res = three.Triangle.getInterpolation( _intersectionPoint, _vA, _vB, _vC, _normalA, _normalB, _normalC, intersection.normal );
				if ( intersection.normal.dot( ray.direction ) > 0 ) {

					intersection.normal.multiplyScalar( - 1 );

				}

				if ( ! IS_GT_REVISION_169 ) {

					intersection.normal = res;

				}

			}

			const face = {
				a: a,
				b: b,
				c: c,
				normal: new three.Vector3(),
				materialIndex: 0
			};

			three.Triangle.getNormal( _vA, _vB, _vC, face.normal );

			intersection.face = face;
			intersection.faceIndex = a;

			if ( IS_GT_REVISION_169 ) {

				const barycoord = new three.Vector3();
				three.Triangle.getBarycoord( _intersectionPoint, _vA, _vB, _vC, barycoord );

				intersection.barycoord = barycoord;

			}

		}

		return intersection;

	}

	function getSide( materialOrSide ) {

		return materialOrSide && materialOrSide.isMaterial ? materialOrSide.side : materialOrSide;

	}

	// https://github.com/mrdoob/three.js/blob/0aa87c999fe61e216c1133fba7a95772b503eddf/src/objects/Mesh.js#L258
	function intersectTri( geometry, materialOrSide, ray, tri, intersections, near, far ) {

		const triOffset = tri * 3;
		let a = triOffset + 0;
		let b = triOffset + 1;
		let c = triOffset + 2;

		const { index, groups } = geometry;
		if ( geometry.index ) {

			a = index.getX( a );
			b = index.getX( b );
			c = index.getX( c );

		}

		const { position, normal, uv, uv1 } = geometry.attributes;
		if ( Array.isArray( materialOrSide ) ) {

			// check which groups a triangle is present in and run the intersections
			// TODO: we shouldn't need to run and intersection test multiple times
			const firstIndex = tri * 3;
			for ( let i = 0, l = groups.length; i < l; i ++ ) {

				const { start, count, materialIndex } = groups[ i ];
				if ( firstIndex >= start && firstIndex < start + count ) {

					const side = getSide( materialOrSide[ materialIndex ] );
					const intersection = checkBufferGeometryIntersection( ray, position, normal, uv, uv1, a, b, c, side, near, far );
					if ( intersection ) {

						intersection.faceIndex = tri;
						intersection.face.materialIndex = materialIndex;

						if ( intersections ) {

							intersections.push( intersection );

						} else {

							return intersection;

						}

					}

				}

			}

		} else {

			// run the intersection for the single material
			const side = getSide( materialOrSide );
			const intersection = checkBufferGeometryIntersection( ray, position, normal, uv, uv1, a, b, c, side, near, far );
			if ( intersection ) {

				intersection.faceIndex = tri;
				intersection.face.materialIndex = 0;

				if ( intersections ) {

					intersections.push( intersection );

				} else {

					return intersection;

				}

			}

		}

		return null;

	}

	// sets the vertices of triangle `tri` with the 3 vertices after i
	function setTriangle( tri, i, index, pos ) {

		const ta = tri.a;
		const tb = tri.b;
		const tc = tri.c;

		let i0 = i;
		let i1 = i + 1;
		let i2 = i + 2;
		if ( index ) {

			i0 = index.getX( i0 );
			i1 = index.getX( i1 );
			i2 = index.getX( i2 );

		}

		ta.x = pos.getX( i0 );
		ta.y = pos.getY( i0 );
		ta.z = pos.getZ( i0 );

		tb.x = pos.getX( i1 );
		tb.y = pos.getY( i1 );
		tb.z = pos.getZ( i1 );

		tc.x = pos.getX( i2 );
		tc.y = pos.getY( i2 );
		tc.z = pos.getZ( i2 );

	}

	const tempV1 = /* @__PURE__ */ new three.Vector3();
	const tempV2 = /* @__PURE__ */ new three.Vector3();
	const tempV3 = /* @__PURE__ */ new three.Vector3();
	const tempUV1 = /* @__PURE__ */ new three.Vector2();
	const tempUV2 = /* @__PURE__ */ new three.Vector2();
	const tempUV3 = /* @__PURE__ */ new three.Vector2();

	function getTriangleHitPointInfo( point, geometry, triangleIndex, target ) {

		const indices = geometry.getIndex().array;
		const positions = geometry.getAttribute( 'position' );
		const uvs = geometry.getAttribute( 'uv' );

		const a = indices[ triangleIndex * 3 ];
		const b = indices[ triangleIndex * 3 + 1 ];
		const c = indices[ triangleIndex * 3 + 2 ];

		tempV1.fromBufferAttribute( positions, a );
		tempV2.fromBufferAttribute( positions, b );
		tempV3.fromBufferAttribute( positions, c );

		// find the associated material index
		let materialIndex = 0;
		const groups = geometry.groups;
		const firstVertexIndex = triangleIndex * 3;
		for ( let i = 0, l = groups.length; i < l; i ++ ) {

			const group = groups[ i ];
			const { start, count } = group;
			if ( firstVertexIndex >= start && firstVertexIndex < start + count ) {

				materialIndex = group.materialIndex;
				break;

			}

		}

		// extract barycoord
		const barycoord = target && target.barycoord ? target.barycoord : new three.Vector3();
		three.Triangle.getBarycoord( point, tempV1, tempV2, tempV3, barycoord );

		// extract uvs
		let uv = null;
		if ( uvs ) {

			tempUV1.fromBufferAttribute( uvs, a );
			tempUV2.fromBufferAttribute( uvs, b );
			tempUV3.fromBufferAttribute( uvs, c );

			if ( target && target.uv ) uv = target.uv;
			else uv = new three.Vector2();

			three.Triangle.getInterpolation( point, tempV1, tempV2, tempV3, tempUV1, tempUV2, tempUV3, uv );

		}

		// adjust the provided target or create a new one
		if ( target ) {

			if ( ! target.face ) target.face = { };
			target.face.a = a;
			target.face.b = b;
			target.face.c = c;
			target.face.materialIndex = materialIndex;
			if ( ! target.face.normal ) target.face.normal = new three.Vector3();
			three.Triangle.getNormal( tempV1, tempV2, tempV3, target.face.normal );

			if ( uv ) target.uv = uv;
			target.barycoord = barycoord;

			return target;

		} else {

			return {
				face: {
					a: a,
					b: b,
					c: c,
					materialIndex: materialIndex,
					normal: three.Triangle.getNormal( tempV1, tempV2, tempV3, new three.Vector3() )
				},
				uv: uv,
				barycoord: barycoord,
			};

		}

	}

	/*************************************************************/
	/* This file is generated from "iterationUtils.template.js". */
	/*************************************************************/

	function intersectTris( bvh, materialOrSide, ray, offset, count, intersections, near, far ) {

		const { geometry, _indirectBuffer } = bvh;
		for ( let i = offset, end = offset + count; i < end; i ++ ) {


			intersectTri( geometry, materialOrSide, ray, i, intersections, near, far );


		}

	}

	function intersectClosestTri( bvh, materialOrSide, ray, offset, count, near, far ) {

		const { geometry, _indirectBuffer } = bvh;
		let dist = Infinity;
		let res = null;
		for ( let i = offset, end = offset + count; i < end; i ++ ) {

			let intersection;

			intersection = intersectTri( geometry, materialOrSide, ray, i, null, near, far );


			if ( intersection && intersection.distance < dist ) {

				res = intersection;
				dist = intersection.distance;

			}

		}

		return res;

	}

	function iterateOverTriangles(
		offset,
		count,
		bvh,
		intersectsTriangleFunc,
		contained,
		depth,
		triangle
	) {

		const { geometry } = bvh;
		const { index } = geometry;
		const pos = geometry.attributes.position;
		for ( let i = offset, l = count + offset; i < l; i ++ ) {

			let tri;

			tri = i;

			setTriangle( triangle, tri * 3, index, pos );
			triangle.needsUpdate = true;

			if ( intersectsTriangleFunc( triangle, tri, contained, depth ) ) {

				return true;

			}

		}

		return false;

	}

	/****************************************************/
	/* This file is generated from "refit.template.js". */
	/****************************************************/

	function refit( bvh, nodeIndices = null ) {

		if ( nodeIndices && Array.isArray( nodeIndices ) ) {

			nodeIndices = new Set( nodeIndices );

		}

		const geometry = bvh.geometry;
		const indexArr = geometry.index ? geometry.index.array : null;
		const posAttr = geometry.attributes.position;

		let buffer, uint32Array, uint16Array, float32Array;
		let byteOffset = 0;
		const roots = bvh._roots;
		for ( let i = 0, l = roots.length; i < l; i ++ ) {

			buffer = roots[ i ];
			uint32Array = new Uint32Array( buffer );
			uint16Array = new Uint16Array( buffer );
			float32Array = new Float32Array( buffer );

			_traverse( 0, byteOffset );
			byteOffset += buffer.byteLength;

		}

		function _traverse( nodeIndex32, byteOffset, force = false ) {

			const nodeIndex16 = nodeIndex32 * 2;
			if ( IS_LEAF( nodeIndex16, uint16Array ) ) {

				const offset = uint32Array[ nodeIndex32 + 6 ];
				const count = uint16Array[ nodeIndex16 + 14 ];

				let minx = Infinity;
				let miny = Infinity;
				let minz = Infinity;
				let maxx = - Infinity;
				let maxy = - Infinity;
				let maxz = - Infinity;


				for ( let i = 3 * offset, l = 3 * ( offset + count ); i < l; i ++ ) {

					let index = indexArr[ i ];
					const x = posAttr.getX( index );
					const y = posAttr.getY( index );
					const z = posAttr.getZ( index );

					if ( x < minx ) minx = x;
					if ( x > maxx ) maxx = x;

					if ( y < miny ) miny = y;
					if ( y > maxy ) maxy = y;

					if ( z < minz ) minz = z;
					if ( z > maxz ) maxz = z;

				}


				if (
					float32Array[ nodeIndex32 + 0 ] !== minx ||
					float32Array[ nodeIndex32 + 1 ] !== miny ||
					float32Array[ nodeIndex32 + 2 ] !== minz ||

					float32Array[ nodeIndex32 + 3 ] !== maxx ||
					float32Array[ nodeIndex32 + 4 ] !== maxy ||
					float32Array[ nodeIndex32 + 5 ] !== maxz
				) {

					float32Array[ nodeIndex32 + 0 ] = minx;
					float32Array[ nodeIndex32 + 1 ] = miny;
					float32Array[ nodeIndex32 + 2 ] = minz;

					float32Array[ nodeIndex32 + 3 ] = maxx;
					float32Array[ nodeIndex32 + 4 ] = maxy;
					float32Array[ nodeIndex32 + 5 ] = maxz;

					return true;

				} else {

					return false;

				}

			} else {

				const left = LEFT_NODE( nodeIndex32 );
				const right = RIGHT_NODE( nodeIndex32, uint32Array );

				// the identifying node indices provided by the shapecast function include offsets of all
				// root buffers to guarantee they're unique between roots so offset left and right indices here.
				let forceChildren = force;
				let includesLeft = false;
				let includesRight = false;

				if ( nodeIndices ) {

					// if we see that neither the left or right child are included in the set that need to be updated
					// then we assume that all children need to be updated.
					if ( ! forceChildren ) {

						const leftNodeId = left / UINT32_PER_NODE + byteOffset / BYTES_PER_NODE;
						const rightNodeId = right / UINT32_PER_NODE + byteOffset / BYTES_PER_NODE;
						includesLeft = nodeIndices.has( leftNodeId );
						includesRight = nodeIndices.has( rightNodeId );
						forceChildren = ! includesLeft && ! includesRight;

					}

				} else {

					includesLeft = true;
					includesRight = true;

				}

				const traverseLeft = forceChildren || includesLeft;
				const traverseRight = forceChildren || includesRight;

				let leftChange = false;
				if ( traverseLeft ) {

					leftChange = _traverse( left, byteOffset, forceChildren );

				}

				let rightChange = false;
				if ( traverseRight ) {

					rightChange = _traverse( right, byteOffset, forceChildren );

				}

				const didChange = leftChange || rightChange;
				if ( didChange ) {

					for ( let i = 0; i < 3; i ++ ) {

						const left_i = left + i;
						const right_i = right + i;
						const minLeftValue = float32Array[ left_i ];
						const maxLeftValue = float32Array[ left_i + 3 ];
						const minRightValue = float32Array[ right_i ];
						const maxRightValue = float32Array[ right_i + 3 ];

						float32Array[ nodeIndex32 + i ] = minLeftValue < minRightValue ? minLeftValue : minRightValue;
						float32Array[ nodeIndex32 + i + 3 ] = maxLeftValue > maxRightValue ? maxLeftValue : maxRightValue;

					}

				}

				return didChange;

			}

		}

	}

	/**
	 * This function performs intersection tests similar to Ray.intersectBox in three.js,
	 * with the difference that the box values are read from an array to improve performance.
	 */
	function intersectRay( nodeIndex32, array, ray, near, far ) {

		let tmin, tmax, tymin, tymax, tzmin, tzmax;

		const invdirx = 1 / ray.direction.x,
			invdiry = 1 / ray.direction.y,
			invdirz = 1 / ray.direction.z;

		const ox = ray.origin.x;
		const oy = ray.origin.y;
		const oz = ray.origin.z;

		let minx = array[ nodeIndex32 ];
		let maxx = array[ nodeIndex32 + 3 ];

		let miny = array[ nodeIndex32 + 1 ];
		let maxy = array[ nodeIndex32 + 3 + 1 ];

		let minz = array[ nodeIndex32 + 2 ];
		let maxz = array[ nodeIndex32 + 3 + 2 ];

		if ( invdirx >= 0 ) {

			tmin = ( minx - ox ) * invdirx;
			tmax = ( maxx - ox ) * invdirx;

		} else {

			tmin = ( maxx - ox ) * invdirx;
			tmax = ( minx - ox ) * invdirx;

		}

		if ( invdiry >= 0 ) {

			tymin = ( miny - oy ) * invdiry;
			tymax = ( maxy - oy ) * invdiry;

		} else {

			tymin = ( maxy - oy ) * invdiry;
			tymax = ( miny - oy ) * invdiry;

		}

		if ( ( tmin > tymax ) || ( tymin > tmax ) ) return false;

		if ( tymin > tmin || isNaN( tmin ) ) tmin = tymin;

		if ( tymax < tmax || isNaN( tmax ) ) tmax = tymax;

		if ( invdirz >= 0 ) {

			tzmin = ( minz - oz ) * invdirz;
			tzmax = ( maxz - oz ) * invdirz;

		} else {

			tzmin = ( maxz - oz ) * invdirz;
			tzmax = ( minz - oz ) * invdirz;

		}

		if ( ( tmin > tzmax ) || ( tzmin > tmax ) ) return false;

		if ( tzmin > tmin || tmin !== tmin ) tmin = tzmin;

		if ( tzmax < tmax || tmax !== tmax ) tmax = tzmax;

		//return point closest to the ray (positive side)

		return tmin <= far && tmax >= near;

	}

	/*************************************************************/
	/* This file is generated from "iterationUtils.template.js". */
	/*************************************************************/

	function intersectTris_indirect( bvh, materialOrSide, ray, offset, count, intersections, near, far ) {

		const { geometry, _indirectBuffer } = bvh;
		for ( let i = offset, end = offset + count; i < end; i ++ ) {

			let vi = _indirectBuffer ? _indirectBuffer[ i ] : i;
			intersectTri( geometry, materialOrSide, ray, vi, intersections, near, far );


		}

	}

	function intersectClosestTri_indirect( bvh, materialOrSide, ray, offset, count, near, far ) {

		const { geometry, _indirectBuffer } = bvh;
		let dist = Infinity;
		let res = null;
		for ( let i = offset, end = offset + count; i < end; i ++ ) {

			let intersection;
			intersection = intersectTri( geometry, materialOrSide, ray, _indirectBuffer ? _indirectBuffer[ i ] : i, null, near, far );


			if ( intersection && intersection.distance < dist ) {

				res = intersection;
				dist = intersection.distance;

			}

		}

		return res;

	}

	function iterateOverTriangles_indirect(
		offset,
		count,
		bvh,
		intersectsTriangleFunc,
		contained,
		depth,
		triangle
	) {

		const { geometry } = bvh;
		const { index } = geometry;
		const pos = geometry.attributes.position;
		for ( let i = offset, l = count + offset; i < l; i ++ ) {

			let tri;
			tri = bvh.resolveTriangleIndex( i );

			setTriangle( triangle, tri * 3, index, pos );
			triangle.needsUpdate = true;

			if ( intersectsTriangleFunc( triangle, tri, contained, depth ) ) {

				return true;

			}

		}

		return false;

	}

	/******************************************************/
	/* This file is generated from "raycast.template.js". */
	/******************************************************/

	function raycast( bvh, root, materialOrSide, ray, intersects, near, far ) {

		BufferStack.setBuffer( bvh._roots[ root ] );
		_raycast$1( 0, bvh, materialOrSide, ray, intersects, near, far );
		BufferStack.clearBuffer();

	}

	function _raycast$1( nodeIndex32, bvh, materialOrSide, ray, intersects, near, far ) {

		const { float32Array, uint16Array, uint32Array } = BufferStack;
		const nodeIndex16 = nodeIndex32 * 2;
		const isLeaf = IS_LEAF( nodeIndex16, uint16Array );
		if ( isLeaf ) {

			const offset = OFFSET( nodeIndex32, uint32Array );
			const count = COUNT( nodeIndex16, uint16Array );


			intersectTris( bvh, materialOrSide, ray, offset, count, intersects, near, far );


		} else {

			const leftIndex = LEFT_NODE( nodeIndex32 );
			if ( intersectRay( leftIndex, float32Array, ray, near, far ) ) {

				_raycast$1( leftIndex, bvh, materialOrSide, ray, intersects, near, far );

			}

			const rightIndex = RIGHT_NODE( nodeIndex32, uint32Array );
			if ( intersectRay( rightIndex, float32Array, ray, near, far ) ) {

				_raycast$1( rightIndex, bvh, materialOrSide, ray, intersects, near, far );

			}

		}

	}

	/***********************************************************/
	/* This file is generated from "raycastFirst.template.js". */
	/***********************************************************/

	const _xyzFields$1 = [ 'x', 'y', 'z' ];

	function raycastFirst( bvh, root, materialOrSide, ray, near, far ) {

		BufferStack.setBuffer( bvh._roots[ root ] );
		const result = _raycastFirst$1( 0, bvh, materialOrSide, ray, near, far );
		BufferStack.clearBuffer();

		return result;

	}

	function _raycastFirst$1( nodeIndex32, bvh, materialOrSide, ray, near, far ) {

		const { float32Array, uint16Array, uint32Array } = BufferStack;
		let nodeIndex16 = nodeIndex32 * 2;

		const isLeaf = IS_LEAF( nodeIndex16, uint16Array );
		if ( isLeaf ) {

			const offset = OFFSET( nodeIndex32, uint32Array );
			const count = COUNT( nodeIndex16, uint16Array );


			// eslint-disable-next-line no-unreachable
			return intersectClosestTri( bvh, materialOrSide, ray, offset, count, near, far );


		} else {

			// consider the position of the split plane with respect to the oncoming ray; whichever direction
			// the ray is coming from, look for an intersection among that side of the tree first
			const splitAxis = SPLIT_AXIS( nodeIndex32, uint32Array );
			const xyzAxis = _xyzFields$1[ splitAxis ];
			const rayDir = ray.direction[ xyzAxis ];
			const leftToRight = rayDir >= 0;

			// c1 is the child to check first
			let c1, c2;
			if ( leftToRight ) {

				c1 = LEFT_NODE( nodeIndex32 );
				c2 = RIGHT_NODE( nodeIndex32, uint32Array );

			} else {

				c1 = RIGHT_NODE( nodeIndex32, uint32Array );
				c2 = LEFT_NODE( nodeIndex32 );

			}

			const c1Intersection = intersectRay( c1, float32Array, ray, near, far );
			const c1Result = c1Intersection ? _raycastFirst$1( c1, bvh, materialOrSide, ray, near, far ) : null;

			// if we got an intersection in the first node and it's closer than the second node's bounding
			// box, we don't need to consider the second node because it couldn't possibly be a better result
			if ( c1Result ) {

				// check if the point is within the second bounds
				// "point" is in the local frame of the bvh
				const point = c1Result.point[ xyzAxis ];
				const isOutside = leftToRight ?
					point <= float32Array[ c2 + splitAxis ] : // min bounding data
					point >= float32Array[ c2 + splitAxis + 3 ]; // max bounding data

				if ( isOutside ) {

					return c1Result;

				}

			}

			// either there was no intersection in the first node, or there could still be a closer
			// intersection in the second, so check the second node and then take the better of the two
			const c2Intersection = intersectRay( c2, float32Array, ray, near, far );
			const c2Result = c2Intersection ? _raycastFirst$1( c2, bvh, materialOrSide, ray, near, far ) : null;

			if ( c1Result && c2Result ) {

				return c1Result.distance <= c2Result.distance ? c1Result : c2Result;

			} else {

				return c1Result || c2Result || null;

			}

		}

	}

	/*****************************************************************/
	/* This file is generated from "intersectsGeometry.template.js". */
	/*****************************************************************/
	/* eslint-disable indent */

	const boundingBox$2 = /* @__PURE__ */ new three.Box3();
	const triangle$1 = /* @__PURE__ */ new ExtendedTriangle();
	const triangle2$1 = /* @__PURE__ */ new ExtendedTriangle();
	const invertedMat$1 = /* @__PURE__ */ new three.Matrix4();

	const obb$3 = /* @__PURE__ */ new OrientedBox();
	const obb2$3 = /* @__PURE__ */ new OrientedBox();

	function intersectsGeometry( bvh, root, otherGeometry, geometryToBvh ) {

		BufferStack.setBuffer( bvh._roots[ root ] );
		const result = _intersectsGeometry$1( 0, bvh, otherGeometry, geometryToBvh );
		BufferStack.clearBuffer();

		return result;

	}

	function _intersectsGeometry$1( nodeIndex32, bvh, otherGeometry, geometryToBvh, cachedObb = null ) {

		const { float32Array, uint16Array, uint32Array } = BufferStack;
		let nodeIndex16 = nodeIndex32 * 2;

		if ( cachedObb === null ) {

			if ( ! otherGeometry.boundingBox ) {

				otherGeometry.computeBoundingBox();

			}

			obb$3.set( otherGeometry.boundingBox.min, otherGeometry.boundingBox.max, geometryToBvh );
			cachedObb = obb$3;

		}

		const isLeaf = IS_LEAF( nodeIndex16, uint16Array );
		if ( isLeaf ) {

			const thisGeometry = bvh.geometry;
			const thisIndex = thisGeometry.index;
			const thisPos = thisGeometry.attributes.position;

			const otherIndex = otherGeometry.index;
			const otherPos = otherGeometry.attributes.position;

			const offset = OFFSET( nodeIndex32, uint32Array );
			const count = COUNT( nodeIndex16, uint16Array );

			// get the inverse of the geometry matrix so we can transform our triangles into the
			// geometry space we're trying to test. We assume there are fewer triangles being checked
			// here.
			invertedMat$1.copy( geometryToBvh ).invert();

			if ( otherGeometry.boundsTree ) {

				// if there's a bounds tree
				arrayToBox( BOUNDING_DATA_INDEX( nodeIndex32 ), float32Array, obb2$3 );
				obb2$3.matrix.copy( invertedMat$1 );
				obb2$3.needsUpdate = true;

				// TODO: use a triangle iteration function here
				const res = otherGeometry.boundsTree.shapecast( {

					intersectsBounds: box => obb2$3.intersectsBox( box ),

					intersectsTriangle: tri => {

						tri.a.applyMatrix4( geometryToBvh );
						tri.b.applyMatrix4( geometryToBvh );
						tri.c.applyMatrix4( geometryToBvh );
						tri.needsUpdate = true;


						for ( let i = offset * 3, l = ( count + offset ) * 3; i < l; i += 3 ) {

							// this triangle needs to be transformed into the current BVH coordinate frame
							setTriangle( triangle2$1, i, thisIndex, thisPos );
							triangle2$1.needsUpdate = true;
							if ( tri.intersectsTriangle( triangle2$1 ) ) {

								return true;

							}

						}


						return false;

					}

				} );

				return res;

			} else {

				// if we're just dealing with raw geometry
				const otherTriangleCount = getTriCount( otherGeometry );


				for ( let i = offset * 3, l = ( count + offset ) * 3; i < l; i += 3 ) {

					// this triangle needs to be transformed into the current BVH coordinate frame
					setTriangle( triangle$1, i, thisIndex, thisPos );


					triangle$1.a.applyMatrix4( invertedMat$1 );
					triangle$1.b.applyMatrix4( invertedMat$1 );
					triangle$1.c.applyMatrix4( invertedMat$1 );
					triangle$1.needsUpdate = true;

					for ( let i2 = 0, l2 = otherTriangleCount * 3; i2 < l2; i2 += 3 ) {

						setTriangle( triangle2$1, i2, otherIndex, otherPos );
						triangle2$1.needsUpdate = true;

						if ( triangle$1.intersectsTriangle( triangle2$1 ) ) {

							return true;

						}

					}


				}


			}

		} else {

			const left = LEFT_NODE( nodeIndex32 );
			const right = RIGHT_NODE( nodeIndex32, uint32Array );

			arrayToBox( BOUNDING_DATA_INDEX( left ), float32Array, boundingBox$2 );
			const leftIntersection =
				cachedObb.intersectsBox( boundingBox$2 ) &&
				_intersectsGeometry$1( left, bvh, otherGeometry, geometryToBvh, cachedObb );

			if ( leftIntersection ) return true;

			arrayToBox( BOUNDING_DATA_INDEX( right ), float32Array, boundingBox$2 );
			const rightIntersection =
				cachedObb.intersectsBox( boundingBox$2 ) &&
				_intersectsGeometry$1( right, bvh, otherGeometry, geometryToBvh, cachedObb );

			if ( rightIntersection ) return true;

			return false;

		}

	}

	/*********************************************************************/
	/* This file is generated from "closestPointToGeometry.template.js". */
	/*********************************************************************/

	const tempMatrix$1 = /* @__PURE__ */ new three.Matrix4();
	const obb$2 = /* @__PURE__ */ new OrientedBox();
	const obb2$2 = /* @__PURE__ */ new OrientedBox();
	const temp1$1 = /* @__PURE__ */ new three.Vector3();
	const temp2$1 = /* @__PURE__ */ new three.Vector3();
	const temp3$1 = /* @__PURE__ */ new three.Vector3();
	const temp4$1 = /* @__PURE__ */ new three.Vector3();

	function closestPointToGeometry(
		bvh,
		otherGeometry,
		geometryToBvh,
		target1 = { },
		target2 = { },
		minThreshold = 0,
		maxThreshold = Infinity,
	) {

		if ( ! otherGeometry.boundingBox ) {

			otherGeometry.computeBoundingBox();

		}

		obb$2.set( otherGeometry.boundingBox.min, otherGeometry.boundingBox.max, geometryToBvh );
		obb$2.needsUpdate = true;

		const geometry = bvh.geometry;
		const pos = geometry.attributes.position;
		const index = geometry.index;
		const otherPos = otherGeometry.attributes.position;
		const otherIndex = otherGeometry.index;
		const triangle = ExtendedTrianglePool.getPrimitive();
		const triangle2 = ExtendedTrianglePool.getPrimitive();

		let tempTarget1 = temp1$1;
		let tempTargetDest1 = temp2$1;
		let tempTarget2 = null;
		let tempTargetDest2 = null;

		if ( target2 ) {

			tempTarget2 = temp3$1;
			tempTargetDest2 = temp4$1;

		}

		let closestDistance = Infinity;
		let closestDistanceTriIndex = null;
		let closestDistanceOtherTriIndex = null;
		tempMatrix$1.copy( geometryToBvh ).invert();
		obb2$2.matrix.copy( tempMatrix$1 );
		bvh.shapecast(
			{

				boundsTraverseOrder: box => {

					return obb$2.distanceToBox( box );

				},

				intersectsBounds: ( box, isLeaf, score ) => {

					if ( score < closestDistance && score < maxThreshold ) {

						// if we know the triangles of this bounds will be intersected next then
						// save the bounds to use during triangle checks.
						if ( isLeaf ) {

							obb2$2.min.copy( box.min );
							obb2$2.max.copy( box.max );
							obb2$2.needsUpdate = true;

						}

						return true;

					}

					return false;

				},

				intersectsRange: ( offset, count ) => {

					if ( otherGeometry.boundsTree ) {

						// if the other geometry has a bvh then use the accelerated path where we use shapecast to find
						// the closest bounds in the other geometry to check.
						const otherBvh = otherGeometry.boundsTree;
						return otherBvh.shapecast( {
							boundsTraverseOrder: box => {

								return obb2$2.distanceToBox( box );

							},

							intersectsBounds: ( box, isLeaf, score ) => {

								return score < closestDistance && score < maxThreshold;

							},

							intersectsRange: ( otherOffset, otherCount ) => {

								for ( let i2 = otherOffset, l2 = otherOffset + otherCount; i2 < l2; i2 ++ ) {


									setTriangle( triangle2, 3 * i2, otherIndex, otherPos );

									triangle2.a.applyMatrix4( geometryToBvh );
									triangle2.b.applyMatrix4( geometryToBvh );
									triangle2.c.applyMatrix4( geometryToBvh );
									triangle2.needsUpdate = true;

									for ( let i = offset, l = offset + count; i < l; i ++ ) {


										setTriangle( triangle, 3 * i, index, pos );

										triangle.needsUpdate = true;

										const dist = triangle.distanceToTriangle( triangle2, tempTarget1, tempTarget2 );
										if ( dist < closestDistance ) {

											tempTargetDest1.copy( tempTarget1 );

											if ( tempTargetDest2 ) {

												tempTargetDest2.copy( tempTarget2 );

											}

											closestDistance = dist;
											closestDistanceTriIndex = i;
											closestDistanceOtherTriIndex = i2;

										}

										// stop traversal if we find a point that's under the given threshold
										if ( dist < minThreshold ) {

											return true;

										}

									}

								}

							},
						} );

					} else {

						// If no bounds tree then we'll just check every triangle.
						const triCount = getTriCount( otherGeometry );
						for ( let i2 = 0, l2 = triCount; i2 < l2; i2 ++ ) {

							setTriangle( triangle2, 3 * i2, otherIndex, otherPos );
							triangle2.a.applyMatrix4( geometryToBvh );
							triangle2.b.applyMatrix4( geometryToBvh );
							triangle2.c.applyMatrix4( geometryToBvh );
							triangle2.needsUpdate = true;

							for ( let i = offset, l = offset + count; i < l; i ++ ) {


								setTriangle( triangle, 3 * i, index, pos );

								triangle.needsUpdate = true;

								const dist = triangle.distanceToTriangle( triangle2, tempTarget1, tempTarget2 );
								if ( dist < closestDistance ) {

									tempTargetDest1.copy( tempTarget1 );

									if ( tempTargetDest2 ) {

										tempTargetDest2.copy( tempTarget2 );

									}

									closestDistance = dist;
									closestDistanceTriIndex = i;
									closestDistanceOtherTriIndex = i2;

								}

								// stop traversal if we find a point that's under the given threshold
								if ( dist < minThreshold ) {

									return true;

								}

							}

						}

					}

				},

			}

		);

		ExtendedTrianglePool.releasePrimitive( triangle );
		ExtendedTrianglePool.releasePrimitive( triangle2 );

		if ( closestDistance === Infinity ) {

			return null;

		}

		if ( ! target1.point ) {

			target1.point = tempTargetDest1.clone();

		} else {

			target1.point.copy( tempTargetDest1 );

		}

		target1.distance = closestDistance,
		target1.faceIndex = closestDistanceTriIndex;

		if ( target2 ) {

			if ( ! target2.point ) target2.point = tempTargetDest2.clone();
			else target2.point.copy( tempTargetDest2 );
			target2.point.applyMatrix4( tempMatrix$1 );
			tempTargetDest1.applyMatrix4( tempMatrix$1 );
			target2.distance = tempTargetDest1.sub( target2.point ).length();
			target2.faceIndex = closestDistanceOtherTriIndex;

		}

		return target1;

	}

	/****************************************************/
	/* This file is generated from "refit.template.js". */
	/****************************************************/

	function refit_indirect( bvh, nodeIndices = null ) {

		if ( nodeIndices && Array.isArray( nodeIndices ) ) {

			nodeIndices = new Set( nodeIndices );

		}

		const geometry = bvh.geometry;
		const indexArr = geometry.index ? geometry.index.array : null;
		const posAttr = geometry.attributes.position;

		let buffer, uint32Array, uint16Array, float32Array;
		let byteOffset = 0;
		const roots = bvh._roots;
		for ( let i = 0, l = roots.length; i < l; i ++ ) {

			buffer = roots[ i ];
			uint32Array = new Uint32Array( buffer );
			uint16Array = new Uint16Array( buffer );
			float32Array = new Float32Array( buffer );

			_traverse( 0, byteOffset );
			byteOffset += buffer.byteLength;

		}

		function _traverse( nodeIndex32, byteOffset, force = false ) {

			const nodeIndex16 = nodeIndex32 * 2;
			if ( IS_LEAF( nodeIndex16, uint16Array ) ) {

				const offset = uint32Array[ nodeIndex32 + 6 ];
				const count = uint16Array[ nodeIndex16 + 14 ];

				let minx = Infinity;
				let miny = Infinity;
				let minz = Infinity;
				let maxx = - Infinity;
				let maxy = - Infinity;
				let maxz = - Infinity;

				for ( let i = offset, l = offset + count; i < l; i ++ ) {

					const t = 3 * bvh.resolveTriangleIndex( i );
					for ( let j = 0; j < 3; j ++ ) {

						let index = t + j;
						index = indexArr ? indexArr[ index ] : index;

						const x = posAttr.getX( index );
						const y = posAttr.getY( index );
						const z = posAttr.getZ( index );

						if ( x < minx ) minx = x;
						if ( x > maxx ) maxx = x;

						if ( y < miny ) miny = y;
						if ( y > maxy ) maxy = y;

						if ( z < minz ) minz = z;
						if ( z > maxz ) maxz = z;


					}

				}


				if (
					float32Array[ nodeIndex32 + 0 ] !== minx ||
					float32Array[ nodeIndex32 + 1 ] !== miny ||
					float32Array[ nodeIndex32 + 2 ] !== minz ||

					float32Array[ nodeIndex32 + 3 ] !== maxx ||
					float32Array[ nodeIndex32 + 4 ] !== maxy ||
					float32Array[ nodeIndex32 + 5 ] !== maxz
				) {

					float32Array[ nodeIndex32 + 0 ] = minx;
					float32Array[ nodeIndex32 + 1 ] = miny;
					float32Array[ nodeIndex32 + 2 ] = minz;

					float32Array[ nodeIndex32 + 3 ] = maxx;
					float32Array[ nodeIndex32 + 4 ] = maxy;
					float32Array[ nodeIndex32 + 5 ] = maxz;

					return true;

				} else {

					return false;

				}

			} else {

				const left = LEFT_NODE( nodeIndex32 );
				const right = RIGHT_NODE( nodeIndex32, uint32Array );

				// the identifying node indices provided by the shapecast function include offsets of all
				// root buffers to guarantee they're unique between roots so offset left and right indices here.
				let forceChildren = force;
				let includesLeft = false;
				let includesRight = false;

				if ( nodeIndices ) {

					// if we see that neither the left or right child are included in the set that need to be updated
					// then we assume that all children need to be updated.
					if ( ! forceChildren ) {

						const leftNodeId = left / UINT32_PER_NODE + byteOffset / BYTES_PER_NODE;
						const rightNodeId = right / UINT32_PER_NODE + byteOffset / BYTES_PER_NODE;
						includesLeft = nodeIndices.has( leftNodeId );
						includesRight = nodeIndices.has( rightNodeId );
						forceChildren = ! includesLeft && ! includesRight;

					}

				} else {

					includesLeft = true;
					includesRight = true;

				}

				const traverseLeft = forceChildren || includesLeft;
				const traverseRight = forceChildren || includesRight;

				let leftChange = false;
				if ( traverseLeft ) {

					leftChange = _traverse( left, byteOffset, forceChildren );

				}

				let rightChange = false;
				if ( traverseRight ) {

					rightChange = _traverse( right, byteOffset, forceChildren );

				}

				const didChange = leftChange || rightChange;
				if ( didChange ) {

					for ( let i = 0; i < 3; i ++ ) {

						const left_i = left + i;
						const right_i = right + i;
						const minLeftValue = float32Array[ left_i ];
						const maxLeftValue = float32Array[ left_i + 3 ];
						const minRightValue = float32Array[ right_i ];
						const maxRightValue = float32Array[ right_i + 3 ];

						float32Array[ nodeIndex32 + i ] = minLeftValue < minRightValue ? minLeftValue : minRightValue;
						float32Array[ nodeIndex32 + i + 3 ] = maxLeftValue > maxRightValue ? maxLeftValue : maxRightValue;

					}

				}

				return didChange;

			}

		}

	}

	/******************************************************/
	/* This file is generated from "raycast.template.js". */
	/******************************************************/

	function raycast_indirect( bvh, root, materialOrSide, ray, intersects, near, far ) {

		BufferStack.setBuffer( bvh._roots[ root ] );
		_raycast( 0, bvh, materialOrSide, ray, intersects, near, far );
		BufferStack.clearBuffer();

	}

	function _raycast( nodeIndex32, bvh, materialOrSide, ray, intersects, near, far ) {

		const { float32Array, uint16Array, uint32Array } = BufferStack;
		const nodeIndex16 = nodeIndex32 * 2;
		const isLeaf = IS_LEAF( nodeIndex16, uint16Array );
		if ( isLeaf ) {

			const offset = OFFSET( nodeIndex32, uint32Array );
			const count = COUNT( nodeIndex16, uint16Array );

			intersectTris_indirect( bvh, materialOrSide, ray, offset, count, intersects, near, far );


		} else {

			const leftIndex = LEFT_NODE( nodeIndex32 );
			if ( intersectRay( leftIndex, float32Array, ray, near, far ) ) {

				_raycast( leftIndex, bvh, materialOrSide, ray, intersects, near, far );

			}

			const rightIndex = RIGHT_NODE( nodeIndex32, uint32Array );
			if ( intersectRay( rightIndex, float32Array, ray, near, far ) ) {

				_raycast( rightIndex, bvh, materialOrSide, ray, intersects, near, far );

			}

		}

	}

	/***********************************************************/
	/* This file is generated from "raycastFirst.template.js". */
	/***********************************************************/

	const _xyzFields = [ 'x', 'y', 'z' ];

	function raycastFirst_indirect( bvh, root, materialOrSide, ray, near, far ) {

		BufferStack.setBuffer( bvh._roots[ root ] );
		const result = _raycastFirst( 0, bvh, materialOrSide, ray, near, far );
		BufferStack.clearBuffer();

		return result;

	}

	function _raycastFirst( nodeIndex32, bvh, materialOrSide, ray, near, far ) {

		const { float32Array, uint16Array, uint32Array } = BufferStack;
		let nodeIndex16 = nodeIndex32 * 2;

		const isLeaf = IS_LEAF( nodeIndex16, uint16Array );
		if ( isLeaf ) {

			const offset = OFFSET( nodeIndex32, uint32Array );
			const count = COUNT( nodeIndex16, uint16Array );

			return intersectClosestTri_indirect( bvh, materialOrSide, ray, offset, count, near, far );


		} else {

			// consider the position of the split plane with respect to the oncoming ray; whichever direction
			// the ray is coming from, look for an intersection among that side of the tree first
			const splitAxis = SPLIT_AXIS( nodeIndex32, uint32Array );
			const xyzAxis = _xyzFields[ splitAxis ];
			const rayDir = ray.direction[ xyzAxis ];
			const leftToRight = rayDir >= 0;

			// c1 is the child to check first
			let c1, c2;
			if ( leftToRight ) {

				c1 = LEFT_NODE( nodeIndex32 );
				c2 = RIGHT_NODE( nodeIndex32, uint32Array );

			} else {

				c1 = RIGHT_NODE( nodeIndex32, uint32Array );
				c2 = LEFT_NODE( nodeIndex32 );

			}

			const c1Intersection = intersectRay( c1, float32Array, ray, near, far );
			const c1Result = c1Intersection ? _raycastFirst( c1, bvh, materialOrSide, ray, near, far ) : null;

			// if we got an intersection in the first node and it's closer than the second node's bounding
			// box, we don't need to consider the second node because it couldn't possibly be a better result
			if ( c1Result ) {

				// check if the point is within the second bounds
				// "point" is in the local frame of the bvh
				const point = c1Result.point[ xyzAxis ];
				const isOutside = leftToRight ?
					point <= float32Array[ c2 + splitAxis ] : // min bounding data
					point >= float32Array[ c2 + splitAxis + 3 ]; // max bounding data

				if ( isOutside ) {

					return c1Result;

				}

			}

			// either there was no intersection in the first node, or there could still be a closer
			// intersection in the second, so check the second node and then take the better of the two
			const c2Intersection = intersectRay( c2, float32Array, ray, near, far );
			const c2Result = c2Intersection ? _raycastFirst( c2, bvh, materialOrSide, ray, near, far ) : null;

			if ( c1Result && c2Result ) {

				return c1Result.distance <= c2Result.distance ? c1Result : c2Result;

			} else {

				return c1Result || c2Result || null;

			}

		}

	}

	/*****************************************************************/
	/* This file is generated from "intersectsGeometry.template.js". */
	/*****************************************************************/
	/* eslint-disable indent */

	const boundingBox$1 = /* @__PURE__ */ new three.Box3();
	const triangle = /* @__PURE__ */ new ExtendedTriangle();
	const triangle2 = /* @__PURE__ */ new ExtendedTriangle();
	const invertedMat = /* @__PURE__ */ new three.Matrix4();

	const obb$1 = /* @__PURE__ */ new OrientedBox();
	const obb2$1 = /* @__PURE__ */ new OrientedBox();

	function intersectsGeometry_indirect( bvh, root, otherGeometry, geometryToBvh ) {

		BufferStack.setBuffer( bvh._roots[ root ] );
		const result = _intersectsGeometry( 0, bvh, otherGeometry, geometryToBvh );
		BufferStack.clearBuffer();

		return result;

	}

	function _intersectsGeometry( nodeIndex32, bvh, otherGeometry, geometryToBvh, cachedObb = null ) {

		const { float32Array, uint16Array, uint32Array } = BufferStack;
		let nodeIndex16 = nodeIndex32 * 2;

		if ( cachedObb === null ) {

			if ( ! otherGeometry.boundingBox ) {

				otherGeometry.computeBoundingBox();

			}

			obb$1.set( otherGeometry.boundingBox.min, otherGeometry.boundingBox.max, geometryToBvh );
			cachedObb = obb$1;

		}

		const isLeaf = IS_LEAF( nodeIndex16, uint16Array );
		if ( isLeaf ) {

			const thisGeometry = bvh.geometry;
			const thisIndex = thisGeometry.index;
			const thisPos = thisGeometry.attributes.position;

			const otherIndex = otherGeometry.index;
			const otherPos = otherGeometry.attributes.position;

			const offset = OFFSET( nodeIndex32, uint32Array );
			const count = COUNT( nodeIndex16, uint16Array );

			// get the inverse of the geometry matrix so we can transform our triangles into the
			// geometry space we're trying to test. We assume there are fewer triangles being checked
			// here.
			invertedMat.copy( geometryToBvh ).invert();

			if ( otherGeometry.boundsTree ) {

				// if there's a bounds tree
				arrayToBox( BOUNDING_DATA_INDEX( nodeIndex32 ), float32Array, obb2$1 );
				obb2$1.matrix.copy( invertedMat );
				obb2$1.needsUpdate = true;

				// TODO: use a triangle iteration function here
				const res = otherGeometry.boundsTree.shapecast( {

					intersectsBounds: box => obb2$1.intersectsBox( box ),

					intersectsTriangle: tri => {

						tri.a.applyMatrix4( geometryToBvh );
						tri.b.applyMatrix4( geometryToBvh );
						tri.c.applyMatrix4( geometryToBvh );
						tri.needsUpdate = true;

						for ( let i = offset, l = count + offset; i < l; i ++ ) {

							// this triangle needs to be transformed into the current BVH coordinate frame
							setTriangle( triangle2, 3 * bvh.resolveTriangleIndex( i ), thisIndex, thisPos );
							triangle2.needsUpdate = true;
							if ( tri.intersectsTriangle( triangle2 ) ) {

								return true;

							}

						}


						return false;

					}

				} );

				return res;

			} else {

				// if we're just dealing with raw geometry
				const otherTriangleCount = getTriCount( otherGeometry );

				for ( let i = offset, l = count + offset; i < l; i ++ ) {

					// this triangle needs to be transformed into the current BVH coordinate frame
					const ti = bvh.resolveTriangleIndex( i );
					setTriangle( triangle, 3 * ti, thisIndex, thisPos );


					triangle.a.applyMatrix4( invertedMat );
					triangle.b.applyMatrix4( invertedMat );
					triangle.c.applyMatrix4( invertedMat );
					triangle.needsUpdate = true;

					for ( let i2 = 0, l2 = otherTriangleCount * 3; i2 < l2; i2 += 3 ) {

						setTriangle( triangle2, i2, otherIndex, otherPos );
						triangle2.needsUpdate = true;

						if ( triangle.intersectsTriangle( triangle2 ) ) {

							return true;

						}

					}

				}


			}

		} else {

			const left = LEFT_NODE( nodeIndex32 );
			const right = RIGHT_NODE( nodeIndex32, uint32Array );

			arrayToBox( BOUNDING_DATA_INDEX( left ), float32Array, boundingBox$1 );
			const leftIntersection =
				cachedObb.intersectsBox( boundingBox$1 ) &&
				_intersectsGeometry( left, bvh, otherGeometry, geometryToBvh, cachedObb );

			if ( leftIntersection ) return true;

			arrayToBox( BOUNDING_DATA_INDEX( right ), float32Array, boundingBox$1 );
			const rightIntersection =
				cachedObb.intersectsBox( boundingBox$1 ) &&
				_intersectsGeometry( right, bvh, otherGeometry, geometryToBvh, cachedObb );

			if ( rightIntersection ) return true;

			return false;

		}

	}

	/*********************************************************************/
	/* This file is generated from "closestPointToGeometry.template.js". */
	/*********************************************************************/

	const tempMatrix = /* @__PURE__ */ new three.Matrix4();
	const obb = /* @__PURE__ */ new OrientedBox();
	const obb2 = /* @__PURE__ */ new OrientedBox();
	const temp1 = /* @__PURE__ */ new three.Vector3();
	const temp2 = /* @__PURE__ */ new three.Vector3();
	const temp3 = /* @__PURE__ */ new three.Vector3();
	const temp4 = /* @__PURE__ */ new three.Vector3();

	function closestPointToGeometry_indirect(
		bvh,
		otherGeometry,
		geometryToBvh,
		target1 = { },
		target2 = { },
		minThreshold = 0,
		maxThreshold = Infinity,
	) {

		if ( ! otherGeometry.boundingBox ) {

			otherGeometry.computeBoundingBox();

		}

		obb.set( otherGeometry.boundingBox.min, otherGeometry.boundingBox.max, geometryToBvh );
		obb.needsUpdate = true;

		const geometry = bvh.geometry;
		const pos = geometry.attributes.position;
		const index = geometry.index;
		const otherPos = otherGeometry.attributes.position;
		const otherIndex = otherGeometry.index;
		const triangle = ExtendedTrianglePool.getPrimitive();
		const triangle2 = ExtendedTrianglePool.getPrimitive();

		let tempTarget1 = temp1;
		let tempTargetDest1 = temp2;
		let tempTarget2 = null;
		let tempTargetDest2 = null;

		if ( target2 ) {

			tempTarget2 = temp3;
			tempTargetDest2 = temp4;

		}

		let closestDistance = Infinity;
		let closestDistanceTriIndex = null;
		let closestDistanceOtherTriIndex = null;
		tempMatrix.copy( geometryToBvh ).invert();
		obb2.matrix.copy( tempMatrix );
		bvh.shapecast(
			{

				boundsTraverseOrder: box => {

					return obb.distanceToBox( box );

				},

				intersectsBounds: ( box, isLeaf, score ) => {

					if ( score < closestDistance && score < maxThreshold ) {

						// if we know the triangles of this bounds will be intersected next then
						// save the bounds to use during triangle checks.
						if ( isLeaf ) {

							obb2.min.copy( box.min );
							obb2.max.copy( box.max );
							obb2.needsUpdate = true;

						}

						return true;

					}

					return false;

				},

				intersectsRange: ( offset, count ) => {

					if ( otherGeometry.boundsTree ) {

						// if the other geometry has a bvh then use the accelerated path where we use shapecast to find
						// the closest bounds in the other geometry to check.
						const otherBvh = otherGeometry.boundsTree;
						return otherBvh.shapecast( {
							boundsTraverseOrder: box => {

								return obb2.distanceToBox( box );

							},

							intersectsBounds: ( box, isLeaf, score ) => {

								return score < closestDistance && score < maxThreshold;

							},

							intersectsRange: ( otherOffset, otherCount ) => {

								for ( let i2 = otherOffset, l2 = otherOffset + otherCount; i2 < l2; i2 ++ ) {

									const ti2 = otherBvh.resolveTriangleIndex( i2 );
									setTriangle( triangle2, 3 * ti2, otherIndex, otherPos );

									triangle2.a.applyMatrix4( geometryToBvh );
									triangle2.b.applyMatrix4( geometryToBvh );
									triangle2.c.applyMatrix4( geometryToBvh );
									triangle2.needsUpdate = true;

									for ( let i = offset, l = offset + count; i < l; i ++ ) {

										const ti = bvh.resolveTriangleIndex( i );
										setTriangle( triangle, 3 * ti, index, pos );

										triangle.needsUpdate = true;

										const dist = triangle.distanceToTriangle( triangle2, tempTarget1, tempTarget2 );
										if ( dist < closestDistance ) {

											tempTargetDest1.copy( tempTarget1 );

											if ( tempTargetDest2 ) {

												tempTargetDest2.copy( tempTarget2 );

											}

											closestDistance = dist;
											closestDistanceTriIndex = i;
											closestDistanceOtherTriIndex = i2;

										}

										// stop traversal if we find a point that's under the given threshold
										if ( dist < minThreshold ) {

											return true;

										}

									}

								}

							},
						} );

					} else {

						// If no bounds tree then we'll just check every triangle.
						const triCount = getTriCount( otherGeometry );
						for ( let i2 = 0, l2 = triCount; i2 < l2; i2 ++ ) {

							setTriangle( triangle2, 3 * i2, otherIndex, otherPos );
							triangle2.a.applyMatrix4( geometryToBvh );
							triangle2.b.applyMatrix4( geometryToBvh );
							triangle2.c.applyMatrix4( geometryToBvh );
							triangle2.needsUpdate = true;

							for ( let i = offset, l = offset + count; i < l; i ++ ) {

								const ti = bvh.resolveTriangleIndex( i );
								setTriangle( triangle, 3 * ti, index, pos );

								triangle.needsUpdate = true;

								const dist = triangle.distanceToTriangle( triangle2, tempTarget1, tempTarget2 );
								if ( dist < closestDistance ) {

									tempTargetDest1.copy( tempTarget1 );

									if ( tempTargetDest2 ) {

										tempTargetDest2.copy( tempTarget2 );

									}

									closestDistance = dist;
									closestDistanceTriIndex = i;
									closestDistanceOtherTriIndex = i2;

								}

								// stop traversal if we find a point that's under the given threshold
								if ( dist < minThreshold ) {

									return true;

								}

							}

						}

					}

				},

			}

		);

		ExtendedTrianglePool.releasePrimitive( triangle );
		ExtendedTrianglePool.releasePrimitive( triangle2 );

		if ( closestDistance === Infinity ) {

			return null;

		}

		if ( ! target1.point ) {

			target1.point = tempTargetDest1.clone();

		} else {

			target1.point.copy( tempTargetDest1 );

		}

		target1.distance = closestDistance,
		target1.faceIndex = closestDistanceTriIndex;

		if ( target2 ) {

			if ( ! target2.point ) target2.point = tempTargetDest2.clone();
			else target2.point.copy( tempTargetDest2 );
			target2.point.applyMatrix4( tempMatrix );
			tempTargetDest1.applyMatrix4( tempMatrix );
			target2.distance = tempTargetDest1.sub( target2.point ).length();
			target2.faceIndex = closestDistanceOtherTriIndex;

		}

		return target1;

	}

	const _bufferStack1 = /* @__PURE__ */ new BufferStack.constructor();
	const _bufferStack2 = /* @__PURE__ */ new BufferStack.constructor();
	const _boxPool = /* @__PURE__ */ new PrimitivePool( () => new three.Box3() );
	const _leftBox1 = /* @__PURE__ */ new three.Box3();
	const _rightBox1 = /* @__PURE__ */ new three.Box3();

	const _leftBox2 = /* @__PURE__ */ new three.Box3();
	const _rightBox2 = /* @__PURE__ */ new three.Box3();

	let _active = false;

	function bvhcast( bvh, otherBvh, matrixToLocal, intersectsRanges ) {

		if ( _active ) {

			throw new Error( 'MeshBVH: Recursive calls to bvhcast not supported.' );

		}

		_active = true;

		const roots = bvh._roots;
		const otherRoots = otherBvh._roots;
		let result;
		let nodeOffset1 = 0;
		let nodeOffset2 = 0;
		const invMat = new three.Matrix4().copy( matrixToLocal ).invert();

		// iterate over the first set of roots
		for ( let i = 0, il = roots.length; i < il; i ++ ) {

			_bufferStack1.setBuffer( roots[ i ] );
			nodeOffset2 = 0;

			// prep the initial root box
			const localBox = _boxPool.getPrimitive();
			arrayToBox( BOUNDING_DATA_INDEX( 0 ), _bufferStack1.float32Array, localBox );
			localBox.applyMatrix4( invMat );

			// iterate over the second set of roots
			for ( let j = 0, jl = otherRoots.length; j < jl; j ++ ) {

				_bufferStack2.setBuffer( otherRoots[ j ] );

				result = _traverse(
					0, 0, matrixToLocal, invMat, intersectsRanges,
					nodeOffset1, nodeOffset2, 0, 0,
					localBox,
				);

				_bufferStack2.clearBuffer();
				nodeOffset2 += otherRoots[ j ].byteLength / BYTES_PER_NODE;

				if ( result ) {

					break;

				}

			}

			// release stack info
			_boxPool.releasePrimitive( localBox );
			_bufferStack1.clearBuffer();
			nodeOffset1 += roots[ i ].byteLength / BYTES_PER_NODE;

			if ( result ) {

				break;

			}

		}

		_active = false;
		return result;

	}

	function _traverse(
		node1Index32,
		node2Index32,
		matrix2to1,
		matrix1to2,
		intersectsRangesFunc,

		// offsets for ids
		node1IndexOffset = 0,
		node2IndexOffset = 0,

		// tree depth
		depth1 = 0,
		depth2 = 0,

		currBox = null,
		reversed = false,

	) {

		// get the buffer stacks associated with the current indices
		let bufferStack1, bufferStack2;
		if ( reversed ) {

			bufferStack1 = _bufferStack2;
			bufferStack2 = _bufferStack1;

		} else {

			bufferStack1 = _bufferStack1;
			bufferStack2 = _bufferStack2;

		}

		// get the local instances of the typed buffers
		const
			float32Array1 = bufferStack1.float32Array,
			uint32Array1 = bufferStack1.uint32Array,
			uint16Array1 = bufferStack1.uint16Array,
			float32Array2 = bufferStack2.float32Array,
			uint32Array2 = bufferStack2.uint32Array,
			uint16Array2 = bufferStack2.uint16Array;

		const node1Index16 = node1Index32 * 2;
		const node2Index16 = node2Index32 * 2;
		const isLeaf1 = IS_LEAF( node1Index16, uint16Array1 );
		const isLeaf2 = IS_LEAF( node2Index16, uint16Array2 );
		let result = false;
		if ( isLeaf2 && isLeaf1 ) {

			// if both bounds are leaf nodes then fire the callback if the boxes intersect
			// Note the "nodeIndex" values are just intended to be used as unique identifiers in the tree and
			// not used for accessing data
			if ( reversed ) {

				result = intersectsRangesFunc(
					OFFSET( node2Index32, uint32Array2 ), COUNT( node2Index32 * 2, uint16Array2 ),
					OFFSET( node1Index32, uint32Array1 ), COUNT( node1Index32 * 2, uint16Array1 ),
					depth2, node2IndexOffset + node2Index32 / UINT32_PER_NODE,
					depth1, node1IndexOffset + node1Index32 / UINT32_PER_NODE,
				);

			} else {

				result = intersectsRangesFunc(
					OFFSET( node1Index32, uint32Array1 ), COUNT( node1Index32 * 2, uint16Array1 ),
					OFFSET( node2Index32, uint32Array2 ), COUNT( node2Index32 * 2, uint16Array2 ),
					depth1, node1IndexOffset + node1Index32 / UINT32_PER_NODE,
					depth2, node2IndexOffset + node2Index32 / UINT32_PER_NODE,
				);

			}

		} else if ( isLeaf2 ) {

			// SWAP
			// If we've traversed to the leaf node on the other bvh then we need to swap over
			// to traverse down the first one

			// get the new box to use
			const newBox = _boxPool.getPrimitive();
			arrayToBox( BOUNDING_DATA_INDEX( node2Index32 ), float32Array2, newBox );
			newBox.applyMatrix4( matrix2to1 );

			// get the child bounds to check before traversal
			const cl1 = LEFT_NODE( node1Index32 );
			const cr1 = RIGHT_NODE( node1Index32, uint32Array1 );
			arrayToBox( BOUNDING_DATA_INDEX( cl1 ), float32Array1, _leftBox1 );
			arrayToBox( BOUNDING_DATA_INDEX( cr1 ), float32Array1, _rightBox1 );

			// precompute the intersections otherwise the global boxes will be modified during traversal
			const intersectCl1 = newBox.intersectsBox( _leftBox1 );
			const intersectCr1 = newBox.intersectsBox( _rightBox1 );
			result = (
				intersectCl1 && _traverse(
					node2Index32, cl1, matrix1to2, matrix2to1, intersectsRangesFunc,
					node2IndexOffset, node1IndexOffset, depth2, depth1 + 1,
					newBox, ! reversed,
				)
			) || (
				intersectCr1 && _traverse(
					node2Index32, cr1, matrix1to2, matrix2to1, intersectsRangesFunc,
					node2IndexOffset, node1IndexOffset, depth2, depth1 + 1,
					newBox, ! reversed,
				)
			);

			_boxPool.releasePrimitive( newBox );

		} else {

			// if neither are leaves then we should swap if one of the children does not
			// intersect with the current bounds

			// get the child bounds to check
			const cl2 = LEFT_NODE( node2Index32 );
			const cr2 = RIGHT_NODE( node2Index32, uint32Array2 );
			arrayToBox( BOUNDING_DATA_INDEX( cl2 ), float32Array2, _leftBox2 );
			arrayToBox( BOUNDING_DATA_INDEX( cr2 ), float32Array2, _rightBox2 );

			const leftIntersects = currBox.intersectsBox( _leftBox2 );
			const rightIntersects = currBox.intersectsBox( _rightBox2 );
			if ( leftIntersects && rightIntersects ) {

				// continue to traverse both children if they both intersect
				result = _traverse(
					node1Index32, cl2, matrix2to1, matrix1to2, intersectsRangesFunc,
					node1IndexOffset, node2IndexOffset, depth1, depth2 + 1,
					currBox, reversed,
				) || _traverse(
					node1Index32, cr2, matrix2to1, matrix1to2, intersectsRangesFunc,
					node1IndexOffset, node2IndexOffset, depth1, depth2 + 1,
					currBox, reversed,
				);

			} else if ( leftIntersects ) {

				if ( isLeaf1 ) {

					// if the current box is a leaf then just continue
					result = _traverse(
						node1Index32, cl2, matrix2to1, matrix1to2, intersectsRangesFunc,
						node1IndexOffset, node2IndexOffset, depth1, depth2 + 1,
						currBox, reversed,
					);

				} else {

					// SWAP
					// if only one box intersects then we have to swap to the other bvh to continue
					const newBox = _boxPool.getPrimitive();
					newBox.copy( _leftBox2 ).applyMatrix4( matrix2to1 );

					const cl1 = LEFT_NODE( node1Index32 );
					const cr1 = RIGHT_NODE( node1Index32, uint32Array1 );
					arrayToBox( BOUNDING_DATA_INDEX( cl1 ), float32Array1, _leftBox1 );
					arrayToBox( BOUNDING_DATA_INDEX( cr1 ), float32Array1, _rightBox1 );

					// precompute the intersections otherwise the global boxes will be modified during traversal
					const intersectCl1 = newBox.intersectsBox( _leftBox1 );
					const intersectCr1 = newBox.intersectsBox( _rightBox1 );
					result = (
						intersectCl1 && _traverse(
							cl2, cl1, matrix1to2, matrix2to1, intersectsRangesFunc,
							node2IndexOffset, node1IndexOffset, depth2, depth1 + 1,
							newBox, ! reversed,
						)
					) || (
						intersectCr1 && _traverse(
							cl2, cr1, matrix1to2, matrix2to1, intersectsRangesFunc,
							node2IndexOffset, node1IndexOffset, depth2, depth1 + 1,
							newBox, ! reversed,
						)
					);

					_boxPool.releasePrimitive( newBox );

				}

			} else if ( rightIntersects ) {

				if ( isLeaf1 ) {

					// if the current box is a leaf then just continue
					result = _traverse(
						node1Index32, cr2, matrix2to1, matrix1to2, intersectsRangesFunc,
						node1IndexOffset, node2IndexOffset, depth1, depth2 + 1,
						currBox, reversed,
					);

				} else {

					// SWAP
					// if only one box intersects then we have to swap to the other bvh to continue
					const newBox = _boxPool.getPrimitive();
					newBox.copy( _rightBox2 ).applyMatrix4( matrix2to1 );

					const cl1 = LEFT_NODE( node1Index32 );
					const cr1 = RIGHT_NODE( node1Index32, uint32Array1 );
					arrayToBox( BOUNDING_DATA_INDEX( cl1 ), float32Array1, _leftBox1 );
					arrayToBox( BOUNDING_DATA_INDEX( cr1 ), float32Array1, _rightBox1 );

					// precompute the intersections otherwise the global boxes will be modified during traversal
					const intersectCl1 = newBox.intersectsBox( _leftBox1 );
					const intersectCr1 = newBox.intersectsBox( _rightBox1 );
					result = (
						intersectCl1 && _traverse(
							cr2, cl1, matrix1to2, matrix2to1, intersectsRangesFunc,
							node2IndexOffset, node1IndexOffset, depth2, depth1 + 1,
							newBox, ! reversed,
						)
					) || (
						intersectCr1 && _traverse(
							cr2, cr1, matrix1to2, matrix2to1, intersectsRangesFunc,
							node2IndexOffset, node1IndexOffset, depth2, depth1 + 1,
							newBox, ! reversed,
						)
					);

					_boxPool.releasePrimitive( newBox );

				}

			}

		}

		return result;

	}

	// converts the given BVH raycast intersection to align with the three.js raycast
	// structure (include object, world space distance and point).
	function convertRaycastIntersect( hit, object, raycaster ) {

		if ( hit === null ) {

			return null;

		}

		hit.point.applyMatrix4( object.matrixWorld );
		hit.distance = hit.point.distanceTo( raycaster.ray.origin );
		hit.object = object;

		return hit;

	}

	function isSharedArrayBufferSupported() {

		return typeof SharedArrayBuffer !== 'undefined';

	}

	function convertToBufferType( array, BufferConstructor ) {

		if ( array === null ) {

			return array;

		} else if ( array.buffer ) {

			const buffer = array.buffer;
			if ( buffer.constructor === BufferConstructor ) {

				return array;

			}

			const ArrayConstructor = array.constructor;
			const result = new ArrayConstructor( new BufferConstructor( buffer.byteLength ) );
			result.set( array );
			return result;

		} else {

			if ( array.constructor === BufferConstructor ) {

				return array;

			}

			const result = new BufferConstructor( array.byteLength );
			new Uint8Array( result ).set( new Uint8Array( array ) );
			return result;

		}

	}

	// construct a new buffer that points to the set of triangles represented by the given ranges
	function generateIndirectBuffer( ranges, useSharedArrayBuffer ) {

		const lastRange = ranges[ ranges.length - 1 ];
		const useUint32 = lastRange.offset + lastRange.count > 2 ** 16;

		// use getRootIndexRanges which excludes gaps
		const length = ranges.reduce( ( acc, val ) => acc + val.count, 0 );
		const byteCount = useUint32 ? 4 : 2;
		const buffer = useSharedArrayBuffer ? new SharedArrayBuffer( length * byteCount ) : new ArrayBuffer( length * byteCount );
		const indirectBuffer = useUint32 ? new Uint32Array( buffer ) : new Uint16Array( buffer );

		// construct a compact form of the triangles in these ranges
		let index = 0;
		for ( let r = 0; r < ranges.length; r ++ ) {

			const { offset, count } = ranges[ r ];
			for ( let i = 0; i < count; i ++ ) {

				indirectBuffer[ index + i ] = offset + i;

			}

			index += count;

		}

		return indirectBuffer;

	}

	class GeometryBVH extends BVH {

		get indirect() {

			return ! ! this._indirectBuffer;

		}

		get primitiveStride() {

			return null;

		}

		get primitiveBufferStride() {

			return this.indirect ? 1 : this.primitiveStride;

		}
		set primitiveBufferStride( v ) {}

		get primitiveBuffer() {

			return this.indirect ? this._indirectBuffer : this.geometry.index.array;

		}
		set primitiveBuffer( v ) {}

		constructor( geometry, options = {} ) {

			if ( ! geometry.isBufferGeometry ) {

				throw new Error( 'BVH: Only BufferGeometries are supported.' );

			} else if ( geometry.index && geometry.index.isInterleavedBufferAttribute ) {

				throw new Error( 'BVH: InterleavedBufferAttribute is not supported for the index attribute.' );

			}

			if ( options.useSharedArrayBuffer && ! isSharedArrayBufferSupported() ) {

				throw new Error( 'BVH: SharedArrayBuffer is not available.' );

			}

			super();

			// retain references to the geometry so we can use them it without having to
			// take a geometry reference in every function.
			this.geometry = geometry;
			this.resolvePrimitiveIndex = options.indirect ? i => this._indirectBuffer[ i ] : i => i;
			this.primitiveBuffer = null;
			this.primitiveBufferStride = null;
			this._indirectBuffer = null;

			options = {
				...DEFAULT_OPTIONS,
				...options,
			};

			// build the BVH unless we're deserializing
			if ( ! options[ SKIP_GENERATION ] ) {

				this.init( options );

			}

		}

		init( options ) {

			const { geometry, primitiveStride } = this;

			if ( options.indirect ) {

				// construct an buffer that is indirectly sorts the triangles used for the BVH
				const ranges = getRootPrimitiveRanges( geometry, options.range, primitiveStride );
				const indirectBuffer = generateIndirectBuffer( ranges, options.useSharedArrayBuffer );
				this._indirectBuffer = indirectBuffer;

			} else {

				ensureIndex( geometry, options );

			}

			super.init( options );

			if ( ! geometry.boundingBox && options.setBoundingBox ) {

				geometry.boundingBox = this.getBoundingBox( new three.Box3() );

			}

		}

		// Abstract methods to be implemented by subclasses
		computePrimitiveBounds( /* offset, count */ ) {

			throw new Error( 'BVH: computePrimitiveBounds() not implemented' );

		}

		getRootRanges( range ) {

			// TODO: can we avoid passing options in here
			if ( this.indirect ) {

				return [ { offset: 0, count: this._indirectBuffer.length } ];


			} else {

				return getRootPrimitiveRanges( this.geometry, range, this.primitiveStride );

			}

		}

		raycastObject3D( /* object, raycaster, intersects = [] */ ) {

			throw new Error( 'BVH: raycastObject3D() not implemented' );

		}

		shapecast( callbacks ) {

			let {
				iterateDirect,
				iterateIndirect,
				...rest
			} = callbacks;

			const selectedIterateFunc = this.indirect ? iterateIndirect : iterateDirect;
			return super.shapecast( {
				...rest,
				iterate: selectedIterateFunc,
			} );

		}

	}

	const _obb = /* @__PURE__ */ new OrientedBox();
	const _ray$2 = /* @__PURE__ */ new three.Ray();
	const _direction$1 = /* @__PURE__ */ new three.Vector3();
	const _InverseMatrix = /* @__PURE__ */ new three.Matrix4();
	const _worldScale = /* @__PURE__ */ new three.Vector3();

	class MeshBVH extends GeometryBVH {

		static serialize( bvh, options = {} ) {

			options = {
				cloneBuffers: true,
				...options,
			};

			const geometry = bvh.geometry;
			const rootData = bvh._roots;
			const indirectBuffer = bvh._indirectBuffer;
			const indexAttribute = geometry.getIndex();
			const result = {
				version: 1,
				roots: null,
				index: null,
				indirectBuffer: null,
			};
			if ( options.cloneBuffers ) {

				result.roots = rootData.map( root => root.slice() );
				result.index = indexAttribute ? indexAttribute.array.slice() : null;
				result.indirectBuffer = indirectBuffer ? indirectBuffer.slice() : null;

			} else {

				result.roots = rootData;
				result.index = indexAttribute ? indexAttribute.array : null;
				result.indirectBuffer = indirectBuffer;

			}

			return result;

		}

		static deserialize( data, geometry, options = {} ) {

			options = {
				setIndex: true,
				indirect: Boolean( data.indirectBuffer ),
				...options,
			};

			const { index, roots, indirectBuffer } = data;

			// handle backwards compatibility by fixing up the buffer roots
			// see issue gkjohnson/three-mesh-bvh#759
			if ( ! data.version ) {

				console.warn(
					'MeshBVH.deserialize: Serialization format has been changed and will be fixed up. ' +
					'It is recommended to regenerate any stored serialized data.'
				);
				fixupVersion0( roots );

			}

			const bvh = new MeshBVH( geometry, { ...options, [ SKIP_GENERATION ]: true } );
			bvh._roots = roots;
			bvh._indirectBuffer = indirectBuffer || null;

			if ( options.setIndex ) {

				const indexAttribute = geometry.getIndex();
				if ( indexAttribute === null ) {

					const newIndex = new three.BufferAttribute( data.index, 1, false );
					geometry.setIndex( newIndex );

				} else if ( indexAttribute.array !== index ) {

					indexAttribute.array.set( index );
					indexAttribute.needsUpdate = true;

				}

			}

			return bvh;

			// convert version 0 serialized data (uint32 indices) to version 1 (node indices)
			function fixupVersion0( roots ) {

				for ( let rootIndex = 0; rootIndex < roots.length; rootIndex ++ ) {

					const root = roots[ rootIndex ];
					const uint32Array = new Uint32Array( root );
					const uint16Array = new Uint16Array( root );

					// iterate over nodes and convert right child offsets
					for ( let node = 0, l = root.byteLength / BYTES_PER_NODE; node < l; node ++ ) {

						const node32Index = UINT32_PER_NODE * node;
						const node16Index = 2 * node32Index;
						if ( ! IS_LEAF( node16Index, uint16Array ) ) {

							// convert absolute right child offset to relative offset
							uint32Array[ node32Index + 6 ] = uint32Array[ node32Index + 6 ] / UINT32_PER_NODE - node;

						}

					}

				}

			}

		}

		get primitiveStride() {

			return 3;

		}

		get resolveTriangleIndex() {

			return this.resolvePrimitiveIndex;

		}

		constructor( geometry, options = {} ) {

			if ( options.maxLeafTris ) {

				options = {
					...options,
					maxLeafSize: options.maxLeafTris,
				};

			}

			super( geometry, options );

		}

		// implement abstract methods from BVH base class
		shiftTriangleOffsets( offset ) {

			return super.shiftPrimitiveOffsets( offset );

		}

		// precomputes the bounding box for each triangle; required for quickly calculating tree splits.
		// result is an array of size count * 6 where triangle i maps to a
		// [x_center, x_delta, y_center, y_delta, z_center, z_delta] tuple starting at index (i - offset) * 6,
		// representing the center and half-extent in each dimension of triangle i
		computePrimitiveBounds( offset, count, targetBuffer ) {

			const geometry = this.geometry;
			const indirectBuffer = this._indirectBuffer;
			const posAttr = geometry.attributes.position;
			const index = geometry.index ? geometry.index.array : null;
			const normalized = posAttr.normalized;

			if ( offset < 0 || count + offset - targetBuffer.offset > targetBuffer.length / 6 ) {

				throw new Error( 'MeshBVH: compute triangle bounds range is invalid.' );

			}

			// used for non-normalized positions
			const posArr = posAttr.array;

			// support for an interleaved position buffer
			const bufferOffset = posAttr.offset || 0;
			let stride = 3;
			if ( posAttr.isInterleavedBufferAttribute ) {

				stride = posAttr.data.stride;

			}

			// used for normalized positions
			const getters = [ 'getX', 'getY', 'getZ' ];
			const writeOffset = targetBuffer.offset;

			// iterate over the triangle range
			for ( let i = offset, l = offset + count; i < l; i ++ ) {

				const tri = indirectBuffer ? indirectBuffer[ i ] : i;
				const tri3 = tri * 3;
				const boundsIndexOffset = ( i - writeOffset ) * 6;

				let ai = tri3 + 0;
				let bi = tri3 + 1;
				let ci = tri3 + 2;

				if ( index ) {

					ai = index[ ai ];
					bi = index[ bi ];
					ci = index[ ci ];

				}

				// we add the stride and offset here since we access the array directly
				// below for the sake of performance
				if ( ! normalized ) {

					ai = ai * stride + bufferOffset;
					bi = bi * stride + bufferOffset;
					ci = ci * stride + bufferOffset;

				}

				for ( let el = 0; el < 3; el ++ ) {

					let a, b, c;

					if ( normalized ) {

						a = posAttr[ getters[ el ] ]( ai );
						b = posAttr[ getters[ el ] ]( bi );
						c = posAttr[ getters[ el ] ]( ci );

					} else {

						a = posArr[ ai + el ];
						b = posArr[ bi + el ];
						c = posArr[ ci + el ];

					}

					let min = a;
					if ( b < min ) min = b;
					if ( c < min ) min = c;

					let max = a;
					if ( b > max ) max = b;
					if ( c > max ) max = c;

					// Increase the bounds size by float32 epsilon to avoid precision errors when
					// converting to 32 bit float. Scale the epsilon by the size of the numbers being
					// worked with.
					const halfExtents = ( max - min ) / 2;
					const el2 = el * 2;
					targetBuffer[ boundsIndexOffset + el2 + 0 ] = min + halfExtents;
					targetBuffer[ boundsIndexOffset + el2 + 1 ] = halfExtents + ( Math.abs( min ) + halfExtents ) * FLOAT32_EPSILON;

				}

			}

			return targetBuffer;

		}

		raycastObject3D( object, raycaster, intersects = [] ) {

			const { material } = object;
			if ( material === undefined ) {

				return;

			}

			_InverseMatrix.copy( object.matrixWorld ).invert();
			_ray$2.copy( raycaster.ray ).applyMatrix4( _InverseMatrix );

			_worldScale.setFromMatrixScale( object.matrixWorld );
			_direction$1.copy( _ray$2.direction ).multiply( _worldScale );

			const scaleFactor = _direction$1.length();
			const near = raycaster.near / scaleFactor;
			const far = raycaster.far / scaleFactor;

			if ( raycaster.firstHitOnly === true ) {

				let hit = this.raycastFirst( _ray$2, material, near, far );
				hit = convertRaycastIntersect( hit, object, raycaster );
				if ( hit ) {

					intersects.push( hit );

				}

			} else {

				const hits = this.raycast( _ray$2, material, near, far );
				for ( let i = 0, l = hits.length; i < l; i ++ ) {

					const hit = convertRaycastIntersect( hits[ i ], object, raycaster );
					if ( hit ) {

						intersects.push( hit );

					}

				}

			}

			return intersects;

		}

		refit( nodeIndices = null ) {

			const refitFunc = this.indirect ? refit_indirect : refit;
			return refitFunc( this, nodeIndices );

		}

		/* Core Cast Functions */
		raycast( ray, materialOrSide = three.FrontSide, near = 0, far = Infinity ) {

			const roots = this._roots;
			const intersects = [];
			const raycastFunc = this.indirect ? raycast_indirect : raycast;
			for ( let i = 0, l = roots.length; i < l; i ++ ) {

				raycastFunc( this, i, materialOrSide, ray, intersects, near, far );

			}

			return intersects;

		}

		raycastFirst( ray, materialOrSide = three.FrontSide, near = 0, far = Infinity ) {

			const roots = this._roots;
			let closestResult = null;

			const raycastFirstFunc = this.indirect ? raycastFirst_indirect : raycastFirst;
			for ( let i = 0, l = roots.length; i < l; i ++ ) {

				const result = raycastFirstFunc( this, i, materialOrSide, ray, near, far );
				if ( result != null && ( closestResult == null || result.distance < closestResult.distance ) ) {

					closestResult = result;

				}

			}

			return closestResult;

		}

		intersectsGeometry( otherGeometry, geomToMesh ) {

			let result = false;
			const roots = this._roots;
			const intersectsGeometryFunc = this.indirect ? intersectsGeometry_indirect : intersectsGeometry;
			for ( let i = 0, l = roots.length; i < l; i ++ ) {

				result = intersectsGeometryFunc( this, i, otherGeometry, geomToMesh );

				if ( result ) {

					break;

				}

			}

			return result;

		}

		shapecast( callbacks ) {

			const triangle = ExtendedTrianglePool.getPrimitive();
			const result = super.shapecast(
				{
					...callbacks,
					intersectsPrimitive: callbacks.intersectsTriangle,
					scratchPrimitive: triangle,

					// TODO: is the performance significant enough for the added complexity here?
					// can we just use one function?
					iterateDirect: iterateOverTriangles,
					iterateIndirect: iterateOverTriangles_indirect,
				}
			);
			ExtendedTrianglePool.releasePrimitive( triangle );

			return result;

		}

		bvhcast( otherBvh, matrixToLocal, callbacks ) {

			let {
				intersectsRanges,
				intersectsTriangles,
			} = callbacks;

			const triangle1 = ExtendedTrianglePool.getPrimitive();
			const indexAttr1 = this.geometry.index;
			const positionAttr1 = this.geometry.attributes.position;
			const assignTriangle1 = this.indirect ?
				i1 => {


					const ti = this.resolveTriangleIndex( i1 );
					setTriangle( triangle1, ti * 3, indexAttr1, positionAttr1 );

				} :
				i1 => {

					setTriangle( triangle1, i1 * 3, indexAttr1, positionAttr1 );

				};

			const triangle2 = ExtendedTrianglePool.getPrimitive();
			const indexAttr2 = otherBvh.geometry.index;
			const positionAttr2 = otherBvh.geometry.attributes.position;
			const assignTriangle2 = otherBvh.indirect ?
				i2 => {

					const ti2 = otherBvh.resolveTriangleIndex( i2 );
					setTriangle( triangle2, ti2 * 3, indexAttr2, positionAttr2 );

				} :
				i2 => {

					setTriangle( triangle2, i2 * 3, indexAttr2, positionAttr2 );

				};

			// generate triangle callback if needed
			if ( intersectsTriangles ) {

				const iterateOverDoubleTriangles = ( offset1, count1, offset2, count2, depth1, nodeIndex1, depth2, nodeIndex2 ) => {

					for ( let i2 = offset2, l2 = offset2 + count2; i2 < l2; i2 ++ ) {

						assignTriangle2( i2 );

						triangle2.a.applyMatrix4( matrixToLocal );
						triangle2.b.applyMatrix4( matrixToLocal );
						triangle2.c.applyMatrix4( matrixToLocal );
						triangle2.needsUpdate = true;

						for ( let i1 = offset1, l1 = offset1 + count1; i1 < l1; i1 ++ ) {

							assignTriangle1( i1 );

							triangle1.needsUpdate = true;

							if ( intersectsTriangles( triangle1, triangle2, i1, i2, depth1, nodeIndex1, depth2, nodeIndex2 ) ) {

								return true;

							}

						}

					}

					return false;

				};

				if ( intersectsRanges ) {

					const originalIntersectsRanges = intersectsRanges;
					intersectsRanges = function ( offset1, count1, offset2, count2, depth1, nodeIndex1, depth2, nodeIndex2 ) {

						if ( ! originalIntersectsRanges( offset1, count1, offset2, count2, depth1, nodeIndex1, depth2, nodeIndex2 ) ) {

							return iterateOverDoubleTriangles( offset1, count1, offset2, count2, depth1, nodeIndex1, depth2, nodeIndex2 );

						}

						return true;

					};

				} else {

					intersectsRanges = iterateOverDoubleTriangles;

				}

			}

			return bvhcast( this, otherBvh, matrixToLocal, intersectsRanges );

		}


		/* Derived Cast Functions */
		intersectsBox( box, boxToMesh ) {

			_obb.set( box.min, box.max, boxToMesh );
			_obb.needsUpdate = true;

			return this.shapecast(
				{
					intersectsBounds: box => _obb.intersectsBox( box ),
					intersectsTriangle: tri => _obb.intersectsTriangle( tri )
				}
			);

		}

		intersectsSphere( sphere ) {

			return this.shapecast(
				{
					intersectsBounds: box => sphere.intersectsBox( box ),
					intersectsTriangle: tri => tri.intersectsSphere( sphere )
				}
			);

		}

		closestPointToGeometry( otherGeometry, geometryToBvh, target1 = { }, target2 = { }, minThreshold = 0, maxThreshold = Infinity ) {

			const closestPointToGeometryFunc = this.indirect ? closestPointToGeometry_indirect : closestPointToGeometry;
			return closestPointToGeometryFunc(
				this,
				otherGeometry,
				geometryToBvh,
				target1,
				target2,
				minThreshold,
				maxThreshold,
			);

		}

		closestPointToPoint( point, target = { }, minThreshold = 0, maxThreshold = Infinity ) {

			return closestPointToPoint(
				this,
				point,
				target,
				minThreshold,
				maxThreshold,
			);

		}

	}

	const _inverseMatrix$1 = /* @__PURE__ */ new three.Matrix4();
	const _ray$1 = /* @__PURE__ */ new three.Ray();
	const _linePool = /* @__PURE__ */ new PrimitivePool( () => new three.Line3() );
	const _intersectPointOnRay = /*@__PURE__*/ new three.Vector3();
	const _intersectPointOnSegment = /*@__PURE__*/ new three.Vector3();
	const _box$1 = /* @__PURE__ */ new three.Box3();

	class LineSegmentsBVH extends GeometryBVH {

		get primitiveStride() {

			return 2;

		}

		computePrimitiveBounds( offset, count, targetBuffer ) {

			const indirectBuffer = this._indirectBuffer;
			const { geometry, primitiveStride } = this;

			const posAttr = geometry.attributes.position;
			const boundsOffset = targetBuffer.offset || 0;

			// TODO: this may not be right for a LineLoop with a limited draw range / groups
			const vertCount = geometry.index ? geometry.index.count : geometry.attributes.position.count;
			const getters = [ 'getX', 'getY', 'getZ' ];

			for ( let i = offset, end = offset + count; i < end; i ++ ) {

				const prim = indirectBuffer ? indirectBuffer[ i ] : i;
				let i0 = prim * primitiveStride;
				let i1 = ( i0 + 1 ) % vertCount;
				if ( geometry.index ) {

					i0 = geometry.index.getX( i0 );
					i1 = geometry.index.getX( i1 );

				}

				const baseIndex = ( i - boundsOffset ) * 6;
				for ( let el = 0; el < 3; el ++ ) {

					const v0 = posAttr[ getters[ el ] ]( i0 );
					const v1 = posAttr[ getters[ el ] ]( i1 );
					const min = v0 < v1 ? v0 : v1;
					const max = v0 > v1 ? v0 : v1;

					const halfExtents = ( max - min ) / 2;
					const el2 = el * 2;
					targetBuffer[ baseIndex + el2 + 0 ] = min + halfExtents;
					targetBuffer[ baseIndex + el2 + 1 ] = halfExtents + ( Math.abs( min ) + halfExtents ) * FLOAT32_EPSILON;

				}

			}

			return targetBuffer;

		}

		shapecast( callbacks ) {

			const line = _linePool.getPrimitive();
			const result = super.shapecast( {
				...callbacks,
				intersectsPrimitive: callbacks.intersectsLine,
				scratchPrimitive: line,
				iterateDirect: iterateOverLines,
				iterateIndirect: iterateOverLines,
			} );
			_linePool.releasePrimitive( line );

			return result;

		}

		raycastObject3D( object, raycaster, intersects = [] ) {

			const { matrixWorld } = object;
			const { firstHitOnly } = raycaster;

			_inverseMatrix$1.copy( matrixWorld ).invert();
			_ray$1.copy( raycaster.ray ).applyMatrix4( _inverseMatrix$1 );

			const threshold = raycaster.params.Line.threshold;
			const localThreshold = threshold / ( ( object.scale.x + object.scale.y + object.scale.z ) / 3 );
			const localThresholdSq = localThreshold * localThreshold;

			let closestHit = null;
			let closestDistance = Infinity;
			this.shapecast( {
				boundsTraverseOrder: box => {

					return box.distanceToPoint( _ray$1.origin );

				},
				intersectsBounds: box => {

					// TODO: for some reason trying to early-out here is causing firstHitOnly tests to fail
					_box$1.copy( box ).expandByScalar( Math.abs( localThreshold ) );
					return _ray$1.intersectsBox( _box$1 ) ? INTERSECTED : NOT_INTERSECTED;

				},
				intersectsLine: ( line, index ) => {

					const distSq = _ray$1.distanceSqToSegment( line.start, line.end, _intersectPointOnRay, _intersectPointOnSegment );

					if ( distSq > localThresholdSq ) return;

					_intersectPointOnRay.applyMatrix4( object.matrixWorld );

					const distance = raycaster.ray.origin.distanceTo( _intersectPointOnRay );

					if ( distance < raycaster.near || distance > raycaster.far ) return;

					if ( firstHitOnly && distance >= closestDistance ) return;
					closestDistance = distance;

					index = this.resolvePrimitiveIndex( index );

					closestHit = {
						distance,
						point: _intersectPointOnSegment.clone().applyMatrix4( matrixWorld ),
						index: index * this.primitiveStride,
						face: null,
						faceIndex: null,
						barycoord: null,
						object,
					};

					if ( ! firstHitOnly ) {

						intersects.push( closestHit );

					}

				},
			} );

			if ( firstHitOnly && closestHit ) {

				intersects.push( closestHit );

			}

			return intersects;

		}

	}

	class LineLoopBVH extends LineSegmentsBVH {

		get primitiveStride() {

			return 1;

		}

		constructor( geometry, options = {} ) {

			// "Line" and "LineLoop" BVH must be indirect since we cannot rearrange the index
			// buffer without breaking the lines
			options = {
				...options,
				indirect: true,
			};

			super( geometry, options );

		}

	}

	class LineBVH extends LineLoopBVH {

		getRootRanges( ...args ) {

			const res = super.getRootRanges( ...args );
			res.forEach( group => group.count -- );
			return res;

		}

	}

	function iterateOverLines(
		offset,
		count,
		bvh,
		intersectsPointFunc,
		contained,
		depth,
		line
	) {

		const { geometry, primitiveStride } = bvh;
		const { index } = geometry;
		const posAttr = geometry.attributes.position;
		const vertCount = index ? index.count : posAttr.count;

		for ( let i = offset, l = count + offset; i < l; i ++ ) {

			const prim = bvh.resolvePrimitiveIndex( i );
			let i0 = prim * primitiveStride;
			let i1 = ( i0 + 1 ) % vertCount;
			if ( index ) {

				i0 = index.getX( i0 );
				i1 = index.getX( i1 );

			}

			line.start.fromBufferAttribute( posAttr, i0 );
			line.end.fromBufferAttribute( posAttr, i1 );

			if ( intersectsPointFunc( line, i, contained, depth ) ) {

				return true;

			}

		}

		return false;

	}

	const _inverseMatrix = /* @__PURE__ */ new three.Matrix4();
	const _ray = /* @__PURE__ */ new three.Ray();
	const _pointPool = /* @__PURE__ */ new PrimitivePool( () => new three.Vector3() );
	const _box = /* @__PURE__ */ new three.Box3();

	class PointsBVH extends GeometryBVH {

		get primitiveStride() {

			return 1;

		}

		// Implement abstract methods from BVH base class
		computePrimitiveBounds( offset, count, targetBuffer ) {

			const indirectBuffer = this._indirectBuffer;
			const { geometry } = this;

			const posAttr = geometry.attributes.position;
			const boundsOffset = targetBuffer.offset || 0;
			for ( let i = offset, end = offset + count; i < end; i ++ ) {

				let pointIndex = indirectBuffer ? indirectBuffer[ i ] : i;
				if ( geometry.index ) {

					pointIndex = geometry.index.getX( pointIndex );

				}

				const baseIndex = ( i - boundsOffset ) * 6;
				const px = posAttr.getX( pointIndex );
				const py = posAttr.getY( pointIndex );
				const pz = posAttr.getZ( pointIndex );
				targetBuffer[ baseIndex + 0 ] = px;
				targetBuffer[ baseIndex + 1 ] = Math.abs( px ) * FLOAT32_EPSILON;
				targetBuffer[ baseIndex + 2 ] = py;
				targetBuffer[ baseIndex + 3 ] = Math.abs( py ) * FLOAT32_EPSILON;
				targetBuffer[ baseIndex + 4 ] = pz;
				targetBuffer[ baseIndex + 5 ] = Math.abs( pz ) * FLOAT32_EPSILON;

			}

			return targetBuffer;

		}

		shapecast( callbacks ) {

			// TODO: avoid unnecessary "iterate over points" function
			const point = _pointPool.getPrimitive();
			const result = super.shapecast(
				{
					...callbacks,
					intersectsPrimitive: callbacks.intersectsPoint,
					scratchPrimitive: point,
					iterateDirect: iterateOverPoints,
					iterateIndirect: iterateOverPoints,
				},
			);

			_pointPool.releasePrimitive( point );
			return result;

		}

		raycastObject3D( object, raycaster, intersects = [] ) {

			const { geometry } = this;
			const { matrixWorld } = object;
			const { firstHitOnly } = raycaster;

			_inverseMatrix.copy( matrixWorld ).invert();
			_ray.copy( raycaster.ray ).applyMatrix4( _inverseMatrix );

			const threshold = raycaster.params.Points.threshold;
			const localThreshold = threshold / ( ( object.scale.x + object.scale.y + object.scale.z ) / 3 );
			const localThresholdSq = localThreshold * localThreshold;

			let closestHit = null;
			let closestDistance = Infinity;
			this.shapecast( {
				boundsTraverseOrder: box => {

					return box.distanceToPoint( _ray.origin );

				},
				intersectsBounds: box => {

					// TODO: for some reason trying to early-out here is causing firstHitOnly tests to fail
					_box.copy( box ).expandByScalar( Math.abs( localThreshold ) );
					return _ray.intersectsBox( _box ) ? INTERSECTED : NOT_INTERSECTED;

				},
				intersectsPoint: ( point, index ) => {

					const rayPointDistanceSq = _ray.distanceSqToPoint( point );
					if ( rayPointDistanceSq < localThresholdSq ) {

						const intersectPoint = new three.Vector3();

						_ray.closestPointToPoint( point, intersectPoint );
						intersectPoint.applyMatrix4( matrixWorld );

						const distance = raycaster.ray.origin.distanceTo( intersectPoint );

						if ( distance < raycaster.near || distance > raycaster.far ) return;

						if ( firstHitOnly && distance >= closestDistance ) return;
						closestDistance = distance;

						index = this.resolvePrimitiveIndex( index );

						closestHit = {
							distance,
							// TODO: this doesn't seem right?
							distanceToRay: Math.sqrt( rayPointDistanceSq ),
							point: intersectPoint,
							index: geometry.index ? geometry.index.getX( index ) : index,
							face: null,
							faceIndex: null,
							barycoord: null,
							object,
						};

						if ( ! firstHitOnly ) {

							intersects.push( closestHit );

						}

					}

				},
			} );

			if ( firstHitOnly && closestHit ) {

				intersects.push( closestHit );

			}

			return intersects;

		}

	}

	function iterateOverPoints(
		offset,
		count,
		bvh,
		intersectsPointFunc,
		contained,
		depth,
		point
	) {

		const { geometry } = bvh;
		const { index } = geometry;
		const pos = geometry.attributes.position;

		for ( let i = offset, l = count + offset; i < l; i ++ ) {

			const prim = bvh.resolvePrimitiveIndex( i );
			const vertexIndex = index ? index.array[ prim ] : prim;
			point.fromBufferAttribute( pos, vertexIndex );

			if ( intersectsPointFunc( point, i, contained, depth ) ) {

				return true;

			}

		}

		return false;

	}

	const boundingBox = /* @__PURE__ */ new three.Box3();
	const matrix = /* @__PURE__ */ new three.Matrix4();

	class BVHRootHelper extends three.Object3D {

		get isMesh() {

			return ! this.displayEdges;

		}

		get isLineSegments() {

			return this.displayEdges;

		}

		get isLine() {

			return this.displayEdges;

		}

		getVertexPosition( ...args ) {

			// implement this function so it works with Box3.setFromObject
			return three.Mesh.prototype.getVertexPosition.call( this, ...args );

		}

		constructor( bvh, material, depth = 10, group = 0 ) {

			super();

			this.material = material;
			this.geometry = new three.BufferGeometry();
			this.name = 'BVHRootHelper';
			this.depth = depth;
			this.displayParents = false;
			this.bvh = bvh;
			this.displayEdges = true;
			this._group = group;

		}

		raycast() {}

		update() {

			const geometry = this.geometry;
			const boundsTree = this.bvh;
			const group = this._group;
			geometry.dispose();
			this.visible = false;
			if ( boundsTree ) {

				// count the number of bounds required
				const targetDepth = this.depth - 1;
				const displayParents = this.displayParents;
				let boundsCount = 0;
				boundsTree.traverse( ( depth, isLeaf ) => {

					if ( depth >= targetDepth || isLeaf ) {

						boundsCount ++;
						return true;

					} else if ( displayParents ) {

						boundsCount ++;

					}

				}, group );

				// fill in the position buffer with the bounds corners
				let posIndex = 0;
				const positionArray = new Float32Array( 8 * 3 * boundsCount );
				boundsTree.traverse( ( depth, isLeaf, boundingData ) => {

					const terminate = depth >= targetDepth || isLeaf;
					if ( terminate || displayParents ) {

						arrayToBox( 0, boundingData, boundingBox );

						const { min, max } = boundingBox;
						for ( let x = - 1; x <= 1; x += 2 ) {

							const xVal = x < 0 ? min.x : max.x;
							for ( let y = - 1; y <= 1; y += 2 ) {

								const yVal = y < 0 ? min.y : max.y;
								for ( let z = - 1; z <= 1; z += 2 ) {

									const zVal = z < 0 ? min.z : max.z;
									positionArray[ posIndex + 0 ] = xVal;
									positionArray[ posIndex + 1 ] = yVal;
									positionArray[ posIndex + 2 ] = zVal;

									posIndex += 3;

								}

							}

						}

						return terminate;

					}

				}, group );

				let indexArray;
				let indices;
				if ( this.displayEdges ) {

					// fill in the index buffer to point to the corner points
					indices = new Uint8Array( [
						// x axis
						0, 4,
						1, 5,
						2, 6,
						3, 7,

						// y axis
						0, 2,
						1, 3,
						4, 6,
						5, 7,

						// z axis
						0, 1,
						2, 3,
						4, 5,
						6, 7,
					] );

				} else {

					indices = new Uint8Array( [

						// X-, X+
						0, 1, 2,
						2, 1, 3,

						4, 6, 5,
						6, 7, 5,

						// Y-, Y+
						1, 4, 5,
						0, 4, 1,

						2, 3, 6,
						3, 7, 6,

						// Z-, Z+
						0, 2, 4,
						2, 6, 4,

						1, 5, 3,
						3, 5, 7,

					] );

				}

				if ( positionArray.length > 65535 ) {

					indexArray = new Uint32Array( indices.length * boundsCount );

				} else {

					indexArray = new Uint16Array( indices.length * boundsCount );

				}

				const indexLength = indices.length;
				for ( let i = 0; i < boundsCount; i ++ ) {

					const posOffset = i * 8;
					const indexOffset = i * indexLength;
					for ( let j = 0; j < indexLength; j ++ ) {

						indexArray[ indexOffset + j ] = posOffset + indices[ j ];

					}

				}

				// update the geometry
				geometry.setIndex(
					new three.BufferAttribute( indexArray, 1, false ),
				);
				geometry.setAttribute(
					'position',
					new three.BufferAttribute( positionArray, 3, false ),
				);
				this.visible = true;

			}

		}

	}

	class BVHHelper extends three.Group {

		get color() {

			return this.edgeMaterial.color;

		}

		get opacity() {

			return this.edgeMaterial.opacity;

		}

		set opacity( v ) {

			this.edgeMaterial.opacity = v;
			this.meshMaterial.opacity = v;

		}

		constructor( mesh = null, bvh = null, depth = 10 ) {

			// handle bvh, depth signature
			if ( mesh instanceof MeshBVH ) {

				depth = bvh || 10;
				bvh = mesh;
				mesh = null;

			}

			// handle mesh, depth signature
			if ( typeof bvh === 'number' ) {

				depth = bvh;
				bvh = null;

			}

			super();

			this.name = 'BVHHelper';
			this.depth = depth;
			this.mesh = mesh;
			this.bvh = bvh;
			this.displayParents = false;
			this.displayEdges = true;
			this.objectIndex = 0;
			this._roots = [];

			const edgeMaterial = new three.LineBasicMaterial( {
				color: 0x00FF88,
				transparent: true,
				opacity: 0.3,
				depthWrite: false,
			} );

			const meshMaterial = new three.MeshBasicMaterial( {
				color: 0x00FF88,
				transparent: true,
				opacity: 0.3,
				depthWrite: false,
			} );

			meshMaterial.color = edgeMaterial.color;

			this.edgeMaterial = edgeMaterial;
			this.meshMaterial = meshMaterial;

			this.update();

		}

		update() {

			const mesh = this.mesh;
			let bvh = this.bvh || mesh.geometry.boundsTree || null;
			if ( mesh && mesh.isBatchedMesh && mesh.boundsTrees && ! bvh ) {

				// get the bvh from a batchedMesh if not provided
				// TODO: we should have an official way to get the geometry index cleanly
				const drawInfo = mesh._drawInfo[ this.objectIndex ];
				if ( drawInfo ) {

					bvh = mesh.boundsTrees[ drawInfo.geometryIndex ] || bvh;

				}

			}

			const totalRoots = bvh ? bvh._roots.length : 0;
			while ( this._roots.length > totalRoots ) {

				const root = this._roots.pop();
				root.geometry.dispose();
				this.remove( root );

			}

			for ( let i = 0; i < totalRoots; i ++ ) {

				const { depth, edgeMaterial, meshMaterial, displayParents, displayEdges } = this;

				if ( i >= this._roots.length ) {

					const root = new BVHRootHelper( bvh, edgeMaterial, depth, i );
					this.add( root );
					this._roots.push( root );

				}

				const root = this._roots[ i ];
				root.bvh = bvh;
				root.depth = depth;
				root.displayParents = displayParents;
				root.displayEdges = displayEdges;
				root.material = displayEdges ? edgeMaterial : meshMaterial;
				root.update();

			}

		}

		updateMatrixWorld( ...args ) {

			const mesh = this.mesh;
			const parent = this.parent;

			if ( mesh !== null ) {

				mesh.updateWorldMatrix( true, false );

				if ( parent ) {

					this.matrix
						.copy( parent.matrixWorld )
						.invert()
						.multiply( mesh.matrixWorld );

				} else {

					this.matrix
						.copy( mesh.matrixWorld );

				}

				// handle batched and instanced mesh bvhs
				if ( mesh.isInstancedMesh || mesh.isBatchedMesh ) {

					mesh.getMatrixAt( this.objectIndex, matrix );
					this.matrix.multiply( matrix );

				}

				this.matrix.decompose(
					this.position,
					this.quaternion,
					this.scale,
				);

			}

			super.updateMatrixWorld( ...args );

		}

		copy( source ) {

			this.depth = source.depth;
			this.mesh = source.mesh;
			this.bvh = source.bvh;
			this.opacity = source.opacity;
			this.color.copy( source.color );

		}

		clone() {

			return new MeshBVHHelper( this.mesh, this.bvh, this.depth );

		}

		dispose() {

			this.edgeMaterial.dispose();
			this.meshMaterial.dispose();

			const children = this.children;
			for ( let i = 0, l = children.length; i < l; i ++ ) {

				children[ i ].geometry.dispose();

			}

		}

	}

	const _box1 = /* @__PURE__ */ new three.Box3();
	const _box2 = /* @__PURE__ */ new three.Box3();
	const _vec = /* @__PURE__ */ new three.Vector3();

	// https://stackoverflow.com/questions/1248302/how-to-get-the-size-of-a-javascript-object
	function getPrimitiveSize( el ) {

		switch ( typeof el ) {

			case 'number':
				return 8;
			case 'string':
				return el.length * 2;
			case 'boolean':
				return 4;
			default:
				return 0;

		}

	}

	function isTypedArray( arr ) {

		const regex = /(Uint|Int|Float)(8|16|32)Array/;
		return regex.test( arr.constructor.name );

	}

	function getRootExtremes( bvh, group ) {

		const result = {
			nodeCount: 0,
			leafNodeCount: 0,

			depth: {
				min: Infinity, max: - Infinity
			},
			primitives: {
				min: Infinity, max: - Infinity
			},
			splits: [ 0, 0, 0 ],
			surfaceAreaScore: 0,
		};

		bvh.traverse( ( depth, isLeaf, boundingData, offsetOrSplit, count ) => {

			const l0 = boundingData[ 0 + 3 ] - boundingData[ 0 ];
			const l1 = boundingData[ 1 + 3 ] - boundingData[ 1 ];
			const l2 = boundingData[ 2 + 3 ] - boundingData[ 2 ];

			const surfaceArea = 2 * ( l0 * l1 + l1 * l2 + l2 * l0 );

			result.nodeCount ++;
			if ( isLeaf ) {

				result.leafNodeCount ++;

				result.depth.min = Math.min( depth, result.depth.min );
				result.depth.max = Math.max( depth, result.depth.max );

				result.primitives.min = Math.min( count, result.primitives.min );
				result.primitives.max = Math.max( count, result.primitives.max );

				result.surfaceAreaScore += surfaceArea * PRIMITIVE_INTERSECT_COST * count;

			} else {

				result.splits[ offsetOrSplit ] ++;

				result.surfaceAreaScore += surfaceArea * TRAVERSAL_COST;

			}

		}, group );

		// If there are no leaf nodes because the tree hasn't finished generating yet.
		if ( result.primitives.min === Infinity ) {

			result.primitives.min = 0;
			result.primitives.max = 0;

		}

		if ( result.depth.min === Infinity ) {

			result.depth.min = 0;
			result.depth.max = 0;

		}

		return result;

	}

	function getBVHExtremes( bvh ) {

		return bvh._roots.map( ( root, i ) => getRootExtremes( bvh, i ) );

	}

	function estimateMemoryInBytes( obj ) {

		const traversed = new Set();
		const stack = [ obj ];
		let bytes = 0;

		while ( stack.length ) {

			const curr = stack.pop();
			if ( traversed.has( curr ) ) {

				continue;

			}

			traversed.add( curr );

			for ( let key in curr ) {

				if ( ! Object.hasOwn( curr, key ) ) {

					continue;

				}

				bytes += getPrimitiveSize( key );

				const value = curr[ key ];
				if ( value && ( typeof value === 'object' || typeof value === 'function' ) ) {

					if ( isTypedArray( value ) ) {

						bytes += value.byteLength;

					} else if ( isSharedArrayBufferSupported() && value instanceof SharedArrayBuffer ) {

						bytes += value.byteLength;

					} else if ( value instanceof ArrayBuffer ) {

						bytes += value.byteLength;

					} else {

						stack.push( value );

					}

				} else {

					bytes += getPrimitiveSize( value );

				}


			}

		}

		return bytes;

	}

	function validateBounds( bvh ) {

		const geometry = bvh.geometry;
		const depthStack = [];
		const index = geometry.index;
		const position = geometry.getAttribute( 'position' );
		let passes = true;

		bvh.traverse( ( depth, isLeaf, boundingData, offset, count ) => {

			const info = {
				depth,
				isLeaf,
				boundingData,
				offset,
				count,
			};
			depthStack[ depth ] = info;

			arrayToBox( 0, boundingData, _box1 );
			const parent = depthStack[ depth - 1 ];

			if ( isLeaf ) {

				// check triangles
				for ( let i = offset, l = offset + count; i < l; i ++ ) {

					const triIndex = bvh.resolveTriangleIndex( i );
					let i0 = 3 * triIndex;
					let i1 = 3 * triIndex + 1;
					let i2 = 3 * triIndex + 2;

					if ( index ) {

						i0 = index.getX( i0 );
						i1 = index.getX( i1 );
						i2 = index.getX( i2 );

					}

					let isContained;

					_vec.fromBufferAttribute( position, i0 );
					isContained = _box1.containsPoint( _vec );

					_vec.fromBufferAttribute( position, i1 );
					isContained = isContained && _box1.containsPoint( _vec );

					_vec.fromBufferAttribute( position, i2 );
					isContained = isContained && _box1.containsPoint( _vec );

					console.assert( isContained, 'Leaf bounds does not fully contain triangle.' );
					passes = passes && isContained;

				}

			}

			if ( parent ) {

				// check if my bounds fit in my parents
				arrayToBox( 0, boundingData, _box2 );

				const isContained = _box2.containsBox( _box1 );
				console.assert( isContained, 'Parent bounds does not fully contain child.' );
				passes = passes && isContained;

			}

		} );

		return passes;

	}

	// Returns a simple, human readable object that represents the BVH.
	function getJSONStructure( bvh ) {

		const depthStack = [];

		bvh.traverse( ( depth, isLeaf, boundingData, offset, count ) => {

			const info = {
				bounds: arrayToBox( 0, boundingData, new three.Box3() ),
			};

			if ( isLeaf ) {

				info.count = count;
				info.offset = offset;

			} else {

				info.left = null;
				info.right = null;

			}

			depthStack[ depth ] = info;

			// traversal hits the left then right node
			const parent = depthStack[ depth - 1 ];
			if ( parent ) {

				if ( parent.left === null ) {

					parent.left = info;

				} else {

					parent.right = info;

				}

			}

		} );

		return depthStack[ 0 ];

	}

	const IS_REVISION_166 = parseInt( three.REVISION ) >= 166;

	// TODO: how can we expand these raycast functions?
	const _raycastFunctions = {
		'Mesh': three.Mesh.prototype.raycast,
		'Line': three.Line.prototype.raycast,
		'LineSegments': three.LineSegments.prototype.raycast,
		'LineLoop': three.LineLoop.prototype.raycast,
		'Points': three.Points.prototype.raycast,
		'BatchedMesh': three.BatchedMesh.prototype.raycast,
	};

	const _mesh = /* @__PURE__ */ new three.Mesh();
	const _batchIntersects = [];

	function acceleratedRaycast( raycaster, intersects ) {

		if ( this.isBatchedMesh ) {

			acceleratedBatchedMeshRaycast.call( this, raycaster, intersects );

		} else {

			const { geometry } = this;
			if ( geometry.boundsTree ) {

				geometry.boundsTree.raycastObject3D( this, raycaster, intersects );

			} else {

				_raycastFunctions[ this.type ].call( this, raycaster, intersects );

			}

		}

	}

	function acceleratedBatchedMeshRaycast( raycaster, intersects ) {

		if ( this.boundsTrees ) {

			// TODO: remove use of geometry info, instance info when r170 is minimum version
			const boundsTrees = this.boundsTrees;
			const drawInfo = this._drawInfo || this._instanceInfo;
			const drawRanges = this._drawRanges || this._geometryInfo;
			const matrixWorld = this.matrixWorld;

			_mesh.material = this.material;
			_mesh.geometry = this.geometry;

			const oldBoundsTree = _mesh.geometry.boundsTree;
			const oldDrawRange = _mesh.geometry.drawRange;

			if ( _mesh.geometry.boundingSphere === null ) {

				_mesh.geometry.boundingSphere = new three.Sphere();

			}

			// TODO: provide new method to get instances count instead of 'drawInfo.length'
			for ( let i = 0, l = drawInfo.length; i < l; i ++ ) {

				if ( ! this.getVisibleAt( i ) ) {

					continue;

				}

				// TODO: use getGeometryIndex
				const geometryId = drawInfo[ i ].geometryIndex;

				_mesh.geometry.boundsTree = boundsTrees[ geometryId ];

				this.getMatrixAt( i, _mesh.matrixWorld ).premultiply( matrixWorld );

				if ( ! _mesh.geometry.boundsTree ) {

					this.getBoundingBoxAt( geometryId, _mesh.geometry.boundingBox );
					this.getBoundingSphereAt( geometryId, _mesh.geometry.boundingSphere );

					const drawRange = drawRanges[ geometryId ];
					_mesh.geometry.setDrawRange( drawRange.start, drawRange.count );

				}

				_mesh.raycast( raycaster, _batchIntersects );

				for ( let j = 0, l = _batchIntersects.length; j < l; j ++ ) {

					const intersect = _batchIntersects[ j ];
					intersect.object = this;
					intersect.batchId = i;
					intersects.push( intersect );

				}

				_batchIntersects.length = 0;

			}

			_mesh.geometry.boundsTree = oldBoundsTree;
			_mesh.geometry.drawRange = oldDrawRange;
			_mesh.material = null;
			_mesh.geometry = null;

		} else {

			_raycastFunctions.BatchedMesh.call( this, raycaster, intersects );

		}

	}

	function computeBoundsTree( options = {} ) {

		const { type = MeshBVH } = options;
		this.boundsTree = new type( this, options );
		return this.boundsTree;

	}

	function disposeBoundsTree() {

		this.boundsTree = null;

	}

	function computeBatchedBoundsTree( index = - 1, options = {} ) {

		if ( ! IS_REVISION_166 ) {

			throw new Error( 'BatchedMesh: Three r166+ is required to compute bounds trees.' );

		}

		options = {
			...options,
			range: null
		};

		const drawRanges = this._drawRanges || this._geometryInfo;
		const geometryCount = this._geometryCount;
		if ( ! this.boundsTrees ) {

			this.boundsTrees = new Array( geometryCount ).fill( null );

		}

		const boundsTrees = this.boundsTrees;
		while ( boundsTrees.length < geometryCount ) {

			boundsTrees.push( null );

		}

		if ( index < 0 ) {

			for ( let i = 0; i < geometryCount; i ++ ) {

				options.range = drawRanges[ i ];
				boundsTrees[ i ] = new MeshBVH( this.geometry, options );

			}

			return boundsTrees;

		} else {

			if ( index < drawRanges.length ) {

				options.range = drawRanges[ index ];
				boundsTrees[ index ] = new MeshBVH( this.geometry, options );

			}

			return boundsTrees[ index ] || null;

		}

	}

	function disposeBatchedBoundsTree( index = - 1 ) {

		if ( index < 0 ) {

			this.boundsTrees.fill( null );

		} else {

			if ( index < this.boundsTrees.length ) {

				this.boundsTrees[ index ] = null;

			}

		}

	}

	function countToStringFormat( count ) {

		switch ( count ) {

			case 1: return 'R';
			case 2: return 'RG';
			case 3: return 'RGBA';
			case 4: return 'RGBA';

		}

		throw new Error();

	}

	function countToFormat( count ) {

		switch ( count ) {

			case 1: return three.RedFormat;
			case 2: return three.RGFormat;
			case 3: return three.RGBAFormat;
			case 4: return three.RGBAFormat;

		}

	}

	function countToIntFormat( count ) {

		switch ( count ) {

			case 1: return three.RedIntegerFormat;
			case 2: return three.RGIntegerFormat;
			case 3: return three.RGBAIntegerFormat;
			case 4: return three.RGBAIntegerFormat;

		}

	}

	class VertexAttributeTexture extends three.DataTexture {

		constructor() {

			super();
			this.minFilter = three.NearestFilter;
			this.magFilter = three.NearestFilter;
			this.generateMipmaps = false;
			this.overrideItemSize = null;
			this._forcedType = null;

		}

		updateFrom( attr ) {

			const overrideItemSize = this.overrideItemSize;
			const originalItemSize = attr.itemSize;
			const originalCount = attr.count;
			if ( overrideItemSize !== null ) {

				if ( ( originalItemSize * originalCount ) % overrideItemSize !== 0.0 ) {

					throw new Error( 'VertexAttributeTexture: overrideItemSize must divide evenly into buffer length.' );

				}

				attr.itemSize = overrideItemSize;
				attr.count = originalCount * originalItemSize / overrideItemSize;

			}

			const itemSize = attr.itemSize;
			const count = attr.count;
			const normalized = attr.normalized;
			const originalBufferCons = attr.array.constructor;
			const byteCount = originalBufferCons.BYTES_PER_ELEMENT;
			let targetType = this._forcedType;
			let finalStride = itemSize;

			// derive the type of texture this should be in the shader
			if ( targetType === null ) {

				switch ( originalBufferCons ) {

					case Float32Array:
						targetType = three.FloatType;
						break;

					case Uint8Array:
					case Uint16Array:
					case Uint32Array:
						targetType = three.UnsignedIntType;
						break;

					case Int8Array:
					case Int16Array:
					case Int32Array:
						targetType = three.IntType;
						break;

				}

			}

			// get the target format to store the texture as
			let type, format, normalizeValue, targetBufferCons;
			let internalFormat = countToStringFormat( itemSize );
			switch ( targetType ) {

				case three.FloatType:
					normalizeValue = 1.0;
					format = countToFormat( itemSize );

					if ( normalized && byteCount === 1 ) {

						targetBufferCons = originalBufferCons;
						internalFormat += '8';

						if ( originalBufferCons === Uint8Array ) {

							type = three.UnsignedByteType;

						} else {

							type = three.ByteType;
							internalFormat += '_SNORM';

						}

					} else {

						targetBufferCons = Float32Array;
						internalFormat += '32F';
						type = three.FloatType;

					}

					break;

				case three.IntType:
					internalFormat += byteCount * 8 + 'I';
					normalizeValue = normalized ? Math.pow( 2, originalBufferCons.BYTES_PER_ELEMENT * 8 - 1 ) : 1.0;
					format = countToIntFormat( itemSize );

					if ( byteCount === 1 ) {

						targetBufferCons = Int8Array;
						type = three.ByteType;

					} else if ( byteCount === 2 ) {

						targetBufferCons = Int16Array;
						type = three.ShortType;

					} else {

						targetBufferCons = Int32Array;
						type = three.IntType;

					}

					break;

				case three.UnsignedIntType:
					internalFormat += byteCount * 8 + 'UI';
					normalizeValue = normalized ? Math.pow( 2, originalBufferCons.BYTES_PER_ELEMENT * 8 - 1 ) : 1.0;
					format = countToIntFormat( itemSize );

					if ( byteCount === 1 ) {

						targetBufferCons = Uint8Array;
						type = three.UnsignedByteType;

					} else if ( byteCount === 2 ) {

						targetBufferCons = Uint16Array;
						type = three.UnsignedShortType;

					} else {

						targetBufferCons = Uint32Array;
						type = three.UnsignedIntType;

					}

					break;

			}

			// there will be a mismatch between format length and final length because
			// RGBFormat and RGBIntegerFormat was removed
			if ( finalStride === 3 && ( format === three.RGBAFormat || format === three.RGBAIntegerFormat ) ) {

				finalStride = 4;

			}

			// copy the data over to the new texture array
			const dimension = Math.ceil( Math.sqrt( count ) ) || 1;
			const length = finalStride * dimension * dimension;
			const dataArray = new targetBufferCons( length );

			// temporarily set the normalized state to false since we have custom normalization logic
			const originalNormalized = attr.normalized;
			attr.normalized = false;
			for ( let i = 0; i < count; i ++ ) {

				const ii = finalStride * i;
				dataArray[ ii ] = attr.getX( i ) / normalizeValue;

				if ( itemSize >= 2 ) {

					dataArray[ ii + 1 ] = attr.getY( i ) / normalizeValue;

				}

				if ( itemSize >= 3 ) {

					dataArray[ ii + 2 ] = attr.getZ( i ) / normalizeValue;

					if ( finalStride === 4 ) {

						dataArray[ ii + 3 ] = 1.0;

					}

				}

				if ( itemSize >= 4 ) {

					dataArray[ ii + 3 ] = attr.getW( i ) / normalizeValue;

				}

			}

			attr.normalized = originalNormalized;

			this.internalFormat = internalFormat;
			this.format = format;
			this.type = type;
			this.image.width = dimension;
			this.image.height = dimension;
			this.image.data = dataArray;
			this.needsUpdate = true;
			this.dispose();

			attr.itemSize = originalItemSize;
			attr.count = originalCount;

		}

	}

	class UIntVertexAttributeTexture extends VertexAttributeTexture {

		constructor() {

			super();
			this._forcedType = three.UnsignedIntType;

		}

	}

	class IntVertexAttributeTexture extends VertexAttributeTexture {

		constructor() {

			super();
			this._forcedType = three.IntType;

		}


	}

	class FloatVertexAttributeTexture extends VertexAttributeTexture {

		constructor() {

			super();
			this._forcedType = three.FloatType;

		}

	}

	class MeshBVHUniformStruct {

		constructor() {

			this.index = new UIntVertexAttributeTexture();
			this.position = new FloatVertexAttributeTexture();
			this.bvhBounds = new three.DataTexture();
			this.bvhContents = new three.DataTexture();
			this._cachedIndexAttr = null;

			this.index.overrideItemSize = 3;

		}

		updateFrom( bvh ) {

			const { geometry } = bvh;
			bvhToTextures( bvh, this.bvhBounds, this.bvhContents );

			this.position.updateFrom( geometry.attributes.position );

			// dereference a new index attribute if we're using indirect storage
			if ( bvh.indirect ) {

				const indirectBuffer = bvh._indirectBuffer;
				if (
					this._cachedIndexAttr === null ||
					this._cachedIndexAttr.count !== indirectBuffer.length
				) {

					if ( geometry.index ) {

						this._cachedIndexAttr = geometry.index.clone();

					} else {

						const array = getIndexArray( getVertexCount( geometry ) );
						this._cachedIndexAttr = new three.BufferAttribute( array, 1, false );

					}

				}

				dereferenceIndex( geometry, indirectBuffer, this._cachedIndexAttr );
				this.index.updateFrom( this._cachedIndexAttr );

			} else {

				this.index.updateFrom( geometry.index );

			}

		}

		dispose() {

			const { index, position, bvhBounds, bvhContents } = this;

			if ( index ) index.dispose();
			if ( position ) position.dispose();
			if ( bvhBounds ) bvhBounds.dispose();
			if ( bvhContents ) bvhContents.dispose();

		}

	}

	function dereferenceIndex( geometry, indirectBuffer, target ) {

		const unpacked = target.array;
		const indexArray = geometry.index ? geometry.index.array : null;
		for ( let i = 0, l = indirectBuffer.length; i < l; i ++ ) {

			const i3 = 3 * i;
			const v3 = 3 * indirectBuffer[ i ];
			for ( let c = 0; c < 3; c ++ ) {

				unpacked[ i3 + c ] = indexArray ? indexArray[ v3 + c ] : v3 + c;

			}

		}

	}

	function bvhToTextures( bvh, boundsTexture, contentsTexture ) {

		const roots = bvh._roots;

		if ( roots.length !== 1 ) {

			throw new Error( 'MeshBVHUniformStruct: Multi-root BVHs not supported.' );

		}

		const root = roots[ 0 ];
		const uint16Array = new Uint16Array( root );
		const uint32Array = new Uint32Array( root );
		const float32Array = new Float32Array( root );

		// Both bounds need two elements per node so compute the height so it's twice as long as
		// the width so we can expand the row by two and still have a square texture
		const nodeCount = root.byteLength / BYTES_PER_NODE;
		const boundsDimension = 2 * Math.ceil( Math.sqrt( nodeCount / 2 ) );
		const boundsArray = new Float32Array( 4 * boundsDimension * boundsDimension );

		const contentsDimension = Math.ceil( Math.sqrt( nodeCount ) );
		const contentsArray = new Uint32Array( 2 * contentsDimension * contentsDimension );

		for ( let i = 0; i < nodeCount; i ++ ) {

			const nodeIndex32 = i * BYTES_PER_NODE / 4;
			const nodeIndex16 = nodeIndex32 * 2;
			const boundsIndex = BOUNDING_DATA_INDEX( nodeIndex32 );
			for ( let b = 0; b < 3; b ++ ) {

				boundsArray[ 8 * i + 0 + b ] = float32Array[ boundsIndex + 0 + b ];
				boundsArray[ 8 * i + 4 + b ] = float32Array[ boundsIndex + 3 + b ];

			}

			if ( IS_LEAF( nodeIndex16, uint16Array ) ) {

				const count = COUNT( nodeIndex16, uint16Array );
				const offset = OFFSET( nodeIndex32, uint32Array );

				const mergedLeafCount = LEAFNODE_MASK_32 | count;
				contentsArray[ i * 2 + 0 ] = mergedLeafCount;
				contentsArray[ i * 2 + 1 ] = offset;

			} else {

				const rightNodeIndex = uint32Array[ nodeIndex32 + 6 ];
				const splitAxis = SPLIT_AXIS( nodeIndex32, uint32Array );

				contentsArray[ i * 2 + 0 ] = splitAxis;
				contentsArray[ i * 2 + 1 ] = rightNodeIndex;

			}

		}

		boundsTexture.image.data = boundsArray;
		boundsTexture.image.width = boundsDimension;
		boundsTexture.image.height = boundsDimension;
		boundsTexture.format = three.RGBAFormat;
		boundsTexture.type = three.FloatType;
		boundsTexture.internalFormat = 'RGBA32F';
		boundsTexture.minFilter = three.NearestFilter;
		boundsTexture.magFilter = three.NearestFilter;
		boundsTexture.generateMipmaps = false;
		boundsTexture.needsUpdate = true;
		boundsTexture.dispose();

		contentsTexture.image.data = contentsArray;
		contentsTexture.image.width = contentsDimension;
		contentsTexture.image.height = contentsDimension;
		contentsTexture.format = three.RGIntegerFormat;
		contentsTexture.type = three.UnsignedIntType;
		contentsTexture.internalFormat = 'RG32UI';
		contentsTexture.minFilter = three.NearestFilter;
		contentsTexture.magFilter = three.NearestFilter;
		contentsTexture.generateMipmaps = false;
		contentsTexture.needsUpdate = true;
		contentsTexture.dispose();

	}

	const _positionVector$1 = /*@__PURE__*/ new three.Vector3();
	const _normalVector$1 = /*@__PURE__*/ new three.Vector3();
	const _tangentVector$1 = /*@__PURE__*/ new three.Vector3();
	const _tangentVector4$1 = /*@__PURE__*/ new three.Vector4();

	const _morphVector$1 = /*@__PURE__*/ new three.Vector3();
	const _temp$1 = /*@__PURE__*/ new three.Vector3();

	const _skinIndex$1 = /*@__PURE__*/ new three.Vector4();
	const _skinWeight$1 = /*@__PURE__*/ new three.Vector4();
	const _matrix$1 = /*@__PURE__*/ new three.Matrix4();
	const _boneMatrix$1 = /*@__PURE__*/ new three.Matrix4();

	// Confirms that the two provided attributes are compatible
	function validateAttributes$1( attr1, attr2 ) {

		if ( ! attr1 && ! attr2 ) {

			return;

		}

		const sameCount = attr1.count === attr2.count;
		const sameNormalized = attr1.normalized === attr2.normalized;
		const sameType = attr1.array.constructor === attr2.array.constructor;
		const sameItemSize = attr1.itemSize === attr2.itemSize;

		if ( ! sameCount || ! sameNormalized || ! sameType || ! sameItemSize ) {

			throw new Error();

		}

	}

	// Clones the given attribute with a new compatible buffer attribute but no data
	function createAttributeClone$1( attr, countOverride = null ) {

		const cons = attr.array.constructor;
		const normalized = attr.normalized;
		const itemSize = attr.itemSize;
		const count = countOverride === null ? attr.count : countOverride;

		return new three.BufferAttribute( new cons( itemSize * count ), itemSize, normalized );

	}

	// target offset is the number of elements in the target buffer stride to skip before copying the
	// attributes contents in to.
	function copyAttributeContents$1( attr, target, targetOffset = 0 ) {

		if ( attr.isInterleavedBufferAttribute ) {

			const itemSize = attr.itemSize;
			for ( let i = 0, l = attr.count; i < l; i ++ ) {

				const io = i + targetOffset;
				target.setX( io, attr.getX( i ) );
				if ( itemSize >= 2 ) target.setY( io, attr.getY( i ) );
				if ( itemSize >= 3 ) target.setZ( io, attr.getZ( i ) );
				if ( itemSize >= 4 ) target.setW( io, attr.getW( i ) );

			}

		} else {

			const array = target.array;
			const cons = array.constructor;
			const byteOffset = array.BYTES_PER_ELEMENT * attr.itemSize * targetOffset;
			const temp = new cons( array.buffer, byteOffset, attr.array.length );
			temp.set( attr.array );

		}

	}

	// Adds the "matrix" multiplied by "scale" to "target"
	function addScaledMatrix$1( target, matrix, scale ) {

		const targetArray = target.elements;
		const matrixArray = matrix.elements;
		for ( let i = 0, l = matrixArray.length; i < l; i ++ ) {

			targetArray[ i ] += matrixArray[ i ] * scale;

		}

	}

	// A version of "SkinnedMesh.boneTransform" for normals
	function boneNormalTransform$1( mesh, index, target ) {

		const skeleton = mesh.skeleton;
		const geometry = mesh.geometry;
		const bones = skeleton.bones;
		const boneInverses = skeleton.boneInverses;

		_skinIndex$1.fromBufferAttribute( geometry.attributes.skinIndex, index );
		_skinWeight$1.fromBufferAttribute( geometry.attributes.skinWeight, index );

		_matrix$1.elements.fill( 0 );

		for ( let i = 0; i < 4; i ++ ) {

			const weight = _skinWeight$1.getComponent( i );

			if ( weight !== 0 ) {

				const boneIndex = _skinIndex$1.getComponent( i );
				_boneMatrix$1.multiplyMatrices( bones[ boneIndex ].matrixWorld, boneInverses[ boneIndex ] );

				addScaledMatrix$1( _matrix$1, _boneMatrix$1, weight );

			}

		}

		_matrix$1.multiply( mesh.bindMatrix ).premultiply( mesh.bindMatrixInverse );
		target.transformDirection( _matrix$1 );

		return target;

	}

	// Applies the morph target data to the target vector
	function applyMorphTarget$1( morphData, morphInfluences, morphTargetsRelative, i, target ) {

		_morphVector$1.set( 0, 0, 0 );
		for ( let j = 0, jl = morphData.length; j < jl; j ++ ) {

			const influence = morphInfluences[ j ];
			const morphAttribute = morphData[ j ];

			if ( influence === 0 ) continue;

			_temp$1.fromBufferAttribute( morphAttribute, i );

			if ( morphTargetsRelative ) {

				_morphVector$1.addScaledVector( _temp$1, influence );

			} else {

				_morphVector$1.addScaledVector( _temp$1.sub( target ), influence );

			}

		}

		target.add( _morphVector$1 );

	}

	// Modified version of BufferGeometryUtils.mergeBufferGeometries that ignores morph targets and updates a attributes in place
	function mergeBufferGeometries( geometries, options = { useGroups: false, updateIndex: false, skipAttributes: [] }, targetGeometry = new three.BufferGeometry() ) {

		const isIndexed = geometries[ 0 ].index !== null;
		const { useGroups = false, updateIndex = false, skipAttributes = [] } = options;

		const attributesUsed = new Set( Object.keys( geometries[ 0 ].attributes ) );
		const attributes = {};

		let offset = 0;

		targetGeometry.clearGroups();
		for ( let i = 0; i < geometries.length; ++ i ) {

			const geometry = geometries[ i ];
			let attributesCount = 0;

			// ensure that all geometries are indexed, or none
			if ( isIndexed !== ( geometry.index !== null ) ) {

				throw new Error( 'StaticGeometryGenerator: All geometries must have compatible attributes; make sure index attribute exists among all geometries, or in none of them.' );

			}

			// gather attributes, exit early if they're different
			for ( const name in geometry.attributes ) {

				if ( ! attributesUsed.has( name ) ) {

					throw new Error( 'StaticGeometryGenerator: All geometries must have compatible attributes; make sure "' + name + '" attribute exists among all geometries, or in none of them.' );

				}

				if ( attributes[ name ] === undefined ) {

					attributes[ name ] = [];

				}

				attributes[ name ].push( geometry.attributes[ name ] );
				attributesCount ++;

			}

			// ensure geometries have the same number of attributes
			if ( attributesCount !== attributesUsed.size ) {

				throw new Error( 'StaticGeometryGenerator: Make sure all geometries have the same number of attributes.' );

			}

			if ( useGroups ) {

				let count;
				if ( isIndexed ) {

					count = geometry.index.count;

				} else if ( geometry.attributes.position !== undefined ) {

					count = geometry.attributes.position.count;

				} else {

					throw new Error( 'StaticGeometryGenerator: The geometry must have either an index or a position attribute' );

				}

				targetGeometry.addGroup( offset, count, i );
				offset += count;

			}

		}

		// merge indices
		if ( isIndexed ) {

			let forceUpdateIndex = false;
			if ( ! targetGeometry.index ) {

				let indexCount = 0;
				for ( let i = 0; i < geometries.length; ++ i ) {

					indexCount += geometries[ i ].index.count;

				}

				targetGeometry.setIndex( new three.BufferAttribute( new Uint32Array( indexCount ), 1, false ) );
				forceUpdateIndex = true;

			}

			if ( updateIndex || forceUpdateIndex ) {

				const targetIndex = targetGeometry.index;
				let targetOffset = 0;
				let indexOffset = 0;
				for ( let i = 0; i < geometries.length; ++ i ) {

					const geometry = geometries[ i ];
					const index = geometry.index;
					if ( skipAttributes[ i ] !== true ) {

						for ( let j = 0; j < index.count; ++ j ) {

							targetIndex.setX( targetOffset, index.getX( j ) + indexOffset );
							targetOffset ++;

						}

					}

					indexOffset += geometry.attributes.position.count;

				}

			}

		}

		// merge attributes
		for ( const name in attributes ) {

			const attrList = attributes[ name ];
			if ( ! ( name in targetGeometry.attributes ) ) {

				let count = 0;
				for ( const key in attrList ) {

					count += attrList[ key ].count;

				}

				targetGeometry.setAttribute( name, createAttributeClone$1( attributes[ name ][ 0 ], count ) );

			}

			const targetAttribute = targetGeometry.attributes[ name ];
			let offset = 0;
			for ( let i = 0, l = attrList.length; i < l; i ++ ) {

				const attr = attrList[ i ];
				if ( skipAttributes[ i ] !== true ) {

					copyAttributeContents$1( attr, targetAttribute, offset );

				}

				offset += attr.count;

			}

		}

		return targetGeometry;

	}

	function checkTypedArrayEquality( a, b ) {

		if ( a === null || b === null ) {

			return a === b;

		}

		if ( a.length !== b.length ) {

			return false;

		}

		for ( let i = 0, l = a.length; i < l; i ++ ) {

			if ( a[ i ] !== b[ i ] ) {

				return false;

			}

		}

		return true;

	}

	function invertGeometry$1( geometry ) {

		const { index, attributes } = geometry;
		if ( index ) {

			for ( let i = 0, l = index.count; i < l; i += 3 ) {

				const v0 = index.getX( i );
				const v2 = index.getX( i + 2 );
				index.setX( i, v2 );
				index.setX( i + 2, v0 );

			}

		} else {

			for ( const key in attributes ) {

				const attr = attributes[ key ];
				const itemSize = attr.itemSize;
				for ( let i = 0, l = attr.count; i < l; i += 3 ) {

					for ( let j = 0; j < itemSize; j ++ ) {

						const v0 = attr.getComponent( i, j );
						const v2 = attr.getComponent( i + 2, j );
						attr.setComponent( i, j, v2 );
						attr.setComponent( i + 2, j, v0 );

					}

				}

			}

		}

		return geometry;


	}

	// Checks whether the geometry changed between this and last evaluation
	class GeometryDiff {

		constructor( mesh ) {

			this.matrixWorld = new three.Matrix4();
			this.geometryHash = null;
			this.boneMatrices = null;
			this.primitiveCount = - 1;
			this.mesh = mesh;

			this.update();

		}

		update() {

			const mesh = this.mesh;
			const geometry = mesh.geometry;
			const skeleton = mesh.skeleton;
			const primitiveCount = ( geometry.index ? geometry.index.count : geometry.attributes.position.count ) / 3;
			this.matrixWorld.copy( mesh.matrixWorld );
			this.geometryHash = geometry.attributes.position.version;
			this.primitiveCount = primitiveCount;

			if ( skeleton ) {

				// ensure the bone matrix array is updated to the appropriate length
				if ( ! skeleton.boneTexture ) {

					skeleton.computeBoneTexture();

				}

				skeleton.update();

				// copy data if possible otherwise clone it
				const boneMatrices = skeleton.boneMatrices;
				if ( ! this.boneMatrices || this.boneMatrices.length !== boneMatrices.length ) {

					this.boneMatrices = boneMatrices.slice();

				} else {

					this.boneMatrices.set( boneMatrices );

				}

			} else {

				this.boneMatrices = null;

			}

		}

		didChange() {

			const mesh = this.mesh;
			const geometry = mesh.geometry;
			const primitiveCount = ( geometry.index ? geometry.index.count : geometry.attributes.position.count ) / 3;
			const identical =
				this.matrixWorld.equals( mesh.matrixWorld ) &&
				this.geometryHash === geometry.attributes.position.version &&
				checkTypedArrayEquality( mesh.skeleton && mesh.skeleton.boneMatrices || null, this.boneMatrices ) &&
				this.primitiveCount === primitiveCount;

			return ! identical;

		}

	}

	class StaticGeometryGenerator$1 {

		constructor( meshes ) {

			if ( ! Array.isArray( meshes ) ) {

				meshes = [ meshes ];

			}

			const finalMeshes = [];
			meshes.forEach( object => {

				object.traverseVisible( c => {

					if ( c.isMesh ) {

						finalMeshes.push( c );

					}

				} );

			} );

			this.meshes = finalMeshes;
			this.useGroups = true;
			this.applyWorldTransforms = true;
			this.attributes = [ 'position', 'normal', 'color', 'tangent', 'uv', 'uv2' ];
			this._intermediateGeometry = new Array( finalMeshes.length ).fill().map( () => new three.BufferGeometry() );
			this._diffMap = new WeakMap();

		}

		getMaterials() {

			const materials = [];
			this.meshes.forEach( mesh => {

				if ( Array.isArray( mesh.material ) ) {

					materials.push( ...mesh.material );

				} else {

					materials.push( mesh.material );

				}

			} );
			return materials;

		}

		generate( targetGeometry = new three.BufferGeometry() ) {

			// track which attributes have been updated and which to skip to avoid unnecessary attribute copies
			let skipAttributes = [];
			const { meshes, useGroups, _intermediateGeometry, _diffMap } = this;
			for ( let i = 0, l = meshes.length; i < l; i ++ ) {

				const mesh = meshes[ i ];
				const geom = _intermediateGeometry[ i ];
				const diff = _diffMap.get( mesh );
				if ( ! diff || diff.didChange( mesh ) ) {

					this._convertToStaticGeometry( mesh, geom );
					skipAttributes.push( false );

					if ( ! diff ) {

						_diffMap.set( mesh, new GeometryDiff( mesh ) );

					} else {

						diff.update();

					}

				} else {

					skipAttributes.push( true );

				}

			}

			if ( _intermediateGeometry.length === 0 ) {

				// if there are no geometries then just create a fake empty geometry to provide
				targetGeometry.setIndex( null );

				// remove all geometry
				const attrs = targetGeometry.attributes;
				for ( const key in attrs ) {

					targetGeometry.deleteAttribute( key );

				}

				// create dummy attributes
				for ( const key in this.attributes ) {

					targetGeometry.setAttribute( this.attributes[ key ], new three.BufferAttribute( new Float32Array( 0 ), 4, false ) );

				}

			} else {

				mergeBufferGeometries( _intermediateGeometry, { useGroups, skipAttributes }, targetGeometry );

			}

			for ( const key in targetGeometry.attributes ) {

				targetGeometry.attributes[ key ].needsUpdate = true;

			}

			return targetGeometry;

		}

		_convertToStaticGeometry( mesh, targetGeometry = new three.BufferGeometry() ) {

			const geometry = mesh.geometry;
			const applyWorldTransforms = this.applyWorldTransforms;
			const includeNormal = this.attributes.includes( 'normal' );
			const includeTangent = this.attributes.includes( 'tangent' );
			const attributes = geometry.attributes;
			const targetAttributes = targetGeometry.attributes;

			// initialize the attributes if they don't exist
			if ( ! targetGeometry.index && geometry.index ) {

				targetGeometry.index = geometry.index.clone();

			}

			if ( ! targetAttributes.position ) {

				targetGeometry.setAttribute( 'position', createAttributeClone$1( attributes.position ) );

			}

			if ( includeNormal && ! targetAttributes.normal && attributes.normal ) {

				targetGeometry.setAttribute( 'normal', createAttributeClone$1( attributes.normal ) );

			}

			if ( includeTangent && ! targetAttributes.tangent && attributes.tangent ) {

				targetGeometry.setAttribute( 'tangent', createAttributeClone$1( attributes.tangent ) );

			}

			// ensure the attributes are consistent
			validateAttributes$1( geometry.index, targetGeometry.index );
			validateAttributes$1( attributes.position, targetAttributes.position );

			if ( includeNormal ) {

				validateAttributes$1( attributes.normal, targetAttributes.normal );

			}

			if ( includeTangent ) {

				validateAttributes$1( attributes.tangent, targetAttributes.tangent );

			}

			// generate transformed vertex attribute data
			const position = attributes.position;
			const normal = includeNormal ? attributes.normal : null;
			const tangent = includeTangent ? attributes.tangent : null;
			const morphPosition = geometry.morphAttributes.position;
			const morphNormal = geometry.morphAttributes.normal;
			const morphTangent = geometry.morphAttributes.tangent;
			const morphTargetsRelative = geometry.morphTargetsRelative;
			const morphInfluences = mesh.morphTargetInfluences;
			const normalMatrix = new three.Matrix3();
			normalMatrix.getNormalMatrix( mesh.matrixWorld );

			// copy the index
			if ( geometry.index ) {

				targetGeometry.index.array.set( geometry.index.array );

			}

			// copy and apply other attributes
			for ( let i = 0, l = attributes.position.count; i < l; i ++ ) {

				_positionVector$1.fromBufferAttribute( position, i );
				if ( normal ) {

					_normalVector$1.fromBufferAttribute( normal, i );

				}

				if ( tangent ) {

					_tangentVector4$1.fromBufferAttribute( tangent, i );
					_tangentVector$1.fromBufferAttribute( tangent, i );

				}

				// apply morph target transform
				if ( morphInfluences ) {

					if ( morphPosition ) {

						applyMorphTarget$1( morphPosition, morphInfluences, morphTargetsRelative, i, _positionVector$1 );

					}

					if ( morphNormal ) {

						applyMorphTarget$1( morphNormal, morphInfluences, morphTargetsRelative, i, _normalVector$1 );

					}

					if ( morphTangent ) {

						applyMorphTarget$1( morphTangent, morphInfluences, morphTargetsRelative, i, _tangentVector$1 );

					}

				}

				// apply bone transform
				if ( mesh.isSkinnedMesh ) {

					mesh.applyBoneTransform( i, _positionVector$1 );
					if ( normal ) {

						boneNormalTransform$1( mesh, i, _normalVector$1 );

					}

					if ( tangent ) {

						boneNormalTransform$1( mesh, i, _tangentVector$1 );

					}

				}

				// update the vectors of the attributes
				if ( applyWorldTransforms ) {

					_positionVector$1.applyMatrix4( mesh.matrixWorld );

				}

				targetAttributes.position.setXYZ( i, _positionVector$1.x, _positionVector$1.y, _positionVector$1.z );

				if ( normal ) {

					if ( applyWorldTransforms ) {

						_normalVector$1.applyNormalMatrix( normalMatrix );

					}

					targetAttributes.normal.setXYZ( i, _normalVector$1.x, _normalVector$1.y, _normalVector$1.z );

				}

				if ( tangent ) {

					if ( applyWorldTransforms ) {

						_tangentVector$1.transformDirection( mesh.matrixWorld );

					}

					targetAttributes.tangent.setXYZW( i, _tangentVector$1.x, _tangentVector$1.y, _tangentVector$1.z, _tangentVector4$1.w );

				}

			}

			// copy other attributes over
			for ( const i in this.attributes ) {

				const key = this.attributes[ i ];
				if ( key === 'position' || key === 'tangent' || key === 'normal' || ! ( key in attributes ) ) {

					continue;

				}

				if ( ! targetAttributes[ key ] ) {

					targetGeometry.setAttribute( key, createAttributeClone$1( attributes[ key ] ) );

				}

				validateAttributes$1( attributes[ key ], targetAttributes[ key ] );
				copyAttributeContents$1( attributes[ key ], targetAttributes[ key ] );

			}

			if ( mesh.matrixWorld.determinant() < 0 ) {

				invertGeometry$1( targetGeometry );

			}

			return targetGeometry;

		}

	}

	const common_functions = /* glsl */`

// A stack of uint32 indices can can store the indices for
// a perfectly balanced tree with a depth up to 31. Lower stack
// depth gets higher performance.
//
// However not all trees are balanced. Best value to set this to
// is the trees max depth.
#ifndef BVH_STACK_DEPTH
#define BVH_STACK_DEPTH 60
#endif

#ifndef INFINITY
#define INFINITY 1e20
#endif

// Utilities
uvec4 uTexelFetch1D( usampler2D tex, uint index ) {

	uint width = uint( textureSize( tex, 0 ).x );
	uvec2 uv;
	uv.x = index % width;
	uv.y = index / width;

	return texelFetch( tex, ivec2( uv ), 0 );

}

ivec4 iTexelFetch1D( isampler2D tex, uint index ) {

	uint width = uint( textureSize( tex, 0 ).x );
	uvec2 uv;
	uv.x = index % width;
	uv.y = index / width;

	return texelFetch( tex, ivec2( uv ), 0 );

}

vec4 texelFetch1D( sampler2D tex, uint index ) {

	uint width = uint( textureSize( tex, 0 ).x );
	uvec2 uv;
	uv.x = index % width;
	uv.y = index / width;

	return texelFetch( tex, ivec2( uv ), 0 );

}

vec4 textureSampleBarycoord( sampler2D tex, vec3 barycoord, uvec3 faceIndices ) {

	return
		barycoord.x * texelFetch1D( tex, faceIndices.x ) +
		barycoord.y * texelFetch1D( tex, faceIndices.y ) +
		barycoord.z * texelFetch1D( tex, faceIndices.z );

}

void ndcToCameraRay(
	vec2 coord, mat4 cameraWorld, mat4 invProjectionMatrix,
	out vec3 rayOrigin, out vec3 rayDirection
) {

	// get camera look direction and near plane for camera clipping
	vec4 lookDirection = cameraWorld * vec4( 0.0, 0.0, - 1.0, 0.0 );
	vec4 nearVector = invProjectionMatrix * vec4( 0.0, 0.0, - 1.0, 1.0 );
	float near = abs( nearVector.z / nearVector.w );

	// get the camera direction and position from camera matrices
	vec4 origin = cameraWorld * vec4( 0.0, 0.0, 0.0, 1.0 );
	vec4 direction = invProjectionMatrix * vec4( coord, 0.5, 1.0 );
	direction /= direction.w;
	direction = cameraWorld * direction - origin;

	// slide the origin along the ray until it sits at the near clip plane position
	origin.xyz += direction.xyz * near / dot( direction, lookDirection );

	rayOrigin = origin.xyz;
	rayDirection = direction.xyz;

}
`;

	// Distance to Point
	const bvh_distance_functions = /* glsl */`

float dot2( vec3 v ) {

	return dot( v, v );

}

// https://www.shadertoy.com/view/ttfGWl
vec3 closestPointToTriangle( vec3 p, vec3 v0, vec3 v1, vec3 v2, out vec3 barycoord ) {

    vec3 v10 = v1 - v0;
    vec3 v21 = v2 - v1;
    vec3 v02 = v0 - v2;

	vec3 p0 = p - v0;
	vec3 p1 = p - v1;
	vec3 p2 = p - v2;

    vec3 nor = cross( v10, v02 );

    // method 2, in barycentric space
    vec3  q = cross( nor, p0 );
    float d = 1.0 / dot2( nor );
    float u = d * dot( q, v02 );
    float v = d * dot( q, v10 );
    float w = 1.0 - u - v;

	if( u < 0.0 ) {

		w = clamp( dot( p2, v02 ) / dot2( v02 ), 0.0, 1.0 );
		u = 0.0;
		v = 1.0 - w;

	} else if( v < 0.0 ) {

		u = clamp( dot( p0, v10 ) / dot2( v10 ), 0.0, 1.0 );
		v = 0.0;
		w = 1.0 - u;

	} else if( w < 0.0 ) {

		v = clamp( dot( p1, v21 ) / dot2( v21 ), 0.0, 1.0 );
		w = 0.0;
		u = 1.0 - v;

	}

	barycoord = vec3( u, v, w );
    return u * v1 + v * v2 + w * v0;

}

float distanceToTriangles(
	// geometry info and triangle range
	sampler2D positionAttr, usampler2D indexAttr, uint offset, uint count,

	// point and cut off range
	vec3 point, float closestDistanceSquared,

	// outputs
	inout uvec4 faceIndices, inout vec3 faceNormal, inout vec3 barycoord, inout float side, inout vec3 outPoint
) {

	bool found = false;
	vec3 localBarycoord;
	for ( uint i = offset, l = offset + count; i < l; i ++ ) {

		uvec3 indices = uTexelFetch1D( indexAttr, i ).xyz;
		vec3 a = texelFetch1D( positionAttr, indices.x ).rgb;
		vec3 b = texelFetch1D( positionAttr, indices.y ).rgb;
		vec3 c = texelFetch1D( positionAttr, indices.z ).rgb;

		// get the closest point and barycoord
		vec3 closestPoint = closestPointToTriangle( point, a, b, c, localBarycoord );
		vec3 delta = point - closestPoint;
		float sqDist = dot2( delta );
		if ( sqDist < closestDistanceSquared ) {

			// set the output results
			closestDistanceSquared = sqDist;
			faceIndices = uvec4( indices.xyz, i );
			faceNormal = normalize( cross( a - b, b - c ) );
			barycoord = localBarycoord;
			outPoint = closestPoint;
			side = sign( dot( faceNormal, delta ) );

		}

	}

	return closestDistanceSquared;

}

float distanceSqToBounds( vec3 point, vec3 boundsMin, vec3 boundsMax ) {

	vec3 clampedPoint = clamp( point, boundsMin, boundsMax );
	vec3 delta = point - clampedPoint;
	return dot( delta, delta );

}

float distanceSqToBVHNodeBoundsPoint( vec3 point, sampler2D bvhBounds, uint currNodeIndex ) {

	uint cni2 = currNodeIndex * 2u;
	vec3 boundsMin = texelFetch1D( bvhBounds, cni2 ).xyz;
	vec3 boundsMax = texelFetch1D( bvhBounds, cni2 + 1u ).xyz;
	return distanceSqToBounds( point, boundsMin, boundsMax );

}

// use a macro to hide the fact that we need to expand the struct into separate fields
#define\
	bvhClosestPointToPoint(\
		bvh,\
		point, maxDistance, faceIndices, faceNormal, barycoord, side, outPoint\
	)\
	_bvhClosestPointToPoint(\
		bvh.position, bvh.index, bvh.bvhBounds, bvh.bvhContents,\
		point, maxDistance, faceIndices, faceNormal, barycoord, side, outPoint\
	)

float _bvhClosestPointToPoint(
	// bvh info
	sampler2D bvh_position, usampler2D bvh_index, sampler2D bvh_bvhBounds, usampler2D bvh_bvhContents,

	// point to check
	vec3 point, float maxDistance,

	// output variables
	inout uvec4 faceIndices, inout vec3 faceNormal, inout vec3 barycoord,
	inout float side, inout vec3 outPoint
 ) {

	// stack needs to be twice as long as the deepest tree we expect because
	// we push both the left and right child onto the stack every traversal
	int ptr = 0;
	uint stack[ BVH_STACK_DEPTH ];
	stack[ 0 ] = 0u;

	float closestDistanceSquared = maxDistance * maxDistance;
	bool found = false;
	while ( ptr > - 1 && ptr < BVH_STACK_DEPTH ) {

		uint currNodeIndex = stack[ ptr ];
		ptr --;

		// check if we intersect the current bounds
		float boundsHitDistance = distanceSqToBVHNodeBoundsPoint( point, bvh_bvhBounds, currNodeIndex );
		if ( boundsHitDistance > closestDistanceSquared ) {

			continue;

		}

		uvec2 boundsInfo = uTexelFetch1D( bvh_bvhContents, currNodeIndex ).xy;
		bool isLeaf = bool( boundsInfo.x & 0xffff0000u );
		if ( isLeaf ) {

			uint count = boundsInfo.x & 0x0000ffffu;
			uint offset = boundsInfo.y;
			closestDistanceSquared = distanceToTriangles(
				bvh_position, bvh_index, offset, count, point, closestDistanceSquared,

				// outputs
				faceIndices, faceNormal, barycoord, side, outPoint
			);

		} else {

			uint leftIndex = currNodeIndex + 1u;
			uint splitAxis = boundsInfo.x & 0x0000ffffu;
			uint rightIndex = currNodeIndex + boundsInfo.y;
			bool leftToRight = distanceSqToBVHNodeBoundsPoint( point, bvh_bvhBounds, leftIndex ) < distanceSqToBVHNodeBoundsPoint( point, bvh_bvhBounds, rightIndex );//rayDirection[ splitAxis ] >= 0.0;
			uint c1 = leftToRight ? leftIndex : rightIndex;
			uint c2 = leftToRight ? rightIndex : leftIndex;

			// set c2 in the stack so we traverse it later. We need to keep track of a pointer in
			// the stack while we traverse. The second pointer added is the one that will be
			// traversed first
			ptr ++;
			stack[ ptr ] = c2;
			ptr ++;
			stack[ ptr ] = c1;

		}

	}

	return sqrt( closestDistanceSquared );

}
`;

	const bvh_ray_functions = /* glsl */`

#ifndef TRI_INTERSECT_EPSILON
#define TRI_INTERSECT_EPSILON 1e-5
#endif

// Raycasting
bool intersectsBounds( vec3 rayOrigin, vec3 rayDirection, vec3 boundsMin, vec3 boundsMax, out float dist ) {

	// https://www.reddit.com/r/opengl/comments/8ntzz5/fast_glsl_ray_box_intersection/
	// https://tavianator.com/2011/ray_box.html
	vec3 invDir = 1.0 / rayDirection;

	// find intersection distances for each plane
	vec3 tMinPlane = invDir * ( boundsMin - rayOrigin );
	vec3 tMaxPlane = invDir * ( boundsMax - rayOrigin );

	// get the min and max distances from each intersection
	vec3 tMinHit = min( tMaxPlane, tMinPlane );
	vec3 tMaxHit = max( tMaxPlane, tMinPlane );

	// get the furthest hit distance
	vec2 t = max( tMinHit.xx, tMinHit.yz );
	float t0 = max( t.x, t.y );

	// get the minimum hit distance
	t = min( tMaxHit.xx, tMaxHit.yz );
	float t1 = min( t.x, t.y );

	// set distance to 0.0 if the ray starts inside the box
	dist = max( t0, 0.0 );

	return t1 >= dist;

}

bool intersectsTriangle(
	vec3 rayOrigin, vec3 rayDirection, vec3 a, vec3 b, vec3 c,
	out vec3 barycoord, out vec3 norm, out float dist, out float side
) {

	// https://stackoverflow.com/questions/42740765/intersection-between-line-and-triangle-in-3d
	vec3 edge1 = b - a;
	vec3 edge2 = c - a;
	norm = cross( edge1, edge2 );

	float det = - dot( rayDirection, norm );
	float invdet = 1.0 / det;

	vec3 AO = rayOrigin - a;
	vec3 DAO = cross( AO, rayDirection );

	vec4 uvt;
	uvt.x = dot( edge2, DAO ) * invdet;
	uvt.y = - dot( edge1, DAO ) * invdet;
	uvt.z = dot( AO, norm ) * invdet;
	uvt.w = 1.0 - uvt.x - uvt.y;

	// set the hit information
	barycoord = uvt.wxy; // arranged in A, B, C order
	dist = uvt.z;
	side = sign( det );
	norm = side * normalize( norm );

	// add an epsilon to avoid misses between triangles
	uvt += vec4( TRI_INTERSECT_EPSILON );

	return all( greaterThanEqual( uvt, vec4( 0.0 ) ) );

}

bool intersectTriangles(
	// geometry info and triangle range
	sampler2D positionAttr, usampler2D indexAttr, uint offset, uint count,

	// ray
	vec3 rayOrigin, vec3 rayDirection,

	// outputs
	inout float minDistance, inout uvec4 faceIndices, inout vec3 faceNormal, inout vec3 barycoord,
	inout float side, inout float dist
) {

	bool found = false;
	vec3 localBarycoord, localNormal;
	float localDist, localSide;
	for ( uint i = offset, l = offset + count; i < l; i ++ ) {

		uvec3 indices = uTexelFetch1D( indexAttr, i ).xyz;
		vec3 a = texelFetch1D( positionAttr, indices.x ).rgb;
		vec3 b = texelFetch1D( positionAttr, indices.y ).rgb;
		vec3 c = texelFetch1D( positionAttr, indices.z ).rgb;

		if (
			intersectsTriangle( rayOrigin, rayDirection, a, b, c, localBarycoord, localNormal, localDist, localSide )
			&& localDist < minDistance
		) {

			found = true;
			minDistance = localDist;

			faceIndices = uvec4( indices.xyz, i );
			faceNormal = localNormal;

			side = localSide;
			barycoord = localBarycoord;
			dist = localDist;

		}

	}

	return found;

}

bool intersectsBVHNodeBounds( vec3 rayOrigin, vec3 rayDirection, sampler2D bvhBounds, uint currNodeIndex, out float dist ) {

	uint cni2 = currNodeIndex * 2u;
	vec3 boundsMin = texelFetch1D( bvhBounds, cni2 ).xyz;
	vec3 boundsMax = texelFetch1D( bvhBounds, cni2 + 1u ).xyz;
	return intersectsBounds( rayOrigin, rayDirection, boundsMin, boundsMax, dist );

}

// use a macro to hide the fact that we need to expand the struct into separate fields
#define\
	bvhIntersectFirstHit(\
		bvh,\
		rayOrigin, rayDirection, faceIndices, faceNormal, barycoord, side, dist\
	)\
	_bvhIntersectFirstHit(\
		bvh.position, bvh.index, bvh.bvhBounds, bvh.bvhContents,\
		rayOrigin, rayDirection, faceIndices, faceNormal, barycoord, side, dist\
	)

bool _bvhIntersectFirstHit(
	// bvh info
	sampler2D bvh_position, usampler2D bvh_index, sampler2D bvh_bvhBounds, usampler2D bvh_bvhContents,

	// ray
	vec3 rayOrigin, vec3 rayDirection,

	// output variables split into separate variables due to output precision
	inout uvec4 faceIndices, inout vec3 faceNormal, inout vec3 barycoord,
	inout float side, inout float dist
) {

	// stack needs to be twice as long as the deepest tree we expect because
	// we push both the left and right child onto the stack every traversal
	int ptr = 0;
	uint stack[ BVH_STACK_DEPTH ];
	stack[ 0 ] = 0u;

	float triangleDistance = INFINITY;
	bool found = false;
	while ( ptr > - 1 && ptr < BVH_STACK_DEPTH ) {

		uint currNodeIndex = stack[ ptr ];
		ptr --;

		// check if we intersect the current bounds
		float boundsHitDistance;
		if (
			! intersectsBVHNodeBounds( rayOrigin, rayDirection, bvh_bvhBounds, currNodeIndex, boundsHitDistance )
			|| boundsHitDistance > triangleDistance
		) {

			continue;

		}

		uvec2 boundsInfo = uTexelFetch1D( bvh_bvhContents, currNodeIndex ).xy;
		bool isLeaf = bool( boundsInfo.x & 0xffff0000u );

		if ( isLeaf ) {

			uint count = boundsInfo.x & 0x0000ffffu;
			uint offset = boundsInfo.y;

			found = intersectTriangles(
				bvh_position, bvh_index, offset, count,
				rayOrigin, rayDirection, triangleDistance,
				faceIndices, faceNormal, barycoord, side, dist
			) || found;

		} else {

			uint leftIndex = currNodeIndex + 1u;
			uint splitAxis = boundsInfo.x & 0x0000ffffu;
			uint rightIndex = currNodeIndex + boundsInfo.y;

			bool leftToRight = rayDirection[ splitAxis ] >= 0.0;
			uint c1 = leftToRight ? leftIndex : rightIndex;
			uint c2 = leftToRight ? rightIndex : leftIndex;

			// set c2 in the stack so we traverse it later. We need to keep track of a pointer in
			// the stack while we traverse. The second pointer added is the one that will be
			// traversed first
			ptr ++;
			stack[ ptr ] = c2;

			ptr ++;
			stack[ ptr ] = c1;

		}

	}

	return found;

}
`;

	// Note that a struct cannot be used for the hit record including faceIndices, faceNormal, barycoord,
	// side, and dist because on some mobile GPUS (such as Adreno) numbers are afforded less precision specifically
	// when in a struct leading to inaccurate hit results. See KhronosGroup/WebGL#3351 for more details.
	const bvh_struct_definitions = /* glsl */`
struct BVH {

	usampler2D index;
	sampler2D position;

	sampler2D bvhBounds;
	usampler2D bvhContents;

};
`;

	var BVHShaderGLSL = /*#__PURE__*/Object.freeze({
		__proto__: null,
		common_functions: common_functions,
		bvh_distance_functions: bvh_distance_functions,
		bvh_ray_functions: bvh_ray_functions,
		bvh_struct_definitions: bvh_struct_definitions
	});

	const shaderStructs = bvh_struct_definitions;
	const shaderDistanceFunction = bvh_distance_functions;
	const shaderIntersectFunction = `
	${ common_functions }
	${ bvh_ray_functions }
`;

	// target offset is the number of elements in the target buffer stride to skip before copying the
	// attributes contents in to.
	function copyAttributeContents( attr, target, targetOffset = 0 ) {

		if ( attr.isInterleavedBufferAttribute ) {

			const itemSize = attr.itemSize;
			for ( let i = 0, l = attr.count; i < l; i ++ ) {

				const io = i + targetOffset;
				target.setX( io, attr.getX( i ) );
				if ( itemSize >= 2 ) target.setY( io, attr.getY( i ) );
				if ( itemSize >= 3 ) target.setZ( io, attr.getZ( i ) );
				if ( itemSize >= 4 ) target.setW( io, attr.getW( i ) );

			}

		} else {

			const array = target.array;
			const cons = array.constructor;
			const byteOffset = array.BYTES_PER_ELEMENT * attr.itemSize * targetOffset;
			const temp = new cons( array.buffer, byteOffset, attr.array.length );
			temp.set( attr.array );

		}

	}

	// Clones the given attribute with a new compatible buffer attribute but no data
	function createAttributeClone( attr, countOverride = null ) {

		const cons = attr.array.constructor;
		const normalized = attr.normalized;
		const itemSize = attr.itemSize;
		const count = countOverride === null ? attr.count : countOverride;

		return new three.BufferAttribute( new cons( itemSize * count ), itemSize, normalized );

	}

	// Confirms that the two provided attributes are compatible. Returns false if they are not.
	function validateAttributes( attr1, attr2 ) {

		if ( ! attr1 && ! attr2 ) {

			return true;

		}

		if ( Boolean( attr1 ) !== Boolean( attr2 ) ) {

			return false;

		}

		const sameCount = attr1.count === attr2.count;
		const sameNormalized = attr1.normalized === attr2.normalized;
		const sameType = attr1.array.constructor === attr2.array.constructor;
		const sameItemSize = attr1.itemSize === attr2.itemSize;

		if ( ! sameCount || ! sameNormalized || ! sameType || ! sameItemSize ) {

			return false;

		}

		return true;

	}

	function validateMergeability( geometries ) {

		const isIndexed = geometries[ 0 ].index !== null;
		const attributesUsed = new Set( Object.keys( geometries[ 0 ].attributes ) );
		if ( ! geometries[ 0 ].getAttribute( 'position' ) ) {

			throw new Error( 'StaticGeometryGenerator: position attribute is required.' );

		}

		for ( let i = 0; i < geometries.length; ++ i ) {

			const geometry = geometries[ i ];
			let attributesCount = 0;

			// ensure that all geometries are indexed, or none
			if ( isIndexed !== ( geometry.index !== null ) ) {

				throw new Error( 'StaticGeometryGenerator: All geometries must have compatible attributes; make sure index attribute exists among all geometries, or in none of them.' );

			}

			// gather attributes, exit early if they're different
			for ( const name in geometry.attributes ) {

				if ( ! attributesUsed.has( name ) ) {

					throw new Error( 'StaticGeometryGenerator: All geometries must have compatible attributes; make sure "' + name + '" attribute exists among all geometries, or in none of them.' );

				}

				attributesCount ++;

			}

			// ensure geometries have the same number of attributes
			if ( attributesCount !== attributesUsed.size ) {

				throw new Error( 'StaticGeometryGenerator: All geometries must have the same number of attributes.' );

			}

		}

	}

	function getTotalIndexCount( geometries ) {

		let result = 0;
		for ( let i = 0, l = geometries.length; i < l; i ++ ) {

			result += geometries[ i ].getIndex().count;

		}

		return result;

	}

	function getTotalAttributeCount( geometries ) {

		let result = 0;
		for ( let i = 0, l = geometries.length; i < l; i ++ ) {

			result += geometries[ i ].getAttribute( 'position' ).count;

		}

		return result;

	}

	function trimMismatchedAttributes( target, indexCount, attrCount ) {

		if ( target.index && target.index.count !== indexCount ) {

			target.setIndex( null );

		}

		const attributes = target.attributes;
		for ( const key in attributes ) {

			const attr = attributes[ key ];
			if ( attr.count !== attrCount ) {

				target.deleteAttribute( key );

			}

		}

	}

	// Modified version of BufferGeometryUtils.mergeBufferGeometries that ignores morph targets and updates a attributes in place
	function mergeGeometries( geometries, options = {}, targetGeometry = new three.BufferGeometry() ) {

		const {
			useGroups = false,
			forceUpdate = false,
			skipAssigningAttributes = [],
			overwriteIndex = true,
		} = options;

		// check if we can merge these geometries
		validateMergeability( geometries );

		const isIndexed = geometries[ 0 ].index !== null;
		const totalIndexCount = isIndexed ? getTotalIndexCount( geometries ) : - 1;
		const totalAttributeCount = getTotalAttributeCount( geometries );
		trimMismatchedAttributes( targetGeometry, totalIndexCount, totalAttributeCount );

		// set up groups
		if ( useGroups ) {

			let offset = 0;
			for ( let i = 0, l = geometries.length; i < l; i ++ ) {

				const geometry = geometries[ i ];

				let primitiveCount;
				if ( isIndexed ) {

					primitiveCount = geometry.getIndex().count;

				} else {

					primitiveCount = geometry.getAttribute( 'position' ).count;

				}

				targetGeometry.addGroup( offset, primitiveCount, i );
				offset += primitiveCount;

			}

		}

		// generate the final geometry
		// skip the assigning any attributes for items in the above array
		if ( isIndexed ) {

			// set up the index if it doesn't exist
			let forceUpdateIndex = false;
			if ( ! targetGeometry.index ) {

				targetGeometry.setIndex( new three.BufferAttribute( new Uint32Array( totalIndexCount ), 1, false ) );
				forceUpdateIndex = true;

			}

			if ( forceUpdateIndex || overwriteIndex ) {

				// copy the index data to the target geometry
				let targetOffset = 0;
				let indexOffset = 0;
				const targetIndex = targetGeometry.getIndex();
				for ( let i = 0, l = geometries.length; i < l; i ++ ) {

					const geometry = geometries[ i ];
					const index = geometry.getIndex();
					const skip = ! forceUpdate && ! forceUpdateIndex && skipAssigningAttributes[ i ];
					if ( ! skip ) {

						for ( let j = 0; j < index.count; ++ j ) {

							targetIndex.setX( targetOffset + j, index.getX( j ) + indexOffset );

						}

					}

					targetOffset += index.count;
					indexOffset += geometry.getAttribute( 'position' ).count;

				}

			}

		}

		// copy all the attribute data over
		const attributes = Object.keys( geometries[ 0 ].attributes );
		for ( let i = 0, l = attributes.length; i < l; i ++ ) {

			let forceUpdateAttr = false;
			const key = attributes[ i ];
			if ( ! targetGeometry.getAttribute( key ) ) {

				const firstAttr = geometries[ 0 ].getAttribute( key );
				targetGeometry.setAttribute( key, createAttributeClone( firstAttr, totalAttributeCount ) );
				forceUpdateAttr = true;

			}

			let offset = 0;
			const targetAttribute = targetGeometry.getAttribute( key );
			for ( let g = 0, l = geometries.length; g < l; g ++ ) {

				const geometry = geometries[ g ];
				const skip = ! forceUpdate && ! forceUpdateAttr && skipAssigningAttributes[ g ];
				const attr = geometry.getAttribute( key );
	 			if ( ! skip ) {

					if ( key === 'color' && targetAttribute.itemSize !== attr.itemSize ) {

						// make sure the color attribute is aligned with itemSize 3 to 4
						for ( let index = offset, l = attr.count; index < l; index ++ ) {

							attr.setXYZW( index, targetAttribute.getX( index ), targetAttribute.getY( index ), targetAttribute.getZ( index ), 1.0 );

						}

					} else {

						copyAttributeContents( attr, targetAttribute, offset );

					}

				}

				offset += attr.count;

			}

		}

	}

	function updateMaterialIndexAttribute( geometry, materials, allMaterials ) {

		const indexAttr = geometry.index;
		const posAttr = geometry.attributes.position;
		const vertCount = posAttr.count;
		const totalCount = indexAttr ? indexAttr.count : vertCount;
		let groups = geometry.groups;
		if ( groups.length === 0 ) {

			groups = [ { count: totalCount, start: 0, materialIndex: 0 } ];

		}

		let materialIndexAttribute = geometry.getAttribute( 'materialIndex' );
		if ( ! materialIndexAttribute || materialIndexAttribute.count !== vertCount ) {

			// use an array with the minimum precision required to store all material id references.
			let array;
			if ( allMaterials.length <= 255 ) {

				array = new Uint8Array( vertCount );

			} else {

				array = new Uint16Array( vertCount );

			}

			materialIndexAttribute = new three.BufferAttribute( array, 1, false );
			geometry.deleteAttribute( 'materialIndex' );
			geometry.setAttribute( 'materialIndex', materialIndexAttribute );

		}

		const materialArray = materialIndexAttribute.array;
		for ( let i = 0; i < groups.length; i ++ ) {

			const group = groups[ i ];
			const start = group.start;
			const count = group.count;
			const endCount = Math.min( count, totalCount - start );

			const mat = Array.isArray( materials ) ? materials[ group.materialIndex ] : materials;
			const materialIndex = allMaterials.indexOf( mat );

			for ( let j = 0; j < endCount; j ++ ) {

				let index = start + j;
				if ( indexAttr ) {

					index = indexAttr.getX( index );

				}

				materialArray[ index ] = materialIndex;

			}

		}

	}

	function setCommonAttributes( geometry, attributes ) {

		if ( ! geometry.index ) {

			// TODO: compute a typed array
			const indexCount = geometry.attributes.position.count;
			const array = new Array( indexCount );
			for ( let i = 0; i < indexCount; i ++ ) {

				array[ i ] = i;

			}

			geometry.setIndex( array );

		}

		if ( ! geometry.attributes.normal && ( attributes && attributes.includes( 'normal' ) ) ) {

			geometry.computeVertexNormals();

		}

		if ( ! geometry.attributes.uv && ( attributes && attributes.includes( 'uv' ) ) ) {

			const vertCount = geometry.attributes.position.count;
			geometry.setAttribute( 'uv', new three.BufferAttribute( new Float32Array( vertCount * 2 ), 2, false ) );

		}

		if ( ! geometry.attributes.uv2 && ( attributes && attributes.includes( 'uv2' ) ) ) {

			const vertCount = geometry.attributes.position.count;
			geometry.setAttribute( 'uv2', new three.BufferAttribute( new Float32Array( vertCount * 2 ), 2, false ) );

		}

		if ( ! geometry.attributes.tangent && ( attributes && attributes.includes( 'tangent' ) ) ) {

			// compute tangents requires a uv and normal buffer
			if ( geometry.attributes.uv && geometry.attributes.normal ) {

				geometry.computeTangents();

			} else {

				const vertCount = geometry.attributes.position.count;
				geometry.setAttribute( 'tangent', new three.BufferAttribute( new Float32Array( vertCount * 4 ), 4, false ) );

			}

		}

		if ( ! geometry.attributes.color && ( attributes && attributes.includes( 'color' ) ) ) {

			const vertCount = geometry.attributes.position.count;
			const array = new Float32Array( vertCount * 4 );
			array.fill( 1.0 );
			geometry.setAttribute( 'color', new three.BufferAttribute( array, 4 ) );

		}

	}

	// https://www.geeksforgeeks.org/how-to-create-hash-from-string-in-javascript/
	// https://stackoverflow.com/questions/7616461/generate-a-hash-from-string-in-javascript
	function bufferToHash( buffer ) {

		let hash = 0;

		if ( buffer.byteLength !== 0 ) {

			const uintArray = new Uint8Array( buffer );
			for ( let i = 0; i < buffer.byteLength; i ++ ) {

				const byte = uintArray[ i ];
				hash = ( ( hash << 5 ) - hash ) + byte;
				hash |= 0;

			}

		}

		return hash;

	}

	function getGeometryHash( geometry ) {

		let hash = geometry.uuid;
		const attributes = Object.values( geometry.attributes );
		if ( geometry.index ) {

			attributes.push( geometry.index );
			hash += `index|${ geometry.index.version }`;

		}

		const keys = Object.keys( attributes ).sort();
		for ( const key of keys ) {

			const attr = attributes[ key ];
			hash += `${ key }_${ attr.version }|`;

		}

		return hash;

	}

	function getSkeletonHash( mesh ) {

		const skeleton = mesh.skeleton;
		if ( skeleton ) {

			if ( ! skeleton.boneTexture ) {

				skeleton.computeBoneTexture();

			}

			// we can't use the texture version here because it will change even
			// when the bones haven't
			const dataHash = bufferToHash( skeleton.boneTexture.image.data.buffer );
			return `${ dataHash }_${ skeleton.boneTexture.uuid }`;

		} else {

			return null;

		}

	}

	// Checks whether the geometry changed between this and last evaluation
	class MeshDiff {

		constructor( mesh = null ) {

			this.matrixWorld = new three.Matrix4();
			this.geometryHash = null;
			this.skeletonHash = null;
			this.primitiveCount = - 1;

			if ( mesh !== null ) {

				this.updateFrom( mesh );

			}

		}

		updateFrom( mesh ) {

			const geometry = mesh.geometry;
			const primitiveCount = ( geometry.index ? geometry.index.count : geometry.attributes.position.count ) / 3;
			this.matrixWorld.copy( mesh.matrixWorld );
			this.geometryHash = getGeometryHash( geometry );
			this.primitiveCount = primitiveCount;
			this.skeletonHash = getSkeletonHash( mesh );

		}

		didChange( mesh ) {

			const geometry = mesh.geometry;
			const primitiveCount = ( geometry.index ? geometry.index.count : geometry.attributes.position.count ) / 3;

			const identical =
				this.matrixWorld.equals( mesh.matrixWorld ) &&
				this.geometryHash === getGeometryHash( geometry ) &&
				this.skeletonHash === getSkeletonHash( mesh ) &&
				this.primitiveCount === primitiveCount;

			return ! identical;

		}

	}

	const _positionVector = /*@__PURE__*/ new three.Vector3();
	const _normalVector = /*@__PURE__*/ new three.Vector3();
	const _tangentVector = /*@__PURE__*/ new three.Vector3();
	const _tangentVector4 = /*@__PURE__*/ new three.Vector4();

	const _morphVector = /*@__PURE__*/ new three.Vector3();
	const _temp = /*@__PURE__*/ new three.Vector3();

	const _skinIndex = /*@__PURE__*/ new three.Vector4();
	const _skinWeight = /*@__PURE__*/ new three.Vector4();
	const _matrix = /*@__PURE__*/ new three.Matrix4();
	const _boneMatrix = /*@__PURE__*/ new three.Matrix4();

	// A version of "SkinnedMesh.boneTransform" for normals
	function boneNormalTransform( mesh, index, target ) {

		const skeleton = mesh.skeleton;
		const geometry = mesh.geometry;
		const bones = skeleton.bones;
		const boneInverses = skeleton.boneInverses;

		_skinIndex.fromBufferAttribute( geometry.attributes.skinIndex, index );
		_skinWeight.fromBufferAttribute( geometry.attributes.skinWeight, index );

		_matrix.elements.fill( 0 );

		for ( let i = 0; i < 4; i ++ ) {

			const weight = _skinWeight.getComponent( i );

			if ( weight !== 0 ) {

				const boneIndex = _skinIndex.getComponent( i );
				_boneMatrix.multiplyMatrices( bones[ boneIndex ].matrixWorld, boneInverses[ boneIndex ] );

				addScaledMatrix( _matrix, _boneMatrix, weight );

			}

		}

		_matrix.multiply( mesh.bindMatrix ).premultiply( mesh.bindMatrixInverse );
		target.transformDirection( _matrix );

		return target;

	}

	// Applies the morph target data to the target vector
	function applyMorphTarget( morphData, morphInfluences, morphTargetsRelative, i, target ) {

		_morphVector.set( 0, 0, 0 );
		for ( let j = 0, jl = morphData.length; j < jl; j ++ ) {

			const influence = morphInfluences[ j ];
			const morphAttribute = morphData[ j ];

			if ( influence === 0 ) continue;

			_temp.fromBufferAttribute( morphAttribute, i );

			if ( morphTargetsRelative ) {

				_morphVector.addScaledVector( _temp, influence );

			} else {

				_morphVector.addScaledVector( _temp.sub( target ), influence );

			}

		}

		target.add( _morphVector );

	}

	// Adds the "matrix" multiplied by "scale" to "target"
	function addScaledMatrix( target, matrix, scale ) {

		const targetArray = target.elements;
		const matrixArray = matrix.elements;
		for ( let i = 0, l = matrixArray.length; i < l; i ++ ) {

			targetArray[ i ] += matrixArray[ i ] * scale;

		}

	}

	// inverts the geometry in place
	function invertGeometry( geometry ) {

		const { index, attributes } = geometry;
		if ( index ) {

			for ( let i = 0, l = index.count; i < l; i += 3 ) {

				const v0 = index.getX( i );
				const v2 = index.getX( i + 2 );
				index.setX( i, v2 );
				index.setX( i + 2, v0 );

			}

		} else {

			for ( const key in attributes ) {

				const attr = attributes[ key ];
				const itemSize = attr.itemSize;
				for ( let i = 0, l = attr.count; i < l; i += 3 ) {

					for ( let j = 0; j < itemSize; j ++ ) {

						const v0 = attr.getComponent( i, j );
						const v2 = attr.getComponent( i + 2, j );
						attr.setComponent( i, j, v2 );
						attr.setComponent( i + 2, j, v0 );

					}

				}

			}

		}

		return geometry;

	}

	function convertToStaticGeometry( mesh, options = {}, targetGeometry = new three.BufferGeometry() ) {

		options = {
			applyWorldTransforms: true,
			attributes: [],
			...options
		};

		const geometry = mesh.geometry;
		const applyWorldTransforms = options.applyWorldTransforms;
		const includeNormal = options.attributes.includes( 'normal' );
		const includeTangent = options.attributes.includes( 'tangent' );
		const attributes = geometry.attributes;
		const targetAttributes = targetGeometry.attributes;

		// strip any unused and unneeded attributes
		for ( const key in targetGeometry.attributes ) {

			if ( ! options.attributes.includes( key ) || ! ( key in geometry.attributes ) ) {

				targetGeometry.deleteAttribute( key );

			}

		}

		// initialize the attributes if they don't exist
		if ( ! targetGeometry.index && geometry.index ) {

			targetGeometry.index = geometry.index.clone();

		}

		if ( ! targetAttributes.position ) {

			targetGeometry.setAttribute( 'position', createAttributeClone( attributes.position ) );

		}

		if ( includeNormal && ! targetAttributes.normal && attributes.normal ) {

			targetGeometry.setAttribute( 'normal', createAttributeClone( attributes.normal ) );

		}

		if ( includeTangent && ! targetAttributes.tangent && attributes.tangent ) {

			targetGeometry.setAttribute( 'tangent', createAttributeClone( attributes.tangent ) );

		}

		// ensure the attributes are consistent
		validateAttributes( geometry.index, targetGeometry.index );
		validateAttributes( attributes.position, targetAttributes.position );

		if ( includeNormal ) {

			validateAttributes( attributes.normal, targetAttributes.normal );

		}

		if ( includeTangent ) {

			validateAttributes( attributes.tangent, targetAttributes.tangent );

		}

		// generate transformed vertex attribute data
		const position = attributes.position;
		const normal = includeNormal ? attributes.normal : null;
		const tangent = includeTangent ? attributes.tangent : null;
		const morphPosition = geometry.morphAttributes.position;
		const morphNormal = geometry.morphAttributes.normal;
		const morphTangent = geometry.morphAttributes.tangent;
		const morphTargetsRelative = geometry.morphTargetsRelative;
		const morphInfluences = mesh.morphTargetInfluences;
		const normalMatrix = new three.Matrix3();
		normalMatrix.getNormalMatrix( mesh.matrixWorld );

		// copy the index
		if ( geometry.index ) {

			targetGeometry.index.array.set( geometry.index.array );

		}

		// copy and apply other attributes
		for ( let i = 0, l = attributes.position.count; i < l; i ++ ) {

			_positionVector.fromBufferAttribute( position, i );
			if ( normal ) {

				_normalVector.fromBufferAttribute( normal, i );

			}

			if ( tangent ) {

				_tangentVector4.fromBufferAttribute( tangent, i );
				_tangentVector.fromBufferAttribute( tangent, i );

			}

			// apply morph target transform
			if ( morphInfluences ) {

				if ( morphPosition ) {

					applyMorphTarget( morphPosition, morphInfluences, morphTargetsRelative, i, _positionVector );

				}

				if ( morphNormal ) {

					applyMorphTarget( morphNormal, morphInfluences, morphTargetsRelative, i, _normalVector );

				}

				if ( morphTangent ) {

					applyMorphTarget( morphTangent, morphInfluences, morphTargetsRelative, i, _tangentVector );

				}

			}

			// apply bone transform
			if ( mesh.isSkinnedMesh ) {

				mesh.applyBoneTransform( i, _positionVector );
				if ( normal ) {

					boneNormalTransform( mesh, i, _normalVector );

				}

				if ( tangent ) {

					boneNormalTransform( mesh, i, _tangentVector );

				}

			}

			// update the vectors of the attributes
			if ( applyWorldTransforms ) {

				_positionVector.applyMatrix4( mesh.matrixWorld );

			}

			targetAttributes.position.setXYZ( i, _positionVector.x, _positionVector.y, _positionVector.z );

			if ( normal ) {

				if ( applyWorldTransforms ) {

					_normalVector.applyNormalMatrix( normalMatrix );

				}

				targetAttributes.normal.setXYZ( i, _normalVector.x, _normalVector.y, _normalVector.z );

			}

			if ( tangent ) {

				if ( applyWorldTransforms ) {

					_tangentVector.transformDirection( mesh.matrixWorld );

				}

				targetAttributes.tangent.setXYZW( i, _tangentVector.x, _tangentVector.y, _tangentVector.z, _tangentVector4.w );

			}

		}

		// copy other attributes over
		for ( const i in options.attributes ) {

			const key = options.attributes[ i ];
			if ( key === 'position' || key === 'tangent' || key === 'normal' || ! ( key in attributes ) ) {

				continue;

			}

			if ( ! targetAttributes[ key ] ) {

				targetGeometry.setAttribute( key, createAttributeClone( attributes[ key ] ) );

			}

			validateAttributes( attributes[ key ], targetAttributes[ key ] );
			copyAttributeContents( attributes[ key ], targetAttributes[ key ] );

		}

		if ( mesh.matrixWorld.determinant() < 0 ) {

			invertGeometry( targetGeometry );

		}

		return targetGeometry;

	}

	class BakedGeometry extends three.BufferGeometry {

		constructor() {

			super();
			this.version = 0;
			this.hash = null;
			this._diff = new MeshDiff();

		}

		// returns whether the passed mesh is compatible with this baked geometry
		// such that it can be updated without resizing attributes
		isCompatible( mesh, attributes ) {

			const geometry = mesh.geometry;
			for ( let i = 0; i < attributes.length; i ++ ) {

				const key = attributes[ i ];
				const attr1 = geometry.attributes[ key ];
				const attr2 = this.attributes[ key ];
				if ( attr1 && ! validateAttributes( attr1, attr2 ) ) {

					return false;

				}

			}

			return true;

		}

		updateFrom( mesh, options ) {

			const diff = this._diff;
			if ( diff.didChange( mesh ) ) {

				convertToStaticGeometry( mesh, options, this );
				diff.updateFrom( mesh );
				this.version ++;
				this.hash = `${ this.uuid }_${ this.version }`;
				return true;

			} else {

				return false;

			}

		}

	}

	const NO_CHANGE = 0;
	const GEOMETRY_ADJUSTED = 1;
	const GEOMETRY_REBUILT = 2;

	// iterate over only the meshes in the provided objects
	function flatTraverseMeshes( objects, cb ) {

		for ( let i = 0, l = objects.length; i < l; i ++ ) {

			const object = objects[ i ];
			object.traverseVisible( o => {

				if ( o.isMesh ) {

					cb( o );

				}

			} );

		}

	}

	// return the set of materials used by the provided meshes
	function getMaterials( meshes ) {

		const materials = [];
		for ( let i = 0, l = meshes.length; i < l; i ++ ) {

			const mesh = meshes[ i ];
			if ( Array.isArray( mesh.material ) ) {

				materials.push( ...mesh.material );

			} else {

				materials.push( mesh.material );

			}

		}

		return materials;

	}

	function mergeGeometryList( geometries, target, options ) {

		// If we have no geometry to merge then provide an empty geometry.
		if ( geometries.length === 0 ) {

			// if there are no geometries then just create a fake empty geometry to provide
			target.setIndex( null );

			// remove all geometry
			const attrs = target.attributes;
			for ( const key in attrs ) {

				target.deleteAttribute( key );

			}

			// create dummy attributes
			for ( const key in options.attributes ) {

				target.setAttribute( options.attributes[ key ], new three.BufferAttribute( new Float32Array( 0 ), 4, false ) );

			}

		} else {

			mergeGeometries( geometries, options, target );

		}

		// Mark all attributes as needing an update
		for ( const key in target.attributes ) {

			target.attributes[ key ].needsUpdate = true;

		}

	}


	class StaticGeometryGenerator {

		constructor( objects ) {

			this.objects = null;
			this.useGroups = true;
			this.applyWorldTransforms = true;
			this.generateMissingAttributes = true;
			this.overwriteIndex = true;
			this.attributes = [ 'position', 'normal', 'color', 'tangent', 'uv', 'uv2' ];
			this._intermediateGeometry = new Map();
			this._geometryMergeSets = new WeakMap();
			this._mergeOrder = [];
			this._dummyMesh = null;

			this.setObjects( objects || [] );

		}

		_getDummyMesh() {

			// return a consistent dummy mesh
			if ( ! this._dummyMesh ) {

				const dummyMaterial = new three.MeshBasicMaterial();
				const emptyGeometry = new three.BufferGeometry();
				emptyGeometry.setAttribute( 'position', new three.BufferAttribute( new Float32Array( 9 ), 3 ) );
				this._dummyMesh = new three.Mesh( emptyGeometry, dummyMaterial );

			}

			return this._dummyMesh;

		}

		_getMeshes() {

			// iterate over only the meshes in the provided objects
			const meshes = [];
			flatTraverseMeshes( this.objects, mesh => {

				meshes.push( mesh );

			} );

			// Sort the geometry so it's in a reliable order
			meshes.sort( ( a, b ) => {

				if ( a.uuid > b.uuid ) return 1;
				if ( a.uuid < b.uuid ) return - 1;
				return 0;

			} );

			if ( meshes.length === 0 ) {

				meshes.push( this._getDummyMesh() );

			}

			return meshes;

		}

		_updateIntermediateGeometries() {

			const { _intermediateGeometry } = this;

			const meshes = this._getMeshes();
			const unusedMeshKeys = new Set( _intermediateGeometry.keys() );
			const convertOptions = {
				attributes: this.attributes,
				applyWorldTransforms: this.applyWorldTransforms,
			};

			for ( let i = 0, l = meshes.length; i < l; i ++ ) {

				const mesh = meshes[ i ];
				const meshKey = mesh.uuid;
				unusedMeshKeys.delete( meshKey );

				// initialize the intermediate geometry
				// if the mesh and source geometry have changed in such a way that they are no longer
				// compatible then regenerate the baked geometry from scratch
				let geom = _intermediateGeometry.get( meshKey );
				if ( ! geom || ! geom.isCompatible( mesh, this.attributes ) ) {

					if ( geom ) {

						geom.dispose();

					}

					geom = new BakedGeometry();
					_intermediateGeometry.set( meshKey, geom );

				}

				// transform the geometry into the intermediate buffer geometry, saving whether
				// or not it changed.
				if ( geom.updateFrom( mesh, convertOptions ) ) {

					// TODO: provide option for only generating the set of attributes that are present
					// and are in the attributes array
					if ( this.generateMissingAttributes ) {

						setCommonAttributes( geom, this.attributes );

					}

				}

			}

			unusedMeshKeys.forEach( key => {

				_intermediateGeometry.delete( key );

			} );

		}

		setObjects( objects ) {

			if ( Array.isArray( objects ) ) {

				this.objects = [ ...objects ];

			} else {

				this.objects = [ objects ];

			}

		}

		generate( targetGeometry = new three.BufferGeometry() ) {

			// track which attributes have been updated and which to skip to avoid unnecessary attribute copies
			const { useGroups, overwriteIndex, _intermediateGeometry, _geometryMergeSets } = this;

			const meshes = this._getMeshes();
			const skipAssigningAttributes = [];
			const mergeGeometry = [];
			const previousMergeInfo = _geometryMergeSets.get( targetGeometry ) || [];

			// update all the intermediate static geometry representations
			this._updateIntermediateGeometries();

			// get the list of geometries to merge
			let forceUpdate = false;
			if ( meshes.length !== previousMergeInfo.length ) {

				forceUpdate = true;

			}

			for ( let i = 0, l = meshes.length; i < l; i ++ ) {

				const mesh = meshes[ i ];
				const geom = _intermediateGeometry.get( mesh.uuid );
				mergeGeometry.push( geom );

				const info = previousMergeInfo[ i ];
				if ( ! info || info.uuid !== geom.uuid ) {

					skipAssigningAttributes.push( false );
					forceUpdate = true;

				} else if ( info.version !== geom.version ) {

					skipAssigningAttributes.push( false );

				} else {

					skipAssigningAttributes.push( true );

				}

			}

			// If we have no geometry to merge then provide an empty geometry.
			mergeGeometryList( mergeGeometry, targetGeometry, { useGroups, forceUpdate, skipAssigningAttributes, overwriteIndex } );

			// force update means the attribute buffer lengths have changed
			if ( forceUpdate ) {

				targetGeometry.dispose();

			}

			_geometryMergeSets.set( targetGeometry, mergeGeometry.map( g => ( {
				version: g.version,
				uuid: g.uuid,
			} ) ) );

			let changeType = NO_CHANGE;
			if ( forceUpdate ) changeType = GEOMETRY_REBUILT;
			else if ( skipAssigningAttributes.includes( false ) ) changeType = GEOMETRY_ADJUSTED;

			return {
				changeType,
				materials: getMaterials( meshes ),
				geometry: targetGeometry,
			};

		}

	}

	// collect the textures from the materials
	function getTextures$1( materials ) {

		const textureSet = new Set();
		for ( let i = 0, l = materials.length; i < l; i ++ ) {

			const material = materials[ i ];
			for ( const key in material ) {

				const value = material[ key ];
				if ( value && value.isTexture ) {

					textureSet.add( value );

				}

			}

		}

		return Array.from( textureSet );

	}

	// collect the lights in the scene
	function getLights$1( objects ) {

		const lights = [];
		const iesSet = new Set();
		for ( let i = 0, l = objects.length; i < l; i ++ ) {

			objects[ i ].traverse( c => {

				if ( c.visible ) {

					if (
						c.isRectAreaLight ||
						c.isSpotLight ||
						c.isPointLight ||
						c.isDirectionalLight
					) {

						lights.push( c );

						if ( c.iesMap ) {

							iesSet.add( c.iesMap );

						}

					}

				}

			} );

		}

		const iesTextures = Array.from( iesSet ).sort( ( a, b ) => {

			if ( a.uuid < b.uuid ) return 1;
			if ( a.uuid > b.uuid ) return - 1;
			return 0;

		} );

		return { lights, iesTextures };

	}

	class PathTracingSceneGenerator {

		get initialized() {

			return Boolean( this.bvh );

		}

		constructor( objects ) {

			// options
			this.bvhOptions = {};
			this.attributes = [ 'position', 'normal', 'tangent', 'color', 'uv', 'uv2' ];
			this.generateBVH = true;

			// state
			this.bvh = null;
			this.geometry = new three.BufferGeometry();
			this.staticGeometryGenerator = new StaticGeometryGenerator( objects );
			this._bvhWorker = null;
			this._pendingGenerate = null;
			this._buildAsync = false;
			this._materialUuids = null;

		}

		setObjects( objects ) {

			this.staticGeometryGenerator.setObjects( objects );

		}

		setBVHWorker( bvhWorker ) {

			this._bvhWorker = bvhWorker;

		}

		async generateAsync( onProgress = null ) {

			if ( ! this._bvhWorker ) {

				throw new Error( 'PathTracingSceneGenerator: "setBVHWorker" must be called before "generateAsync" can be called.' );

			}

			if ( this.bvh instanceof Promise ) {

				// if a bvh is already being generated we can wait for that to finish
				// and build another with the latest data while sharing the results.
				if ( ! this._pendingGenerate ) {

					this._pendingGenerate = new Promise( async () => {

						await this.bvh;
						this._pendingGenerate = null;

						// TODO: support multiple callbacks queued?
						return this.generateAsync( onProgress );

					} );

				}

				return this._pendingGenerate;

			} else {

				this._buildAsync = true;
				const result = this.generate( onProgress );
				this._buildAsync = false;

				result.bvh = this.bvh = await result.bvh;
				return result;

			}

		}

		generate( onProgress = null ) {

			const { staticGeometryGenerator, geometry, attributes } = this;
			const objects = staticGeometryGenerator.objects;
			staticGeometryGenerator.attributes = attributes;

			// update the skeleton animations in case WebGLRenderer is not running
			// to update it.
			objects.forEach( o => {

				o.traverse( c => {

					if ( c.isSkinnedMesh && c.skeleton ) {

						c.skeleton.update();

					}

				} );

			} );

			// generate the geometry
			const result = staticGeometryGenerator.generate( geometry );
			const materials = result.materials;
			let needsMaterialIndexUpdate = result.changeType !== NO_CHANGE || this._materialUuids === null || this._materialUuids.length !== length;
			if ( ! needsMaterialIndexUpdate ) {

				for ( let i = 0, length = materials.length; i < length; i ++ ) {

					const material = materials[ i ];
					if ( material.uuid !== this._materialUuids[ i ] ) {

						needsMaterialIndexUpdate = true;
						break;

					}

				}

			}

			const textures = getTextures$1( materials );
			const { lights, iesTextures } = getLights$1( objects );
			if ( needsMaterialIndexUpdate ) {

				updateMaterialIndexAttribute( geometry, materials, materials );
				this._materialUuids = materials.map( material => material.uuid );

			}

			// only generate a new bvh if the objects used have changed
			if ( this.generateBVH ) {

				if ( this.bvh instanceof Promise ) {

					throw new Error( 'PathTracingSceneGenerator: BVH is already building asynchronously.' );

				}

				if ( result.changeType === GEOMETRY_REBUILT ) {

					const bvhOptions = {
						strategy: SAH,
						maxLeafTris: 1,
						indirect: true,
						onProgress,
						...this.bvhOptions,
					};

					if ( this._buildAsync ) {

						this.bvh = this._bvhWorker.generate( geometry, bvhOptions );

					} else {

						this.bvh = new MeshBVH( geometry, bvhOptions );

					}

				} else if ( result.changeType === GEOMETRY_ADJUSTED ) {

					this.bvh.refit();

				}

			}

			return {
				bvhChanged: result.changeType !== NO_CHANGE,
				bvh: this.bvh,
				needsMaterialIndexUpdate,
				lights,
				iesTextures,
				geometry,
				materials,
				textures,
				objects,
			};

		}

	}

	class DynamicPathTracingSceneGenerator extends PathTracingSceneGenerator {

		constructor( ...args ) {

			super( ...args );
			console.warn( 'DynamicPathTracingSceneGenerator has been deprecated and renamed to "PathTracingSceneGenerator".' );

		}

	}

	class PathTracingSceneWorker extends PathTracingSceneGenerator {

		constructor( ...args ) {

			super( ...args );
			console.warn( 'PathTracingSceneWorker has been deprecated and renamed to "PathTracingSceneGenerator".' );

		}

	}

	class MaterialBase extends three.ShaderMaterial {

		set needsUpdate( v ) {

			super.needsUpdate = true;
			this.dispatchEvent( {

				type: 'recompilation',

			} );

		}

		constructor( shader ) {

			super( shader );

			for ( const key in this.uniforms ) {

				Object.defineProperty( this, key, {

					get() {

						return this.uniforms[ key ].value;

					},

					set( v ) {

						this.uniforms[ key ].value = v;

					}

				} );

			}

		}

		// sets the given named define value and sets "needsUpdate" to true if it's different
		setDefine( name, value = undefined ) {

			if ( value === undefined || value === null ) {

				if ( name in this.defines ) {

					delete this.defines[ name ];
					this.needsUpdate = true;
					return true;

				}

			} else {

				if ( this.defines[ name ] !== value ) {

					this.defines[ name ] = value;
					this.needsUpdate = true;
					return true;

				}

			}

			return false;

		}

	}

	class BlendMaterial extends MaterialBase {

		constructor( parameters ) {

			super( {

				blending: three.NoBlending,

				uniforms: {

					target1: { value: null },
					target2: { value: null },
					opacity: { value: 1.0 },

				},

				vertexShader: /* glsl */`

				varying vec2 vUv;

				void main() {

					vUv = uv;
					gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );

				}`,

				fragmentShader: /* glsl */`

				uniform float opacity;

				uniform sampler2D target1;
				uniform sampler2D target2;

				varying vec2 vUv;

				void main() {

					vec4 color1 = texture2D( target1, vUv );
					vec4 color2 = texture2D( target2, vUv );

					float invOpacity = 1.0 - opacity;
					float totalAlpha = color1.a * invOpacity + color2.a * opacity;

					if ( color1.a != 0.0 || color2.a != 0.0 ) {

						gl_FragColor.rgb = color1.rgb * ( invOpacity * color1.a / totalAlpha ) + color2.rgb * ( opacity * color2.a / totalAlpha );
						gl_FragColor.a = totalAlpha;

					} else {

						gl_FragColor = vec4( 0.0 );

					}

				}`

			} );

			this.setValues( parameters );

		}

	}

	// References
	// - https://jcgt.org/published/0009/04/01/
	// - Code from https://www.shadertoy.com/view/WtGyDm

	// functions to generate multi-dimensions variables of the same functions
	// to support 1, 2, 3, and 4 dimensional sobol sampling.
	function generateSobolFunctionVariants( dim = 1 ) {

		let type = 'uint';
		if ( dim > 1 ) {

			type = 'uvec' + dim;

		}

		return /* glsl */`
		${ type } sobolReverseBits( ${ type } x ) {

			x = ( ( ( x & 0xaaaaaaaau ) >> 1 ) | ( ( x & 0x55555555u ) << 1 ) );
			x = ( ( ( x & 0xccccccccu ) >> 2 ) | ( ( x & 0x33333333u ) << 2 ) );
			x = ( ( ( x & 0xf0f0f0f0u ) >> 4 ) | ( ( x & 0x0f0f0f0fu ) << 4 ) );
			x = ( ( ( x & 0xff00ff00u ) >> 8 ) | ( ( x & 0x00ff00ffu ) << 8 ) );
			return ( ( x >> 16 ) | ( x << 16 ) );

		}

		${ type } sobolHashCombine( uint seed, ${ type } v ) {

			return seed ^ ( v + ${ type }( ( seed << 6 ) + ( seed >> 2 ) ) );

		}

		${ type } sobolLaineKarrasPermutation( ${ type } x, ${ type } seed ) {

			x += seed;
			x ^= x * 0x6c50b47cu;
			x ^= x * 0xb82f1e52u;
			x ^= x * 0xc7afe638u;
			x ^= x * 0x8d22f6e6u;
			return x;

		}

		${ type } nestedUniformScrambleBase2( ${ type } x, ${ type } seed ) {

			x = sobolLaineKarrasPermutation( x, seed );
			x = sobolReverseBits( x );
			return x;

		}
	`;

	}

	function generateSobolSampleFunctions( dim = 1 ) {

		let utype = 'uint';
		let vtype = 'float';
		let num = '';
		let components = '.r';
		let combineValues = '1u';
		if ( dim > 1 ) {

			utype = 'uvec' + dim;
			vtype = 'vec' + dim;
			num = dim + '';
			if ( dim === 2 ) {

				components = '.rg';
				combineValues = 'uvec2( 1u, 2u )';

			} else if ( dim === 3 ) {

				components = '.rgb';
				combineValues = 'uvec3( 1u, 2u, 3u )';

			} else {

				components = '';
				combineValues = 'uvec4( 1u, 2u, 3u, 4u )';

			}

		}

		return /* glsl */`

		${ vtype } sobol${ num }( int effect ) {

			uint seed = sobolGetSeed( sobolBounceIndex, uint( effect ) );
			uint index = sobolPathIndex;

			uint shuffle_seed = sobolHashCombine( seed, 0u );
			uint shuffled_index = nestedUniformScrambleBase2( sobolReverseBits( index ), shuffle_seed );
			${ vtype } sobol_pt = sobolGetTexturePoint( shuffled_index )${ components };
			${ utype } result = ${ utype }( sobol_pt * 16777216.0 );

			${ utype } seed2 = sobolHashCombine( seed, ${ combineValues } );
			result = nestedUniformScrambleBase2( result, seed2 );

			return SOBOL_FACTOR * ${ vtype }( result >> 8 );

		}
	`;

	}

	const sobol_common = /* glsl */`

	// Utils
	const float SOBOL_FACTOR = 1.0 / 16777216.0;
	const uint SOBOL_MAX_POINTS = 256u * 256u;

	${ generateSobolFunctionVariants( 1 ) }
	${ generateSobolFunctionVariants( 2 ) }
	${ generateSobolFunctionVariants( 3 ) }
	${ generateSobolFunctionVariants( 4 ) }

	uint sobolHash( uint x ) {

		// finalizer from murmurhash3
		x ^= x >> 16;
		x *= 0x85ebca6bu;
		x ^= x >> 13;
		x *= 0xc2b2ae35u;
		x ^= x >> 16;
		return x;

	}

`;

	const sobol_point_generation = /* glsl */`

	const uint SOBOL_DIRECTIONS_1[ 32 ] = uint[ 32 ](
		0x80000000u, 0xc0000000u, 0xa0000000u, 0xf0000000u,
		0x88000000u, 0xcc000000u, 0xaa000000u, 0xff000000u,
		0x80800000u, 0xc0c00000u, 0xa0a00000u, 0xf0f00000u,
		0x88880000u, 0xcccc0000u, 0xaaaa0000u, 0xffff0000u,
		0x80008000u, 0xc000c000u, 0xa000a000u, 0xf000f000u,
		0x88008800u, 0xcc00cc00u, 0xaa00aa00u, 0xff00ff00u,
		0x80808080u, 0xc0c0c0c0u, 0xa0a0a0a0u, 0xf0f0f0f0u,
		0x88888888u, 0xccccccccu, 0xaaaaaaaau, 0xffffffffu
	);

	const uint SOBOL_DIRECTIONS_2[ 32 ] = uint[ 32 ](
		0x80000000u, 0xc0000000u, 0x60000000u, 0x90000000u,
		0xe8000000u, 0x5c000000u, 0x8e000000u, 0xc5000000u,
		0x68800000u, 0x9cc00000u, 0xee600000u, 0x55900000u,
		0x80680000u, 0xc09c0000u, 0x60ee0000u, 0x90550000u,
		0xe8808000u, 0x5cc0c000u, 0x8e606000u, 0xc5909000u,
		0x6868e800u, 0x9c9c5c00u, 0xeeee8e00u, 0x5555c500u,
		0x8000e880u, 0xc0005cc0u, 0x60008e60u, 0x9000c590u,
		0xe8006868u, 0x5c009c9cu, 0x8e00eeeeu, 0xc5005555u
	);

	const uint SOBOL_DIRECTIONS_3[ 32 ] = uint[ 32 ](
		0x80000000u, 0xc0000000u, 0x20000000u, 0x50000000u,
		0xf8000000u, 0x74000000u, 0xa2000000u, 0x93000000u,
		0xd8800000u, 0x25400000u, 0x59e00000u, 0xe6d00000u,
		0x78080000u, 0xb40c0000u, 0x82020000u, 0xc3050000u,
		0x208f8000u, 0x51474000u, 0xfbea2000u, 0x75d93000u,
		0xa0858800u, 0x914e5400u, 0xdbe79e00u, 0x25db6d00u,
		0x58800080u, 0xe54000c0u, 0x79e00020u, 0xb6d00050u,
		0x800800f8u, 0xc00c0074u, 0x200200a2u, 0x50050093u
	);

	const uint SOBOL_DIRECTIONS_4[ 32 ] = uint[ 32 ](
		0x80000000u, 0x40000000u, 0x20000000u, 0xb0000000u,
		0xf8000000u, 0xdc000000u, 0x7a000000u, 0x9d000000u,
		0x5a800000u, 0x2fc00000u, 0xa1600000u, 0xf0b00000u,
		0xda880000u, 0x6fc40000u, 0x81620000u, 0x40bb0000u,
		0x22878000u, 0xb3c9c000u, 0xfb65a000u, 0xddb2d000u,
		0x78022800u, 0x9c0b3c00u, 0x5a0fb600u, 0x2d0ddb00u,
		0xa2878080u, 0xf3c9c040u, 0xdb65a020u, 0x6db2d0b0u,
		0x800228f8u, 0x400b3cdcu, 0x200fb67au, 0xb00ddb9du
	);

	uint getMaskedSobol( uint index, uint directions[ 32 ] ) {

		uint X = 0u;
		for ( int bit = 0; bit < 32; bit ++ ) {

			uint mask = ( index >> bit ) & 1u;
			X ^= mask * directions[ bit ];

		}
		return X;

	}

	vec4 generateSobolPoint( uint index ) {

		if ( index >= SOBOL_MAX_POINTS ) {

			return vec4( 0.0 );

		}

		// NOTE: this sobol "direction" is also available but we can't write out 5 components
		// uint x = index & 0x00ffffffu;
		uint x = sobolReverseBits( getMaskedSobol( index, SOBOL_DIRECTIONS_1 ) ) & 0x00ffffffu;
		uint y = sobolReverseBits( getMaskedSobol( index, SOBOL_DIRECTIONS_2 ) ) & 0x00ffffffu;
		uint z = sobolReverseBits( getMaskedSobol( index, SOBOL_DIRECTIONS_3 ) ) & 0x00ffffffu;
		uint w = sobolReverseBits( getMaskedSobol( index, SOBOL_DIRECTIONS_4 ) ) & 0x00ffffffu;

		return vec4( x, y, z, w ) * SOBOL_FACTOR;

	}

`;

	const sobol_functions = /* glsl */`

	// Seeds
	uniform sampler2D sobolTexture;
	uint sobolPixelIndex = 0u;
	uint sobolPathIndex = 0u;
	uint sobolBounceIndex = 0u;

	uint sobolGetSeed( uint bounce, uint effect ) {

		return sobolHash(
			sobolHashCombine(
				sobolHashCombine(
					sobolHash( bounce ),
					sobolPixelIndex
				),
				effect
			)
		);

	}

	vec4 sobolGetTexturePoint( uint index ) {

		if ( index >= SOBOL_MAX_POINTS ) {

			index = index % SOBOL_MAX_POINTS;

		}

		uvec2 dim = uvec2( textureSize( sobolTexture, 0 ).xy );
		uint y = index / dim.x;
		uint x = index - y * dim.x;
		vec2 uv = vec2( x, y ) / vec2( dim );
		return texture( sobolTexture, uv );

	}

	${ generateSobolSampleFunctions( 1 ) }
	${ generateSobolSampleFunctions( 2 ) }
	${ generateSobolSampleFunctions( 3 ) }
	${ generateSobolSampleFunctions( 4 ) }

`;

	class SobolNumbersMaterial extends MaterialBase {

		constructor() {

			super( {

				blending: three.NoBlending,

				uniforms: {

					resolution: { value: new three.Vector2() },

				},

				vertexShader: /* glsl */`

				varying vec2 vUv;
				void main() {

					vUv = uv;
					gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );

				}
			`,

				fragmentShader: /* glsl */`

				${ sobol_common }
				${ sobol_point_generation }

				varying vec2 vUv;
				uniform vec2 resolution;
				void main() {

					uint index = uint( gl_FragCoord.y ) * uint( resolution.x ) + uint( gl_FragCoord.x );
					gl_FragColor = generateSobolPoint( index );

				}
			`,

			} );

		}

	}

	class SobolNumberMapGenerator {

		generate( renderer, dimensions = 256 ) {

			const target = new three.WebGLRenderTarget( dimensions, dimensions, {

				type: three.FloatType,
				format: three.RGBAFormat,
				minFilter: three.NearestFilter,
				magFilter: three.NearestFilter,
				generateMipmaps: false,

			} );

			const ogTarget = renderer.getRenderTarget();
			renderer.setRenderTarget( target );

			const quad = new Pass_js.FullScreenQuad( new SobolNumbersMaterial() );
			quad.material.resolution.set( dimensions, dimensions );
			quad.render( renderer );

			renderer.setRenderTarget( ogTarget );
			quad.dispose();

			return target;

		}

	}

	class PhysicalCamera extends three.PerspectiveCamera {

		set bokehSize( size ) {

			this.fStop = this.getFocalLength() / size;

		}

		get bokehSize() {

			return this.getFocalLength() / this.fStop;

		}

		constructor( ...args ) {

			super( ...args );
			this.fStop = 1.4;
			this.apertureBlades = 0;
			this.apertureRotation = 0;
			this.focusDistance = 25;
			this.anamorphicRatio = 1;

		}

		copy( source, recursive ) {

			super.copy( source, recursive );

			this.fStop = source.fStop;
			this.apertureBlades = source.apertureBlades;
			this.apertureRotation = source.apertureRotation;
			this.focusDistance = source.focusDistance;
			this.anamorphicRatio = source.anamorphicRatio;

			return this;

		}

	}

	class PhysicalCameraUniform {

		constructor() {

			this.bokehSize = 0;
			this.apertureBlades = 0;
			this.apertureRotation = 0;
			this.focusDistance = 10;
			this.anamorphicRatio = 1;

		}

		updateFrom( camera ) {

			if ( camera instanceof PhysicalCamera ) {

				this.bokehSize = camera.bokehSize;
				this.apertureBlades = camera.apertureBlades;
				this.apertureRotation = camera.apertureRotation;
				this.focusDistance = camera.focusDistance;
				this.anamorphicRatio = camera.anamorphicRatio;

			} else {

				this.bokehSize = 0;
				this.apertureRotation = 0;
				this.apertureBlades = 0;
				this.focusDistance = 10;
				this.anamorphicRatio = 1;

			}

		}

	}

	function toHalfFloatArray( f32Array ) {

		const f16Array = new Uint16Array( f32Array.length );
		for ( let i = 0, n = f32Array.length; i < n; ++ i ) {

			f16Array[ i ] = three.DataUtils.toHalfFloat( f32Array[ i ] );

		}

		return f16Array;

	}

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
	function preprocessEnvMap( envMap, targetType = three.HalfFloatType ) {

		const map = envMap.clone();
		map.source = new three.Source( { ...map.image } );
		const { width, height, data } = map.image;

		// [FIX 1] Calculate stride dynamically (3 for RGB, 4 for RGBA) to prevent data corruption
		const originalStride = Math.floor( data.length / ( width * height ) );

		// Force copy and sanitization
		let newData;
		const targetStride = originalStride;

		if ( targetType === three.HalfFloatType ) {

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
			if ( map.type === three.HalfFloatType ) {

				v = three.DataUtils.fromHalfFloat( data[ i ] );

			}

			if ( map.type !== three.FloatType && map.type !== three.HalfFloatType ) {

				v /= maxIntValue;

			}

			// [FIX 2] Robust Sanitization: If Infinity (Sun), clamp to max value. Do not set to 0.
			if ( ! Number.isFinite( v ) ) {

				if ( v > 0 ) v = MAX_HALF_FLOAT;
				else v = 0.0;

			} else if ( v < 0 ) {

				v = 0.0;

			}

			if ( targetType === three.HalfFloatType ) {

				newData[ i ] = three.DataUtils.toHalfFloat( v );

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

	class EquirectHdrInfoUniform {

		constructor() {

			const blackTex = new three.DataTexture( toHalfFloatArray( new Float32Array( [ 0, 0, 0, 0 ] ) ), 1, 1 );
			blackTex.type = three.HalfFloatType;
			blackTex.format = three.RGBAFormat;
			blackTex.minFilter = three.LinearFilter;
			blackTex.magFilter = three.LinearFilter;
			blackTex.wrapS = three.RepeatWrapping;
			blackTex.wrapT = three.RepeatWrapping;
			blackTex.generateMipmaps = false;
			blackTex.needsUpdate = true;

			const marginalWeights = new three.DataTexture( toHalfFloatArray( new Float32Array( [ 0, 1 ] ) ), 1, 2 );
			marginalWeights.type = three.HalfFloatType;
			marginalWeights.format = three.RedFormat;
			marginalWeights.minFilter = three.LinearFilter;
			marginalWeights.magFilter = three.LinearFilter;
			marginalWeights.generateMipmaps = false;
			marginalWeights.needsUpdate = true;

			const conditionalWeights = new three.DataTexture( toHalfFloatArray( new Float32Array( [ 0, 0, 1, 1 ] ) ), 2, 2 );
			conditionalWeights.type = three.HalfFloatType;
			conditionalWeights.format = three.RedFormat;
			conditionalWeights.minFilter = three.LinearFilter;
			conditionalWeights.magFilter = three.LinearFilter;
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
			map.wrapS = three.RepeatWrapping;
			map.wrapT = three.ClampToEdgeWrapping;

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
					let r = three.DataUtils.fromHalfFloat( data[ stride * i + 0 ] );
					let g = three.DataUtils.fromHalfFloat( data[ stride * i + 1 ] );
					let b = three.DataUtils.fromHalfFloat( data[ stride * i + 2 ] );

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
				marginalDataArray[ i ] = three.DataUtils.toHalfFloat( ( row + 0.5 ) / height );

			}

			for ( let y = 0; y < height; y ++ ) {

				for ( let x = 0; x < width; x ++ ) {

					const i = y * width + x;
					const dist = ( x + 1 ) / width;
					const col = binarySearchFindClosestIndexOf( cdfConditional, dist, y * width, width );
					conditionalDataArray[ i ] = three.DataUtils.toHalfFloat( ( col + 0.5 ) / width );

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

	const LIGHT_PIXELS = 6;
	const RECT_AREA_LIGHT = 0;
	const CIRC_AREA_LIGHT = 1;
	const SPOT_LIGHT = 2;
	const DIR_LIGHT = 3;
	const POINT_LIGHT = 4;

	const u = new three.Vector3();
	const v = new three.Vector3();
	const m = new three.Matrix4();
	const worldQuaternion = new three.Quaternion();
	const eye = new three.Vector3();
	const target = new three.Vector3();
	const up = new three.Vector3( 0, 1, 0 );
	class LightsInfoUniformStruct {

		constructor() {

			const tex = new three.DataTexture( new Float32Array( 4 ), 1, 1 );
			tex.format = three.RGBAFormat;
			tex.type = three.FloatType;
			tex.wrapS = three.ClampToEdgeWrapping;
			tex.wrapT = three.ClampToEdgeWrapping;
			tex.generateMipmaps = false;
			tex.minFilter = three.NearestFilter;
			tex.magFilter = three.NearestFilter;

			this.tex = tex;
			this.count = 0;

		}

		updateFrom( lights, iesTextures = [] ) {

			const tex = this.tex;
			const pixelCount = Math.max( lights.length * LIGHT_PIXELS, 1 );
			const dimension = Math.ceil( Math.sqrt( pixelCount ) );

			if ( tex.image.width !== dimension ) {

				tex.dispose();

				tex.image.data = new Float32Array( dimension * dimension * 4 );
				tex.image.width = dimension;
				tex.image.height = dimension;

			}

			const floatArray = tex.image.data;

			for ( let i = 0, l = lights.length; i < l; i ++ ) {

				const l = lights[ i ];

				const baseIndex = i * LIGHT_PIXELS * 4;
				let index = 0;

				// initialize to 0
				for ( let p = 0; p < LIGHT_PIXELS * 4; p ++ ) {

					floatArray[ baseIndex + p ] = 0;

				}

				// sample 1
			    // position
				l.getWorldPosition( v );
				floatArray[ baseIndex + ( index ++ ) ] = v.x;
				floatArray[ baseIndex + ( index ++ ) ] = v.y;
				floatArray[ baseIndex + ( index ++ ) ] = v.z;

				// type
				let type = RECT_AREA_LIGHT;
				if ( l.isRectAreaLight && l.isCircular ) {

					type = CIRC_AREA_LIGHT;

				} else if ( l.isSpotLight ) {

					type = SPOT_LIGHT;

				} else if ( l.isDirectionalLight ) {

					type = DIR_LIGHT;

				} else if ( l.isPointLight ) {

					type = POINT_LIGHT;

				}

				floatArray[ baseIndex + ( index ++ ) ] = type;

				// sample 2
				// color
				floatArray[ baseIndex + ( index ++ ) ] = l.color.r;
				floatArray[ baseIndex + ( index ++ ) ] = l.color.g;
				floatArray[ baseIndex + ( index ++ ) ] = l.color.b;

				// intensity
				floatArray[ baseIndex + ( index ++ ) ] = l.intensity;

				l.getWorldQuaternion( worldQuaternion );

				if ( l.isRectAreaLight ) {

					// sample 3
					// u vector
					u.set( l.width, 0, 0 ).applyQuaternion( worldQuaternion );

					floatArray[ baseIndex + ( index ++ ) ] = u.x;
					floatArray[ baseIndex + ( index ++ ) ] = u.y;
					floatArray[ baseIndex + ( index ++ ) ] = u.z;
					index ++;

					// sample 4
					// v vector
					v.set( 0, l.height, 0 ).applyQuaternion( worldQuaternion );

					floatArray[ baseIndex + ( index ++ ) ] = v.x;
					floatArray[ baseIndex + ( index ++ ) ] = v.y;
					floatArray[ baseIndex + ( index ++ ) ] = v.z;

					// area
					floatArray[ baseIndex + ( index ++ ) ] = u.cross( v ).length() * ( l.isCircular ? ( Math.PI / 4.0 ) : 1.0 );

				} else if ( l.isSpotLight ) {

					const radius = l.radius || 0;
					eye.setFromMatrixPosition( l.matrixWorld );
					target.setFromMatrixPosition( l.target.matrixWorld );
					m.lookAt( eye, target, up );
					worldQuaternion.setFromRotationMatrix( m );

					// sample 3
					// u vector
					u.set( 1, 0, 0 ).applyQuaternion( worldQuaternion );

					floatArray[ baseIndex + ( index ++ ) ] = u.x;
					floatArray[ baseIndex + ( index ++ ) ] = u.y;
					floatArray[ baseIndex + ( index ++ ) ] = u.z;
					index ++;

					// sample 4
					// v vector
					v.set( 0, 1, 0 ).applyQuaternion( worldQuaternion );

					floatArray[ baseIndex + ( index ++ ) ] = v.x;
					floatArray[ baseIndex + ( index ++ ) ] = v.y;
					floatArray[ baseIndex + ( index ++ ) ] = v.z;

					// area
					floatArray[ baseIndex + ( index ++ ) ] = Math.PI * radius * radius;

					// sample 5
					// radius
					floatArray[ baseIndex + ( index ++ ) ] = radius;

					// decay
					floatArray[ baseIndex + ( index ++ ) ] = l.decay;

					// distance
					floatArray[ baseIndex + ( index ++ ) ] = l.distance;

					// coneCos
					floatArray[ baseIndex + ( index ++ ) ] = Math.cos( l.angle );

					// sample 6
					// penumbraCos
					floatArray[ baseIndex + ( index ++ ) ] = Math.cos( l.angle * ( 1 - l.penumbra ) );

					// iesProfile
					floatArray[ baseIndex + ( index ++ ) ] = l.iesMap ? iesTextures.indexOf( l.iesMap ) : - 1;

				} else if ( l.isPointLight ) {

					const worldPosition = u.setFromMatrixPosition( l.matrixWorld );

					// sample 3
					// u vector
					floatArray[ baseIndex + ( index ++ ) ] = worldPosition.x;
					floatArray[ baseIndex + ( index ++ ) ] = worldPosition.y;
					floatArray[ baseIndex + ( index ++ ) ] = worldPosition.z;
					index ++;

					// sample 4
					index += 4;

					// sample 5
					index += 1;

					floatArray[ baseIndex + ( index ++ ) ] = l.decay;
					floatArray[ baseIndex + ( index ++ ) ] = l.distance;

				} else if ( l.isDirectionalLight ) {

					const worldPosition = u.setFromMatrixPosition( l.matrixWorld );
					const targetPosition = v.setFromMatrixPosition( l.target.matrixWorld );
					target.subVectors( worldPosition, targetPosition ).normalize();

					// sample 3
					// u vector
					floatArray[ baseIndex + ( index ++ ) ] = target.x;
					floatArray[ baseIndex + ( index ++ ) ] = target.y;
					floatArray[ baseIndex + ( index ++ ) ] = target.z;

				}

			}

			this.count = lights.length;

			const hash = bufferToHash( floatArray.buffer );
			if ( this.hash !== hash ) {

				this.hash = hash;
				tex.needsUpdate = true;
				return true;

			}

			return false;

		}

	}

	function copyArrayToArray( fromArray, fromStride, toArray, toStride, offset ) {

		if ( fromStride > toStride ) {

			throw new Error();

		}

		// scale non-float values to their normalized range
		const count = fromArray.length / fromStride;
		const bpe = fromArray.constructor.BYTES_PER_ELEMENT * 8;
		let maxValue = 1.0;
		switch ( fromArray.constructor ) {

		case Uint8Array:
		case Uint16Array:
		case Uint32Array:
			maxValue = 2 ** bpe - 1;
			break;

		case Int8Array:
		case Int16Array:
		case Int32Array:
			maxValue = 2 ** ( bpe - 1 ) - 1;
			break;

		}

		for ( let i = 0; i < count; i ++ ) {

			const i4 = 4 * i;
			const is = fromStride * i;
			for ( let j = 0; j < toStride; j ++ ) {

				toArray[ offset + i4 + j ] = fromStride >= j + 1 ? fromArray[ is + j ] / maxValue : 0;

			}

		}

	}

	class FloatAttributeTextureArray extends three.DataArrayTexture {

		constructor() {

			super();
			this._textures = [];
			this.type = three.FloatType;
			this.format = three.RGBAFormat;
			this.internalFormat = 'RGBA32F';

		}

		updateAttribute( index, attr ) {

			// update the texture
			const tex = this._textures[ index ];
			tex.updateFrom( attr );

			// ensure compatibility
			const baseImage = tex.image;
			const image = this.image;
			if ( baseImage.width !== image.width || baseImage.height !== image.height ) {

				throw new Error( 'FloatAttributeTextureArray: Attribute must be the same dimensions when updating single layer.' );

			}

			// update the image
			const { width, height, data } = image;
			const length = width * height * 4;
			const offset = length * index;
			let itemSize = attr.itemSize;
			if ( itemSize === 3 ) {

				itemSize = 4;

			}

			// copy the data
			copyArrayToArray( tex.image.data, itemSize, data, 4, offset );

			this.dispose();
			this.needsUpdate = true;

		}

		setAttributes( attrs ) {

			// ensure the attribute count
			const itemCount = attrs[ 0 ].count;
			const attrsLength = attrs.length;
			for ( let i = 0, l = attrsLength; i < l; i ++ ) {

				if ( attrs[ i ].count !== itemCount ) {

					throw new Error( 'FloatAttributeTextureArray: All attributes must have the same item count.' );

				}

			}

			// initialize all textures
			const textures = this._textures;
			while ( textures.length < attrsLength ) {

				const tex = new FloatVertexAttributeTexture();
				textures.push( tex );

			}

			while ( textures.length > attrsLength ) {

				textures.pop();

			}

			// update all textures
			for ( let i = 0, l = attrsLength; i < l; i ++ ) {

				textures[ i ].updateFrom( attrs[ i ] );

			}

			// determine if we need to create a new array
			const baseTexture = textures[ 0 ];
			const baseImage = baseTexture.image;
			const image = this.image;

			if ( baseImage.width !== image.width || baseImage.height !== image.height || baseImage.depth !== attrsLength ) {

				image.width = baseImage.width;
				image.height = baseImage.height;
				image.depth = attrsLength;
				image.data = new Float32Array( image.width * image.height * image.depth * 4 );

			}

			// copy the other texture data into the data array texture
			const { data, width, height } = image;
			for ( let i = 0, l = attrsLength; i < l; i ++ ) {

				const tex = textures[ i ];
				const length = width * height * 4;
				const offset = length * i;

				let itemSize = attrs[ i ].itemSize;
				if ( itemSize === 3 ) {

					itemSize = 4;

				}

				copyArrayToArray( tex.image.data, itemSize, data, 4, offset );

			}

			// reset the texture
			this.dispose();
			this.needsUpdate = true;

		}


	}

	class AttributesTextureArray extends FloatAttributeTextureArray {

		updateNormalAttribute( attr ) {

			this.updateAttribute( 0, attr );

		}

		updateTangentAttribute( attr ) {

			this.updateAttribute( 1, attr );

		}

		updateUvAttribute( attr ) {

			this.updateAttribute( 2, attr );

		}

		updateColorAttribute( attr ) {

			this.updateAttribute( 3, attr );

		}

		updateFrom( normal, tangent, uv, color ) {

			this.setAttributes( [ normal, tangent, uv, color ] );

		}

	}

	function uuidSort( a, b ) {

		if ( a.uuid < b.uuid ) return 1;
		if ( a.uuid > b.uuid ) return - 1;
		return 0;

	}

	// we must hash the texture to determine uniqueness using the encoding, as well, because the
	// when rendering each texture to the texture array they must have a consistent color space.
	function getTextureHash$1( t ) {

		return `${ t.source.uuid }:${ t.colorSpace }`;

	}

	// reduce the set of textures to just those with a unique source while retaining
	// the order of the textures.
	function reduceTexturesToUniqueSources( textures ) {

		const sourceSet = new Set();
		const result = [];
		for ( let i = 0, l = textures.length; i < l; i ++ ) {

			const tex = textures[ i ];
			const hash = getTextureHash$1( tex );
			if ( ! sourceSet.has( hash ) ) {

				sourceSet.add( hash );
				result.push( tex );

			}

		}

		return result;

	}

	function getIesTextures( lights ) {

		const textures = lights.map( l => l.iesMap || null ).filter( t => t );
		const textureSet = new Set( textures );
		return Array.from( textureSet ).sort( uuidSort );

	}

	function getTextures( materials ) {

		const textureSet = new Set();
		for ( let i = 0, l = materials.length; i < l; i ++ ) {

			const material = materials[ i ];
			for ( const key in material ) {

				const value = material[ key ];
				if ( value && value.isTexture ) {

					textureSet.add( value );

				}

			}

		}

		const textureArray = Array.from( textureSet );
		return reduceTexturesToUniqueSources( textureArray ).sort( uuidSort );

	}

	function getLights( scene ) {

		const lights = [];
		scene.traverse( c => {

			if ( c.visible ) {

				if (
					c.isRectAreaLight ||
					c.isSpotLight ||
					c.isPointLight ||
					c.isDirectionalLight
				) {

					lights.push( c );

				}

			}

		} );

		return lights.sort( uuidSort );

	}

	const MATERIAL_PIXELS = 47;
	const MATERIAL_STRIDE = MATERIAL_PIXELS * 4;

	class MaterialFeatures {

		constructor() {

			this._features = {};

		}

		isUsed( feature ) {

			return feature in this._features;

		}

		setUsed( feature, used = true ) {

			if ( used === false ) {

				delete this._features[ feature ];

			} else {

				this._features[ feature ] = true;

			}

		}

		reset() {

			this._features = {};

		}

	}

	class MaterialsTexture extends three.DataTexture {

		constructor() {

			super( new Float32Array( 4 ), 1, 1 );

			this.format = three.RGBAFormat;
			this.type = three.FloatType;
			this.wrapS = three.ClampToEdgeWrapping;
			this.wrapT = three.ClampToEdgeWrapping;
			this.minFilter = three.NearestFilter;
			this.magFilter = three.NearestFilter;
			this.generateMipmaps = false;
			this.features = new MaterialFeatures();

		}

		updateFrom( materials, textures ) {

			function getTexture( material, key, def = - 1 ) {

				if ( key in material && material[ key ] ) {

					const hash = getTextureHash$1( material[ key ] );
					return textureLookUp[ hash ];

				} else {

					return def;

				}

			}

			function getField( material, key, def ) {

				return key in material ? material[ key ] : def;

			}

			function writeTextureMatrixToArray( material, textureKey, array, offset ) {

				const texture = material[ textureKey ] && material[ textureKey ].isTexture ? material[ textureKey ] : null;

				// check if texture exists
				if ( texture ) {

					if ( texture.matrixAutoUpdate ) {

						texture.updateMatrix();

					}

					const elements = texture.matrix.elements;

					let i = 0;

					// first row
					array[ offset + i ++ ] = elements[ 0 ];
					array[ offset + i ++ ] = elements[ 3 ];
					array[ offset + i ++ ] = elements[ 6 ];
					i ++;

					// second row
					array[ offset + i ++ ] = elements[ 1 ];
					array[ offset + i ++ ] = elements[ 4 ];
					array[ offset + i ++ ] = elements[ 7 ];
					i ++;

				}

				return 8;

			}

			let index = 0;
			const pixelCount = materials.length * MATERIAL_PIXELS;
			const dimension = Math.ceil( Math.sqrt( pixelCount ) ) || 1;
			const { image, features } = this;

			// index the list of textures based on shareable source
			const textureLookUp = {};
			for ( let i = 0, l = textures.length; i < l; i ++ ) {

				textureLookUp[ getTextureHash$1( textures[ i ] ) ] = i;

			}

			if ( image.width !== dimension ) {

				this.dispose();

				image.data = new Float32Array( dimension * dimension * 4 );
				image.width = dimension;
				image.height = dimension;

			}

			const floatArray = image.data;

			// on some devices (Google Pixel 6) the "floatBitsToInt" function does not work correctly so we
			// can't encode texture ids that way.
			// const intArray = new Int32Array( floatArray.buffer );

			features.reset();
			for ( let i = 0, l = materials.length; i < l; i ++ ) {

				const m = materials[ i ];

				if ( m.isFogVolumeMaterial ) {

					features.setUsed( 'FOG' );

					for ( let j = 0; j < MATERIAL_STRIDE; j ++ ) {

						floatArray[ index + j ] = 0;

					}

					// sample 0 .rgb
					floatArray[ index + 0 * 4 + 0 ] = m.color.r;
					floatArray[ index + 0 * 4 + 1 ] = m.color.g;
					floatArray[ index + 0 * 4 + 2 ] = m.color.b;

					// sample 2 .a
					floatArray[ index + 2 * 4 + 3 ] = getField( m, 'emissiveIntensity', 0.0 );

					// sample 3 .rgb
					floatArray[ index + 3 * 4 + 0 ] = m.emissive.r;
					floatArray[ index + 3 * 4 + 1 ] = m.emissive.g;
					floatArray[ index + 3 * 4 + 2 ] = m.emissive.b;

					// sample 13 .g
					// reusing opacity field
					floatArray[ index + 13 * 4 + 1 ] = m.density;

					// side
					floatArray[ index + 13 * 4 + 3 ] = 0.0;

					// sample 14 .b
					floatArray[ index + 14 * 4 + 2 ] = 1 << 2;

					index += MATERIAL_STRIDE;
					continue;

				}

				// sample 0
				// color
				floatArray[ index ++ ] = m.color.r;
				floatArray[ index ++ ] = m.color.g;
				floatArray[ index ++ ] = m.color.b;
				floatArray[ index ++ ] = getTexture( m, 'map' );

				// sample 1
				// metalness & roughness
				floatArray[ index ++ ] = getField( m, 'metalness', 0.0 );
				floatArray[ index ++ ] = getTexture( m, 'metalnessMap' );
				floatArray[ index ++ ] = getField( m, 'roughness', 0.0 );
				floatArray[ index ++ ] = getTexture( m, 'roughnessMap' );

				// sample 2
				// transmission & emissiveIntensity
				// three.js assumes a default f0 of 0.04 if no ior is provided which equates to an ior of 1.5
				floatArray[ index ++ ] = getField( m, 'ior', 1.5 );
				floatArray[ index ++ ] = getField( m, 'transmission', 0.0 );
				floatArray[ index ++ ] = getTexture( m, 'transmissionMap' );
				floatArray[ index ++ ] = getField( m, 'emissiveIntensity', 0.0 );

				// sample 3
				// emission
				if ( 'emissive' in m ) {

					floatArray[ index ++ ] = m.emissive.r;
					floatArray[ index ++ ] = m.emissive.g;
					floatArray[ index ++ ] = m.emissive.b;

				} else {

					floatArray[ index ++ ] = 0.0;
					floatArray[ index ++ ] = 0.0;
					floatArray[ index ++ ] = 0.0;

				}

				floatArray[ index ++ ] = getTexture( m, 'emissiveMap' );

				// sample 4
				// normals
				floatArray[ index ++ ] = getTexture( m, 'normalMap' );
				if ( 'normalScale' in m ) {

					floatArray[ index ++ ] = m.normalScale.x;
					floatArray[ index ++ ] = m.normalScale.y;

	 			} else {

	 				floatArray[ index ++ ] = 1;
	 				floatArray[ index ++ ] = 1;

	 			}

				// clearcoat
				floatArray[ index ++ ] = getField( m, 'clearcoat', 0.0 );
				floatArray[ index ++ ] = getTexture( m, 'clearcoatMap' ); // sample 5

				floatArray[ index ++ ] = getField( m, 'clearcoatRoughness', 0.0 );
				floatArray[ index ++ ] = getTexture( m, 'clearcoatRoughnessMap' );

				floatArray[ index ++ ] = getTexture( m, 'clearcoatNormalMap' );

				// sample 6
				if ( 'clearcoatNormalScale' in m ) {

					floatArray[ index ++ ] = m.clearcoatNormalScale.x;
					floatArray[ index ++ ] = m.clearcoatNormalScale.y;

				} else {

					floatArray[ index ++ ] = 1;
					floatArray[ index ++ ] = 1;

				}

				index ++;
				floatArray[ index ++ ] = getField( m, 'sheen', 0.0 );

				// sample 7
				// sheen
				if ( 'sheenColor' in m ) {

					floatArray[ index ++ ] = m.sheenColor.r;
					floatArray[ index ++ ] = m.sheenColor.g;
					floatArray[ index ++ ] = m.sheenColor.b;

				} else {

					floatArray[ index ++ ] = 0.0;
					floatArray[ index ++ ] = 0.0;
					floatArray[ index ++ ] = 0.0;

				}

				floatArray[ index ++ ] = getTexture( m, 'sheenColorMap' );

				// sample 8
				floatArray[ index ++ ] = getField( m, 'sheenRoughness', 0.0 );
				floatArray[ index ++ ] = getTexture( m, 'sheenRoughnessMap' );

				// iridescence
				floatArray[ index ++ ] = getTexture( m, 'iridescenceMap' );
				floatArray[ index ++ ] = getTexture( m, 'iridescenceThicknessMap' );

				// sample 9
				floatArray[ index ++ ] = getField( m, 'iridescence', 0.0 );
				floatArray[ index ++ ] = getField( m, 'iridescenceIOR', 1.3 );

				const iridescenceThicknessRange = getField( m, 'iridescenceThicknessRange', [ 100, 400 ] );
				floatArray[ index ++ ] = iridescenceThicknessRange[ 0 ];
				floatArray[ index ++ ] = iridescenceThicknessRange[ 1 ];

				// sample 10
				// specular color
				if ( 'specularColor' in m ) {

					floatArray[ index ++ ] = m.specularColor.r;
					floatArray[ index ++ ] = m.specularColor.g;
					floatArray[ index ++ ] = m.specularColor.b;

				} else {

					floatArray[ index ++ ] = 1.0;
					floatArray[ index ++ ] = 1.0;
					floatArray[ index ++ ] = 1.0;

				}

				floatArray[ index ++ ] = getTexture( m, 'specularColorMap' );

				// sample 11
				// specular intensity
				floatArray[ index ++ ] = getField( m, 'specularIntensity', 1.0 );
				floatArray[ index ++ ] = getTexture( m, 'specularIntensityMap' );

				// isThinFilm
				const isThinFilm = getField( m, 'thickness', 0.0 ) === 0.0 && getField( m, 'attenuationDistance', Infinity ) === Infinity;
				floatArray[ index ++ ] = Number( isThinFilm );
				index ++;

				// sample 12
				if ( 'attenuationColor' in m ) {

					floatArray[ index ++ ] = m.attenuationColor.r;
					floatArray[ index ++ ] = m.attenuationColor.g;
					floatArray[ index ++ ] = m.attenuationColor.b;

				} else {

					floatArray[ index ++ ] = 1.0;
					floatArray[ index ++ ] = 1.0;
					floatArray[ index ++ ] = 1.0;

				}

				floatArray[ index ++ ] = getField( m, 'attenuationDistance', Infinity );

				// sample 13
				// alphaMap
				floatArray[ index ++ ] = getTexture( m, 'alphaMap' );

				// side & matte
				floatArray[ index ++ ] = m.opacity;
				floatArray[ index ++ ] = m.alphaTest;
				if ( ! isThinFilm && m.transmission > 0.0 ) {

					floatArray[ index ++ ] = 0;

				} else {

					switch ( m.side ) {

					case three.FrontSide:
						floatArray[ index ++ ] = 1;
						break;
					case three.BackSide:
						floatArray[ index ++ ] = - 1;
						break;
					case three.DoubleSide:
						floatArray[ index ++ ] = 0;
						break;

					}

				}

				// sample 14
				floatArray[ index ++ ] = Number( getField( m, 'matte', false ) ); // matte
				floatArray[ index ++ ] = Number( getField( m, 'castShadow', true ) ); // shadow
				floatArray[ index ++ ] = Number( m.vertexColors ) | ( Number( m.flatShading ) << 1 ) | ( Number( getField( m, 'fogVolume', false ) ) << 2 ) | ( Number( getField( m, 'shadowReflectionCatcher', false ) ) << 3 ); // vertexColors, flatShading, fogVolume, shadowReflectionCatcher
				floatArray[ index ++ ] = Number( m.transparent ); // transparent

				// map transform 15
				index += writeTextureMatrixToArray( m, 'map', floatArray, index );

				// metalnessMap transform 17
				index += writeTextureMatrixToArray( m, 'metalnessMap', floatArray, index );

				// roughnessMap transform 19
				index += writeTextureMatrixToArray( m, 'roughnessMap', floatArray, index );

				// transmissionMap transform 21
				index += writeTextureMatrixToArray( m, 'transmissionMap', floatArray, index );

				// emissiveMap transform 22
				index += writeTextureMatrixToArray( m, 'emissiveMap', floatArray, index );

				// normalMap transform 25
				index += writeTextureMatrixToArray( m, 'normalMap', floatArray, index );

				// clearcoatMap transform 27
				index += writeTextureMatrixToArray( m, 'clearcoatMap', floatArray, index );

				// clearcoatNormalMap transform 29
				index += writeTextureMatrixToArray( m, 'clearcoatNormalMap', floatArray, index );

				// clearcoatRoughnessMap transform 31
				index += writeTextureMatrixToArray( m, 'clearcoatRoughnessMap', floatArray, index );

				// sheenColorMap transform 33
				index += writeTextureMatrixToArray( m, 'sheenColorMap', floatArray, index );

				// sheenRoughnessMap transform 35
				index += writeTextureMatrixToArray( m, 'sheenRoughnessMap', floatArray, index );

				// iridescenceMap transform 37
				index += writeTextureMatrixToArray( m, 'iridescenceMap', floatArray, index );

				// iridescenceThicknessMap transform 39
				index += writeTextureMatrixToArray( m, 'iridescenceThicknessMap', floatArray, index );

				// specularColorMap transform 41
				index += writeTextureMatrixToArray( m, 'specularColorMap', floatArray, index );

				// specularIntensityMap transform 43
				index += writeTextureMatrixToArray( m, 'specularIntensityMap', floatArray, index );

				// alphaMap transform 45
				index += writeTextureMatrixToArray( m, 'alphaMap', floatArray, index );

			}

			// check if the contents have changed
			const hash = bufferToHash( floatArray.buffer );
			if ( this.hash !== hash ) {

				this.hash = hash;
				this.needsUpdate = true;
				return true;

			}

			return false;

		}

	}

	const prevColor = new three.Color();
	function getTextureHash( texture ) {

		return texture ? `${ texture.uuid }:${ texture.version }` : null;

	}

	function assignOptions( target, options ) {

		for ( const key in options ) {

			if ( key in target ) {

				target[ key ] = options[ key ];

			}

		}

	}

	class RenderTarget2DArray extends three.WebGLArrayRenderTarget {

		constructor( width, height, options ) {

			const textureOptions = {
				format: three.RGBAFormat,
				type: three.HalfFloatType,
				minFilter: three.LinearFilter,
				magFilter: three.LinearFilter,
				wrapS: three.RepeatWrapping,
				wrapT: three.RepeatWrapping,
				generateMipmaps: false,
				...options,
			};

			super( width, height, 1, textureOptions );

			// manually assign the options because passing options into the
			// constructor does not work
			assignOptions( this.texture, textureOptions );

			this.texture.setTextures = ( ...args ) => {

				this.setTextures( ...args );

			};

			this.hashes = [ null ];

			const fsQuad = new Pass_js.FullScreenQuad( new CopyMaterial() );
			this.fsQuad = fsQuad;

		}

		setTextures( renderer, textures, width = this.width, height = this.height ) {

			// save previous renderer state
			const prevRenderTarget = renderer.getRenderTarget();
			const prevToneMapping = renderer.toneMapping;
			const prevAlpha = renderer.getClearAlpha();
			renderer.getClearColor( prevColor );

			// resize the render target and ensure we don't have an empty texture
			// render target depth must be >= 1 to avoid unbound texture error on android devices
			const depth = textures.length || 1;
			if ( width !== this.width || height !== this.height || this.depth !== depth ) {

				this.setSize( width, height, depth );
				this.hashes = new Array( depth ).fill( null );

			}

			renderer.setClearColor( 0, 0 );
			renderer.toneMapping = three.NoToneMapping;

			// render each texture into each layer of the target
			const fsQuad = this.fsQuad;
			const hashes = this.hashes;
			let updated = false;
			for ( let i = 0, l = depth; i < l; i ++ ) {

				const texture = textures[ i ];
				const hash = getTextureHash( texture );
				if ( texture && ( hashes[ i ] !== hash || texture.isWebGLRenderTarget ) ) {

					// revert to default texture transform before rendering
					texture.matrixAutoUpdate = false;
					texture.matrix.identity();

					fsQuad.material.map = texture;

					renderer.setRenderTarget( this, i );
					fsQuad.render( renderer );

					// restore custom texture transform
					texture.updateMatrix();
					texture.matrixAutoUpdate = true;

					// ensure textures are not updated unnecessarily
					hashes[ i ] = hash;
					updated = true;

				}

			}

			// reset the renderer
			fsQuad.material.map = null;
			renderer.setClearColor( prevColor, prevAlpha );
			renderer.setRenderTarget( prevRenderTarget );
			renderer.toneMapping = prevToneMapping;

			return updated;

		}

		dispose() {

			super.dispose();
			this.fsQuad.dispose();

		}

	}

	class CopyMaterial extends three.ShaderMaterial {

		get map() {

			return this.uniforms.map.value;

		}
		set map( v ) {

			this.uniforms.map.value = v;

		}

		constructor() {

			super( {
				uniforms: {

					map: { value: null },

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
				varying vec2 vUv;
				void main() {

					gl_FragColor = texture2D( map, vUv );

				}
			`
			} );

		}

	}

	// Stratified Sampling based on implementation from hoverinc pathtracer
	// - https://github.com/hoverinc/ray-tracing-renderer
	// - http://www.pbr-book.org/3ed-2018/Sampling_and_Reconstruction/Stratified_Sampling.html

	function shuffle( arr, random = Math.random() ) {

		for ( let i = arr.length - 1; i > 0; i -- ) {

		  const j = Math.floor( random() * ( i + 1 ) );
		  const x = arr[ i ];
		  arr[ i ] = arr[ j ];
		  arr[ j ] = x;

		}

		return arr;

	}

	// strataCount : The number of bins per dimension
	// dimensions  : The number of dimensions to generate stratified values for
	class StratifiedSampler {

		constructor( strataCount, dimensions, random = Math.random ) {

			const l = strataCount ** dimensions;
			const strata = new Uint16Array( l );
			let index = l;

			// each integer represents a statum bin
			for ( let i = 0; i < l; i ++ ) {

				strata[ i ] = i;

			}

			this.samples = new Float32Array( dimensions );

			this.strataCount = strataCount;

			this.reset = function () {

				for ( let i = 0; i < l; i ++ ) {

					strata[ i ] = i;

				}

				index = 0;

			};

			this.reshuffle = function () {

				index = 0;

			};

			this.next = function () {

				const { samples } = this;

				if ( index >= strata.length ) {

					shuffle( strata, random );
					this.reshuffle();

				}

				let stratum = strata[ index ++ ];

				for ( let i = 0; i < dimensions; i ++ ) {

					samples[ i ] = ( stratum % strataCount + random() ) / strataCount;
					stratum = Math.floor( stratum / strataCount );

				}

				return samples;

			};

		}

	}

	// Stratified Sampling based on implementation from hoverinc pathtracer

	// Stratified set of data with each tuple stratified separately and combined
	class StratifiedSamplerCombined {

		constructor( strataCount, listOfDimensions, random = Math.random ) {

			let totalDim = 0;
			for ( const dim of listOfDimensions ) {

				totalDim += dim;

			}

			const combined = new Float32Array( totalDim );
			const strataObjs = [];
			let offset = 0;
			for ( const dim of listOfDimensions ) {

				const sampler = new StratifiedSampler( strataCount, dim, random );
				sampler.samples = new Float32Array( combined.buffer, offset, sampler.samples.length );
				offset += sampler.samples.length * 4;
				strataObjs.push( sampler );

			}

			this.samples = combined;

			this.strataCount = strataCount;

			this.next = function () {

				for ( const strata of strataObjs ) {

					strata.next();

				}

				return combined;

			};

			this.reshuffle = function () {

				for ( const strata of strataObjs ) {

					strata.reshuffle();

				}

			};

			this.reset = function () {

				for ( const strata of strataObjs ) {

					strata.reset();

				}

			};

		}

	}

	// https://stackoverflow.com/questions/424292/seedable-javascript-random-number-generator
	class RandomGenerator {

		constructor( seed = 0 ) {

			// LCG using GCC's constants
			this.m = 0x80000000; // 2**31;
			this.a = 1103515245;
			this.c = 12345;

			this.seed = seed;

		}

		nextInt() {

			this.seed = ( this.a * this.seed + this.c ) % this.m;
			return this.seed;

		}

		nextFloat() {

			// returns in range [0,1]
			return this.nextInt() / ( this.m - 1 );

		}

	}

	class StratifiedSamplesTexture extends three.DataTexture {

		constructor( count = 1, depth = 1, strata = 8 ) {

			super( new Float32Array( 1 ), 1, 1, three.RGBAFormat, three.FloatType );
			this.minFilter = three.NearestFilter;
			this.magFilter = three.NearestFilter;

			this.strata = strata;
			this.sampler = null;
			this.generator = new RandomGenerator();
			this.stableNoise = false;
			this.random = () => {

				if ( this.stableNoise ) {

					return this.generator.nextFloat();

				} else {

					return Math.random();

				}

			};

			this.init( count, depth, strata );

		}

		init( count = this.image.height, depth = this.image.width, strata = this.strata ) {

			const { image } = this;
			if ( image.width === depth && image.height === count && this.sampler !== null ) {

				return;

			}

			const dimensions = new Array( count * depth ).fill( 4 );
			const sampler = new StratifiedSamplerCombined( strata, dimensions, this.random );

			image.width = depth;
			image.height = count;
			image.data = sampler.samples;

			this.sampler = sampler;

			this.dispose();
			this.next();

		}

		next() {

			this.sampler.next();
			this.needsUpdate = true;

		}

		reset() {

			this.sampler.reset();
			this.generator.seed = 0;

		}

	}

	function shuffleArray( array, random = Math.random ) {

		for ( let i = array.length - 1; i > 0; i -- ) {

			const replaceIndex = ~ ~ ( ( random() - 1e-6 ) * i );
			const tmp = array[ i ];
			array[ i ] = array[ replaceIndex ];
			array[ replaceIndex ] = tmp;

		}

	}

	function fillWithOnes( array, count ) {

		array.fill( 0 );

		for ( let i = 0; i < count; i ++ ) {

			array[ i ] = 1;

		}

	}

	class BlueNoiseSamples {

		constructor( size ) {

			this.count = 0;
			this.size = - 1;
			this.sigma = - 1;
			this.radius = - 1;
			this.lookupTable = null;
			this.score = null;
			this.binaryPattern = null;

			this.resize( size );
			this.setSigma( 1.5 );

		}

		findVoid() {

			const { score, binaryPattern } = this;

			let currValue = Infinity;
			let currIndex = - 1;
			for ( let i = 0, l = binaryPattern.length; i < l; i ++ ) {

				if ( binaryPattern[ i ] !== 0 ) {

					continue;

				}

				const pScore = score[ i ];
				if ( pScore < currValue ) {

					currValue = pScore;
					currIndex = i;

				}

			}

			return currIndex;

		}

		findCluster() {

			const { score, binaryPattern } = this;

			let currValue = - Infinity;
			let currIndex = - 1;
			for ( let i = 0, l = binaryPattern.length; i < l; i ++ ) {

				if ( binaryPattern[ i ] !== 1 ) {

					continue;

				}

				const pScore = score[ i ];
				if ( pScore > currValue ) {

					currValue = pScore;
					currIndex = i;

				}

			}

			return currIndex;

		}

		setSigma( sigma ) {

			if ( sigma === this.sigma ) {

				return;

			}

			// generate a radius in which the score will be updated under the
			// assumption that e^-10 is insignificant enough to be the border at
			// which we drop off.
			const radius = ~ ~ ( Math.sqrt( 10 * 2 * ( sigma ** 2 ) ) + 1 );
			const lookupWidth = 2 * radius + 1;
			const lookupTable = new Float32Array( lookupWidth * lookupWidth );
			const sigma2 = sigma * sigma;
			for ( let x = - radius; x <= radius; x ++ ) {

				for ( let y = - radius; y <= radius; y ++ ) {

					const index = ( radius + y ) * lookupWidth + x + radius;
					const dist2 = x * x + y * y;
					lookupTable[ index ] = Math.E ** ( - dist2 / ( 2 * sigma2 ) );

				}

			}

			this.lookupTable = lookupTable;
			this.sigma = sigma;
			this.radius = radius;

		}

		resize( size ) {

			if ( this.size !== size ) {

				this.size = size;
				this.score = new Float32Array( size * size );
				this.binaryPattern = new Uint8Array( size * size );

			}


		}

		invert() {

			const { binaryPattern, score, size } = this;

			score.fill( 0 );

			for ( let i = 0, l = binaryPattern.length; i < l; i ++ ) {

				if ( binaryPattern[ i ] === 0 ) {

					const y = ~ ~ ( i / size );
					const x = i - y * size;
					this.updateScore( x, y, 1 );
					binaryPattern[ i ] = 1;

				} else {

					binaryPattern[ i ] = 0;

				}

			}

		}

		updateScore( x, y, multiplier ) {

			// TODO: Is there a way to keep track of the highest and lowest scores here to avoid have to search over
			// everything in the buffer?
			const { size, score, lookupTable } = this;

			// const sigma2 = sigma * sigma;
			// const radius = Math.floor( size / 2 );
			const radius = this.radius;
			const lookupWidth = 2 * radius + 1;
			for ( let px = - radius; px <= radius; px ++ ) {

				for ( let py = - radius; py <= radius; py ++ ) {

					// const dist2 = px * px + py * py;
					// const value = Math.E ** ( - dist2 / ( 2 * sigma2 ) );

					const lookupIndex = ( radius + py ) * lookupWidth + px + radius;
					const value = lookupTable[ lookupIndex ];

					let sx = ( x + px );
					sx = sx < 0 ? size + sx : sx % size;

					let sy = ( y + py );
					sy = sy < 0 ? size + sy : sy % size;

					const sindex = sy * size + sx;
					score[ sindex ] += multiplier * value;

				}

			}

		}

		addPointIndex( index ) {

			this.binaryPattern[ index ] = 1;

			const size = this.size;
			const y = ~ ~ ( index / size );
			const x = index - y * size;
			this.updateScore( x, y, 1 );
			this.count ++;

		}

		removePointIndex( index ) {

			this.binaryPattern[ index ] = 0;

			const size = this.size;
			const y = ~ ~ ( index / size );
			const x = index - y * size;
			this.updateScore( x, y, - 1 );
			this.count --;

		}

		copy( source ) {

			this.resize( source.size );
			this.score.set( source.score );
			this.binaryPattern.set( source.binaryPattern );
			this.setSigma( source.sigma );
			this.count = source.count;

		}

	}

	class BlueNoiseGenerator {

		constructor() {

			this.random = Math.random;
			this.sigma = 1.5;
			this.size = 64;
			this.majorityPointsRatio = 0.1;

			this.samples = new BlueNoiseSamples( 1 );
			this.savedSamples = new BlueNoiseSamples( 1 );

		}

		generate() {

			// http://cv.ulichney.com/papers/1993-void-cluster.pdf

			const {
				samples,
				savedSamples,
				sigma,
				majorityPointsRatio,
				size,
			} = this;

			samples.resize( size );
			samples.setSigma( sigma );

			// 1. Randomly place the minority points.
			const pointCount = Math.floor( size * size * majorityPointsRatio );
			const initialSamples = samples.binaryPattern;

			fillWithOnes( initialSamples, pointCount );
			shuffleArray( initialSamples, this.random );

			for ( let i = 0, l = initialSamples.length; i < l; i ++ ) {

				if ( initialSamples[ i ] === 1 ) {

					samples.addPointIndex( i );

				}

			}

			// 2. Remove minority point that is in densest cluster and place it in the largest void.
			while ( true ) {

				const clusterIndex = samples.findCluster();
				samples.removePointIndex( clusterIndex );

				const voidIndex = samples.findVoid();
				if ( clusterIndex === voidIndex ) {

					samples.addPointIndex( clusterIndex );
					break;

				}

				samples.addPointIndex( voidIndex );

			}

			// 3. PHASE I: Assign a rank to each progressively less dense cluster point and put it
			// in the dither array.
			const ditherArray = new Uint32Array( size * size );
			savedSamples.copy( samples );

			let rank;
			rank = samples.count - 1;
			while ( rank >= 0 ) {

				const clusterIndex = samples.findCluster();
				samples.removePointIndex( clusterIndex );

				ditherArray[ clusterIndex ] = rank;
				rank --;

			}

			// 4. PHASE II: Do the same thing for the largest voids up to half of the total pixels using
			// the initial binary pattern.
			const totalSize = size * size;
			rank = savedSamples.count;
			while ( rank < totalSize / 2 ) {

				const voidIndex = savedSamples.findVoid();
				savedSamples.addPointIndex( voidIndex );
				ditherArray[ voidIndex ] = rank;
				rank ++;

			}

			// 5. PHASE III: Invert the pattern and finish out by assigning a rank to the remaining
			// and iteratively removing them.
			savedSamples.invert();

			while ( rank < totalSize ) {

				const clusterIndex = savedSamples.findCluster();
				savedSamples.removePointIndex( clusterIndex );
				ditherArray[ clusterIndex ] = rank;
				rank ++;

			}

			return { data: ditherArray, maxValue: totalSize };

		}

	}

	function getStride( channels ) {

		if ( channels >= 3 ) {

			return 4;

		} else {

			return channels;

		}

	}

	function getFormat( channels ) {

		switch ( channels ) {

		case 1:
			return three.RedFormat;
		case 2:
			return three.RGFormat;
		default:
			return three.RGBAFormat;

		}

	}

	class BlueNoiseTexture extends three.DataTexture {

		constructor( size = 64, channels = 1 ) {

			super( new Float32Array( 4 ), 1, 1, three.RGBAFormat, three.FloatType );
			this.minFilter = three.NearestFilter;
			this.magFilter = three.NearestFilter;

			this.size = size;
			this.channels = channels;
			this.update();

		}

		update() {

			const channels = this.channels;
			const size = this.size;
			const generator = new BlueNoiseGenerator();
			generator.channels = channels;
			generator.size = size;

			const stride = getStride( channels );
			const format = getFormat( stride );
			if ( this.image.width !== size || format !== this.format ) {

				this.image.width = size;
				this.image.height = size;
				this.image.data = new Float32Array( ( size ** 2 ) * stride );
				this.format = format;
				this.dispose();

			}

			const data = this.image.data;
			for ( let i = 0, l = channels; i < l; i ++ ) {

				const result = generator.generate();
				const bin = result.data;
				const maxValue = result.maxValue;

				for ( let j = 0, l2 = bin.length; j < l2; j ++ ) {

					const value = bin[ j ] / maxValue;
					data[ j * stride + i ] = value;

				}

			}

			this.needsUpdate = true;

		}

	}

	const camera_struct = /* glsl */`

	struct PhysicalCamera {

		float focusDistance;
		float anamorphicRatio;
		float bokehSize;
		int apertureBlades;
		float apertureRotation;

	};

`;

	const equirect_struct = /* glsl */`

	struct EquirectHdrInfo {

		sampler2D marginalWeights;
		sampler2D conditionalWeights;
		sampler2D map;

		float totalSum;

	};

`;

	const lights_struct = /* glsl */`

	#define RECT_AREA_LIGHT_TYPE 0
	#define CIRC_AREA_LIGHT_TYPE 1
	#define SPOT_LIGHT_TYPE 2
	#define DIR_LIGHT_TYPE 3
	#define POINT_LIGHT_TYPE 4

	struct LightsInfo {

		sampler2D tex;
		uint count;

	};

	struct Light {

		vec3 position;
		int type;

		vec3 color;
		float intensity;

		vec3 u;
		vec3 v;
		float area;

		// spot light fields
		float radius;
		float near;
		float decay;
		float distance;
		float coneCos;
		float penumbraCos;
		int iesProfile;

	};

	Light readLightInfo( sampler2D tex, uint index ) {

		uint i = index * 6u;

		vec4 s0 = texelFetch1D( tex, i + 0u );
		vec4 s1 = texelFetch1D( tex, i + 1u );
		vec4 s2 = texelFetch1D( tex, i + 2u );
		vec4 s3 = texelFetch1D( tex, i + 3u );

		Light l;
		l.position = s0.rgb;
		l.type = int( round( s0.a ) );

		l.color = s1.rgb;
		l.intensity = s1.a;

		l.u = s2.rgb;
		l.v = s3.rgb;
		l.area = s3.a;

		if ( l.type == SPOT_LIGHT_TYPE || l.type == POINT_LIGHT_TYPE ) {

			vec4 s4 = texelFetch1D( tex, i + 4u );
			vec4 s5 = texelFetch1D( tex, i + 5u );
			l.radius = s4.r;
			l.decay = s4.g;
			l.distance = s4.b;
			l.coneCos = s4.a;

			l.penumbraCos = s5.r;
			l.iesProfile = int( round( s5.g ) );

		} else {

			l.radius = 0.0;
			l.decay = 0.0;
			l.distance = 0.0;

			l.coneCos = 0.0;
			l.penumbraCos = 0.0;
			l.iesProfile = - 1;

		}

		return l;

	}

`;

	const material_struct = /* glsl */ `

	struct Material {

		vec3 color;
		int map;

		float metalness;
		int metalnessMap;

		float roughness;
		int roughnessMap;

		float ior;
		float transmission;
		int transmissionMap;

		float emissiveIntensity;
		vec3 emissive;
		int emissiveMap;

		int normalMap;
		vec2 normalScale;

		float clearcoat;
		int clearcoatMap;
		int clearcoatNormalMap;
		vec2 clearcoatNormalScale;
		float clearcoatRoughness;
		int clearcoatRoughnessMap;

		int iridescenceMap;
		int iridescenceThicknessMap;
		float iridescence;
		float iridescenceIor;
		float iridescenceThicknessMinimum;
		float iridescenceThicknessMaximum;

		vec3 specularColor;
		int specularColorMap;

		float specularIntensity;
		int specularIntensityMap;
		bool thinFilm;

		vec3 attenuationColor;
		float attenuationDistance;

		int alphaMap;

		bool castShadow;
		float opacity;
		float alphaTest;

		float side;
		bool matte;
		bool shadowReflectionCatcher;

		float sheen;
		vec3 sheenColor;
		int sheenColorMap;
		float sheenRoughness;
		int sheenRoughnessMap;

		bool vertexColors;
		bool flatShading;
		bool transparent;
		bool fogVolume;

		mat3 mapTransform;
		mat3 metalnessMapTransform;
		mat3 roughnessMapTransform;
		mat3 transmissionMapTransform;
		mat3 emissiveMapTransform;
		mat3 normalMapTransform;
		mat3 clearcoatMapTransform;
		mat3 clearcoatNormalMapTransform;
		mat3 clearcoatRoughnessMapTransform;
		mat3 sheenColorMapTransform;
		mat3 sheenRoughnessMapTransform;
		mat3 iridescenceMapTransform;
		mat3 iridescenceThicknessMapTransform;
		mat3 specularColorMapTransform;
		mat3 specularIntensityMapTransform;
		mat3 alphaMapTransform;

	};

	mat3 readTextureTransform( sampler2D tex, uint index ) {

		mat3 textureTransform;

		vec4 row1 = texelFetch1D( tex, index );
		vec4 row2 = texelFetch1D( tex, index + 1u );

		textureTransform[0] = vec3(row1.r, row2.r, 0.0);
		textureTransform[1] = vec3(row1.g, row2.g, 0.0);
		textureTransform[2] = vec3(row1.b, row2.b, 1.0);

		return textureTransform;

	}

	Material readMaterialInfo( sampler2D tex, uint index ) {

		uint i = index * uint( MATERIAL_PIXELS );

		vec4 s0 = texelFetch1D( tex, i + 0u );
		vec4 s1 = texelFetch1D( tex, i + 1u );
		vec4 s2 = texelFetch1D( tex, i + 2u );
		vec4 s3 = texelFetch1D( tex, i + 3u );
		vec4 s4 = texelFetch1D( tex, i + 4u );
		vec4 s5 = texelFetch1D( tex, i + 5u );
		vec4 s6 = texelFetch1D( tex, i + 6u );
		vec4 s7 = texelFetch1D( tex, i + 7u );
		vec4 s8 = texelFetch1D( tex, i + 8u );
		vec4 s9 = texelFetch1D( tex, i + 9u );
		vec4 s10 = texelFetch1D( tex, i + 10u );
		vec4 s11 = texelFetch1D( tex, i + 11u );
		vec4 s12 = texelFetch1D( tex, i + 12u );
		vec4 s13 = texelFetch1D( tex, i + 13u );
		vec4 s14 = texelFetch1D( tex, i + 14u );

		Material m;
		m.color = s0.rgb;
		m.map = int( round( s0.a ) );

		m.metalness = s1.r;
		m.metalnessMap = int( round( s1.g ) );
		m.roughness = s1.b;
		m.roughnessMap = int( round( s1.a ) );

		m.ior = s2.r;
		m.transmission = s2.g;
		m.transmissionMap = int( round( s2.b ) );
		m.emissiveIntensity = s2.a;

		m.emissive = s3.rgb;
		m.emissiveMap = int( round( s3.a ) );

		m.normalMap = int( round( s4.r ) );
		m.normalScale = s4.gb;

		m.clearcoat = s4.a;
		m.clearcoatMap = int( round( s5.r ) );
		m.clearcoatRoughness = s5.g;
		m.clearcoatRoughnessMap = int( round( s5.b ) );
		m.clearcoatNormalMap = int( round( s5.a ) );
		m.clearcoatNormalScale = s6.rg;

		m.sheen = s6.a;
		m.sheenColor = s7.rgb;
		m.sheenColorMap = int( round( s7.a ) );
		m.sheenRoughness = s8.r;
		m.sheenRoughnessMap = int( round( s8.g ) );

		m.iridescenceMap = int( round( s8.b ) );
		m.iridescenceThicknessMap = int( round( s8.a ) );
		m.iridescence = s9.r;
		m.iridescenceIor = s9.g;
		m.iridescenceThicknessMinimum = s9.b;
		m.iridescenceThicknessMaximum = s9.a;

		m.specularColor = s10.rgb;
		m.specularColorMap = int( round( s10.a ) );

		m.specularIntensity = s11.r;
		m.specularIntensityMap = int( round( s11.g ) );
		m.thinFilm = bool( s11.b );

		m.attenuationColor = s12.rgb;
		m.attenuationDistance = s12.a;

		m.alphaMap = int( round( s13.r ) );

		m.opacity = s13.g;
		m.alphaTest = s13.b;
		m.side = s13.a;

		m.matte = bool( s14.r );
		m.castShadow = bool( s14.g );
		m.vertexColors = bool( int( s14.b ) & 1 );
		m.flatShading = bool( int( s14.b ) & 2 );
		m.fogVolume = bool( int( s14.b ) & 4 );
		m.shadowReflectionCatcher = bool( int( s14.b ) & 8 );
		m.transparent = bool( s14.a );

		uint firstTextureTransformIdx = i + 15u;

		// mat3( 1.0 ) is an identity matrix
		m.mapTransform = m.map == - 1 ? mat3( 1.0 ) : readTextureTransform( tex, firstTextureTransformIdx );
		m.metalnessMapTransform = m.metalnessMap == - 1 ? mat3( 1.0 ) : readTextureTransform( tex, firstTextureTransformIdx + 2u );
		m.roughnessMapTransform = m.roughnessMap == - 1 ? mat3( 1.0 ) : readTextureTransform( tex, firstTextureTransformIdx + 4u );
		m.transmissionMapTransform = m.transmissionMap == - 1 ? mat3( 1.0 ) : readTextureTransform( tex, firstTextureTransformIdx + 6u );
		m.emissiveMapTransform = m.emissiveMap == - 1 ? mat3( 1.0 ) : readTextureTransform( tex, firstTextureTransformIdx + 8u );
		m.normalMapTransform = m.normalMap == - 1 ? mat3( 1.0 ) : readTextureTransform( tex, firstTextureTransformIdx + 10u );
		m.clearcoatMapTransform = m.clearcoatMap == - 1 ? mat3( 1.0 ) : readTextureTransform( tex, firstTextureTransformIdx + 12u );
		m.clearcoatNormalMapTransform = m.clearcoatNormalMap == - 1 ? mat3( 1.0 ) : readTextureTransform( tex, firstTextureTransformIdx + 14u );
		m.clearcoatRoughnessMapTransform = m.clearcoatRoughnessMap == - 1 ? mat3( 1.0 ) : readTextureTransform( tex, firstTextureTransformIdx + 16u );
		m.sheenColorMapTransform = m.sheenColorMap == - 1 ? mat3( 1.0 ) : readTextureTransform( tex, firstTextureTransformIdx + 18u );
		m.sheenRoughnessMapTransform = m.sheenRoughnessMap == - 1 ? mat3( 1.0 ) : readTextureTransform( tex, firstTextureTransformIdx + 20u );
		m.iridescenceMapTransform = m.iridescenceMap == - 1 ? mat3( 1.0 ) : readTextureTransform( tex, firstTextureTransformIdx + 22u );
		m.iridescenceThicknessMapTransform = m.iridescenceThicknessMap == - 1 ? mat3( 1.0 ) : readTextureTransform( tex, firstTextureTransformIdx + 24u );
		m.specularColorMapTransform = m.specularColorMap == - 1 ? mat3( 1.0 ) : readTextureTransform( tex, firstTextureTransformIdx + 26u );
		m.specularIntensityMapTransform = m.specularIntensityMap == - 1 ? mat3( 1.0 ) : readTextureTransform( tex, firstTextureTransformIdx + 28u );
		m.alphaMapTransform = m.alphaMap == - 1 ? mat3( 1.0 ) : readTextureTransform( tex, firstTextureTransformIdx + 30u );

		return m;

	}

`;

	const surface_record_struct = /* glsl */`

	struct SurfaceRecord {

		// surface type
		bool volumeParticle;

		// geometry
		vec3 faceNormal;
		bool frontFace;
		vec3 normal;
		mat3 normalBasis;
		mat3 normalInvBasis;

		// cached properties
		float eta;
		float f0;

		// material
		float roughness;
		float filteredRoughness;
		float metalness;
		vec3 color;
		vec3 emission;

		// transmission
		float ior;
		float transmission;
		bool thinFilm;
		vec3 attenuationColor;
		float attenuationDistance;

		// clearcoat
		vec3 clearcoatNormal;
		mat3 clearcoatBasis;
		mat3 clearcoatInvBasis;
		float clearcoat;
		float clearcoatRoughness;
		float filteredClearcoatRoughness;

		// sheen
		float sheen;
		vec3 sheenColor;
		float sheenRoughness;

		// iridescence
		float iridescence;
		float iridescenceIor;
		float iridescenceThickness;

		// specular
		vec3 specularColor;
		float specularIntensity;
	};

	struct ScatterRecord {
		float specularPdf;
		float pdf;
		vec3 direction;
		vec3 color;
	};

`;

	const equirect_functions = /* glsl */`

	// samples the the given environment map in the given direction
	vec3 sampleEquirectColor( sampler2D envMap, vec3 direction ) {

		return texture2D( envMap, equirectDirectionToUv( direction ) ).rgb;

	}

	// gets the pdf of the given direction to sample
	float equirectDirectionPdf( vec3 direction ) {

		vec2 uv = equirectDirectionToUv( direction );
		float theta = uv.y * PI;
		float sinTheta = sin( theta );
		if ( sinTheta == 0.0 ) {

			return 0.0;

		}

		return 1.0 / ( 2.0 * PI * PI * sinTheta );

	}

	// samples the color given env map with CDF and returns the pdf of the direction
	float sampleEquirect( vec3 direction, inout vec3 color ) {

		float totalSum = envMapInfo.totalSum;
		if ( totalSum == 0.0 ) {

			color = vec3( 0.0 );
			return 1.0;

		}

		vec2 uv = equirectDirectionToUv( direction );
		color = texture2D( envMapInfo.map, uv ).rgb;

		float lum = luminance( color );
		ivec2 resolution = textureSize( envMapInfo.map, 0 );
		float pdf = lum / totalSum;

		return float( resolution.x * resolution.y ) * pdf * equirectDirectionPdf( direction );

	}

	// samples a direction of the envmap with color and retrieves pdf
	float sampleEquirectProbability( vec2 r, inout vec3 color, inout vec3 direction ) {

		// sample env map cdf
		float v = texture2D( envMapInfo.marginalWeights, vec2( r.x, 0.0 ) ).x;
		float u = texture2D( envMapInfo.conditionalWeights, vec2( r.y, v ) ).x;
		vec2 uv = vec2( u, v );

		vec3 derivedDirection = equirectUvToDirection( uv );
		direction = derivedDirection;
		color = texture2D( envMapInfo.map, uv ).rgb;

		float totalSum = envMapInfo.totalSum;
		float lum = luminance( color );
		ivec2 resolution = textureSize( envMapInfo.map, 0 );
		float pdf = lum / totalSum;

		return float( resolution.x * resolution.y ) * pdf * equirectDirectionPdf( direction );

	}
`;

	const light_sampling_functions = /* glsl */`

	float getSpotAttenuation( const in float coneCosine, const in float penumbraCosine, const in float angleCosine ) {

		return smoothstep( coneCosine, penumbraCosine, angleCosine );

	}

	float getDistanceAttenuation( const in float lightDistance, const in float cutoffDistance, const in float decayExponent ) {

		// based upon Frostbite 3 Moving to Physically-based Rendering
		// page 32, equation 26: E[window1]
		// https://seblagarde.files.wordpress.com/2015/07/course_notes_moving_frostbite_to_pbr_v32.pdf
		float distanceFalloff = 1.0 / max( pow( lightDistance, decayExponent ), EPSILON );

		if ( cutoffDistance > 0.0 ) {

			distanceFalloff *= pow2( saturate( 1.0 - pow4( lightDistance / cutoffDistance ) ) );

		}

		return distanceFalloff;

	}

	float getPhotometricAttenuation( sampler2DArray iesProfiles, int iesProfile, vec3 posToLight, vec3 lightDir, vec3 u, vec3 v ) {

		float cosTheta = dot( posToLight, lightDir );
		float angle = acos( cosTheta ) / PI;

		return texture2D( iesProfiles, vec3( angle, 0.0, iesProfile ) ).r;

	}

	struct LightRecord {

		float dist;
		vec3 direction;
		float pdf;
		vec3 emission;
		int type;

	};

	bool intersectLightAtIndex( sampler2D lights, vec3 rayOrigin, vec3 rayDirection, uint l, inout LightRecord lightRec ) {

		bool didHit = false;
		Light light = readLightInfo( lights, l );

		vec3 u = light.u;
		vec3 v = light.v;

		// check for backface
		vec3 normal = normalize( cross( u, v ) );
		if ( dot( normal, rayDirection ) > 0.0 ) {

			u *= 1.0 / dot( u, u );
			v *= 1.0 / dot( v, v );

			float dist;

			// MIS / light intersection is not supported for punctual lights.
			if(
				( light.type == RECT_AREA_LIGHT_TYPE && intersectsRectangle( light.position, normal, u, v, rayOrigin, rayDirection, dist ) ) ||
				( light.type == CIRC_AREA_LIGHT_TYPE && intersectsCircle( light.position, normal, u, v, rayOrigin, rayDirection, dist ) )
			) {

				float cosTheta = dot( rayDirection, normal );
				didHit = true;
				lightRec.dist = dist;
				lightRec.pdf = ( dist * dist ) / ( light.area * cosTheta );
				lightRec.emission = light.color * light.intensity;
				lightRec.direction = rayDirection;
				lightRec.type = light.type;

			}

		}

		return didHit;

	}

	LightRecord randomAreaLightSample( Light light, vec3 rayOrigin, vec2 ruv ) {

		vec3 randomPos;
		if( light.type == RECT_AREA_LIGHT_TYPE ) {

			// rectangular area light
			randomPos = light.position + light.u * ( ruv.x - 0.5 ) + light.v * ( ruv.y - 0.5 );

		} else if( light.type == CIRC_AREA_LIGHT_TYPE ) {

			// circular area light
			float r = 0.5 * sqrt( ruv.x );
			float theta = ruv.y * 2.0 * PI;
			float x = r * cos( theta );
			float y = r * sin( theta );

			randomPos = light.position + light.u * x + light.v * y;

		}

		vec3 toLight = randomPos - rayOrigin;
		float lightDistSq = dot( toLight, toLight );
		float dist = sqrt( lightDistSq );
		vec3 direction = toLight / dist;
		vec3 lightNormal = normalize( cross( light.u, light.v ) );

		LightRecord lightRec;
		lightRec.type = light.type;
		lightRec.emission = light.color * light.intensity;
		lightRec.dist = dist;
		lightRec.direction = direction;

		lightRec.pdf = lightDistSq / max( light.area * abs( dot( direction, lightNormal ) ), 1e-6 );

		return lightRec;

	}

	LightRecord randomSpotLightSample( Light light, sampler2DArray iesProfiles, vec3 rayOrigin, vec2 ruv ) {

		float radius = light.radius * sqrt( ruv.x );
		float theta = ruv.y * 2.0 * PI;
		float x = radius * cos( theta );
		float y = radius * sin( theta );

		vec3 u = light.u;
		vec3 v = light.v;
		vec3 normal = normalize( cross( u, v ) );

		float angle = acos( light.coneCos );
		float angleTan = tan( angle );
		float startDistance = light.radius / max( angleTan, EPSILON );

		vec3 randomPos = light.position - normal * startDistance + u * x + v * y;
		vec3 toLight = randomPos - rayOrigin;
		float lightDistSq = dot( toLight, toLight );
		float dist = sqrt( lightDistSq );

		vec3 direction = toLight / max( dist, EPSILON );
		float cosTheta = dot( direction, normal );

		float spotAttenuation = light.iesProfile != - 1 ?
			getPhotometricAttenuation( iesProfiles, light.iesProfile, direction, normal, u, v ) :
			getSpotAttenuation( light.coneCos, light.penumbraCos, cosTheta );

		float distanceAttenuation = getDistanceAttenuation( dist, light.distance, light.decay );
		LightRecord lightRec;
		lightRec.type = light.type;
		lightRec.dist = dist;
		lightRec.direction = direction;
		lightRec.emission = light.color * light.intensity * distanceAttenuation * spotAttenuation;
		lightRec.pdf = 1.0;

		return lightRec;

	}

	LightRecord randomLightSample( sampler2D lights, sampler2DArray iesProfiles, uint lightCount, vec3 rayOrigin, vec3 ruv ) {

		LightRecord result;

		// pick a random light
		uint l = uint( ruv.x * float( lightCount ) );
		Light light = readLightInfo( lights, l );

		if ( light.type == SPOT_LIGHT_TYPE ) {

			result = randomSpotLightSample( light, iesProfiles, rayOrigin, ruv.yz );

		} else if ( light.type == POINT_LIGHT_TYPE ) {

			vec3 lightRay = light.u - rayOrigin;
			float lightDist = length( lightRay );
			float cutoffDistance = light.distance;
			float distanceFalloff = 1.0 / max( pow( lightDist, light.decay ), 0.01 );
			if ( cutoffDistance > 0.0 ) {

				distanceFalloff *= pow2( saturate( 1.0 - pow4( lightDist / cutoffDistance ) ) );

			}

			LightRecord rec;
			rec.direction = normalize( lightRay );
			rec.dist = length( lightRay );
			rec.pdf = 1.0;
			rec.emission = light.color * light.intensity * distanceFalloff;
			rec.type = light.type;
			result = rec;

		} else if ( light.type == DIR_LIGHT_TYPE ) {

			LightRecord rec;
			rec.dist = 1e10;
			rec.direction = light.u;
			rec.pdf = 1.0;
			rec.emission = light.color * light.intensity;
			rec.type = light.type;

			result = rec;

		} else {

			// sample the light
			result = randomAreaLightSample( light, rayOrigin, ruv.yz );

		}

		return result;

	}

`;

	const shape_sampling_functions = /* glsl */`

	vec3 sampleHemisphere( vec3 n, vec2 uv ) {

		// https://www.rorydriscoll.com/2009/01/07/better-sampling/
		// https://graphics.pixar.com/library/OrthonormalB/paper.pdf
		float sign = n.z == 0.0 ? 1.0 : sign( n.z );
		float a = - 1.0 / ( sign + n.z );
		float b = n.x * n.y * a;
		vec3 b1 = vec3( 1.0 + sign * n.x * n.x * a, sign * b, - sign * n.x );
		vec3 b2 = vec3( b, sign + n.y * n.y * a, - n.y );

		float r = sqrt( uv.x );
		float theta = 2.0 * PI * uv.y;
		float x = r * cos( theta );
		float y = r * sin( theta );
		return x * b1 + y * b2 + sqrt( 1.0 - uv.x ) * n;

	}

	vec2 sampleTriangle( vec2 a, vec2 b, vec2 c, vec2 r ) {

		// get the edges of the triangle and the diagonal across the
		// center of the parallelogram
		vec2 e1 = a - b;
		vec2 e2 = c - b;
		vec2 diag = normalize( e1 + e2 );

		// pick the point in the parallelogram
		if ( r.x + r.y > 1.0 ) {

			r = vec2( 1.0 ) - r;

		}

		return e1 * r.x + e2 * r.y;

	}

	vec2 sampleCircle( vec2 uv ) {

		float angle = 2.0 * PI * uv.x;
		float radius = sqrt( uv.y );
		return vec2( cos( angle ), sin( angle ) ) * radius;

	}

	vec3 sampleSphere( vec2 uv ) {

		float u = ( uv.x - 0.5 ) * 2.0;
		float t = uv.y * PI * 2.0;
		float f = sqrt( 1.0 - u * u );

		return vec3( f * cos( t ), f * sin( t ), u );

	}

	vec2 sampleRegularPolygon( int sides, vec3 uvw ) {

		sides = max( sides, 3 );

		vec3 r = uvw;
		float anglePerSegment = 2.0 * PI / float( sides );
		float segment = floor( float( sides ) * r.x );

		float angle1 = anglePerSegment * segment;
		float angle2 = angle1 + anglePerSegment;
		vec2 a = vec2( sin( angle1 ), cos( angle1 ) );
		vec2 b = vec2( 0.0, 0.0 );
		vec2 c = vec2( sin( angle2 ), cos( angle2 ) );

		return sampleTriangle( a, b, c, r.yz );

	}

	// samples an aperture shape with the given number of sides. 0 means circle
	vec2 sampleAperture( int blades, vec3 uvw ) {

		return blades == 0 ?
			sampleCircle( uvw.xy ) :
			sampleRegularPolygon( blades, uvw );

	}


`;

	const fresnel_functions = /* glsl */`

	bool totalInternalReflection( float cosTheta, float eta ) {

		float sinTheta = sqrt( 1.0 - cosTheta * cosTheta );
		return eta * sinTheta > 1.0;

	}

	// https://google.github.io/filament/Filament.md.html#materialsystem/diffusebrdf
	float schlickFresnel( float cosine, float f0 ) {

		return f0 + ( 1.0 - f0 ) * pow( 1.0 - cosine, 5.0 );

	}

	vec3 schlickFresnel( float cosine, vec3 f0 ) {

		return f0 + ( 1.0 - f0 ) * pow( 1.0 - cosine, 5.0 );

	}

	vec3 schlickFresnel( float cosine, vec3 f0, vec3 f90 ) {

		return f0 + ( f90 - f0 ) * pow( 1.0 - cosine, 5.0 );

	}

	float dielectricFresnel( float cosThetaI, float eta ) {

		// https://schuttejoe.github.io/post/disneybsdf/
		float ni = eta;
		float nt = 1.0;

		// Check for total internal reflection
		float sinThetaISq = 1.0f - cosThetaI * cosThetaI;
		float sinThetaTSq = eta * eta * sinThetaISq;
		if( sinThetaTSq >= 1.0 ) {

			return 1.0;

		}

		float sinThetaT = sqrt( sinThetaTSq );

		float cosThetaT = sqrt( max( 0.0, 1.0f - sinThetaT * sinThetaT ) );
		float rParallel = ( ( nt * cosThetaI ) - ( ni * cosThetaT ) ) / ( ( nt * cosThetaI ) + ( ni * cosThetaT ) );
		float rPerpendicular = ( ( ni * cosThetaI ) - ( nt * cosThetaT ) ) / ( ( ni * cosThetaI ) + ( nt * cosThetaT ) );
		return ( rParallel * rParallel + rPerpendicular * rPerpendicular ) / 2.0;

	}

	// https://raytracing.github.io/books/RayTracingInOneWeekend.html#dielectrics/schlickapproximation
	float iorRatioToF0( float eta ) {

		return pow( ( 1.0 - eta ) / ( 1.0 + eta ), 2.0 );

	}

	vec3 evaluateFresnel( float cosTheta, float eta, vec3 f0, vec3 f90 ) {

		if ( totalInternalReflection( cosTheta, eta ) ) {

			return f90;

		}

		return schlickFresnel( cosTheta, f0, f90 );

	}

	// TODO: disney fresnel was removed and replaced with this fresnel function to better align with
	// the glTF but is causing blown out pixels. Should be revisited
	// float evaluateFresnelWeight( float cosTheta, float eta, float f0 ) {

	// 	if ( totalInternalReflection( cosTheta, eta ) ) {

	// 		return 1.0;

	// 	}

	// 	return schlickFresnel( cosTheta, f0 );

	// }

	// https://schuttejoe.github.io/post/disneybsdf/
	float disneyFresnel( vec3 wo, vec3 wi, vec3 wh, float f0, float eta, float metalness ) {

		float dotHV = dot( wo, wh );
		if ( totalInternalReflection( dotHV, eta ) ) {

			return 1.0;

		}

		float dotHL = dot( wi, wh );
		float dielectricFresnel = dielectricFresnel( abs( dotHV ), eta );
		float metallicFresnel = schlickFresnel( dotHL, f0 );

		return mix( dielectricFresnel, metallicFresnel, metalness );

	}

`;

	const math_functions = /* glsl */`

	// Fast arccos approximation used to remove banding artifacts caused by numerical errors in acos.
	// This is a cubic Lagrange interpolating polynomial for x = [-1, -1/2, 0, 1/2, 1].
	// For more information see: https://github.com/gkjohnson/three-gpu-pathtracer/pull/171#issuecomment-1152275248
	float acosApprox( float x ) {

		x = clamp( x, -1.0, 1.0 );
		return ( - 0.69813170079773212 * x * x - 0.87266462599716477 ) * x + 1.5707963267948966;

	}

	// An acos with input values bound to the range [-1, 1].
	float acosSafe( float x ) {

		return acos( clamp( x, -1.0, 1.0 ) );

	}

	float saturateCos( float val ) {

		return clamp( val, 0.001, 1.0 );

	}

	float square( float t ) {

		return t * t;

	}

	vec2 square( vec2 t ) {

		return t * t;

	}

	vec3 square( vec3 t ) {

		return t * t;

	}

	vec4 square( vec4 t ) {

		return t * t;

	}

	vec2 rotateVector( vec2 v, float t ) {

		float ac = cos( t );
		float as = sin( t );
		return vec2(
			v.x * ac - v.y * as,
			v.x * as + v.y * ac
		);

	}

	// forms a basis with the normal vector as Z
	mat3 getBasisFromNormal( vec3 normal ) {

		vec3 other;
		if ( abs( normal.x ) > 0.5 ) {

			other = vec3( 0.0, 1.0, 0.0 );

		} else {

			other = vec3( 1.0, 0.0, 0.0 );

		}

		vec3 ortho = normalize( cross( normal, other ) );
		vec3 ortho2 = normalize( cross( normal, ortho ) );
		return mat3( ortho2, ortho, normal );

	}

`;

	const shape_intersection_functions = /* glsl */`

	// Finds the point where the ray intersects the plane defined by u and v and checks if this point
	// falls in the bounds of the rectangle on that same plane.
	// Plane intersection: https://lousodrome.net/blog/light/2020/07/03/intersection-of-a-ray-and-a-plane/
	bool intersectsRectangle( vec3 center, vec3 normal, vec3 u, vec3 v, vec3 rayOrigin, vec3 rayDirection, inout float dist ) {

		float t = dot( center - rayOrigin, normal ) / dot( rayDirection, normal );

		if ( t > EPSILON ) {

			vec3 p = rayOrigin + rayDirection * t;
			vec3 vi = p - center;

			// check if p falls inside the rectangle
			float a1 = dot( u, vi );
			if ( abs( a1 ) <= 0.5 ) {

				float a2 = dot( v, vi );
				if ( abs( a2 ) <= 0.5 ) {

					dist = t;
					return true;

				}

			}

		}

		return false;

	}

	// Finds the point where the ray intersects the plane defined by u and v and checks if this point
	// falls in the bounds of the circle on that same plane. See above URL for a description of the plane intersection algorithm.
	bool intersectsCircle( vec3 position, vec3 normal, vec3 u, vec3 v, vec3 rayOrigin, vec3 rayDirection, inout float dist ) {

		float t = dot( position - rayOrigin, normal ) / dot( rayDirection, normal );

		if ( t > EPSILON ) {

			vec3 hit = rayOrigin + rayDirection * t;
			vec3 vi = hit - position;

			float a1 = dot( u, vi );
			float a2 = dot( v, vi );

			if( length( vec2( a1, a2 ) ) <= 0.5 ) {

				dist = t;
				return true;

			}

		}

		return false;

	}

`;

	const texture_sample_functions = /*glsl */`

	// add texel fetch functions for texture arrays
	vec4 texelFetch1D( sampler2DArray tex, int layer, uint index ) {

		uint width = uint( textureSize( tex, 0 ).x );
		uvec2 uv;
		uv.x = index % width;
		uv.y = index / width;

		return texelFetch( tex, ivec3( uv, layer ), 0 );

	}

	vec4 textureSampleBarycoord( sampler2DArray tex, int layer, vec3 barycoord, uvec3 faceIndices ) {

		return
			barycoord.x * texelFetch1D( tex, layer, faceIndices.x ) +
			barycoord.y * texelFetch1D( tex, layer, faceIndices.y ) +
			barycoord.z * texelFetch1D( tex, layer, faceIndices.z );

	}

`;

	const util_functions = /* glsl */`

	// TODO: possibly this should be renamed something related to material or path tracing logic

	#ifndef RAY_OFFSET
	#define RAY_OFFSET 1e-4
	#endif

	// adjust the hit point by the surface normal by a factor of some offset and the
	// maximum component-wise value of the current point to accommodate floating point
	// error as values increase.
	vec3 stepRayOrigin( vec3 rayOrigin, vec3 rayDirection, vec3 offset, float dist ) {

		vec3 point = rayOrigin + rayDirection * dist;
		vec3 absPoint = abs( point );
		float maxPoint = max( absPoint.x, max( absPoint.y, absPoint.z ) );
		return point + offset * ( maxPoint + 1.0 ) * RAY_OFFSET;

	}

	// https://github.com/KhronosGroup/glTF/blob/main/extensions/2.0/Khronos/KHR_materials_volume/README.md#attenuation
	vec3 transmissionAttenuation( float dist, vec3 attColor, float attDist ) {

		vec3 ot = - log( attColor ) / attDist;
		return exp( - ot * dist );

	}

	vec3 getHalfVector( vec3 wi, vec3 wo, float eta ) {

		// get the half vector - assuming if the light incident vector is on the other side
		// of the that it's transmissive.
		vec3 h;
		if ( wi.z > 0.0 ) {

			h = normalize( wi + wo );

		} else {

			// Scale by the ior ratio to retrieve the appropriate half vector
			// From Section 2.2 on computing the transmission half vector:
			// https://blog.selfshadow.com/publications/s2015-shading-course/burley/s2015_pbs_disney_bsdf_notes.pdf
			h = normalize( wi + wo * eta );

		}

		h *= sign( h.z );
		return h;

	}

	vec3 getHalfVector( vec3 a, vec3 b ) {

		return normalize( a + b );

	}

	// The discrepancy between interpolated surface normal and geometry normal can cause issues when a ray
	// is cast that is on the top side of the geometry normal plane but below the surface normal plane. If
	// we find a ray like that we ignore it to avoid artifacts.
	// This function returns if the direction is on the same side of both planes.
	bool isDirectionValid( vec3 direction, vec3 surfaceNormal, vec3 geometryNormal ) {

		bool aboveSurfaceNormal = dot( direction, surfaceNormal ) > 0.0;
		bool aboveGeometryNormal = dot( direction, geometryNormal ) > 0.0;
		return aboveSurfaceNormal == aboveGeometryNormal;

	}

	// ray sampling x and z are swapped to align with expected background view
	vec2 equirectDirectionToUv( vec3 direction ) {

		// from Spherical.setFromCartesianCoords
		vec2 uv = vec2( atan( direction.z, direction.x ), acos( direction.y ) );
		uv /= vec2( 2.0 * PI, PI );

		// apply adjustments to get values in range [0, 1] and y right side up
		uv.x += 0.5;
		uv.y = 1.0 - uv.y;
		return uv;

	}

	vec3 equirectUvToDirection( vec2 uv ) {

		// undo above adjustments
		uv.x -= 0.5;
		uv.y = 1.0 - uv.y;

		// from Vector3.setFromSphericalCoords
		float theta = uv.x * 2.0 * PI;
		float phi = uv.y * PI;

		float sinPhi = sin( phi );

		return vec3( sinPhi * cos( theta ), cos( phi ), sinPhi * sin( theta ) );

	}

	// power heuristic for multiple importance sampling
	float misHeuristic( float a, float b ) {

		float aa = a * a;
		float bb = b * b;
		return aa / ( aa + bb );

	}

	// tentFilter from Peter Shirley's 'Realistic Ray Tracing (2nd Edition)' book, pg. 60
	// erichlof/THREE.js-PathTracing-Renderer/
	float tentFilter( float x ) {

		return x < 0.5 ? sqrt( 2.0 * x ) - 1.0 : 1.0 - sqrt( 2.0 - ( 2.0 * x ) );

	}
`;

	const pcg_functions = /* glsl */`

	// https://www.shadertoy.com/view/wltcRS
	uvec4 WHITE_NOISE_SEED;

	void rng_initialize( vec2 p, int frame ) {

		// white noise seed
		WHITE_NOISE_SEED = uvec4( p, uint( frame ), uint( p.x ) + uint( p.y ) );

	}

	// https://www.pcg-random.org/
	void pcg4d( inout uvec4 v ) {

		v = v * 1664525u + 1013904223u;
		v.x += v.y * v.w;
		v.y += v.z * v.x;
		v.z += v.x * v.y;
		v.w += v.y * v.z;
		v = v ^ ( v >> 16u );
		v.x += v.y*v.w;
		v.y += v.z*v.x;
		v.z += v.x*v.y;
		v.w += v.y*v.z;

	}

	// returns [ 0, 1 ]
	float pcgRand() {

		pcg4d( WHITE_NOISE_SEED );
		return float( WHITE_NOISE_SEED.x ) / float( 0xffffffffu );

	}

	vec2 pcgRand2() {

		pcg4d( WHITE_NOISE_SEED );
		return vec2( WHITE_NOISE_SEED.xy ) / float(0xffffffffu);

	}

	vec3 pcgRand3() {

		pcg4d( WHITE_NOISE_SEED );
		return vec3( WHITE_NOISE_SEED.xyz ) / float( 0xffffffffu );

	}

	vec4 pcgRand4() {

		pcg4d( WHITE_NOISE_SEED );
		return vec4( WHITE_NOISE_SEED ) / float( 0xffffffffu );

	}
`;

	const stratified_functions = /* glsl */`

	uniform sampler2D stratifiedTexture;
	uniform sampler2D stratifiedOffsetTexture;

	uint sobolPixelIndex = 0u;
	uint sobolPathIndex = 0u;
	uint sobolBounceIndex = 0u;
	vec4 pixelSeed = vec4( 0 );

	vec4 rand4( int v ) {

		ivec2 uv = ivec2( v, sobolBounceIndex );
		vec4 stratifiedSample = texelFetch( stratifiedTexture, uv, 0 );
		return fract( stratifiedSample + pixelSeed.r ); // blue noise + stratified samples

	}

	vec3 rand3( int v ) {

		return rand4( v ).xyz;

	}

	vec2 rand2( int v ) {

		return rand4( v ).xy;

	}

	float rand( int v ) {

		return rand4( v ).x;

	}

	void rng_initialize( vec2 screenCoord, int frame ) {

		// tile the small noise texture across the entire screen
		ivec2 noiseSize = ivec2( textureSize( stratifiedOffsetTexture, 0 ) );
		ivec2 pixel = ivec2( screenCoord.xy ) % noiseSize;
		vec2 pixelWidth = 1.0 / vec2( noiseSize );
		vec2 uv = vec2( pixel ) * pixelWidth + pixelWidth * 0.5;

		// note that using "texelFetch" here seems to break Android for some reason
		pixelSeed = texture( stratifiedOffsetTexture, uv );

	}

`;

	/*
	wi     : incident vector or light vector (pointing toward the light)
	wo     : outgoing vector or view vector (pointing towards the camera)
	wh     : computed half vector from wo and wi
	Eval   : Get the color and pdf for a direction
	Sample : Get the direction, color, and pdf for a sample
	eta    : Greek character used to denote the "ratio of ior"
	f0     : Amount of light reflected when looking at a surface head on - "fresnel 0"
	f90    : Amount of light reflected at grazing angles
	*/

	const bsdf_functions = /* glsl */`

	// diffuse
	float diffuseEval( vec3 wo, vec3 wi, vec3 wh, SurfaceRecord surf, inout vec3 color ) {

		// https://schuttejoe.github.io/post/disneybsdf/
		float fl = schlickFresnel( wi.z, 0.0 );
		float fv = schlickFresnel( wo.z, 0.0 );

		float metalFactor = ( 1.0 - surf.metalness );
		float transFactor = ( 1.0 - surf.transmission );
		float rr = 0.5 + 2.0 * surf.roughness * fl * fl;
		float retro = rr * ( fl + fv + fl * fv * ( rr - 1.0f ) );
		float lambert = ( 1.0f - 0.5f * fl ) * ( 1.0f - 0.5f * fv );

		// TODO: subsurface approx?

		// float F = evaluateFresnelWeight( dot( wo, wh ), surf.eta, surf.f0 );
		float F = disneyFresnel( wo, wi, wh, surf.f0, surf.eta, surf.metalness );
		color = ( 1.0 - F ) * transFactor * metalFactor * wi.z * surf.color * ( retro + lambert ) / PI;

		return wi.z / PI;

	}

	vec3 diffuseDirection( vec3 wo, SurfaceRecord surf ) {

		vec3 lightDirection = sampleSphere( rand2( 11 ) );
		lightDirection.z += 1.0;
		lightDirection = normalize( lightDirection );

		return lightDirection;

	}

	// specular
	float specularEval( vec3 wo, vec3 wi, vec3 wh, SurfaceRecord surf, inout vec3 color ) {

		// if roughness is set to 0 then D === NaN which results in black pixels
		float metalness = surf.metalness;
		float roughness = surf.filteredRoughness;

		float eta = surf.eta;
		float f0 = surf.f0;

		vec3 f0Color = mix( f0 * surf.specularColor * surf.specularIntensity, surf.color, surf.metalness );
		vec3 f90Color = vec3( mix( surf.specularIntensity, 1.0, surf.metalness ) );
		vec3 F = evaluateFresnel( dot( wo, wh ), eta, f0Color, f90Color );

		vec3 iridescenceF = evalIridescence( 1.0, surf.iridescenceIor, dot( wi, wh ), surf.iridescenceThickness, f0Color );
		F = mix( F, iridescenceF,  surf.iridescence );

		// PDF
		// See 14.1.1 Microfacet BxDFs in https://www.pbr-book.org/
		float incidentTheta = acos( wo.z );
		float G = ggxShadowMaskG2( wi, wo, roughness );
		float D = ggxDistribution( wh, roughness );
		float G1 = ggxShadowMaskG1( incidentTheta, roughness );
		float denomZ = max( abs( wo.z ), 1e-7 );
		float ggxPdf = D * G1 * max( 0.0, abs( dot( wo, wh ) ) ) / denomZ;

		color = wi.z * F * G * D / max( 4.0 * abs( wi.z * wo.z ), 1e-7 );
		return ggxPdf / max( 4.0 * abs( dot( wo, wh ) ), 1e-7 );

	}

	vec3 specularDirection( vec3 wo, SurfaceRecord surf ) {

		// sample ggx vndf distribution which gives a new normal
		float roughness = surf.filteredRoughness;
		vec3 halfVector = ggxDirection(
			wo,
			vec2( roughness ),
			rand2( 12 )
		);

		// apply to new ray by reflecting off the new normal
		return - reflect( wo, halfVector );

	}


	// transmission
	/*
	float transmissionEval( vec3 wo, vec3 wi, vec3 wh, SurfaceRecord surf, inout vec3 color ) {

		// See section 4.2 in https://www.cs.cornell.edu/~srm/publications/EGSR07-btdf.pdf

		float filteredRoughness = surf.filteredRoughness;
		float eta = surf.eta;
		bool frontFace = surf.frontFace;
		bool thinFilm = surf.thinFilm;

		color = surf.transmission * surf.color;

		float denom = pow( eta * dot( wi, wh ) + dot( wo, wh ), 2.0 );
		return ggxPDF( wo, wh, filteredRoughness ) / max( denom, 1e-7 );

	}

	vec3 transmissionDirection( vec3 wo, SurfaceRecord surf ) {

		float filteredRoughness = surf.filteredRoughness;
		float eta = surf.eta;
		bool frontFace = surf.frontFace;

		// sample ggx vndf distribution which gives a new normal
		vec3 halfVector = ggxDirection(
			wo,
			vec2( filteredRoughness ),
			rand2( 13 )
		);

		vec3 lightDirection = refract( normalize( - wo ), halfVector, eta );
		if ( surf.thinFilm ) {

			lightDirection = - refract( normalize( - lightDirection ), - vec3( 0.0, 0.0, 1.0 ), 1.0 / eta );

		}

		return normalize( lightDirection );

	}
	*/

	// TODO: This is just using a basic cosine-weighted specular distribution with an
	// incorrect PDF value at the moment. Update it to correctly use a GGX distribution
	float transmissionEval( vec3 wo, vec3 wi, vec3 wh, SurfaceRecord surf, inout vec3 color ) {

		color = surf.transmission * surf.color;

		// PDF
		// float F = evaluateFresnelWeight( dot( wo, wh ), surf.eta, surf.f0 );
		// float F = disneyFresnel( wo, wi, wh, surf.f0, surf.eta, surf.metalness );
		// if ( F >= 1.0 ) {

		// 	return 0.0;

		// }

		// return 1.0 / ( 1.0 - F );

		// reverted to previous to transmission. The above was causing black pixels
		float eta = surf.eta;
		float f0 = surf.f0;
		float cosTheta = min( wo.z, 1.0 );
		float sinTheta = sqrt( 1.0 - cosTheta * cosTheta );
		float reflectance = schlickFresnel( cosTheta, f0 );
		bool cannotRefract = eta * sinTheta > 1.0;
		if ( cannotRefract ) {

			return 0.0;

		}

		return 1.0 / ( 1.0 - reflectance );

	}

	vec3 transmissionDirection( vec3 wo, SurfaceRecord surf ) {

		float roughness = surf.filteredRoughness;
		float eta = surf.eta;
		vec3 halfVector = normalize( vec3( 0.0, 0.0, 1.0 ) + sampleSphere( rand2( 13 ) ) * roughness );
		vec3 lightDirection = refract( normalize( - wo ), halfVector, eta );

		if ( surf.thinFilm ) {

			lightDirection = - refract( normalize( - lightDirection ), - vec3( 0.0, 0.0, 1.0 ), 1.0 / eta );

		}
		return normalize( lightDirection );

	}

	// clearcoat
	float clearcoatEval( vec3 wo, vec3 wi, vec3 wh, SurfaceRecord surf, inout vec3 color ) {

		float ior = 1.5;
		float f0 = iorRatioToF0( ior );
		bool frontFace = surf.frontFace;
		float roughness = surf.filteredClearcoatRoughness;

		float eta = frontFace ? 1.0 / ior : ior;
		float G = ggxShadowMaskG2( wi, wo, roughness );
		float D = ggxDistribution( wh, roughness );
		float F = schlickFresnel( dot( wi, wh ), f0 );

		float fClearcoat = F * D * G / ( 4.0 * abs( wi.z * wo.z ) );
		color = color * ( 1.0 - surf.clearcoat * F ) + fClearcoat * surf.clearcoat * wi.z;

		// PDF
		// See equation (27) in http://jcgt.org/published/0003/02/03/
		return ggxPDF( wo, wh, roughness ) / ( 4.0 * dot( wi, wh ) );

	}

	vec3 clearcoatDirection( vec3 wo, SurfaceRecord surf ) {

		// sample ggx vndf distribution which gives a new normal
		float roughness = surf.filteredClearcoatRoughness;
		vec3 halfVector = ggxDirection(
			wo,
			vec2( roughness ),
			rand2( 14 )
		);

		// apply to new ray by reflecting off the new normal
		return - reflect( wo, halfVector );

	}

	// sheen
	vec3 sheenColor( vec3 wo, vec3 wi, vec3 wh, SurfaceRecord surf ) {

		float cosThetaO = saturateCos( wo.z );
		float cosThetaI = saturateCos( wi.z );
		float cosThetaH = wh.z;

		float D = velvetD( cosThetaH, surf.sheenRoughness );
		float G = velvetG( cosThetaO, cosThetaI, surf.sheenRoughness );

		// See equation (1) in http://www.aconty.com/pdf/s2017_pbs_imageworks_sheen.pdf
		vec3 color = surf.sheenColor;
		color *= D * G / ( 4.0 * abs( cosThetaO * cosThetaI ) );
		color *= wi.z;

		return color;

	}

	// bsdf
	void getLobeWeights(
		vec3 wo, vec3 wi, vec3 wh, vec3 clearcoatWo, SurfaceRecord surf,
		inout float diffuseWeight, inout float specularWeight, inout float transmissionWeight, inout float clearcoatWeight
	) {

		float metalness = surf.metalness;
		float transmission = surf.transmission;
		// float fEstimate = evaluateFresnelWeight( dot( wo, wh ), surf.eta, surf.f0 );
		float fEstimate = disneyFresnel( wo, wi, wh, surf.f0, surf.eta, surf.metalness );

		float transSpecularProb = mix( max( 0.25, fEstimate ), 1.0, metalness );
		float diffSpecularProb = 0.5 + 0.5 * metalness;

		diffuseWeight = ( 1.0 - transmission ) * ( 1.0 - diffSpecularProb );
		specularWeight = transmission * transSpecularProb + ( 1.0 - transmission ) * diffSpecularProb;
		transmissionWeight = transmission * ( 1.0 - transSpecularProb );
		clearcoatWeight = surf.clearcoat * schlickFresnel( clearcoatWo.z, 0.04 );

		float totalWeight = diffuseWeight + specularWeight + transmissionWeight + clearcoatWeight;
		diffuseWeight /= totalWeight;
		specularWeight /= totalWeight;
		transmissionWeight /= totalWeight;
		clearcoatWeight /= totalWeight;
	}

	float bsdfEval(
		vec3 wo, vec3 clearcoatWo, vec3 wi, vec3 clearcoatWi, SurfaceRecord surf,
		float diffuseWeight, float specularWeight, float transmissionWeight, float clearcoatWeight, inout float specularPdf, inout vec3 color
	) {

		float metalness = surf.metalness;
		float transmission = surf.transmission;

		float spdf = 0.0;
		float dpdf = 0.0;
		float tpdf = 0.0;
		float cpdf = 0.0;
		color = vec3( 0.0 );

		vec3 halfVector = getHalfVector( wi, wo, surf.eta );

		// diffuse
		if ( diffuseWeight > 0.0 && wi.z > 0.0 ) {

			dpdf = diffuseEval( wo, wi, halfVector, surf, color );
			color *= 1.0 - surf.transmission;

		}

		// ggx specular
		if ( specularWeight > 0.0 && wi.z > 0.0 ) {

			vec3 outColor;
			spdf = specularEval( wo, wi, getHalfVector( wi, wo ), surf, outColor );
			color += outColor;

		}

		// transmission
		if ( transmissionWeight > 0.0 && wi.z < 0.0 ) {

			tpdf = transmissionEval( wo, wi, halfVector, surf, color );

		}

		// sheen
		color *= mix( 1.0, sheenAlbedoScaling( wo, wi, surf ), surf.sheen );
		color += sheenColor( wo, wi, halfVector, surf ) * surf.sheen;

		// clearcoat
		if ( clearcoatWi.z >= 0.0 && clearcoatWeight > 0.0 ) {

			vec3 clearcoatHalfVector = getHalfVector( clearcoatWo, clearcoatWi );
			cpdf = clearcoatEval( clearcoatWo, clearcoatWi, clearcoatHalfVector, surf, color );

		}

		float pdf =
			dpdf * diffuseWeight
			+ spdf * specularWeight
			+ tpdf * transmissionWeight
			+ cpdf * clearcoatWeight;

		// retrieve specular rays for the shadows flag
		specularPdf = spdf * specularWeight + cpdf * clearcoatWeight;

		return pdf;

	}

	float bsdfResult( vec3 worldWo, vec3 worldWi, SurfaceRecord surf, inout vec3 color ) {

		if ( surf.volumeParticle ) {

			color = surf.color / ( 4.0 * PI );
			return 1.0 / ( 4.0 * PI );

		}

		vec3 wo = normalize( surf.normalInvBasis * worldWo );
		vec3 wi = normalize( surf.normalInvBasis * worldWi );

		vec3 clearcoatWo = normalize( surf.clearcoatInvBasis * worldWo );
		vec3 clearcoatWi = normalize( surf.clearcoatInvBasis * worldWi );

		vec3 wh = getHalfVector( wo, wi, surf.eta );
		float diffuseWeight;
		float specularWeight;
		float transmissionWeight;
		float clearcoatWeight;
		getLobeWeights( wo, wi, wh, clearcoatWo, surf, diffuseWeight, specularWeight, transmissionWeight, clearcoatWeight );

		float specularPdf;
		return bsdfEval( wo, clearcoatWo, wi, clearcoatWi, surf, diffuseWeight, specularWeight, transmissionWeight, clearcoatWeight, specularPdf, color );

	}

	ScatterRecord bsdfSample( vec3 worldWo, SurfaceRecord surf ) {

		if ( surf.volumeParticle ) {

			ScatterRecord sampleRec;
			sampleRec.specularPdf = 0.0;
			sampleRec.pdf = 1.0 / ( 4.0 * PI );
			sampleRec.direction = sampleSphere( rand2( 16 ) );
			sampleRec.color = surf.color / ( 4.0 * PI );
			return sampleRec;

		}

		vec3 wo = normalize( surf.normalInvBasis * worldWo );
		vec3 clearcoatWo = normalize( surf.clearcoatInvBasis * worldWo );
		mat3 normalBasis = surf.normalBasis;
		mat3 invBasis = surf.normalInvBasis;
		mat3 clearcoatNormalBasis = surf.clearcoatBasis;
		mat3 clearcoatInvBasis = surf.clearcoatInvBasis;

		float diffuseWeight;
		float specularWeight;
		float transmissionWeight;
		float clearcoatWeight;
		// using normal and basically-reflected ray since we don't have proper half vector here
		getLobeWeights( wo, wo, vec3( 0, 0, 1 ), clearcoatWo, surf, diffuseWeight, specularWeight, transmissionWeight, clearcoatWeight );

		float pdf[4];
		pdf[0] = diffuseWeight;
		pdf[1] = specularWeight;
		pdf[2] = transmissionWeight;
		pdf[3] = clearcoatWeight;

		float cdf[4];
		cdf[0] = pdf[0];
		cdf[1] = pdf[1] + cdf[0];
		cdf[2] = pdf[2] + cdf[1];
		cdf[3] = pdf[3] + cdf[2];

		if( cdf[3] != 0.0 ) {

			float invMaxCdf = 1.0 / cdf[3];
			cdf[0] *= invMaxCdf;
			cdf[1] *= invMaxCdf;
			cdf[2] *= invMaxCdf;
			cdf[3] *= invMaxCdf;

		} else {

			cdf[0] = 1.0;
			cdf[1] = 0.0;
			cdf[2] = 0.0;
			cdf[3] = 0.0;

		}

		vec3 wi;
		vec3 clearcoatWi;

		float r = rand( 15 );
		if ( r <= cdf[0] ) { // diffuse

			wi = diffuseDirection( wo, surf );
			clearcoatWi = normalize( clearcoatInvBasis * normalize( normalBasis * wi ) );

		} else if ( r <= cdf[1] ) { // specular

			wi = specularDirection( wo, surf );
			clearcoatWi = normalize( clearcoatInvBasis * normalize( normalBasis * wi ) );

		} else if ( r <= cdf[2] ) { // transmission / refraction

			wi = transmissionDirection( wo, surf );
			clearcoatWi = normalize( clearcoatInvBasis * normalize( normalBasis * wi ) );

		} else if ( r <= cdf[3] ) { // clearcoat

			clearcoatWi = clearcoatDirection( clearcoatWo, surf );
			wi = normalize( invBasis * normalize( clearcoatNormalBasis * clearcoatWi ) );

		}

		ScatterRecord result;
		result.pdf = bsdfEval( wo, clearcoatWo, wi, clearcoatWi, surf, diffuseWeight, specularWeight, transmissionWeight, clearcoatWeight, result.specularPdf, result.color );
		result.direction = normalize( surf.normalBasis * wi );

		return result;

	}

`;

	const fog_functions = /* glsl */`

	// returns the hit distance given the material density
	float intersectFogVolume( Material material, float u ) {

		// https://raytracing.github.io/books/RayTracingTheNextWeek.html#volumes/constantdensitymediums
		return material.opacity == 0.0 ? INFINITY : ( - 1.0 / material.opacity ) * log( u );

	}

	ScatterRecord sampleFogVolume( SurfaceRecord surf, vec2 uv ) {

		ScatterRecord sampleRec;
		sampleRec.specularPdf = 0.0;
		sampleRec.pdf = 1.0 / ( 2.0 * PI );
		sampleRec.direction = sampleSphere( uv );
		sampleRec.color = surf.color;
		return sampleRec;

	}

`;

	const ggx_functions = /* glsl */`

	// The GGX functions provide sampling and distribution information for normals as output so
	// in order to get probability of scatter direction the half vector must be computed and provided.
	// [0] https://www.cs.cornell.edu/~srm/publications/EGSR07-btdf.pdf
	// [1] https://hal.archives-ouvertes.fr/hal-01509746/document
	// [2] http://jcgt.org/published/0007/04/01/
	// [4] http://jcgt.org/published/0003/02/03/

	// trowbridge-reitz === GGX === GTR

	vec3 ggxDirection( vec3 incidentDir, vec2 roughness, vec2 uv ) {

		// TODO: try GGXVNDF implementation from reference [2], here. Needs to update ggxDistribution
		// function below, as well

		// Implementation from reference [1]
		// stretch view
		vec3 V = normalize( vec3( roughness * incidentDir.xy, incidentDir.z ) );

		// orthonormal basis
		vec3 T1 = ( V.z < 0.9999 ) ? normalize( cross( V, vec3( 0.0, 0.0, 1.0 ) ) ) : vec3( 1.0, 0.0, 0.0 );
		vec3 T2 = cross( T1, V );

		// sample point with polar coordinates (r, phi)
		float a = 1.0 / ( 1.0 + V.z );
		float r = sqrt( uv.x );
		float phi = ( uv.y < a ) ? uv.y / a * PI : PI + ( uv.y - a ) / ( 1.0 - a ) * PI;
		float P1 = r * cos( phi );
		float P2 = r * sin( phi ) * ( ( uv.y < a ) ? 1.0 : V.z );

		// compute normal
		vec3 N = P1 * T1 + P2 * T2 + V * sqrt( max( 0.0, 1.0 - P1 * P1 - P2 * P2 ) );

		// unstretch
		N = normalize( vec3( roughness * N.xy, max( 0.0, N.z ) ) );

		return N;

	}

	// Below are PDF and related functions for use in a Monte Carlo path tracer
	// as specified in Appendix B of the following paper
	// See equation (34) from reference [0]
	float ggxLamda( float theta, float roughness ) {

		float tanTheta = tan( theta );
		float tanTheta2 = tanTheta * tanTheta;
		float alpha2 = roughness * roughness;

		float numerator = - 1.0 + sqrt( 1.0 + alpha2 * tanTheta2 );
		return numerator / 2.0;

	}

	// See equation (34) from reference [0]
	float ggxShadowMaskG1( float theta, float roughness ) {

		return 1.0 / ( 1.0 + ggxLamda( theta, roughness ) );

	}

	// See equation (125) from reference [4]
	float ggxShadowMaskG2( vec3 wi, vec3 wo, float roughness ) {

		float incidentTheta = acos( wi.z );
		float scatterTheta = acos( wo.z );
		return 1.0 / ( 1.0 + ggxLamda( incidentTheta, roughness ) + ggxLamda( scatterTheta, roughness ) );

	}

	// See equation (33) from reference [0]
	float ggxDistribution( vec3 halfVector, float roughness ) {

		float a2 = roughness * roughness;
		a2 = max( EPSILON, a2 );
		float cosTheta = halfVector.z;
		float cosTheta4 = pow( cosTheta, 4.0 );

		if ( cosTheta == 0.0 ) return 0.0;

		float theta = acosSafe( halfVector.z );
		float tanTheta = tan( theta );
		float tanTheta2 = pow( tanTheta, 2.0 );

		float denom = PI * cosTheta4 * pow( a2 + tanTheta2, 2.0 );
		return ( a2 / denom );

	}

	// See equation (3) from reference [2]
	float ggxPDF( vec3 wi, vec3 halfVector, float roughness ) {

		float incidentTheta = acos( wi.z );
		float D = ggxDistribution( halfVector, roughness );
		float G1 = ggxShadowMaskG1( incidentTheta, roughness );

		return D * G1 * max( 0.0, dot( wi, halfVector ) ) / max( abs( wi.z ), 1e-7 );

	}

`;

	const iridescence_functions = /* glsl */`

	// XYZ to sRGB color space
	const mat3 XYZ_TO_REC709 = mat3(
		3.2404542, -0.9692660,  0.0556434,
		-1.5371385,  1.8760108, -0.2040259,
		-0.4985314,  0.0415560,  1.0572252
	);

	vec3 fresnel0ToIor( vec3 fresnel0 ) {

		vec3 sqrtF0 = sqrt( fresnel0 );
		return ( vec3( 1.0 ) + sqrtF0 ) / ( vec3( 1.0 ) - sqrtF0 );

	}

	// Conversion FO/IOR
	vec3 iorToFresnel0( vec3 transmittedIor, float incidentIor ) {

		return square( ( transmittedIor - vec3( incidentIor ) ) / ( transmittedIor + vec3( incidentIor ) ) );

	}

	// ior is a value between 1.0 and 3.0. 1.0 is air interface
	float iorToFresnel0( float transmittedIor, float incidentIor ) {

		return square( ( transmittedIor - incidentIor ) / ( transmittedIor + incidentIor ) );

	}

	// Fresnel equations for dielectric/dielectric interfaces. See https://belcour.github.io/blog/research/2017/05/01/brdf-thin-film.html
	vec3 evalSensitivity( float OPD, vec3 shift ) {

		float phase = 2.0 * PI * OPD * 1.0e-9;

		vec3 val = vec3( 5.4856e-13, 4.4201e-13, 5.2481e-13 );
		vec3 pos = vec3( 1.6810e+06, 1.7953e+06, 2.2084e+06 );
		vec3 var = vec3( 4.3278e+09, 9.3046e+09, 6.6121e+09 );

		vec3 xyz = val * sqrt( 2.0 * PI * var ) * cos( pos * phase + shift ) * exp( - square( phase ) * var );
		xyz.x += 9.7470e-14 * sqrt( 2.0 * PI * 4.5282e+09 ) * cos( 2.2399e+06 * phase + shift[ 0 ] ) * exp( - 4.5282e+09 * square( phase ) );
		xyz /= 1.0685e-7;

		vec3 srgb = XYZ_TO_REC709 * xyz;
		return srgb;

	}

	// See Section 4. Analytic Spectral Integration, A Practical Extension to Microfacet Theory for the Modeling of Varying Iridescence, https://hal.archives-ouvertes.fr/hal-01518344/document
	vec3 evalIridescence( float outsideIOR, float eta2, float cosTheta1, float thinFilmThickness, vec3 baseF0 ) {

		vec3 I;

		// Force iridescenceIor -> outsideIOR when thinFilmThickness -> 0.0
		float iridescenceIor = mix( outsideIOR, eta2, smoothstep( 0.0, 0.03, thinFilmThickness ) );

		// Evaluate the cosTheta on the base layer (Snell law)
		float sinTheta2Sq = square( outsideIOR / iridescenceIor ) * ( 1.0 - square( cosTheta1 ) );

		// Handle TIR:
		float cosTheta2Sq = 1.0 - sinTheta2Sq;
		if ( cosTheta2Sq < 0.0 ) {

			return vec3( 1.0 );

		}

		float cosTheta2 = sqrt( cosTheta2Sq );

		// First interface
		float R0 = iorToFresnel0( iridescenceIor, outsideIOR );
		float R12 = schlickFresnel( cosTheta1, R0 );
		float R21 = R12;
		float T121 = 1.0 - R12;
		float phi12 = 0.0;
		if ( iridescenceIor < outsideIOR ) {

			phi12 = PI;

		}

		float phi21 = PI - phi12;

		// Second interface
		vec3 baseIOR = fresnel0ToIor( clamp( baseF0, 0.0, 0.9999 ) ); // guard against 1.0
		vec3 R1 = iorToFresnel0( baseIOR, iridescenceIor );
		vec3 R23 = schlickFresnel( cosTheta2, R1 );
		vec3 phi23 = vec3( 0.0 );
		if ( baseIOR[0] < iridescenceIor ) {

			phi23[ 0 ] = PI;

		}

		if ( baseIOR[1] < iridescenceIor ) {

			phi23[ 1 ] = PI;

		}

		if ( baseIOR[2] < iridescenceIor ) {

			phi23[ 2 ] = PI;

		}

		// Phase shift
		float OPD = 2.0 * iridescenceIor * thinFilmThickness * cosTheta2;
		vec3 phi = vec3( phi21 ) + phi23;

		// Compound terms
		vec3 R123 = clamp( R12 * R23, 1e-5, 0.9999 );
		vec3 r123 = sqrt( R123 );
		vec3 Rs = square( T121 ) * R23 / ( vec3( 1.0 ) - R123 );

		// Reflectance term for m = 0 (DC term amplitude)
		vec3 C0 = R12 + Rs;
		I = C0;

		// Reflectance term for m > 0 (pairs of diracs)
		vec3 Cm = Rs - T121;
		for ( int m = 1; m <= 2; ++ m ) {

			Cm *= r123;
			vec3 Sm = 2.0 * evalSensitivity( float( m ) * OPD, float( m ) * phi );
			I += Cm * Sm;

		}

		// Since out of gamut colors might be produced, negative color values are clamped to 0.
		return max( I, vec3( 0.0 ) );

	}

`;

	const sheen_functions = /* glsl */`

	// See equation (2) in http://www.aconty.com/pdf/s2017_pbs_imageworks_sheen.pdf
	float velvetD( float cosThetaH, float roughness ) {

		float alpha = max( roughness, 0.07 );
		alpha = alpha * alpha;

		float invAlpha = 1.0 / alpha;

		float sqrCosThetaH = cosThetaH * cosThetaH;
		float sinThetaH = max( 1.0 - sqrCosThetaH, 0.001 );

		return ( 2.0 + invAlpha ) * pow( sinThetaH, 0.5 * invAlpha ) / ( 2.0 * PI );

	}

	float velvetParamsInterpolate( int i, float oneMinusAlphaSquared ) {

		const float p0[5] = float[5]( 25.3245, 3.32435, 0.16801, -1.27393, -4.85967 );
		const float p1[5] = float[5]( 21.5473, 3.82987, 0.19823, -1.97760, -4.32054 );

		return mix( p1[i], p0[i], oneMinusAlphaSquared );

	}

	float velvetL( float x, float alpha ) {

		float oneMinusAlpha = 1.0 - alpha;
		float oneMinusAlphaSquared = oneMinusAlpha * oneMinusAlpha;

		float a = velvetParamsInterpolate( 0, oneMinusAlphaSquared );
		float b = velvetParamsInterpolate( 1, oneMinusAlphaSquared );
		float c = velvetParamsInterpolate( 2, oneMinusAlphaSquared );
		float d = velvetParamsInterpolate( 3, oneMinusAlphaSquared );
		float e = velvetParamsInterpolate( 4, oneMinusAlphaSquared );

		return a / ( 1.0 + b * pow( abs( x ), c ) ) + d * x + e;

	}

	// See equation (3) in http://www.aconty.com/pdf/s2017_pbs_imageworks_sheen.pdf
	float velvetLambda( float cosTheta, float alpha ) {

		return abs( cosTheta ) < 0.5 ? exp( velvetL( cosTheta, alpha ) ) : exp( 2.0 * velvetL( 0.5, alpha ) - velvetL( 1.0 - cosTheta, alpha ) );

	}

	// See Section 3, Shadowing Term, in http://www.aconty.com/pdf/s2017_pbs_imageworks_sheen.pdf
	float velvetG( float cosThetaO, float cosThetaI, float roughness ) {

		float alpha = max( roughness, 0.07 );
		alpha = alpha * alpha;

		return 1.0 / ( 1.0 + velvetLambda( cosThetaO, alpha ) + velvetLambda( cosThetaI, alpha ) );

	}

	float directionalAlbedoSheen( float cosTheta, float alpha ) {

		cosTheta = saturate( cosTheta );

		float c = 1.0 - cosTheta;
		float c3 = c * c * c;

		return 0.65584461 * c3 + 1.0 / ( 4.16526551 + exp( -7.97291361 * sqrt( alpha ) + 6.33516894 ) );

	}

	float sheenAlbedoScaling( vec3 wo, vec3 wi, SurfaceRecord surf ) {

		float alpha = max( surf.sheenRoughness, 0.07 );
		alpha = alpha * alpha;

		float maxSheenColor = max( max( surf.sheenColor.r, surf.sheenColor.g ), surf.sheenColor.b );

		float eWo = directionalAlbedoSheen( saturateCos( wo.z ), alpha );
		float eWi = directionalAlbedoSheen( saturateCos( wi.z ), alpha );

		return min( 1.0 - maxSheenColor * eWo, 1.0 - maxSheenColor * eWi );

	}

	// See Section 5, Layering, in http://www.aconty.com/pdf/s2017_pbs_imageworks_sheen.pdf
	float sheenAlbedoScaling( vec3 wo, SurfaceRecord surf ) {

		float alpha = max( surf.sheenRoughness, 0.07 );
		alpha = alpha * alpha;

		float maxSheenColor = max( max( surf.sheenColor.r, surf.sheenColor.g ), surf.sheenColor.b );

		float eWo = directionalAlbedoSheen( saturateCos( wo.z ), alpha );

		return 1.0 - maxSheenColor * eWo;

	}

`;

	const inside_fog_volume_function = /* glsl */`

#ifndef FOG_CHECK_ITERATIONS
#define FOG_CHECK_ITERATIONS 30
#endif

// returns whether the given material is a fog material or not
bool isMaterialFogVolume( sampler2D materials, uint materialIndex ) {

	uint i = materialIndex * uint( MATERIAL_PIXELS );
	vec4 s14 = texelFetch1D( materials, i + 14u );
	return bool( int( s14.b ) & 4 );

}

// returns true if we're within the first fog volume we hit
bool bvhIntersectFogVolumeHit(
	vec3 rayOrigin, vec3 rayDirection,
	usampler2D materialIndexAttribute, sampler2D materials,
	inout Material material
) {

	material.fogVolume = false;

	for ( int i = 0; i < FOG_CHECK_ITERATIONS; i ++ ) {

		// find nearest hit
		uvec4 faceIndices = uvec4( 0u );
		vec3 faceNormal = vec3( 0.0, 0.0, 1.0 );
		vec3 barycoord = vec3( 0.0 );
		float side = 1.0;
		float dist = 0.0;
		bool hit = bvhIntersectFirstHit( bvh, rayOrigin, rayDirection, faceIndices, faceNormal, barycoord, side, dist );
		if ( hit ) {

			// if it's a fog volume return whether we hit the front or back face
			uint materialIndex = uTexelFetch1D( materialIndexAttribute, faceIndices.x ).r;
			if ( isMaterialFogVolume( materials, materialIndex ) ) {

				material = readMaterialInfo( materials, materialIndex );
				return side == - 1.0;

			} else {

				// move the ray forward
				rayOrigin = stepRayOrigin( rayOrigin, rayDirection, - faceNormal, dist );

			}

		} else {

			return false;

		}

	}

	return false;

}

`;

	const ray_any_hit_function = /* glsl */`

	bool bvhIntersectAnyHit(
		vec3 rayOrigin, vec3 rayDirection,

		// output variables
		inout float side, inout float dist
	) {

		uvec4 faceIndices;
		vec3 faceNormal;
		vec3 barycoord;

		// stack needs to be twice as long as the deepest tree we expect because
		// we push both the left and right child onto the stack every traversal
		int ptr = 0;
		uint stack[ 60 ];
		stack[ 0 ] = 0u;

		float triangleDistance = 1e20;
		while ( ptr > - 1 && ptr < 60 ) {

			uint currNodeIndex = stack[ ptr ];
			ptr --;

			// check if we intersect the current bounds
			float boundsHitDistance = intersectsBVHNodeBounds( rayOrigin, rayDirection, bvh, currNodeIndex );
			if ( boundsHitDistance == INFINITY ) {

				continue;

			}

			uvec2 boundsInfo = uTexelFetch1D( bvh.bvhContents, currNodeIndex ).xy;
			bool isLeaf = bool( boundsInfo.x & 0xffff0000u );

			if ( isLeaf ) {

				uint count = boundsInfo.x & 0x0000ffffu;
				uint offset = boundsInfo.y;

				bool found = intersectTriangles(
					bvh, rayOrigin, rayDirection, offset, count, triangleDistance,
					faceIndices, faceNormal, barycoord, side, dist
				);

				if ( found ) {

					return true;

				}

			} else {

				uint leftIndex = currNodeIndex + 1u;
				uint splitAxis = boundsInfo.x & 0x0000ffffu;
				uint rightIndex = boundsInfo.y;

				// set c2 in the stack so we traverse it later. We need to keep track of a pointer in
				// the stack while we traverse. The second pointer added is the one that will be
				// traversed first
				ptr ++;
				stack[ ptr ] = leftIndex;

				ptr ++;
				stack[ ptr ] = rightIndex;

			}

		}

		return false;

	}

`;

	const attenuate_hit_function = /* glsl */`

	// step through multiple surface hits and accumulate color attenuation based on transmissive surfaces
	// returns true if a solid surface was hit
	bool attenuateHit(
		RenderState state,
		Ray ray, float rayDist,
		out vec3 color
	) {

		// store the original bounce index so we can reset it after
		uint originalBounceIndex = sobolBounceIndex;

		int traversals = state.traversals;
		int transmissiveTraversals = state.transmissiveTraversals;
		bool isShadowRay = state.isShadowRay;
		Material fogMaterial = state.fogMaterial;

		vec3 startPoint = ray.origin;

		// hit results
		SurfaceHit surfaceHit;

		color = vec3( 1.0 );

		bool result = true;
		for ( int i = 0; i < traversals; i ++ ) {

			sobolBounceIndex ++;

			int hitType = traceScene( ray, fogMaterial, surfaceHit );

			if ( hitType == FOG_HIT ) {

				result = true;
				break;

			} else if ( hitType == SURFACE_HIT ) {

				float totalDist = distance( startPoint, ray.origin + ray.direction * surfaceHit.dist );
				if ( totalDist > rayDist ) {

					result = false;
					break;

				}

				// TODO: attenuate the contribution based on the PDF of the resulting ray including refraction values
				// Should be able to work using the material BSDF functions which will take into account specularity, etc.
				// TODO: should we account for emissive surfaces here?

				uint materialIndex = uTexelFetch1D( materialIndexAttribute, surfaceHit.faceIndices.x ).r;
				Material material = readMaterialInfo( materials, materialIndex );

				// adjust the ray to the new surface
				bool isEntering = surfaceHit.side == 1.0;
				ray.origin = stepRayOrigin( ray.origin, ray.direction, - surfaceHit.faceNormal, surfaceHit.dist );

				#if FEATURE_FOG

				if ( material.fogVolume ) {

					fogMaterial = material;
					fogMaterial.fogVolume = surfaceHit.side == 1.0;
					i -= sign( transmissiveTraversals );
					transmissiveTraversals --;
					continue;

				}

				#endif

				if ( ! material.castShadow && isShadowRay ) {

					continue;

				}

				vec2 uv = textureSampleBarycoord( attributesArray, ATTR_UV, surfaceHit.barycoord, surfaceHit.faceIndices.xyz ).xy;
				vec4 vertexColor = textureSampleBarycoord( attributesArray, ATTR_COLOR, surfaceHit.barycoord, surfaceHit.faceIndices.xyz );

				// albedo
				vec4 albedo = vec4( material.color, material.opacity );
				if ( material.map != - 1 ) {

					vec3 uvPrime = material.mapTransform * vec3( uv, 1 );
					albedo *= texture2D( textures, vec3( uvPrime.xy, material.map ) );

				}

				if ( material.vertexColors ) {

					albedo *= vertexColor;

				}

				// alphaMap
				if ( material.alphaMap != - 1 ) {

					vec3 uvPrime = material.alphaMapTransform * vec3( uv, 1 );
					albedo.a *= texture2D( textures, vec3( uvPrime.xy, material.alphaMap ) ).x;

				}

				// transmission
				float transmission = material.transmission;
				if ( material.transmissionMap != - 1 ) {

					vec3 uvPrime = material.transmissionMapTransform * vec3( uv, 1 );
					transmission *= texture2D( textures, vec3( uvPrime.xy, material.transmissionMap ) ).r;

				}

				// metalness
				float metalness = material.metalness;
				if ( material.metalnessMap != - 1 ) {

					vec3 uvPrime = material.metalnessMapTransform * vec3( uv, 1 );
					metalness *= texture2D( textures, vec3( uvPrime.xy, material.metalnessMap ) ).b;

				}

				float alphaTest = material.alphaTest;
				bool useAlphaTest = alphaTest != 0.0;
				float transmissionFactor = ( 1.0 - metalness ) * transmission;
				if (
					transmissionFactor < rand( 9 ) && ! (
						// material sidedness
						material.side != 0.0 && surfaceHit.side == material.side

						// alpha test
						|| useAlphaTest && albedo.a < alphaTest

						// opacity
						|| material.transparent && ! useAlphaTest && albedo.a < rand( 10 )
					)
				) {

					result = true;
					break;

				}

				if ( surfaceHit.side == 1.0 && isEntering ) {

					// only attenuate by surface color on the way in
					color *= mix( vec3( 1.0 ), albedo.rgb, transmissionFactor );

				} else if ( surfaceHit.side == - 1.0 ) {

					// attenuate by medium once we hit the opposite side of the model
					color *= transmissionAttenuation( surfaceHit.dist, material.attenuationColor, material.attenuationDistance );

				}

				bool isTransmissiveRay = dot( ray.direction, surfaceHit.faceNormal * surfaceHit.side ) < 0.0;
				if ( ( isTransmissiveRay || isEntering ) && transmissiveTraversals > 0 ) {

					i -= sign( transmissiveTraversals );
					transmissiveTraversals --;

				}

			} else {

				result = false;
				break;

			}

		}

		// reset the bounce index
		sobolBounceIndex = originalBounceIndex;
		return result;

	}

`;

	const camera_util_functions = /* glsl */`

	vec3 ndcToRayOrigin( vec2 coord ) {

		vec4 rayOrigin4 = cameraWorldMatrix * invProjectionMatrix * vec4( coord, - 1.0, 1.0 );
		return rayOrigin4.xyz / rayOrigin4.w;
	}

	Ray getCameraRay() {

		vec2 ssd = vec2( 1.0 ) / resolution;

		// Jitter the camera ray by finding a uv coordinate at a random sample
		// around this pixel's UV coordinate for AA
		vec2 ruv = rand2( 0 );
		vec2 jitteredUv = vUv + vec2( tentFilter( ruv.x ) * ssd.x, tentFilter( ruv.y ) * ssd.y );
		Ray ray;

		#if CAMERA_TYPE == 2

			// Equirectangular projection
			vec4 rayDirection4 = vec4( equirectUvToDirection( jitteredUv ), 0.0 );
			vec4 rayOrigin4 = vec4( 0.0, 0.0, 0.0, 1.0 );

			rayDirection4 = cameraWorldMatrix * rayDirection4;
			rayOrigin4 = cameraWorldMatrix * rayOrigin4;

			ray.direction = normalize( rayDirection4.xyz );
			ray.origin = rayOrigin4.xyz / rayOrigin4.w;

		#else

			// get [- 1, 1] normalized device coordinates
			vec2 ndc = 2.0 * jitteredUv - vec2( 1.0 );
			ray.origin = ndcToRayOrigin( ndc );

			#if CAMERA_TYPE == 1

				// Orthographic projection
				ray.direction = ( cameraWorldMatrix * vec4( 0.0, 0.0, - 1.0, 0.0 ) ).xyz;
				ray.direction = normalize( ray.direction );

			#else

				// Perspective projection
				ray.direction = normalize( mat3( cameraWorldMatrix ) * ( invProjectionMatrix * vec4( ndc, 0.0, 1.0 ) ).xyz );

			#endif

		#endif

		#if FEATURE_DOF
		{

			// depth of field
			vec3 focalPoint = ray.origin + normalize( ray.direction ) * physicalCamera.focusDistance;

			// get the aperture sample
			// if blades === 0 then we assume a circle
			vec3 shapeUVW= rand3( 1 );
			int blades = physicalCamera.apertureBlades;
			float anamorphicRatio = physicalCamera.anamorphicRatio;
			vec2 apertureSample = sampleAperture( blades, shapeUVW );
			apertureSample *= physicalCamera.bokehSize * 0.5 * 1e-3;

			// rotate the aperture shape
			apertureSample =
				rotateVector( apertureSample, physicalCamera.apertureRotation ) *
				saturate( vec2( anamorphicRatio, 1.0 / anamorphicRatio ) );

			// create the new ray
			ray.origin += ( cameraWorldMatrix * vec4( apertureSample, 0.0, 0.0 ) ).xyz;
			ray.direction = focalPoint - ray.origin;
			// avoid division by zero in normalize when origin equals focal point
			float dirLen = length( ray.direction );
			if ( dirLen < 1e-6 ) {
				ray.direction = ( cameraWorldMatrix * vec4( 0.0, 0.0, - 1.0, 0.0 ) ).xyz;
				ray.direction = normalize( ray.direction );
			} else {
				ray.direction /= dirLen;
			}
		}
		#endif

		#if FEATURE_DOF == 0
		ray.direction = normalize( ray.direction );
		#endif

		return ray;

	}

`;

	const direct_light_contribution_function = /*glsl*/`

	vec3 directLightContribution( vec3 worldWo, SurfaceRecord surf, RenderState state, vec3 rayOrigin ) {

		vec3 result = vec3( 0.0 );

		// uniformly pick a light or environment map
		if( lightsDenom != 0.0 && rand( 5 ) < float( lights.count ) / lightsDenom ) {

			// sample a light or environment
			LightRecord lightRec = randomLightSample( lights.tex, iesProfiles, lights.count, rayOrigin, rand3( 6 ) );

			bool isSampleBelowSurface = ! surf.volumeParticle && dot( surf.faceNormal, lightRec.direction ) < 0.0;
			if ( isSampleBelowSurface ) {

				lightRec.pdf = 0.0;

			}

			// check if a ray could even reach the light area
			Ray lightRay;
			lightRay.origin = rayOrigin;
			lightRay.direction = lightRec.direction;
			vec3 attenuatedColor;
			if (
				lightRec.pdf > 0.0 &&
				isDirectionValid( lightRec.direction, surf.normal, surf.faceNormal ) &&
				! attenuateHit( state, lightRay, lightRec.dist, attenuatedColor )
			) {

				// get the material pdf
				vec3 sampleColor;
				float lightMaterialPdf = bsdfResult( worldWo, lightRec.direction, surf, sampleColor );
				bool isValidSampleColor = all( greaterThanEqual( sampleColor, vec3( 0.0 ) ) );
				if ( lightMaterialPdf > 0.0 && isValidSampleColor ) {

					// weight the direct light contribution
					float lightPdf = lightRec.pdf / lightsDenom;
					float misWeight = lightRec.type == SPOT_LIGHT_TYPE || lightRec.type == DIR_LIGHT_TYPE || lightRec.type == POINT_LIGHT_TYPE ? 1.0 : misHeuristic( lightPdf, lightMaterialPdf );
					result = attenuatedColor * lightRec.emission * state.throughputColor * sampleColor * misWeight / lightPdf;

				}

			}

		} else if ( envMapInfo.totalSum != 0.0 && environmentIntensity != 0.0 ) {

			// find a sample in the environment map to include in the contribution
			vec3 envColor, envDirection;
			float envPdf = sampleEquirectProbability( rand2( 7 ), envColor, envDirection );
			envDirection = invEnvRotation3x3 * envDirection;

			// this env sampling is not set up for transmissive sampling and yields overly bright
			// results so we ignore the sample in this case.
			// TODO: this should be improved but how? The env samples could traverse a few layers?
			bool isSampleBelowSurface = ! surf.volumeParticle && dot( surf.faceNormal, envDirection ) < 0.0;
			if ( isSampleBelowSurface ) {

				envPdf = 0.0;

			}

			// check if a ray could even reach the surface
			Ray envRay;
			envRay.origin = rayOrigin;
			envRay.direction = envDirection;
			vec3 attenuatedColor;
			if (
				envPdf > 0.0 &&
				isDirectionValid( envDirection, surf.normal, surf.faceNormal ) &&
				! attenuateHit( state, envRay, INFINITY, attenuatedColor )
			) {

				// get the material pdf
				vec3 sampleColor;
				float envMaterialPdf = bsdfResult( worldWo, envDirection, surf, sampleColor );
				bool isValidSampleColor = all( greaterThanEqual( sampleColor, vec3( 0.0 ) ) );
				if ( envMaterialPdf > 0.0 && isValidSampleColor ) {

					// weight the direct light contribution
					envPdf /= lightsDenom;
					float misWeight = misHeuristic( envPdf, envMaterialPdf );
					result = attenuatedColor * environmentIntensity * applyEnvSaturation( envColor ) * state.throughputColor * sampleColor * misWeight / envPdf;

				}

			}

		}

		// Function changed to have a single return statement to potentially help with crashes on Mac OS.
		// See issue #470
		return result;

	}

`;

	const get_surface_record_function = /* glsl */`

	#define SKIP_SURFACE 0
	#define HIT_SURFACE 1
	int getSurfaceRecord(
		Material material, SurfaceHit surfaceHit, sampler2DArray attributesArray,
		float accumulatedRoughness,
		inout SurfaceRecord surf
	) {

		if ( material.fogVolume ) {

			vec3 normal = vec3( 0, 0, 1 );

			SurfaceRecord fogSurface;
			fogSurface.volumeParticle = true;
			fogSurface.color = material.color;
			fogSurface.emission = material.emissiveIntensity * material.emissive;
			fogSurface.normal = normal;
			fogSurface.faceNormal = normal;
			fogSurface.clearcoatNormal = normal;

			surf = fogSurface;
			return HIT_SURFACE;

		}

		// uv coord for textures
		vec2 uv = textureSampleBarycoord( attributesArray, ATTR_UV, surfaceHit.barycoord, surfaceHit.faceIndices.xyz ).xy;
		vec4 vertexColor = textureSampleBarycoord( attributesArray, ATTR_COLOR, surfaceHit.barycoord, surfaceHit.faceIndices.xyz );

		// albedo
		vec4 albedo = vec4( material.color, material.opacity );
		if ( material.map != - 1 ) {

			vec3 uvPrime = material.mapTransform * vec3( uv, 1 );
			albedo *= texture2D( textures, vec3( uvPrime.xy, material.map ) );

		}

		if ( material.vertexColors ) {

			albedo *= vertexColor;

		}

		// alphaMap
		if ( material.alphaMap != - 1 ) {

			vec3 uvPrime = material.alphaMapTransform * vec3( uv, 1 );
			albedo.a *= texture2D( textures, vec3( uvPrime.xy, material.alphaMap ) ).x;

		}

		// Hit flag: SKIP_SURFACE = continue ray (transparent); HIT_SURFACE = shade. Solid ground uses hit-flag + alpha
		// (alpha test or stochastic alpha for PNG transparency) + transmission (refraction/tint in attenuateHit).
		// Possibly skip if transparent, alpha test enabled, or wrong material side (single sided).
		// - alpha test disabled when === 0; stochastic alpha: material.transparent && albedo.a < rand(3).
		// - material sidedness: allow light through back side but still shade front; skip wrong side on first ray.
		float alphaTest = material.alphaTest;
		bool useAlphaTest = alphaTest != 0.0;
		if (
			// material sidedness
			material.side != 0.0 && surfaceHit.side != material.side

			// alpha test
			|| useAlphaTest && albedo.a < alphaTest

			// opacity
			|| material.transparent && ! useAlphaTest && albedo.a < rand( 3 )
		) {

			return SKIP_SURFACE;

		}

		// fetch the interpolated smooth normal
		vec3 normal = normalize( textureSampleBarycoord(
			attributesArray,
			ATTR_NORMAL,
			surfaceHit.barycoord,
			surfaceHit.faceIndices.xyz
		).xyz );

		// roughness
		float roughness = material.roughness;
		if ( material.roughnessMap != - 1 ) {

			vec3 uvPrime = material.roughnessMapTransform * vec3( uv, 1 );
			roughness *= texture2D( textures, vec3( uvPrime.xy, material.roughnessMap ) ).g;

		}

		// metalness
		float metalness = material.metalness;
		if ( material.metalnessMap != - 1 ) {

			vec3 uvPrime = material.metalnessMapTransform * vec3( uv, 1 );
			metalness *= texture2D( textures, vec3( uvPrime.xy, material.metalnessMap ) ).b;

		}

		// emission
		vec3 emission = material.emissiveIntensity * material.emissive;
		if ( material.emissiveMap != - 1 ) {

			vec3 uvPrime = material.emissiveMapTransform * vec3( uv, 1 );
			emission *= texture2D( textures, vec3( uvPrime.xy, material.emissiveMap ) ).xyz;

		}

		// transmission
		float transmission = material.transmission;
		if ( material.transmissionMap != - 1 ) {

			vec3 uvPrime = material.transmissionMapTransform * vec3( uv, 1 );
			transmission *= texture2D( textures, vec3( uvPrime.xy, material.transmissionMap ) ).r;

		}

		// normal
		if ( material.flatShading ) {

			// if we're rendering a flat shaded object then use the face normals - the face normal
			// is provided based on the side the ray hits the mesh so flip it to align with the
			// interpolated vertex normals.
			normal = surfaceHit.faceNormal * surfaceHit.side;

		}

		vec3 baseNormal = normal;
		if ( material.normalMap != - 1 ) {

			vec4 tangentSample = textureSampleBarycoord(
				attributesArray,
				ATTR_TANGENT,
				surfaceHit.barycoord,
				surfaceHit.faceIndices.xyz
			);

			// some provided tangents can be malformed (0, 0, 0) causing the normal to be degenerate
			// resulting in NaNs and slow path tracing.
			if ( length( tangentSample.xyz ) > 0.0 ) {

				vec3 tangent = normalize( tangentSample.xyz );
				vec3 bitangent = normalize( cross( normal, tangent ) * tangentSample.w );
				mat3 vTBN = mat3( tangent, bitangent, normal );

				vec3 uvPrime = material.normalMapTransform * vec3( uv, 1 );
				vec3 texNormal = texture2D( textures, vec3( uvPrime.xy, material.normalMap ) ).xyz * 2.0 - 1.0;
				texNormal.xy *= material.normalScale;
				normal = vTBN * texNormal;

			}

		}

		normal *= surfaceHit.side;

		// clearcoat
		float clearcoat = material.clearcoat;
		if ( material.clearcoatMap != - 1 ) {

			vec3 uvPrime = material.clearcoatMapTransform * vec3( uv, 1 );
			clearcoat *= texture2D( textures, vec3( uvPrime.xy, material.clearcoatMap ) ).r;

		}

		// clearcoatRoughness
		float clearcoatRoughness = material.clearcoatRoughness;
		if ( material.clearcoatRoughnessMap != - 1 ) {

			vec3 uvPrime = material.clearcoatRoughnessMapTransform * vec3( uv, 1 );
			clearcoatRoughness *= texture2D( textures, vec3( uvPrime.xy, material.clearcoatRoughnessMap ) ).g;

		}

		// clearcoatNormal
		vec3 clearcoatNormal = baseNormal;
		if ( material.clearcoatNormalMap != - 1 ) {

			vec4 tangentSample = textureSampleBarycoord(
				attributesArray,
				ATTR_TANGENT,
				surfaceHit.barycoord,
				surfaceHit.faceIndices.xyz
			);

			// some provided tangents can be malformed (0, 0, 0) causing the normal to be degenerate
			// resulting in NaNs and slow path tracing.
			if ( length( tangentSample.xyz ) > 0.0 ) {

				vec3 tangent = normalize( tangentSample.xyz );
				vec3 bitangent = normalize( cross( clearcoatNormal, tangent ) * tangentSample.w );
				mat3 vTBN = mat3( tangent, bitangent, clearcoatNormal );

				vec3 uvPrime = material.clearcoatNormalMapTransform * vec3( uv, 1 );
				vec3 texNormal = texture2D( textures, vec3( uvPrime.xy, material.clearcoatNormalMap ) ).xyz * 2.0 - 1.0;
				texNormal.xy *= material.clearcoatNormalScale;
				clearcoatNormal = vTBN * texNormal;

			}

		}

		clearcoatNormal *= surfaceHit.side;

		// sheenColor
		vec3 sheenColor = material.sheenColor;
		if ( material.sheenColorMap != - 1 ) {

			vec3 uvPrime = material.sheenColorMapTransform * vec3( uv, 1 );
			sheenColor *= texture2D( textures, vec3( uvPrime.xy, material.sheenColorMap ) ).rgb;

		}

		// sheenRoughness
		float sheenRoughness = material.sheenRoughness;
		if ( material.sheenRoughnessMap != - 1 ) {

			vec3 uvPrime = material.sheenRoughnessMapTransform * vec3( uv, 1 );
			sheenRoughness *= texture2D( textures, vec3( uvPrime.xy, material.sheenRoughnessMap ) ).a;

		}

		// iridescence
		float iridescence = material.iridescence;
		if ( material.iridescenceMap != - 1 ) {

			vec3 uvPrime = material.iridescenceMapTransform * vec3( uv, 1 );
			iridescence *= texture2D( textures, vec3( uvPrime.xy, material.iridescenceMap ) ).r;

		}

		// iridescence thickness
		float iridescenceThickness = material.iridescenceThicknessMaximum;
		if ( material.iridescenceThicknessMap != - 1 ) {

			vec3 uvPrime = material.iridescenceThicknessMapTransform * vec3( uv, 1 );
			float iridescenceThicknessSampled = texture2D( textures, vec3( uvPrime.xy, material.iridescenceThicknessMap ) ).g;
			iridescenceThickness = mix( material.iridescenceThicknessMinimum, material.iridescenceThicknessMaximum, iridescenceThicknessSampled );

		}

		iridescence = iridescenceThickness == 0.0 ? 0.0 : iridescence;

		// specular color
		vec3 specularColor = material.specularColor;
		if ( material.specularColorMap != - 1 ) {

			vec3 uvPrime = material.specularColorMapTransform * vec3( uv, 1 );
			specularColor *= texture2D( textures, vec3( uvPrime.xy, material.specularColorMap ) ).rgb;

		}

		// specular intensity
		float specularIntensity = material.specularIntensity;
		if ( material.specularIntensityMap != - 1 ) {

			vec3 uvPrime = material.specularIntensityMapTransform * vec3( uv, 1 );
			specularIntensity *= texture2D( textures, vec3( uvPrime.xy, material.specularIntensityMap ) ).a;

		}

		surf.volumeParticle = false;

		surf.faceNormal = surfaceHit.faceNormal;
		surf.normal = normal;

		surf.metalness = metalness;
		surf.color = albedo.rgb;
		surf.emission = emission;

		surf.ior = material.ior;
		surf.transmission = transmission;
		surf.thinFilm = material.thinFilm;
		surf.attenuationColor = material.attenuationColor;
		surf.attenuationDistance = material.attenuationDistance;

		surf.clearcoatNormal = clearcoatNormal;
		surf.clearcoat = clearcoat;

		surf.sheen = material.sheen;
		surf.sheenColor = sheenColor;

		surf.iridescence = iridescence;
		surf.iridescenceIor = material.iridescenceIor;
		surf.iridescenceThickness = iridescenceThickness;

		surf.specularColor = specularColor;
		surf.specularIntensity = specularIntensity;

		// apply perceptual roughness factor from gltf. sheen perceptual roughness is
		// applied by its brdf function
		// https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html#microfacet-surfaces
		surf.roughness = roughness * roughness;
		surf.clearcoatRoughness = clearcoatRoughness * clearcoatRoughness;
		surf.sheenRoughness = sheenRoughness;

		// frontFace is used to determine transmissive properties and PDF. If no transmission is used
		// then we can just always assume this is a front face.
		surf.frontFace = surfaceHit.side == 1.0 || transmission == 0.0;
		surf.eta = material.thinFilm || surf.frontFace ? 1.0 / material.ior : material.ior;
		surf.f0 = iorRatioToF0( surf.eta );

		// Compute the filtered roughness value to use during specular reflection computations.
		// The accumulated roughness value is scaled by a user setting and a "magic value" of 5.0.
		// If we're exiting something transmissive then scale the factor down significantly so we can retain
		// sharp internal reflections
		surf.filteredRoughness = applyFilteredGlossy( surf.roughness, accumulatedRoughness );
		surf.filteredClearcoatRoughness = applyFilteredGlossy( surf.clearcoatRoughness, accumulatedRoughness );

		// get the normal frames
		surf.normalBasis = getBasisFromNormal( surf.normal );
		surf.normalInvBasis = inverse( surf.normalBasis );

		surf.clearcoatBasis = getBasisFromNormal( surf.clearcoatNormal );
		surf.clearcoatInvBasis = inverse( surf.clearcoatBasis );

		return HIT_SURFACE;

	}
`;

	const render_structs = /* glsl */`

	struct Ray {

		vec3 origin;
		vec3 direction;

	};

	struct SurfaceHit {

		uvec4 faceIndices;
		vec3 barycoord;
		vec3 faceNormal;
		float side;
		float dist;

	};

	struct RenderState {

		bool firstRay;
		bool transmissiveRay;
		bool isShadowRay;
		float accumulatedRoughness;
		int transmissiveTraversals;
		int traversals;
		uint depth;
		vec3 throughputColor;
		Material fogMaterial;

	};

	RenderState initRenderState() {

		RenderState result;
		result.firstRay = true;
		result.transmissiveRay = true;
		result.isShadowRay = false;
		result.accumulatedRoughness = 0.0;
		result.transmissiveTraversals = 0;
		result.traversals = 0;
		result.throughputColor = vec3( 1.0 );
		result.depth = 0u;
		result.fogMaterial.fogVolume = false;
		return result;

	}

`;

	const trace_scene_function = /* glsl */`

	#define NO_HIT 0
	#define SURFACE_HIT 1
	#define LIGHT_HIT 2
	#define FOG_HIT 3

	// Passing the global variable 'lights' into this function caused shader program errors.
	// So global variables like 'lights' and 'bvh' were moved out of the function parameters.
	// For more information, refer to: https://github.com/gkjohnson/three-gpu-pathtracer/pull/457
	int traceScene(
		Ray ray, Material fogMaterial, inout SurfaceHit surfaceHit
	) {

		int result = NO_HIT;
		bool hit = bvhIntersectFirstHit( bvh, ray.origin, ray.direction, surfaceHit.faceIndices, surfaceHit.faceNormal, surfaceHit.barycoord, surfaceHit.side, surfaceHit.dist );

		#if FEATURE_FOG

		if ( fogMaterial.fogVolume ) {

			// offset the distance so we don't run into issues with particles on the same surface
			// as other objects
			float particleDist = intersectFogVolume( fogMaterial, rand( 1 ) );
			if ( particleDist + RAY_OFFSET < surfaceHit.dist ) {

				surfaceHit.side = 1.0;
				surfaceHit.faceNormal = normalize( - ray.direction );
				surfaceHit.dist = particleDist;
				return FOG_HIT;

			}

		}

		#endif

		if ( hit ) {

			result = SURFACE_HIT;

		}

		return result;

	}

`;

	class PhysicalPathTracingMaterial extends MaterialBase {

		onBeforeRender() {

			this.setDefine( 'FEATURE_DOF', this.physicalCamera.bokehSize === 0 ? 0 : 1 );
			this.setDefine( 'FEATURE_BACKGROUND_MAP', this.backgroundMap ? 1 : 0 );
			this.setDefine( 'FEATURE_FOG', this.materials.features.isUsed( 'FOG' ) ? 1 : 0 );

		}

		constructor( parameters ) {

			super( {

				transparent: true,
				depthWrite: false,

				defines: {
					FEATURE_MIS: 1,
					FEATURE_RUSSIAN_ROULETTE: 1,
					// Match common runtime values to avoid recompilation on first render
					FEATURE_DOF: 0,
					FEATURE_BACKGROUND_MAP: 0,
					FEATURE_FOG: 0,

					// 0 = PCG
					// 1 = Sobol
					// 2 = Stratified List
					RANDOM_TYPE: 2,

					// 0 = Perspective
					// 1 = Orthographic
					// 2 = Equirectangular
					CAMERA_TYPE: 0,

					DEBUG_MODE: 0,

					ATTR_NORMAL: 0,
					ATTR_TANGENT: 1,
					ATTR_UV: 2,
					ATTR_COLOR: 3,
					MATERIAL_PIXELS: MATERIAL_PIXELS,
				},

				uniforms: {

					// path trace uniforms
					resolution: { value: new three.Vector2() },
					opacity: { value: 1 },
					bounces: { value: 10 },
					transmissiveBounces: { value: 10 },
					filterGlossyFactor: { value: 0 },

					// camera uniforms
					physicalCamera: { value: new PhysicalCameraUniform() },
					cameraWorldMatrix: { value: new three.Matrix4() },
					invProjectionMatrix: { value: new three.Matrix4() },

					// scene uniforms
					bvh: { value: new MeshBVHUniformStruct() },
					attributesArray: { value: new AttributesTextureArray() },
					materialIndexAttribute: { value: new UIntVertexAttributeTexture() },
					materials: { value: new MaterialsTexture() },
					textures: { value: new RenderTarget2DArray().texture },

					// light uniforms
					lights: { value: new LightsInfoUniformStruct() },
					iesProfiles: {
						value: new RenderTarget2DArray( 360, 180, {
							type: three.HalfFloatType,
							wrapS: three.ClampToEdgeWrapping,
							wrapT: three.ClampToEdgeWrapping,
						} ).texture
					},
					environmentIntensity: { value: 1.0 },
					environmentRotation: { value: new three.Matrix4() },
					environmentSaturation: { value: 1.0 },
					envMapInfo: { value: new EquirectHdrInfoUniform() },

					// background uniforms
					backgroundBlur: { value: 0.0 },
					backgroundMap: { value: null },
					backgroundAlpha: { value: 1.0 },
					backgroundIntensity: { value: 1.0 },
					backgroundRotation: { value: new three.Matrix4() },
					shadowCatcherReflectionIntensity: { value: 1.0 },

					// randomness uniforms
					seed: { value: 0 },
					sobolTexture: { value: null },
					stratifiedTexture: { value: new StratifiedSamplesTexture() },
					stratifiedOffsetTexture: { value: new BlueNoiseTexture( 64, 1 ) },
				},

				vertexShader: /* glsl */`

				varying vec2 vUv;
				void main() {

					vec4 mvPosition = vec4( position, 1.0 );
					mvPosition = modelViewMatrix * mvPosition;
					gl_Position = projectionMatrix * mvPosition;

					vUv = uv;

				}

			`,

				fragmentShader: /* glsl */`
				#define RAY_OFFSET 1e-4
				#define INFINITY 1e20

				precision highp isampler2D;
				precision highp usampler2D;
				precision highp sampler2DArray;
				vec4 envMapTexelToLinear( vec4 a ) { return a; }
				#include <common>

				// bvh intersection
				${common_functions}
				${bvh_struct_definitions}
				${bvh_ray_functions}

				// uniform structs
				${camera_struct}
				${lights_struct}
				${equirect_struct}
				${material_struct}
				${surface_record_struct}

				// random
				#if RANDOM_TYPE == 2 	// Stratified List

					${stratified_functions}

				#elif RANDOM_TYPE == 1 	// Sobol

					${pcg_functions}
					${sobol_common}
					${sobol_functions}

					#define rand(v) sobol(v)
					#define rand2(v) sobol2(v)
					#define rand3(v) sobol3(v)
					#define rand4(v) sobol4(v)

				#else 					// PCG

				${pcg_functions}

					// Using the sobol functions seems to break the the compiler on MacOS
					// - specifically the "sobolReverseBits" function.
					uint sobolPixelIndex = 0u;
					uint sobolPathIndex = 0u;
					uint sobolBounceIndex = 0u;

					#define rand(v) pcgRand()
					#define rand2(v) pcgRand2()
					#define rand3(v) pcgRand3()
					#define rand4(v) pcgRand4()

				#endif

				// common
				${texture_sample_functions}
				${fresnel_functions}
				${util_functions}
				${math_functions}
				${shape_intersection_functions}

				// environment
				uniform EquirectHdrInfo envMapInfo;
				uniform mat4 environmentRotation;
				uniform float environmentIntensity;
				uniform float environmentSaturation;

				vec3 applyEnvSaturation( vec3 c ) {

					float g = dot( c, vec3( 0.2126, 0.7152, 0.0722 ) );
					return mix( vec3( g ), c, environmentSaturation );

				}

				// lighting
				uniform sampler2DArray iesProfiles;
				uniform LightsInfo lights;

				// background
				uniform float backgroundBlur;
				uniform float backgroundAlpha;
				uniform float shadowCatcherReflectionIntensity;
				#if FEATURE_BACKGROUND_MAP

				uniform sampler2D backgroundMap;
				uniform mat4 backgroundRotation;
				uniform float backgroundIntensity;

				#endif

				// camera
				uniform mat4 cameraWorldMatrix;
				uniform mat4 invProjectionMatrix;
				#if FEATURE_DOF

				uniform PhysicalCamera physicalCamera;

				#endif

				// geometry
				uniform sampler2DArray attributesArray;
				uniform usampler2D materialIndexAttribute;
				uniform sampler2D materials;
				uniform sampler2DArray textures;
				uniform BVH bvh;

				// path tracer
				uniform int bounces;
				uniform int transmissiveBounces;
				uniform float filterGlossyFactor;
				uniform int seed;

				// image
				uniform vec2 resolution;
				uniform float opacity;

				varying vec2 vUv;

				// globals
				mat3 envRotation3x3;
				mat3 invEnvRotation3x3;
				float lightsDenom;

				// sampling
				${shape_sampling_functions}
				${equirect_functions}
				${light_sampling_functions}

				${inside_fog_volume_function}
				${ggx_functions}
				${sheen_functions}
				${iridescence_functions}
				${fog_functions}
				${bsdf_functions}

				float applyFilteredGlossy( float roughness, float accumulatedRoughness ) {

					return clamp(
						max(
							roughness,
							accumulatedRoughness * filterGlossyFactor * 5.0 ),
						0.0,
						1.0
					);

				}

				vec3 sampleBackground( vec3 direction, vec2 uv ) {

					vec3 sampleDir = sampleHemisphere( direction, uv ) * 0.5 * backgroundBlur;

					#if FEATURE_BACKGROUND_MAP

					sampleDir = normalize( mat3( backgroundRotation ) * direction + sampleDir );
					return applyEnvSaturation( backgroundIntensity * sampleEquirectColor( backgroundMap, sampleDir ) );

					#else

					sampleDir = normalize( envRotation3x3 * direction + sampleDir );
					return applyEnvSaturation( environmentIntensity * sampleEquirectColor( envMapInfo.map, sampleDir ) );

					#endif

				}

				${render_structs}
				${camera_util_functions}
				${trace_scene_function}
				${attenuate_hit_function}
				${direct_light_contribution_function}
				${get_surface_record_function}

				void main() {

					// init
					rng_initialize( gl_FragCoord.xy, seed );
					sobolPixelIndex = ( uint( gl_FragCoord.x ) << 16 ) | uint( gl_FragCoord.y );
					sobolPathIndex = uint( seed );

					// get camera ray
					Ray ray = getCameraRay();

					// inverse environment rotation
					envRotation3x3 = mat3( environmentRotation );
					invEnvRotation3x3 = inverse( envRotation3x3 );
					lightsDenom =
						( environmentIntensity == 0.0 || envMapInfo.totalSum == 0.0 ) && lights.count != 0u ?
							float( lights.count ) :
							float( lights.count + 1u );

					// final color
					gl_FragColor = vec4( 0, 0, 0, 1 );

					// surface results
					SurfaceHit surfaceHit;
					ScatterRecord scatterRec;

					// path tracing state
					RenderState state = initRenderState();
					state.transmissiveTraversals = transmissiveBounces;
					#if FEATURE_FOG

					state.fogMaterial.fogVolume = bvhIntersectFogVolumeHit(
						ray.origin, - ray.direction,
						materialIndexAttribute, materials,
						state.fogMaterial
					);

					#endif

					for ( int i = 0; i < bounces; i ++ ) {

						sobolBounceIndex ++;

						state.depth ++;
						state.traversals = bounces - i;
						state.firstRay = i == 0 && state.transmissiveTraversals == transmissiveBounces;

						int hitType = traceScene( ray, state.fogMaterial, surfaceHit );

						// check if we intersect any lights and accumulate the light contribution
						// TODO: we can add support for light surface rendering in the else condition if we
						// add the ability to toggle visibility of the the light
						if ( ! state.firstRay && ! state.transmissiveRay ) {

							LightRecord lightRec;
							float lightDist = hitType == NO_HIT ? INFINITY : surfaceHit.dist;
							for ( uint i = 0u; i < lights.count; i ++ ) {

								if (
									intersectLightAtIndex( lights.tex, ray.origin, ray.direction, i, lightRec ) &&
									lightRec.dist < lightDist
								) {

									#if FEATURE_MIS

									// weight the contribution
									// NOTE: Only area lights are supported for forward sampling and can be hit
									float misWeight = misHeuristic( scatterRec.pdf, lightRec.pdf / lightsDenom );
									gl_FragColor.rgb += lightRec.emission * state.throughputColor * misWeight;

									#else

									gl_FragColor.rgb += lightRec.emission * state.throughputColor;

									#endif

								}

							}

						}

						if ( hitType == NO_HIT ) {

							if ( state.firstRay || state.transmissiveRay ) {

								gl_FragColor.rgb += sampleBackground( ray.direction, rand2( 2 ) ) * state.throughputColor;
								gl_FragColor.a = backgroundAlpha;

							} else {

								#if FEATURE_MIS

								// get the PDF of the hit envmap point
								vec3 envColor;
								float envPdf = sampleEquirect( envRotation3x3 * ray.direction, envColor );
								envPdf /= lightsDenom;

								// and weight the contribution
								float misWeight = misHeuristic( scatterRec.pdf, envPdf );
								gl_FragColor.rgb += environmentIntensity * applyEnvSaturation( envColor ) * state.throughputColor * misWeight;

								#else

								gl_FragColor.rgb +=
									environmentIntensity *
									applyEnvSaturation( sampleEquirectColor( envMapInfo.map, envRotation3x3 * ray.direction ) ) *
									state.throughputColor;

								#endif

							}
							break;

						}

						uint materialIndex = uTexelFetch1D( materialIndexAttribute, surfaceHit.faceIndices.x ).r;
						Material material = readMaterialInfo( materials, materialIndex );

						#if FEATURE_FOG

						if ( hitType == FOG_HIT ) {

							material = state.fogMaterial;
							state.accumulatedRoughness += 0.2;

						} else if ( material.fogVolume ) {

							state.fogMaterial = material;
							state.fogMaterial.fogVolume = surfaceHit.side == 1.0;

							ray.origin = stepRayOrigin( ray.origin, ray.direction, - surfaceHit.faceNormal, surfaceHit.dist );

							i -= sign( state.transmissiveTraversals );
							state.transmissiveTraversals -= sign( state.transmissiveTraversals );
							continue;

						}

						#endif

						// early out if this is a matte material
						if ( material.matte && state.firstRay ) {

							gl_FragColor = vec4( 0.0 );
							break;

						}

						// if we've determined that this is a shadow ray and we've hit an item with no shadow casting
						// then skip it
						if ( ! material.castShadow && state.isShadowRay ) {

							ray.origin = stepRayOrigin( ray.origin, ray.direction, - surfaceHit.faceNormal, surfaceHit.dist );
							continue;

						}

						SurfaceRecord surf;
						if (
							getSurfaceRecord(
								material, surfaceHit, attributesArray, state.accumulatedRoughness,
								surf
							) == SKIP_SURFACE
						) {

							// only allow a limited number of transparency discards otherwise we could
							// crash the context with too long a loop.
							i -= sign( state.transmissiveTraversals );
							state.transmissiveTraversals -= sign( state.transmissiveTraversals );

							ray.origin = stepRayOrigin( ray.origin, ray.direction, - surfaceHit.faceNormal, surfaceHit.dist );
							continue;

						}

						// shadow/reflection catcher: Production Grade V2
						// Solves wavering ripples (stable Fresnel), double ghosting (transmission mask), black circle (screen-blend alpha)
						if ( material.shadowReflectionCatcher && state.firstRay ) {

							vec3 hitPoint = stepRayOrigin( ray.origin, ray.direction, surf.faceNormal, surfaceHit.dist );

							// --- 1. STABLE FRESNEL MASK (prevents "waver" ripples) ---
							// Use perfect reflection vector so the mask does not jitter with roughness
							vec3 perfectReflDir = reflect( ray.direction, surf.faceNormal );
							vec3 stableHalfVector = normalize( - ray.direction + perfectReflDir );
							float stableDotVH = saturate( dot( - ray.direction, stableHalfVector ) );
							vec3 f0 = mix( vec3( surf.f0 * surf.specularIntensity ), surf.color, surf.metalness );
							vec3 transmissionMask = vec3( 1.0 ) - schlickFresnel( stableDotVH, f0 );

							// --- 2. REFLECTION TRACING (roughness-aware ray) ---
							ScatterRecord catcherScatter = bsdfSample( - ray.direction, surf );
							vec3 reflectionWeight = vec3( 0.0 );
							if ( catcherScatter.pdf > 0.0 ) {
								reflectionWeight = catcherScatter.color / catcherScatter.pdf;
							}
							if ( any( isnan( reflectionWeight ) ) || any( isinf( reflectionWeight ) ) ) {
								reflectionWeight = vec3( 0.0 );
							}

							vec3 reflDir = catcherScatter.direction;
							if ( dot( reflDir, surf.faceNormal ) < 0.0 ) {
								reflDir = reflect( ray.direction, surf.faceNormal );
							}
							Ray reflRay;
							reflRay.origin = stepRayOrigin( hitPoint, reflDir, surf.faceNormal, 0.0 );
							reflRay.direction = reflDir;

							SurfaceHit reflHit;
							int reflHitType = traceScene( reflRay, state.fogMaterial, reflHit );
							vec3 reflectionColor = vec3( 0.0 );

							if ( reflHitType == SURFACE_HIT ) {
								uint reflMatIndex = uTexelFetch1D( materialIndexAttribute, reflHit.faceIndices.x ).r;
								Material reflMat = readMaterialInfo( materials, reflMatIndex );
								SurfaceRecord reflSurf;
								if ( getSurfaceRecord( reflMat, reflHit, attributesArray, 0.0, reflSurf ) != SKIP_SURFACE ) {
									vec3 reflHitPoint = stepRayOrigin( reflRay.origin, reflRay.direction, reflSurf.faceNormal, reflHit.dist );
									reflectionColor = reflSurf.emission + directLightContribution( - reflDir, reflSurf, state, reflHitPoint );
								}
							}

							// --- 3. SHADOW TRACING ---
							float shadowFactor = 0.0;
							state.isShadowRay = true;
							if ( lightsDenom != 0.0 && rand( 9 ) < float( lights.count ) / lightsDenom ) {
								LightRecord lightRec = randomLightSample( lights.tex, iesProfiles, lights.count, hitPoint, rand3( 10 ) );
								if ( dot( surf.faceNormal, lightRec.direction ) >= 0.0 && lightRec.pdf > 0.0 ) {
									Ray lightRay;
									lightRay.origin = hitPoint;
									lightRay.direction = lightRec.direction;
									vec3 att;
									if ( attenuateHit( state, lightRay, lightRec.dist, att ) ) shadowFactor = 1.0;
								}
							} else if ( envMapInfo.totalSum != 0.0 && environmentIntensity != 0.0 ) {
								vec3 envColor, envDirection;
								float envPdf = sampleEquirectProbability( rand2( 11 ), envColor, envDirection );
								envDirection = invEnvRotation3x3 * envDirection;
								if ( dot( surf.faceNormal, envDirection ) >= 0.0 && envPdf > 0.0 ) {
									Ray envRay;
									envRay.origin = hitPoint;
									envRay.direction = envDirection;
									vec3 att;
									if ( attenuateHit( state, envRay, INFINITY, att ) ) shadowFactor = 1.0;
								}
							}
							state.isShadowRay = false;

							// --- 4. COMPOSITING (transmission masking: reflection hides shadow/background) ---
							vec3 backColor = sampleBackground( ray.direction, rand2( 2 ) );
							vec3 shadowedBackground = backColor * ( 1.0 - shadowFactor );
							vec3 finalReflection = reflectionColor * reflectionWeight * shadowCatcherReflectionIntensity;
							gl_FragColor.rgb = shadowedBackground * transmissionMask + finalReflection;

							// --- 5. ALPHA (screen blend to avoid black circle) ---
							float reflectionLuma = dot( finalReflection, vec3( 0.2126, 0.7152, 0.0722 ) );
							float reflAlpha = saturate( reflectionLuma * 1.5 );
							float shadowAlpha = shadowFactor * opacity;
							shadowAlpha *= ( 1.0 - reflAlpha );
							float combinedAlpha = 1.0 - ( 1.0 - shadowAlpha ) * ( 1.0 - reflAlpha );
							gl_FragColor.a = max( backgroundAlpha, combinedAlpha );

							break;

						}

						scatterRec = bsdfSample( - ray.direction, surf );
						state.isShadowRay = scatterRec.specularPdf < rand( 4 );

						bool isBelowSurface = ! surf.volumeParticle && dot( scatterRec.direction, surf.faceNormal ) < 0.0;
						vec3 hitPoint = stepRayOrigin( ray.origin, ray.direction, isBelowSurface ? - surf.faceNormal : surf.faceNormal, surfaceHit.dist );

						// next event estimation
						#if FEATURE_MIS

						gl_FragColor.rgb += directLightContribution( - ray.direction, surf, state, hitPoint );

						#endif

						// accumulate a roughness value to offset diffuse, specular, diffuse rays that have high contribution
						// to a single pixel resulting in fireflies
						// TODO: handle transmissive surfaces
						if ( ! surf.volumeParticle && ! isBelowSurface ) {

							// determine if this is a rough normal or not by checking how far off straight up it is
							vec3 halfVector = normalize( - ray.direction + scatterRec.direction );
							state.accumulatedRoughness += max(
								sin( acosApprox( dot( halfVector, surf.normal ) ) ),
								sin( acosApprox( dot( halfVector, surf.clearcoatNormal ) ) )
							);

							state.transmissiveRay = false;

						}

						// accumulate emissive color
						gl_FragColor.rgb += ( surf.emission * state.throughputColor );

						// skip the sample if our PDF or ray is impossible
						if ( scatterRec.pdf <= 0.0 || ! isDirectionValid( scatterRec.direction, surf.normal, surf.faceNormal ) ) {

							break;

						}

						// if we're bouncing around the inside a transmissive material then decrement
						// perform this separate from a bounce
						bool isTransmissiveRay = ! surf.volumeParticle && dot( scatterRec.direction, surf.faceNormal * surfaceHit.side ) < 0.0;
						if ( ( isTransmissiveRay || isBelowSurface ) && state.transmissiveTraversals > 0 ) {

							state.transmissiveTraversals --;
							i --;

						}

						//

						// handle throughput color transformation
						// attenuate the throughput color by the medium color
						if ( ! surf.frontFace ) {

							state.throughputColor *= transmissionAttenuation( surfaceHit.dist, surf.attenuationColor, surf.attenuationDistance );

						}

						#if FEATURE_RUSSIAN_ROULETTE

						// russian roulette path termination
						// https://www.arnoldrenderer.com/research/physically_based_shader_design_in_arnold.pdf
						uint minBounces = 3u;
						float depthProb = float( state.depth < minBounces );

						float rrProb = luminance( state.throughputColor * scatterRec.color / scatterRec.pdf );
						rrProb /= luminance( state.throughputColor );
						rrProb = sqrt( rrProb );
						rrProb = max( rrProb, depthProb );
						rrProb = min( rrProb, 1.0 );
						if ( rand( 8 ) > rrProb ) {

							break;

						}

						// perform sample clamping here to avoid bright pixels
						state.throughputColor *= min( 1.0 / rrProb, 20.0 );

						#endif

						// adjust the throughput and discard and exit if we find discard the sample if there are any NaNs
						state.throughputColor *= scatterRec.color / scatterRec.pdf;
						if ( any( isnan( state.throughputColor ) ) || any( isinf( state.throughputColor ) ) ) {

							break;

						}

						//

						// prepare for next ray
						ray.direction = scatterRec.direction;
						ray.origin = hitPoint;

					}

					gl_FragColor.a *= opacity;

					#if DEBUG_MODE == 1

					// output the number of rays checked in the path and number of
					// transmissive rays encountered.
					gl_FragColor.rgb = vec3(
						float( state.depth ),
						transmissiveBounces - state.transmissiveTraversals,
						0.0
					);
					gl_FragColor.a = 1.0;

					#endif

				}

			`

			} );

			this.setValues( parameters );

		}

	}

	function* renderTask() {

		const {
			_renderer,
			_fsQuad,
			_blendQuad,
			_primaryTarget,
			_blendTargets,
			_sobolTarget,
			_subframe,
			alpha,
			material,
		} = this;
		const _ogScissor = new three.Vector4();
		const _ogViewport = new three.Vector4();

		const blendMaterial = _blendQuad.material;
		let [ blendTarget1, blendTarget2 ] = _blendTargets;

		while ( true ) {

			if ( alpha ) {

				blendMaterial.opacity = this._opacityFactor / ( this.samples + 1 );
				material.blending = three.NoBlending;
				material.opacity = 1;

			} else {

				material.opacity = this._opacityFactor / ( this.samples + 1 );
				material.blending = three.NormalBlending;

			}

			const [ subX, subY, subW, subH ] = _subframe;

			const w = _primaryTarget.width;
			const h = _primaryTarget.height;
			material.resolution.set( w * subW, h * subH );
			material.sobolTexture = _sobolTarget.texture;
			material.stratifiedTexture.init( 20, material.bounces + material.transmissiveBounces + 5 );
			material.stratifiedTexture.next();
			material.seed ++;

			const tilesX = this.tiles.x || 1;
			const tilesY = this.tiles.y || 1;
			const totalTiles = tilesX * tilesY;

			const pxSubW = Math.ceil( w * subW );
			const pxSubH = Math.ceil( h * subH );
			const pxSubX = Math.floor( subX * w );
			const pxSubY = Math.floor( subY * h );

			const pxTileW = Math.ceil( pxSubW / tilesX );
			const pxTileH = Math.ceil( pxSubH / tilesY );

			for ( let y = 0; y < tilesY; y ++ ) {

				for ( let x = 0; x < tilesX; x ++ ) {

					// store og state
					const ogRenderTarget = _renderer.getRenderTarget();
					const ogAutoClear = _renderer.autoClear;
					const ogScissorTest = _renderer.getScissorTest();
					_renderer.getScissor( _ogScissor );
					_renderer.getViewport( _ogViewport );

					let tx = x;
					let ty = y;
					if ( ! this.stableTiles ) {

						const tileIndex = ( this._currentTile ) % ( tilesX * tilesY );
						tx = tileIndex % tilesX;
						ty = ~ ~ ( tileIndex / tilesX );

						this._currentTile = tileIndex + 1;

					}

					// set the scissor and the viewport on the render target
					// note that when using the webgl renderer set viewport the device pixel ratio
					// is multiplied into the field causing some pixels to not be rendered
					const reverseTy = tilesY - ty - 1;
					_primaryTarget.scissor.set(
						pxSubX + tx * pxTileW,
						pxSubY + reverseTy * pxTileH,
						Math.min( pxTileW, pxSubW - tx * pxTileW ),
						Math.min( pxTileH, pxSubH - reverseTy * pxTileH ),
					);

					_primaryTarget.viewport.set(
						pxSubX,
						pxSubY,
						pxSubW,
						pxSubH,
					);

					// three.js renderer takes values relative to the current pixel ratio
					_renderer.setRenderTarget( _primaryTarget );
					_renderer.setScissorTest( true );

					_renderer.autoClear = false;
					_fsQuad.render( _renderer );

					// reset original renderer state
					_renderer.setViewport( _ogViewport );
					_renderer.setScissor( _ogScissor );
					_renderer.setScissorTest( ogScissorTest );
					_renderer.setRenderTarget( ogRenderTarget );
					_renderer.autoClear = ogAutoClear;

					// swap and blend alpha targets
					if ( alpha ) {

						blendMaterial.target1 = blendTarget1.texture;
						blendMaterial.target2 = _primaryTarget.texture;

						_renderer.setRenderTarget( blendTarget2 );
						_blendQuad.render( _renderer );
						_renderer.setRenderTarget( ogRenderTarget );

					}

					this.samples += ( 1 / totalTiles );

					// round the samples value if we've finished the tiles
					if ( x === tilesX - 1 && y === tilesY - 1 ) {

						this.samples = Math.round( this.samples );

					}

					yield;

				}

			}

			[ blendTarget1, blendTarget2 ] = [ blendTarget2, blendTarget1 ];

		}

	}

	const ogClearColor = new three.Color();
	class PathTracingRenderer {

		get material() {

			return this._fsQuad.material;

		}

		set material( v ) {

			this._fsQuad.material.removeEventListener( 'recompilation', this._compileFunction );
			v.addEventListener( 'recompilation', this._compileFunction );

			this._fsQuad.material = v;

		}

		get target() {

			return this._alpha ? this._blendTargets[ 1 ] : this._primaryTarget;

		}

		set alpha( v ) {

			if ( this._alpha === v ) {

				return;

			}

			if ( ! v ) {

				this._blendTargets[ 0 ].dispose();
				this._blendTargets[ 1 ].dispose();

			}

			this._alpha = v;
			this.reset();

		}

		get alpha() {

			return this._alpha;

		}

		get isCompiling() {

			return Boolean( this._compilePromise );

		}

		constructor( renderer ) {

			this.camera = null;
			this.tiles = new three.Vector2( 3, 3 );

			this.stableNoise = false;
			this.stableTiles = true;

			this.samples = 0;
			this._subframe = new three.Vector4( 0, 0, 1, 1 );
			this._opacityFactor = 1.0;
			this._renderer = renderer;
			this._alpha = false;
			this._fsQuad = new Pass_js.FullScreenQuad( new PhysicalPathTracingMaterial() );
			this._blendQuad = new Pass_js.FullScreenQuad( new BlendMaterial() );
			this._task = null;
			this._currentTile = 0;
			this._compilePromise = null;

			this._sobolTarget = new SobolNumberMapGenerator().generate( renderer );

			this._primaryTarget = new three.WebGLRenderTarget( 1, 1, {
				format: three.RGBAFormat,
				type: three.FloatType,
				magFilter: three.NearestFilter,
				minFilter: three.NearestFilter,
			} );
			this._blendTargets = [
				new three.WebGLRenderTarget( 1, 1, {
					format: three.RGBAFormat,
					type: three.FloatType,
					magFilter: three.NearestFilter,
					minFilter: three.NearestFilter,
				} ),
				new three.WebGLRenderTarget( 1, 1, {
					format: three.RGBAFormat,
					type: three.FloatType,
					magFilter: three.NearestFilter,
					minFilter: three.NearestFilter,
				} ),
			];

			// Debounced compile: wait one frame so multiple define/param changes in one burst cause a single compile.
			// Reduces GPU exhaustion when toggling options or loading scenes.
			this._compileScheduled = false;
			this._compileFunction = () => {

				if ( this._compileScheduled ) return;
				this._compileScheduled = true;

				const self = this;
				requestAnimationFrame( function doCompile() {

					self._compileScheduled = false;
					const promise = self.compileMaterial( self._fsQuad._mesh );
					promise.then( () => {

						if ( self._compilePromise === promise ) {

							self._compilePromise = null;

						}

					} );

					self._compilePromise = promise;

				} );

			};

			this.material.addEventListener( 'recompilation', this._compileFunction );

		}

		compileMaterial() {

			return this._renderer.compileAsync( this._fsQuad._mesh );

		}

		setCamera( camera ) {

			const { material } = this;
			material.cameraWorldMatrix.copy( camera.matrixWorld );
			material.invProjectionMatrix.copy( camera.projectionMatrixInverse );
			material.physicalCamera.updateFrom( camera );

			// Perspective camera (default)
			let cameraType = 0;

			// An orthographic projection matrix will always have the bottom right element == 1
			// And a perspective projection matrix will always have the bottom right element == 0
			if ( camera.projectionMatrix.elements[ 15 ] > 0 ) {

				// Orthographic
				cameraType = 1;

			}

			if ( camera.isEquirectCamera ) {

				// Equirectangular
				cameraType = 2;

			}

			material.setDefine( 'CAMERA_TYPE', cameraType );

			this.camera = camera;

		}

		setSize( w, h ) {

			w = Math.ceil( w );
			h = Math.ceil( h );

			if ( this._primaryTarget.width === w && this._primaryTarget.height === h ) {

				return;

			}

			this._primaryTarget.setSize( w, h );
			this._blendTargets[ 0 ].setSize( w, h );
			this._blendTargets[ 1 ].setSize( w, h );
			this.reset();

		}

		getSize( target ) {

			target.x = this._primaryTarget.width;
			target.y = this._primaryTarget.height;

		}

		dispose() {

			this._primaryTarget.dispose();
			this._blendTargets[ 0 ].dispose();
			this._blendTargets[ 1 ].dispose();
			this._sobolTarget.dispose();

			this._fsQuad.dispose();
			this._blendQuad.dispose();
			this._task = null;
			this._compilePromise = null;
			this._compileScheduled = false;

		}

		reset() {

			const { _renderer, _primaryTarget, _blendTargets } = this;
			const ogRenderTarget = _renderer.getRenderTarget();
			const ogClearAlpha = _renderer.getClearAlpha();
			_renderer.getClearColor( ogClearColor );

			_renderer.setRenderTarget( _primaryTarget );
			_renderer.setClearColor( 0, 0 );
			_renderer.clearColor();

			_renderer.setRenderTarget( _blendTargets[ 0 ] );
			_renderer.setClearColor( 0, 0 );
			_renderer.clearColor();

			_renderer.setRenderTarget( _blendTargets[ 1 ] );
			_renderer.setClearColor( 0, 0 );
			_renderer.clearColor();

			_renderer.setClearColor( ogClearColor, ogClearAlpha );
			_renderer.setRenderTarget( ogRenderTarget );

			this.samples = 0;
			this._task = null;

			this.material.stratifiedTexture.stableNoise = this.stableNoise;
			if ( this.stableNoise ) {

				this.material.seed = 0;
				this.material.stratifiedTexture.reset();

			}

		}

		update() {

			// ensure we've updated our defines before rendering so we can ensure we
			// can wait for compilation to finish
			this.material.onBeforeRender();
			if ( this.isCompiling ) {

				return;

			}

			if ( ! this._task ) {

				this._task = renderTask.call( this );

			}

			this._task.next();

		}

	}

	const _uv = new three.Vector2();
	const _coord = new three.Vector2();
	const _polar = new three.Spherical();
	const _color = new three.Color();
	class ProceduralEquirectTexture extends three.DataTexture {

		constructor( width = 512, height = 512 ) {

			super(
				new Float32Array( width * height * 4 ),
				width, height, three.RGBAFormat, three.FloatType, three.EquirectangularReflectionMapping,
				three.RepeatWrapping, three.ClampToEdgeWrapping, three.LinearFilter, three.LinearFilter,
			);

			this.generationCallback = null;

		}

		update() {

			this.dispose();
			this.needsUpdate = true;

			const { data, width, height } = this.image;
			for ( let x = 0; x < width; x ++ ) {

				for ( let y = 0; y < height; y ++ ) {

					_coord.set( width, height );

					_uv.set( x / width, y / height );
					_uv.x -= 0.5;
					_uv.y = 1.0 - _uv.y;

					_polar.theta = _uv.x * 2.0 * Math.PI;
					_polar.phi = _uv.y * Math.PI;
					_polar.radius = 1.0;

					this.generationCallback( _polar, _uv, _coord, _color );

					const i = y * width + x;
					const i4 = 4 * i;
					data[ i4 + 0 ] = ( _color.r );
					data[ i4 + 1 ] = ( _color.g );
					data[ i4 + 2 ] = ( _color.b );
					data[ i4 + 3 ] = ( 1.0 );

				}

			}

		}

		copy( other ) {

			super.copy( other );
			this.generationCallback = other.generationCallback;
			return this;

		}

	}

	const _direction = new three.Vector3();
	class GradientEquirectTexture extends ProceduralEquirectTexture {

		constructor( resolution = 512 ) {

			super( resolution, resolution );

			this.topColor = new three.Color().set( 0xffffff );
			this.bottomColor = new three.Color().set( 0x000000 );
			this.exponent = 2;
			this.generationCallback = ( polar, uv, coord, color ) => {

				_direction.setFromSpherical( polar );

				const t = _direction.y * 0.5 + 0.5;
				color.lerpColors( this.bottomColor, this.topColor, t ** this.exponent );

			};

		}

		copy( other ) {

			super.copy( other );

			this.topColor.copy( other.topColor );
			this.bottomColor.copy( other.bottomColor );
			return this;

		}

	}

	// Material that tone maps a texture before performing interpolation to prevent
	// unexpected high values during texture stretching interpolation.
	// Emulates browser image stretching
	class ClampedInterpolationMaterial extends three.ShaderMaterial {

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
					#include <premultiplied_alpha_fragment>

				}
			`
			} );

			this.setValues( params );

		}

	}

	class CubeToEquirectMaterial extends three.ShaderMaterial {

		constructor() {

			super( {

				uniforms: {

					envMap: { value: null },
					flipEnvMap: { value: - 1 },

				},

				vertexShader: /* glsl */`
				varying vec2 vUv;
				void main() {

					vUv = uv;
					gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );

				}`,

				fragmentShader: /* glsl */`
				#define ENVMAP_TYPE_CUBE_UV

				uniform samplerCube envMap;
				uniform float flipEnvMap;
				varying vec2 vUv;

				#include <common>
				#include <cube_uv_reflection_fragment>

				${ util_functions }

				void main() {

					vec3 rayDirection = equirectUvToDirection( vUv );
					rayDirection.x *= flipEnvMap;
					gl_FragColor = textureCube( envMap, rayDirection );

				}`
			} );

			this.depthWrite = false;
			this.depthTest = false;

		}

	}

	class CubeToEquirectGenerator {

		constructor( renderer ) {

			this._renderer = renderer;
			this._quad = new Pass_js.FullScreenQuad( new CubeToEquirectMaterial() );

		}

		generate( source, width = null, height = null ) {

			if ( ! source.isCubeTexture ) {

				throw new Error( 'CubeToEquirectMaterial: Source can only be cube textures.' );

			}

			const image = source.images[ 0 ];
			const renderer = this._renderer;
			const quad = this._quad;

			// determine the dimensions if not provided
			if ( width === null ) {

				width = 4 * image.height;

			}

			if ( height === null ) {

				height = 2 * image.height;

			}

			const target = new three.WebGLRenderTarget( width, height, {
				type: three.FloatType,
				colorSpace: image.colorSpace,
			} );

			// prep the cube map data
			const imageHeight = image.height;
			const maxMip = Math.log2( imageHeight ) - 2;
			const texelHeight = 1.0 / imageHeight;
			const texelWidth = 1.0 / ( 3 * Math.max( Math.pow( 2, maxMip ), 7 * 16 ) );

			quad.material.defines.CUBEUV_MAX_MIP = `${ maxMip }.0`;
			quad.material.defines.CUBEUV_TEXEL_WIDTH = texelWidth;
			quad.material.defines.CUBEUV_TEXEL_HEIGHT = texelHeight;
			quad.material.uniforms.envMap.value = source;
			quad.material.uniforms.flipEnvMap.value = source.isRenderTargetTexture ? 1 : - 1;
			quad.material.needsUpdate = true;

			// save state and render the contents
			const currentTarget = renderer.getRenderTarget();
			const currentAutoClear = renderer.autoClear;
			renderer.autoClear = true;
			renderer.setRenderTarget( target );
			quad.render( renderer );
			renderer.setRenderTarget( currentTarget );
			renderer.autoClear = currentAutoClear;

			// read the data back
			const buffer = new Uint16Array( width * height * 4 );
			const readBuffer = new Float32Array( width * height * 4 );
			renderer.readRenderTargetPixels( target, 0, 0, width, height, readBuffer );
			target.dispose();

			for ( let i = 0, l = readBuffer.length; i < l; i ++ ) {

				buffer[ i ] = three.DataUtils.toHalfFloat( readBuffer[ i ] );

			}

			// produce the data texture
			const result = new three.DataTexture( buffer, width, height, three.RGBAFormat, three.HalfFloatType );
			result.minFilter = three.LinearMipMapLinearFilter;
			result.magFilter = three.LinearFilter;
			result.wrapS = three.RepeatWrapping;
			result.wrapT = three.RepeatWrapping;
			result.mapping = three.EquirectangularReflectionMapping;
			result.needsUpdate = true;

			return result;

		}

		dispose() {

			this._quad.dispose();

		}

	}

	function supportsFloatBlending( renderer ) {

		return renderer.extensions.get( 'EXT_float_blend' );

	}

	const _resolution = new three.Vector2();
	class WebGLPathTracer {

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
			this._clock = new three.Clock();
			this._compilePromise = null;

			this._lowResPathTracer = new PathTracingRenderer( renderer );
			this._lowResPathTracer.tiles.set( 1, 1 );
			this._quad = new Pass_js.FullScreenQuad( new ClampedInterpolationMaterial( {
				map: null,
				transparent: true,
				blending: three.NoBlending,

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
			this.textureSize = new three.Vector2( 1024, 1024 ); // preview default; final render bumps to 4096
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
			this.setScene( new three.Scene(), new three.PerspectiveCamera() );

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

				if ( sanitizedMap.type === three.HalfFloatType ) {

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

									floatData[ 4 * i + 0 ] = three.DataUtils.fromHalfFloat( data[ stride * i + 0 ] );
									floatData[ 4 * i + 1 ] = three.DataUtils.fromHalfFloat( data[ stride * i + 1 ] );
									floatData[ 4 * i + 2 ] = three.DataUtils.fromHalfFloat( data[ stride * i + 2 ] );
									floatData[ 4 * i + 3 ] = stride >= 4 ? three.DataUtils.fromHalfFloat( data[ stride * i + 3 ] ) : 1.0;

								}

								self._rasterEnvMap = new three.DataTexture( floatData, width, height, three.RGBAFormat, three.FloatType, three.EquirectangularReflectionMapping, three.RepeatWrapping, three.ClampToEdgeWrapping, three.LinearFilter, three.LinearFilter );
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
						quad.material.blending = this.dynamicLowRes ? three.AdditiveBlending : three.NormalBlending;

					}

					quad.material.map = pathTracer.target.texture;
					this.renderToCanvasCallback( pathTracer.target, renderer, quad );
					quad.material.blending = three.NoBlending;

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

	class EquirectCamera extends three.Camera {

		constructor() {

			super();

			this.isEquirectCamera = true;

		}

	}

	class PhysicalSpotLight extends three.SpotLight {

		constructor( ...args ) {

			super( ...args );

			this.iesMap = null;
			this.radius = 0;

		}

		copy( source, recursive ) {

			super.copy( source, recursive );

			this.iesMap = source.iesMap;
			this.radius = source.radius;

			return this;

		}

	}

	class ShapedAreaLight extends three.RectAreaLight {

		constructor( ...args ) {

			super( ...args );
			this.isCircular = false;

		}

		copy( source, recursive ) {

			super.copy( source, recursive );

			this.isCircular = source.isCircular;

			return this;

		}

	}

	class PMREMCopyMaterial extends MaterialBase {

		constructor() {

			super( {

				uniforms: {

					envMap: { value: null },
					blur: { value: 0 },

				},

				vertexShader: /* glsl */`

				varying vec2 vUv;
				void main() {
					vUv = uv;
					gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
				}

			`,

				fragmentShader: /* glsl */`

				#include <common>
				#include <cube_uv_reflection_fragment>

				${ util_functions }

				uniform sampler2D envMap;
				uniform float blur;
				varying vec2 vUv;
				void main() {

					vec3 rayDirection = equirectUvToDirection( vUv );
					gl_FragColor = textureCubeUV( envMap, rayDirection, blur );

				}

			`,

			} );

		}

	}

	class BlurredEnvMapGenerator {

		constructor( renderer ) {

			this.renderer = renderer;
			this.pmremGenerator = new three.PMREMGenerator( renderer );
			this.copyQuad = new Pass_js.FullScreenQuad( new PMREMCopyMaterial() );
			this.renderTarget = new three.WebGLRenderTarget( 1, 1, { type: three.FloatType, format: three.RGBAFormat } );

		}

		dispose() {

			this.pmremGenerator.dispose();
			this.copyQuad.dispose();
			this.renderTarget.dispose();

		}

		generate( texture, blur ) {

			const { pmremGenerator, renderTarget, copyQuad, renderer } = this;

			// get the pmrem target
			const pmremTarget = pmremGenerator.fromEquirectangular( texture );

			// set up the material
			const { width, height } = texture.image;
			renderTarget.setSize( width, height );
			copyQuad.material.envMap = pmremTarget.texture;
			copyQuad.material.blur = blur;

			// render
			const prevRenderTarget = renderer.getRenderTarget();
			const prevClear = renderer.autoClear;

			renderer.setRenderTarget( renderTarget );
			renderer.autoClear = true;
			copyQuad.render( renderer );

			renderer.setRenderTarget( prevRenderTarget );
			renderer.autoClear = prevClear;

			// read the data back
			const buffer = new Uint16Array( width * height * 4 );
			const readBuffer = new Float32Array( width * height * 4 );
			renderer.readRenderTargetPixels( renderTarget, 0, 0, width, height, readBuffer );

			for ( let i = 0, l = readBuffer.length; i < l; i ++ ) {

				buffer[ i ] = three.DataUtils.toHalfFloat( readBuffer[ i ] );

			}

			const result = new three.DataTexture( buffer, width, height, three.RGBAFormat, three.HalfFloatType );
			result.minFilter = texture.minFilter;
			result.magFilter = texture.magFilter;
			result.wrapS = texture.wrapS;
			result.wrapT = texture.wrapT;
			result.mapping = three.EquirectangularReflectionMapping;
			result.needsUpdate = true;

			// dispose of the now unneeded target
			pmremTarget.dispose();

			return result;

		}

	}

	class DenoiseMaterial extends MaterialBase {

		constructor( parameters ) {

			super( {

				blending: three.NoBlending,

				transparent: false,

				depthWrite: false,

				depthTest: false,

				defines: {

					USE_SLIDER: 0,

				},

				uniforms: {

					sigma: { value: 5.0 },
					threshold: { value: 0.03 },
					kSigma: { value: 1.0 },

					map: { value: null },
					opacity: { value: 1 },

				},

				vertexShader: /* glsl */`

				varying vec2 vUv;

				void main() {

					vUv = uv;
					gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );

				}

			`,

				fragmentShader: /* glsl */`

				//~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
				//  Copyright (c) 2018-2019 Michele Morrone
				//  All rights reserved.
				//
				//  https://michelemorrone.eu - https://BrutPitt.com
				//
				//  me@michelemorrone.eu - brutpitt@gmail.com
				//  twitter: @BrutPitt - github: BrutPitt
				//
				//  https://github.com/BrutPitt/glslSmartDeNoise/
				//
				//  This software is distributed under the terms of the BSD 2-Clause license
				//~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

				uniform sampler2D map;

				uniform float sigma;
				uniform float threshold;
				uniform float kSigma;
				uniform float opacity;

				varying vec2 vUv;

				#define INV_SQRT_OF_2PI 0.39894228040143267793994605993439
				#define INV_PI 0.31830988618379067153776752674503

				// Parameters:
				//	 sampler2D tex	 - sampler image / texture
				//	 vec2 uv		   - actual fragment coord
				//	 float sigma  >  0 - sigma Standard Deviation
				//	 float kSigma >= 0 - sigma coefficient
				//		 kSigma * sigma  -->  radius of the circular kernel
				//	 float threshold   - edge sharpening threshold
				vec4 smartDeNoise( sampler2D tex, vec2 uv, float sigma, float kSigma, float threshold ) {

					float radius = round( kSigma * sigma );
					float radQ = radius * radius;

					float invSigmaQx2 = 0.5 / ( sigma * sigma );
					float invSigmaQx2PI = INV_PI * invSigmaQx2;

					float invThresholdSqx2 = 0.5 / ( threshold * threshold );
					float invThresholdSqrt2PI = INV_SQRT_OF_2PI / threshold;

					vec4 centrPx = texture2D( tex, uv );
					centrPx.rgb *= centrPx.a;

					float zBuff = 0.0;
					vec4 aBuff = vec4( 0.0 );
					vec2 size = vec2( textureSize( tex, 0 ) );

					vec2 d;
					for ( d.x = - radius; d.x <= radius; d.x ++ ) {

						float pt = sqrt( radQ - d.x * d.x );

						for ( d.y = - pt; d.y <= pt; d.y ++ ) {

							float blurFactor = exp( - dot( d, d ) * invSigmaQx2 ) * invSigmaQx2PI;

							vec4 walkPx = texture2D( tex, uv + d / size );
							walkPx.rgb *= walkPx.a;

							vec4 dC = walkPx - centrPx;
							float deltaFactor = exp( - dot( dC.rgba, dC.rgba ) * invThresholdSqx2 ) * invThresholdSqrt2PI * blurFactor;

							zBuff += deltaFactor;
							aBuff += deltaFactor * walkPx;

						}

					}

					return aBuff / zBuff;

				}

				void main() {

					gl_FragColor = smartDeNoise( map, vec2( vUv.x, vUv.y ), sigma, kSigma, threshold );
					#include <tonemapping_fragment>
					#include <colorspace_fragment>
					#include <premultiplied_alpha_fragment>

					gl_FragColor.a *= opacity;

				}

			`

			} );

			this.setValues( parameters );

		}

	}

	class FogVolumeMaterial extends three.MeshStandardMaterial {

		constructor( params ) {

			super( params );

			this.isFogVolumeMaterial = true;

			this.density = 0.015;
			this.emissive = new three.Color();
			this.emissiveIntensity = 0.0;
			this.opacity = 0.15;
			this.transparent = true;
			this.roughness = 1.0;
			this.metalness = 0.0;

			this.setValues( params );

		}

	}

	// core

	exports.BlurredEnvMapGenerator = BlurredEnvMapGenerator;
	exports.DenoiseMaterial = DenoiseMaterial;
	exports.DynamicPathTracingSceneGenerator = DynamicPathTracingSceneGenerator;
	exports.EquirectCamera = EquirectCamera;
	exports.FogVolumeMaterial = FogVolumeMaterial;
	exports.GradientEquirectTexture = GradientEquirectTexture;
	exports.PathTracingRenderer = PathTracingRenderer;
	exports.PathTracingSceneGenerator = PathTracingSceneGenerator;
	exports.PathTracingSceneWorker = PathTracingSceneWorker;
	exports.PhysicalCamera = PhysicalCamera;
	exports.PhysicalPathTracingMaterial = PhysicalPathTracingMaterial;
	exports.PhysicalSpotLight = PhysicalSpotLight;
	exports.ProceduralEquirectTexture = ProceduralEquirectTexture;
	exports.ShapedAreaLight = ShapedAreaLight;
	exports.WebGLPathTracer = WebGLPathTracer;

	Object.defineProperty(exports, '__esModule', { value: true });

}));
//# sourceMappingURL=three-pathtracer.cdn.js.map
