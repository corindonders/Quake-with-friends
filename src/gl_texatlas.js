// World diffuse-texture atlasing.
//
// The renderer already batches same-(texture,lightmap) surfaces into one
// THREE.BatchedMesh each (see R_BuildWorldMeshes in gl_rsurf.js), but a map
// with hundreds of *different* textures visible at once (Arcane
// Dimensions' "start" hub measured ~1000 resident textures) still ends up
// with one BatchedMesh -- one material bind -- per unique texture. Packing
// multiple textures into a shared atlas page lets surfaces that used to
// need separate materials share one, collapsing many BatchedMeshes into
// few.
//
// This can't safely apply to every texture:
//   - Repeating/tiling surfaces (UVs outside roughly [0,1]) would sample
//     across atlas page boundaries into a neighboring texture ("bleeding")
//     without a custom wrap-aware shader, which this doesn't implement.
//     Surfaces with out-of-range UVs are left on their own material.
//   - Animated textures (water, buttons, '+0anim' sequences) swap their
//     GL texture frame-to-frame; baking one frame into a static atlas
//     would freeze the animation. Skipped.
//   - Masked ('{'-prefixed) textures need per-pixel alpha testing right at
//     their own edges; atlas padding would corrupt that. Skipped.
//   - Textures with a fullbright emissive layer (see GL_LoadTexture's
//     splitFullbright) would need the emissive map atlased in the exact
//     same layout too, which this doesn't do. Skipped.
//
// None of that is exhaustive detection of "is this texture ever tiled
// anywhere in the map" -- it's a per-surface, per-use check, which is
// exactly right: the same texture might tile on one wall and not on
// another, and each use is judged independently.

import * as THREE from 'three';

const ATLAS_SIZE = 2048;
const PADDING = 2; // pixels of edge-clamped border around each packed texture, avoids mip-map bleeding at seams

/*
=================
_isEligible

A texture can only be atlased if every use we're considering is a plain,
static, unmasked, non-fullbright, axis-aligned [0,1] UV rectangle.
=================
*/
function _isEligible( texture ) {

	if ( ! texture || ! texture.image || ! texture.image.data ) return false;
	if ( texture._masked === true ) return false;
	if ( texture._fullbright != null ) return false;
	if ( texture.image.width > ATLAS_SIZE - PADDING * 2 ) return false;
	if ( texture.image.height > ATLAS_SIZE - PADDING * 2 ) return false;
	return true;

}

/*
=================
_uvInRange

True if every UV in this geometry's 'uv' attribute is within [0,1] (with a
small epsilon) -- i.e. this particular surface doesn't tile its texture.
=================
*/
function _uvInRange( geom ) {

	const uv = geom.getAttribute( 'uv' );
	if ( ! uv ) return false;

	const EPS = 0.001;
	const arr = uv.array;
	for ( let i = 0; i < arr.length; i ++ ) {

		if ( arr[ i ] < - EPS || arr[ i ] > 1 + EPS ) return false;

	}

	return true;

}

/*
=================
_drawIntoAtlas

Paints a DataTexture's raw RGBA pixels into the atlas canvas at (x, y),
plus a PADDING-px edge-clamped border so linear filtering/mipmapping at
the atlas seam doesn't bleed in a neighboring texture's pixels.
=================
*/
function _drawIntoAtlas( ctx, texture, x, y ) {

	const { width, height, data } = texture.image;
	const imageData = new ImageData( new Uint8ClampedArray( data.buffer, data.byteOffset, data.length ), width, height );

	const scratch = document.createElement( 'canvas' );
	scratch.width = width;
	scratch.height = height;
	scratch.getContext( '2d' ).putImageData( imageData, 0, 0 );

	// Edge-clamped border: stretch the outermost 1px row/column of the
	// source image into the padding area on each side.
	if ( PADDING > 0 ) {

		ctx.drawImage( scratch, 0, 0, width, 1, x, y - PADDING, width, PADDING ); // top
		ctx.drawImage( scratch, 0, height - 1, width, 1, x, y + height, width, PADDING ); // bottom
		ctx.drawImage( scratch, 0, 0, 1, height, x - PADDING, y, PADDING, height ); // left
		ctx.drawImage( scratch, width - 1, 0, 1, height, x + width, y, PADDING, height ); // right

	}

	ctx.drawImage( scratch, x, y );

}

