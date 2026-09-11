// Modern-source-port-style anti-aliasing: Three.js's WebGLRenderer only
// supports MSAA as a fixed construction-time flag (recreating the renderer
// mid-game means a new WebGL context and re-uploading everything to the
// GPU), so this uses an FXAA post-process pass instead -- toggleable at any
// time via the r_antialias cvar, same as QuakeSpasm/Ironwail's AA options.
//
// Falls back to a plain renderer.render() call when disabled (zero
// overhead) or in WebXR (stereo rendering doesn't go through this composer).

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';

let composer = null;
let renderPass = null;
let fxaaPass = null;

/*
=================
PostFX_Init

Builds the composer chain lazily, on the first PostFX_Render call -- scene
and camera are both recreated by R_NewMap on every map load (and camera
doesn't exist yet this early in Host_Init either), so there's no single
"do this once at startup" point where all three of renderer/scene/camera
are guaranteed non-null. PostFX_Render already re-points renderPass at
whichever scene/camera are current each call.
=================
*/
function PostFX_Init( renderer, scene, camera ) {

	composer = new EffectComposer( renderer );

	renderPass = new RenderPass( scene, camera );
	composer.addPass( renderPass );

	fxaaPass = new ShaderPass( FXAAShader );
	composer.addPass( fxaaPass );

	// OutputPass applies the renderer's own tone mapping + color space
	// conversion, which a composer chain otherwise skips (RenderPass's
	// intermediate target is linear, not sRGB-encoded).
	composer.addPass( new OutputPass() );

	const size = new THREE.Vector2();
	renderer.getSize( size );
	PostFX_Resize( size.x, size.y );

}

/*
=================
PostFX_Resize

Called whenever the canvas resizes (see vid.js's resize listener).
=================
*/
export function PostFX_Resize( width, height ) {

	if ( ! composer ) return;

	const pixelRatio = composer.renderer.getPixelRatio();
	composer.setSize( width, height );
	fxaaPass.material.uniforms[ 'resolution' ].value.set(
		1 / ( width * pixelRatio ),
		1 / ( height * pixelRatio )
	);

}

/*
=================
PostFX_Render

Renders `scene`/`camera` through the FXAA composer chain when r_antialias
is enabled, otherwise a plain renderer.render() (matches pre-AA behavior
exactly, including honoring renderer.autoClear=false semantics elsewhere
in the frame -- R_Clear already cleared before this runs).
=================
*/
export function PostFX_Render( renderer, scene, camera, useAA ) {

	if ( ! useAA ) {

		renderer.render( scene, camera );
		return;

	}

	if ( ! composer ) PostFX_Init( renderer, scene, camera );

	// Scene/camera can change identity across a map load (R_NewMap builds a
	// fresh THREE.Scene) -- keep the composer's RenderPass pointed at the
	// current ones rather than rebuilding the whole composer.
	if ( renderPass.scene !== scene ) renderPass.scene = scene;
	if ( renderPass.camera !== camera ) renderPass.camera = camera;

	composer.render();

}
