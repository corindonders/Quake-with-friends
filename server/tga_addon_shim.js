// Stub for "three/addons/loaders/TGALoader.js" when running under Deno.
//
// gl_skybox.js instantiates a TGALoader at module scope for loading skybox
// textures, but skyboxes are a purely client-side rendering concern -- the
// server never calls .load(). This exists only so the import resolves.
export class TGALoader {

	load( url, onLoad, onProgress, onError ) {

		if ( onError ) onError( new Error( 'TGALoader is not available server-side' ) );

	}

}