/*
=================
GL_BuildTextureAtlas

candidates: iterable of THREE.DataTexture (world diffuse textures).
Returns { rectFor(texture) -> {page, u0, v0, u1, v1} | null, pages: THREE.CanvasTexture[] }.
Textures that don't fit any atlas eligibility rule simply won't appear in
the returned map -- callers should fall back to their normal per-texture
material for anything rectFor() returns null for.
=================
*/
export function GL_BuildTextureAtlas( candidates ) {

	const eligible = [];
	for ( const tex of candidates ) if ( _isEligible( tex ) ) eligible.push( tex );

	// Largest-first shelf packing -- simple, and good enough here since
	// Quake textures are typically small and fairly uniform in size.
	eligible.sort( ( a, b ) => b.image.height - a.image.height );

	const rectById = new Map();
	const pages = [];
	let ctx = null;
	let cursorX = 0, shelfY = 0, shelfHeight = 0;

	function newPage() {

		const canvas = document.createElement( 'canvas' );
		canvas.width = ATLAS_SIZE;
		canvas.height = ATLAS_SIZE;
		ctx = canvas.getContext( '2d' );
		pages.push( canvas );
		cursorX = 0; shelfY = 0; shelfHeight = 0;

	}

	newPage();

	for ( const tex of eligible ) {

		const w = tex.image.width + PADDING * 2;
		const h = tex.image.height + PADDING * 2;

		if ( cursorX + w > ATLAS_SIZE ) {

			cursorX = 0;
			shelfY += shelfHeight;
			shelfHeight = 0;

		}

		if ( shelfY + h > ATLAS_SIZE ) newPage();

		const x = cursorX + PADDING;
		const y = shelfY + PADDING;

		_drawIntoAtlas( ctx, tex, x, y );

		rectById.set( tex.id, {
			page: pages.length - 1,
			u0: x / ATLAS_SIZE,
			v0: y / ATLAS_SIZE,
			u1: ( x + tex.image.width ) / ATLAS_SIZE,
			v1: ( y + tex.image.height ) / ATLAS_SIZE
		} );

		cursorX += w;
		shelfHeight = Math.max( shelfHeight, h );

	}

	const pageTextures = pages.map( ( canvas ) => {

		const t = new THREE.CanvasTexture( canvas );
		t.magFilter = THREE.NearestFilter;
		t.minFilter = THREE.NearestFilter;
		t.colorSpace = THREE.SRGBColorSpace;
		t.needsUpdate = true;
		return t;

	} );

	return {
		rectFor( texture ) {

			return rectById.get( texture.id ) || null;

		},
		pages: pageTextures
	};

}

/*
=================
GL_RemapUVsToAtlasRect

Remaps a geometry's existing [0,1] 'uv' attribute in place to the given
atlas sub-rectangle. Call only on geometry already confirmed eligible
(see _uvInRange in R_BuildWorldMeshes).
=================
*/
export function GL_RemapUVsToAtlasRect( geom, rect ) {

	const uv = geom.getAttribute( 'uv' );
	const arr = uv.array;
	const du = rect.u1 - rect.u0;
	const dv = rect.v1 - rect.v0;

	for ( let i = 0; i < arr.length; i += 2 ) {

		arr[ i ] = rect.u0 + arr[ i ] * du;
		arr[ i + 1 ] = rect.v0 + arr[ i + 1 ] * dv;

	}

	uv.needsUpdate = true;

}

export { _uvInRange as GL_UVInRange };
