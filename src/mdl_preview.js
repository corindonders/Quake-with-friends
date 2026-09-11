// Minimal standalone Quake .mdl (alias model) loader + viewer, for the wiki's
// 3D preview panel. Deliberately independent of the full engine (gl_model.js,
// pak.js, etc) -- those are all tightly coupled to a fully booted game
// instance (loadmodel/mod_base globals, a running renderer, precache state),
// which the wiki page never has. This re-implements just enough of the PACK
// and MDL binary formats (mirroring gl_model.js's Mod_LoadAliasModel byte for
// byte) to render one static frame of one model in an isolated Three.js
// scene.
//
// Only handles what a preview needs: frame 0 (or a group frame's first pose)
// of a single-skin or skin-group model, decoded to a real mesh + texture.
// No animation blending, no player-model remapping, no other model types.

import * as THREE from 'three';

const IDPOLYHEADER = 0x4f504449; // 'IDPO' little-endian
const ALIAS_VERSION = 6;
const ALIAS_SINGLE = 0;

let _packFiles = null; // Map<lowercaseName, Uint8Array>
let _palette = null; // Uint8Array[768], RGB triplets

/*
=================
MDLPreview_LoadPaks

Fetches and indexes one or more .pak files (in priority order -- later
ones win on name collisions, matching COM_AddPack's "last added wins"
semantics). Call once before MDLPreview_Load.
=================
*/
export async function MDLPreview_LoadPaks( urls ) {

	_packFiles = new Map();

	for ( const url of urls ) {

		const res = await fetch( url );
		if ( ! res.ok ) continue;

		const buf = await res.arrayBuffer();
		const view = new DataView( buf );
		const bytes = new Uint8Array( buf );

		if ( view.getUint8( 0 ) !== 0x50 || view.getUint8( 1 ) !== 0x41 ||
			view.getUint8( 2 ) !== 0x43 || view.getUint8( 3 ) !== 0x4b ) continue; // 'PACK'

		const dirofs = view.getInt32( 4, true );
		const dirlen = view.getInt32( 8, true );
		const count = Math.floor( dirlen / 64 );

		for ( let i = 0; i < count; i ++ ) {

			const entryOfs = dirofs + i * 64;
			let name = '';
			for ( let j = 0; j < 56; j ++ ) {

				const c = bytes[ entryOfs + j ];
				if ( c === 0 ) break;
				name += String.fromCharCode( c );

			}

			const filepos = view.getInt32( entryOfs + 56, true );
			const filelen = view.getInt32( entryOfs + 60, true );
			_packFiles.set( name.toLowerCase(), new Uint8Array( buf, filepos, filelen ) );

		}

	}

	const paletteFile = _packFiles.get( 'gfx/palette.lmp' );
	if ( paletteFile ) _palette = paletteFile;

}

function _findFile( name ) {

	return _packFiles ? _packFiles.get( name.toLowerCase() ) || null : null;

}

/*
=================
_decodeSkin

Indexed 8-bit skin -> RGBA Uint8ClampedArray via the game palette. Index
255 is the standard Quake "transparent" sentinel (used by a few skins,
e.g. eyes/fire models) -- treated as alpha 0.
=================
*/
function _decodeSkin( indices, width, height ) {

	const out = new Uint8ClampedArray( width * height * 4 );

	for ( let i = 0; i < width * height; i ++ ) {

		const idx = indices[ i ];
		const o = i * 4;

		if ( idx === 255 ) {

			out[ o ] = out[ o + 1 ] = out[ o + 2 ] = out[ o + 3 ] = 0;

		} else {

			out[ o ] = _palette[ idx * 3 ];
			out[ o + 1 ] = _palette[ idx * 3 + 1 ];
			out[ o + 2 ] = _palette[ idx * 3 + 2 ];
			out[ o + 3 ] = 255;

		}

	}

	return out;

}

