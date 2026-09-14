// Generic worldspace UI framework for interactive elements in the 3D world.
//
// Manages a 3D trigger object (mesh) with proximity detection, look-at visibility,
// and keyboard interaction (E key). The trigger can be associated with a DOM panel
// that shows/hides when the player interacts with it.
//
// Usage:
//   const trigger = new WorldspaceUITrigger({
//     world: cl.worldmodel,
//     scene: scene,
//     position: [x, y, z],
//     size: { width: 32, height: 32, depth: 64 },
//     color: 0xb23b2e,
//     range: 96,
//     onProximityEnter: () => {},
//     onProximityExit: () => {},
//     onInteract: () => {},
//   });
//   // In game loop: trigger.frame();

import * as THREE from 'three';
import { cl, cls, ca_connected } from './client.js';
import { r_refdef } from './render.js';
import { css3dScene, CSS3DObject } from './css3d_layer.js';

export class WorldspaceUITrigger {

	constructor( options ) {

		this.world = options.world;
		this.scene = options.scene;
		this.position = options.position;
		this.size = options.size || { width: 32, height: 32, depth: 64 };
		this.color = options.color || 0xffffff;
		this.range = options.range || 96;

		this.onProximityEnter = options.onProximityEnter || (() => {});
		this.onProximityExit = options.onProximityExit || (() => {});
		this.onInteract = options.onInteract || (() => {});

		this.mesh = null;
		this.worldName = options.worldName || '';
		this.inRange = false;
		this.keydownHandler = null;

	}

	/**
	 * Place the trigger mesh in the scene. Should be called when the world model changes.
	 */
	place() {

		if ( this.mesh !== null && this.scene ) {

			this.scene.remove( this.mesh );

		}

		if ( this.world == null || this.scene == null ) return;
		if ( this.worldName === this.world.name ) return;

		this.worldName = this.world.name;

		const geometry = new THREE.BoxGeometry(
			this.size.width,
			this.size.height,
			this.size.depth
		);

		const material = new THREE.MeshBasicMaterial(
			{ color: this.color, side: THREE.DoubleSide }
		);

		this.mesh = new THREE.Mesh( geometry, material );
		this.mesh.position.set( ...this.position );

		this.scene.add( this.mesh );

	}

	/**
	 * Remove the trigger mesh from the scene.
	 */
	remove() {

		if ( this.mesh === null ) return;

		if ( this.scene != null ) this.scene.remove( this.mesh );

		if ( this.mesh.geometry ) this.mesh.geometry.dispose();
		if ( this.mesh.material ) this.mesh.material.dispose();

		this.mesh = null;
		this.worldName = '';

	}

	/**
	 * Update proximity state based on player distance. Called once per frame.
	 */
	updateProximity() {

		if ( cls.state !== ca_connected ) {

			if ( this.inRange ) {

				this.inRange = false;
				this.onProximityExit();

			}

			return;

		}

		if ( this.mesh === null ) {

			if ( this.inRange ) {

				this.inRange = false;
				this.onProximityExit();

			}

			return;

		}

		// Calculate distance from player eye to trigger center
		const dx = r_refdef.vieworg[ 0 ] - this.mesh.position.x;
		const dy = r_refdef.vieworg[ 1 ] - this.mesh.position.y;
		const dz = r_refdef.vieworg[ 2 ] - this.mesh.position.z;
		const distSquared = dx * dx + dy * dy + dz * dz;
		const inRange = distSquared <= this.range * this.range;

		if ( inRange !== this.inRange ) {

			this.inRange = inRange;

			if ( inRange ) {

				this.onProximityEnter();

			} else {

				this.onProximityExit();

			}

		}

	}

	/**
	 * Called once per frame from the game loop. Updates proximity and checks for interaction.
	 */
	frame() {

		// Sync mesh with world model
		const world = cl.worldmodel;
		if ( world !== this.world ) {

			this.world = world;
			if ( world !== null ) {

				this.place();

			} else {

				this.remove();

			}

		}

		// Update proximity state
		this.updateProximity();

	}

	/**
	 * Register keyboard handler for interaction (E key).
	 */
	registerKeyHandler() {

		if ( this.keydownHandler ) return;

		this.keydownHandler = (event) => {

			if ( event.key !== 'e' && event.key !== 'E' ) return;
			if ( event.target !== document.body && event.target !== document.documentElement ) return;
			if ( ! this.inRange ) return;

			this.onInteract();

		};

		document.addEventListener( 'keydown', this.keydownHandler );

	}

	/**
	 * Unregister keyboard handler.
	 */
	unregisterKeyHandler() {

		if ( ! this.keydownHandler ) return;

		document.removeEventListener( 'keydown', this.keydownHandler );
		this.keydownHandler = null;

	}

	/**
	 * Clean up all resources.
	 */
	cleanup() {

		this.unregisterKeyHandler();
		this.remove();

	}

}

/**
 * A DOM panel positioned and oriented as part of the 3D scene, via the
 * CSS3D render layer (see css3d_layer.js), instead of a flat fixed overlay.
 * The element keeps working exactly like normal DOM (selects, buttons,
 * clicks) -- only its screen position/rotation/scale are driven by its
 * transform in the world.
 *
 * This engine keeps the raw Quake coordinate scene throughout (see
 * gl_rmain.js R_SetupGL) -- Z is up, not Y -- so `object.up` is set to
 * (0,0,1) before orienting, matching every other worldspace position in
 * this codebase.
 */
export class WorldspaceUIPanel3D {

	constructor( options ) {

		this.element = options.element;
		this.scale = options.scale || 0.15; // world units per CSS pixel
		this.showPrompt = options.showPrompt || (() => {});
		this.hidePrompt = options.hidePrompt || (() => {});

		this.object = new CSS3DObject( this.element );
		this.object.up.set( 0, 0, 1 );
		this.object.scale.set( this.scale, this.scale, this.scale );

		this.visible = false;
		this.keydownHandler = null;

	}

	/**
	 * Position the panel and turn its readable side to face `facingPoint`
	 * (e.g. the spot a player stands at while interacting with it).
	 */
	setTransform( position, facingPoint ) {

		this.object.position.set( ...position );
		this.object.lookAt( ...facingPoint );

	}

	show() {

		if ( this.visible ) return;
		this.visible = true;

		css3dScene.add( this.object );
		this.showPrompt();

		// Register dismiss handler
		if ( ! this.keydownHandler ) {

			this.keydownHandler = (event) => {

				if ( event.key === 'Escape' && this.visible ) {

					this.hide();

				}

			};

			document.addEventListener( 'keydown', this.keydownHandler );

		}

	}

	hide() {

		if ( ! this.visible ) return;
		this.visible = false;

		css3dScene.remove( this.object );
		this.hidePrompt();

		// Unregister dismiss handler
		if ( this.keydownHandler ) {

			document.removeEventListener( 'keydown', this.keydownHandler );
			this.keydownHandler = null;

		}

	}

	cleanup() {

		this.hide();

	}

}
