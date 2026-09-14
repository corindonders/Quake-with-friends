// Stub for "three/addons/renderers/CSS3DRenderer.js" when running under Deno.
//
// css3d_layer.js instantiates a CSS3DRenderer to position DOM panels in the
// 3D scene, but that's a purely client-side (browser DOM) concern -- the
// server never renders. This exists only so the import resolves.
export class CSS3DRenderer {

	setSize() {}
	render() {}

	get domElement() {

		return { style: {} };

	}

}

export class CSS3DObject {

	constructor( element ) {

		this.element = element || { style: {} };
		this.position = { set() {} };
		this.rotation = { set() {}, y: 0 };
		this.scale = { set() {} };

	}

}
