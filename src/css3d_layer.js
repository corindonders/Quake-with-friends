// Thin wrapper around Three.js's CSS3DRenderer -- a second, DOM-backed render
// layer that sits on top of the WebGL canvas and shares its camera. Lets
// ordinary interactive DOM (selects, buttons, inputs) be positioned and
// oriented as if it were part of the 3D scene, instead of a flat fixed
// overlay. Used by worldspace_ui.js for panels that should read as "part of
// the map" (see DEVELOPMENT.md v1 build order item 3).

import * as THREE from 'three';
import { CSS3DRenderer, CSS3DObject } from 'three/addons/renderers/CSS3DRenderer.js';

export { CSS3DObject };

let cssRenderer = null;
export const css3dScene = new THREE.Scene();

/**
 * Create the CSS3D render layer and attach it over the WebGL canvas.
 * Safe to call once at startup, independent of map load/unload -- the
 * scene and renderer here are never torn down for the life of the page.
 */
export function CSS3D_Init() {

	if ( cssRenderer != null ) return;

	cssRenderer = new CSS3DRenderer();
	cssRenderer.setSize( window.innerWidth, window.innerHeight );

	const el = cssRenderer.domElement;
	el.style.position = 'fixed';
	el.style.top = '0';
	el.style.left = '0';
	// The layer covers the whole viewport so panels can be positioned
	// anywhere in it, but must never itself intercept mouse-look -- only
	// the individual panel elements re-enable pointer events (CSS3DObject
	// sets that on its own element).
	el.style.pointerEvents = 'none';
	el.style.zIndex = '40'; // above the game canvas, below travel_ui's fixed overlays

	document.body.appendChild( el );

	window.addEventListener( 'resize', () => {

		cssRenderer.setSize( window.innerWidth, window.innerHeight );

	} );

}

/**
 * Render the CSS3D scene with the given (shared) camera. Call once per
 * frame alongside the WebGL render -- cheap when css3dScene is empty.
 */
export function CSS3D_Render( camera ) {

	if ( cssRenderer == null || camera == null ) return;

	cssRenderer.render( css3dScene, camera );

}