/*
=================
MDLPreview_Load

Parses a single .mdl file (already located via MDLPreview_LoadPaks) and
returns { geometry, texture, radius } for the caller to build a Mesh
from, or null if the model wasn't found / isn't a valid .mdl.
=================
*/
export function MDLPreview_Load( modelPath ) {

	const buf = _findFile( modelPath );
	if ( ! buf || ! _palette ) return null;

	const arrayBuf = buf.buffer.slice( buf.byteOffset, buf.byteOffset + buf.byteLength );
	const view = new DataView( arrayBuf );

	if ( view.getInt32( 0, true ) !== IDPOLYHEADER ) return null;
	if ( view.getInt32( 4, true ) !== ALIAS_VERSION ) return null;

	// mdl_t: ident(4) version(4) scale[3](12) scale_origin[3](12)
	// boundingradius(4) eyeposition[3](12) numskins(4) skinwidth(4)
	// skinheight(4) numverts(4) numtris(4) numframes(4) synctype(4)
	// flags(4) size(4) = 84 bytes total
	const scale = [ view.getFloat32( 8, true ), view.getFloat32( 12, true ), view.getFloat32( 16, true ) ];
	const scaleOrigin = [ view.getFloat32( 20, true ), view.getFloat32( 24, true ), view.getFloat32( 28, true ) ];
	const boundingradius = view.getFloat32( 32, true );
	const numskins = view.getInt32( 48, true );
	const skinwidth = view.getInt32( 52, true );
	const skinheight = view.getInt32( 56, true );
	const numverts = view.getInt32( 60, true );
	const numtris = view.getInt32( 64, true );
	const numframes = view.getInt32( 68, true );

	if ( numverts <= 0 || numtris <= 0 || numframes < 1 || numskins < 1 ) return null;

	let pos = 84;

	// -------- skins (only the first is used for the preview) --------
	const skinSize = skinwidth * skinheight;
	let firstSkinIndices = null;

	for ( let i = 0; i < numskins; i ++ ) {

		const skinType = view.getInt32( pos, true );
		pos += 4;

		if ( skinType === 0 ) { // single

			const indices = new Uint8Array( arrayBuf, pos, skinSize );
			if ( ! firstSkinIndices ) firstSkinIndices = indices;
			pos += skinSize;

		} else { // group -- skip interval table, take the first sub-skin

			const groupCount = view.getInt32( pos, true );
			pos += 4 + groupCount * 4; // numskins + float interval[groupCount]

			for ( let j = 0; j < groupCount; j ++ ) {

				const indices = new Uint8Array( arrayBuf, pos, skinSize );
				if ( ! firstSkinIndices ) firstSkinIndices = indices;
				pos += skinSize;

			}

		}

	}

	// -------- st verts: int onseam, int s, int t (12 bytes each) --------
	const stverts = new Array( numverts );
	for ( let i = 0; i < numverts; i ++ ) {

		const o = pos + i * 12;
		stverts[ i ] = {
			onseam: view.getInt32( o, true ),
			s: view.getInt32( o + 4, true ),
			t: view.getInt32( o + 8, true )
		};

	}

	pos += numverts * 12;

	// -------- triangles: int facesfront, int vertindex[3] (16 bytes each) --------
	const triangles = new Array( numtris );
	for ( let i = 0; i < numtris; i ++ ) {

		const o = pos + i * 16;
		triangles[ i ] = {
			facesfront: view.getInt32( o, true ),
			vertindex: [ view.getInt32( o + 4, true ), view.getInt32( o + 8, true ), view.getInt32( o + 12, true ) ]
		};

	}

	pos += numtris * 16;

	// -------- first frame only --------
	const frameType = view.getInt32( pos, true );
	pos += 4;

	let poseOffset;
	if ( frameType === ALIAS_SINGLE ) {

		// daliasframe_t: bboxmin(4) bboxmax(4) name(16) = 24, then trivertx_t[numverts]
		poseOffset = pos + 24;

	} else {

		// daliasgroup_t: numframes(4) bboxmin(4) bboxmax(4) = 12, then
		// float interval[numframes], then daliasframe_t per sub-frame --
		// only the first sub-frame's pose is needed for a static preview.
		const groupFrames = view.getInt32( pos, true );
		poseOffset = pos + 12 + groupFrames * 4 + 24;

	}

	const poseBytes = new Uint8Array( arrayBuf, poseOffset, numverts * 4 );

	// -------- build a flat (non-indexed) triangle soup, since a vertex on
	// the skin seam needs two different U values depending on which side
	// of the model the triangle using it faces (see gl_mesh.js) --------
	const positions = new Float32Array( numtris * 3 * 3 );
	const uvs = new Float32Array( numtris * 3 * 2 );

	for ( let t = 0; t < numtris; t ++ ) {

		const tri = triangles[ t ];

		for ( let c = 0; c < 3; c ++ ) {

			const vi = tri.vertindex[ c ];
			const vo = vi * 4;

			const x = scaleOrigin[ 0 ] + poseBytes[ vo ] * scale[ 0 ];
			const y = scaleOrigin[ 1 ] + poseBytes[ vo + 1 ] * scale[ 1 ];
			const z = scaleOrigin[ 2 ] + poseBytes[ vo + 2 ] * scale[ 2 ];

			const outIdx = ( t * 3 + c );
			// Quake's Z is up; rotate into Three's Y-up convention.
			positions[ outIdx * 3 ] = x;
			positions[ outIdx * 3 + 1 ] = z;
			positions[ outIdx * 3 + 2 ] = - y;

			let s = stverts[ vi ].s;
			if ( ! tri.facesfront && stverts[ vi ].onseam ) s += skinwidth / 2;
			uvs[ outIdx * 2 ] = ( s + 0.5 ) / skinwidth;
			uvs[ outIdx * 2 + 1 ] = ( stverts[ vi ].t + 0.5 ) / skinheight;

		}

	}

	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute( 'position', new THREE.BufferAttribute( positions, 3 ) );
	geometry.setAttribute( 'uv', new THREE.BufferAttribute( uvs, 2 ) );
	geometry.computeVertexNormals();

	const rgba = _decodeSkin( firstSkinIndices, skinwidth, skinheight );
	const texture = new THREE.DataTexture( rgba, skinwidth, skinheight, THREE.RGBAFormat );
	texture.magFilter = THREE.NearestFilter;
	texture.minFilter = THREE.NearestFilter;
	// flipY defaults to false for DataTexture, which is correct here -- the
	// (s,t) formula above matches gl_model.js's real loader exactly, which
	// relies on that default (see its comment at the skin-texture setup).
	texture.needsUpdate = true;

	return { geometry, texture, radius: boundingradius || 40 };

}
