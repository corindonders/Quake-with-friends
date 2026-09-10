// Modern TGA-cubemap skybox support -- reads a map's worldspawn "sky" (or
// ericw-tools' "_sky") key and, if present, loads the 6 face textures
// (gfx/env/<name>{rt,lf,up,dn,ft,bk}.tga) as a Three.js cube-mapped
// scene.background. Layered on top of, not replacing, the classic
// procedural scrolling sky in gl_rsurf.js's R_DrawSkyChain -- maps that
// don't specify one (the vast majority of original id1-era maps) keep
// using that unchanged; R_DrawSkyChain skips drawing entirely while a
// cubemap skybox is active, letting the background show through instead.

import * as THREE from 'three';
import { TGALoader } from 'three/addons/loaders/TGALoader.js';
import { Con_Printf } from './console.js';

const _loader = new TGALoader();
const _cache = new Map(); // skyName -> THREE.CubeTexture

// Three.js CubeTexture face order is [+X, -X, +Y, -Y, +Z, -Z]. id-software
// skybox sets are traditionally named for that same right/left/up/down/
// front/back layout.
const FACE_SUFFIXES = [ 'rt', 'lf', 'up', 'dn', 'ft', 'bk' ];

let _currentSkyName = null;

/*
=================
R_ExtractWorldspawnSky

Pulls the "_sky" (or plain "sky") value out of a map's raw entity lump
text -- always worldspawn, the first entity block. QuakeC never sees this
key (it's not a declared field on vanilla progs.dat), so it has to be
read here rather than via the normal entity-spawn path.
=================
*/
export function R_ExtractWorldspawnSky( entitiesText ) {

	if ( ! entitiesText ) return '';

	const blockEnd = entitiesText.indexOf( '}' );
	const block = blockEnd >= 0 ? entitiesText.slice( 0, blockEnd ) : entitiesText;

	let m = block.match( /"_sky"\s*"([^"]*)"/ );
	if ( ! m ) m = block.match( /"sky"\s*"([^"]*)"/ );

	return m ? m[ 1 ].trim() : '';

}

/*
=================
R_SkyboxActive

Whether a cubemap skybox is set for the current map -- R_DrawSkyChain
checks this to skip the classic procedural sky.
=================
*/
export function R_SkyboxActive() {

	return !! _currentSkyName;

}

/*
=================
R_SetSky

Called once per map load (see R_NewMap in gl_rmain.js) with whatever
R_ExtractWorldspawnSky found. Empty string clears any previous skybox.
=================
*/
export function R_SetSky( skyName, scene ) {

	const name = ( skyName || '' ).trim();
	if ( name === _currentSkyName ) return;

	_currentSkyName = name;

	if ( name === '' ) {

		if ( scene ) scene.background = null;
		return;

	}

	_loadCubeTexture( name ).then( ( tex ) => {

		// The map may have changed again (or the skybox cleared) while this
		// was in flight -- don't stomp whatever's current now.
		if ( _currentSkyName !== name || ! scene ) return;
		scene.background = tex;

	} ).catch( ( e ) => {

		Con_Printf( 'Could not load skybox "' + name + '": ' + e.message + '\n' );
		_currentSkyName = null;
		if ( scene ) scene.background = null;

	} );

}

function _imageDataToCanvas( image ) {

	const canvas = document.createElement( 'canvas' );
	canvas.width = image.width;
	canvas.height = image.height;

	const ctx = canvas.getContext( '2d' );
	const imageData = new ImageData( new Uint8ClampedArray( image.data.buffer, image.data.byteOffset, image.data.length ), image.width, image.height );

	if ( image.flipY ) {

		// putImageData ignores canvas transforms, so flip via an
		// intermediate canvas instead.
		const src = document.createElement( 'canvas' );
		src.width = image.width;
		src.height = image.height;
		src.getContext( '2d' ).putImageData( imageData, 0, 0 );

		ctx.translate( 0, image.height );
		ctx.scale( 1, - 1 );
		ctx.drawImage( src, 0, 0 );

	} else {

		ctx.putImageData( imageData, 0, 0 );

	}

	return canvas;

}

function _loadCubeTexture( name ) {

	const cached = _cache.get( name );
	if ( cached ) return Promise.resolve( cached );

	const loads = FACE_SUFFIXES.map( ( suffix ) => new Promise( ( resolve, reject ) => {

		const url = 'gfx/env/' + name + suffix + '.tga';
		// TGALoader is a DataTextureLoader: texture.image is raw
		// {data,width,height} pixels, not a canvas/ImageBitmap -- CubeTexture
		// (and WebGL's texSubImage2D under it) needs an actual image source,
		// so paint the decoded pixels onto a canvas ourselves.
		_loader.load( url, ( texture ) => resolve( _imageDataToCanvas( texture.image ) ), undefined,
			() => reject( new Error( url + ' not found' ) ) );

	} ) );

	return Promise.all( loads ).then( ( images ) => {

		const cubeTexture = new THREE.CubeTexture( images );
		cubeTexture.needsUpdate = true;
		_cache.set( name, cubeTexture );
		return cubeTexture;

	} );

}
