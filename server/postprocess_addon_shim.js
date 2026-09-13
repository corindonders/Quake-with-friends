// Stub for "three/addons/postprocessing/*" and "three/addons/shaders/FXAAShader.js"
// when running under Deno.
//
// gl_postprocess.js instantiates an EffectComposer/pass chain at module scope
// for client-side rendering, but the server never renders a frame -- this
// exists only so the imports resolve.
export class EffectComposer {

	addPass() {}
	setSize() {}
	setPixelRatio() {}
	render() {}
	dispose() {}

}

export class RenderPass {

	constructor() {}

}

export class ShaderPass {

	constructor() {

		this.uniforms = {};

	}

}

export class OutputPass {

	constructor() {}

}

export const FXAAShader = {
	uniforms: {},
	vertexShader: '',
	fragmentShader: '',
};
