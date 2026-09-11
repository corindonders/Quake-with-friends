// Kill feed + damage number HUD, layered on top of the classic engine.
//
// Kill feed: every broadcast (bprint) message the server sends -- kills,
// "found a secret", level-change announcements, etc -- already exists as
// plain svc_print text (see CL_ParseServerMessage's svc_print case). Chat
// ("say"/"say_team") is also sent via svc_print, but Host_Say always
// prefixes it with \x01 (the engine's "gold/chat text" color marker, see
// host_cmd.js) -- checking for that prefix is enough to separate real chat
// from event broadcasts without parsing per-mod death-message text, which
// would be too fragile across four different mods' QuakeC.
//
// Damage numbers: the NetQuake wire protocol this engine implements never
// tells the client how much damage a specific hit dealt (that's fully a
// QuakeC-side concept, and we don't control/recompile every mod's progs.dat
// here) -- so real floating numbers on enemies aren't possible without a
// protocol addition. What IS already on the wire is the local player's own
// health stat, so this tracks health deltas and pops a "-N"/"+N" flash for
// damage actually taken/healed by the local player.

import { Draw_String, Draw_Fill, Draw_GetVirtualWidth } from './gl_draw.js';
import { realtime } from './host.js';

const MAX_FEED_LINES = 6;
const FEED_LINE_LIFETIME = 5.0; // seconds
const FEED_FADE_TIME = 1.0; // seconds of fade-out at the end of lifetime
const FEED_LINE_HEIGHT = 8;
const FEED_TOP_MARGIN = 16;
const FEED_RIGHT_MARGIN = 8;

const DAMAGE_FLASH_LIFETIME = 1.0; // seconds

// { text, time }[], most recent first
const feedLines = [];

// { text, time, color }[] -- color: 1 = damage (red-ish via '\x01'-less
// plain text isn't colorable per-char here, so we just prefix a sign)
const damageFlashes = [];

let lastKnownHealth = null;

/*
=================
Feed_AddMessage

Called for every non-chat broadcast print. Keeps the most recent
MAX_FEED_LINES, each shown for FEED_LINE_LIFETIME seconds.
=================
*/
export function Feed_AddMessage( text ) {

	const line = text.replace( /\n+$/, '' ).trim();
	if ( line.length === 0 ) return;

	feedLines.unshift( { text: line, time: realtime } );
	if ( feedLines.length > MAX_FEED_LINES ) feedLines.length = MAX_FEED_LINES;

}

/*
=================
Feed_NoteHealthChange

Called whenever the local player's STAT_HEALTH updates. Pops a damage (or
heal) flash for the delta. Ignores the very first update after (re)connect
so spawning in doesn't show a spurious "+100".
=================
*/
export function Feed_NoteHealthChange( newHealth ) {

	if ( lastKnownHealth === null ) {

		lastKnownHealth = newHealth;
		return;

	}

	const delta = newHealth - lastKnownHealth;
	lastKnownHealth = newHealth;

	if ( delta === 0 ) return;

	// A large positive jump right after death (respawn to full health) isn't
	// a "heal" -- skip anything that looks like a fresh spawn.
	if ( delta >= 50 ) return;

	damageFlashes.unshift( { amount: delta, time: realtime } );
	if ( damageFlashes.length > 4 ) damageFlashes.length = 4;

}

/*
=================
Feed_Reset

Called on disconnect/level change so stale lines and a stale health
baseline don't carry over.
=================
*/
export function Feed_Reset() {

	feedLines.length = 0;
	damageFlashes.length = 0;
	lastKnownHealth = null;

}

/*
=================
Feed_Draw

Draws the kill feed (top-right, newest on top) and any active damage
flashes (center screen, rising and fading). Call once per frame, inside
the same 2D-overlay pass as the rest of the HUD.
=================
*/
export function Feed_Draw() {

	const vw = Draw_GetVirtualWidth();

	let y = FEED_TOP_MARGIN;
	for ( let i = 0; i < feedLines.length; i ++ ) {

		const entry = feedLines[ i ];
		const age = realtime - entry.time;
		if ( age > FEED_LINE_LIFETIME ) continue;

		// Fade isn't a real alpha blend (the classic charset draw has no
		// alpha channel to speak of) -- approximate it by simply dropping
		// the line once it's within the last FEED_FADE_TIME seconds of life,
		// which reads fine at a glance for a fast-moving feed.
		if ( age > FEED_LINE_LIFETIME - FEED_FADE_TIME && ( ( realtime * 4 ) | 0 ) % 2 === 0 ) continue;

		const textWidth = entry.text.length * 8;
		const x = vw - FEED_RIGHT_MARGIN - textWidth;

		Draw_Fill( x - 4, y - 1, textWidth + 8, FEED_LINE_HEIGHT + 2, 0 );
		Draw_String( x, y, entry.text );

		y += FEED_LINE_HEIGHT + 2;

	}

	for ( let i = 0; i < damageFlashes.length; i ++ ) {

		const flash = damageFlashes[ i ];
		const age = realtime - flash.time;
		if ( age > DAMAGE_FLASH_LIFETIME ) continue;

		const text = ( flash.amount > 0 ? '+' : '' ) + flash.amount;
		const rise = Math.floor( age * 12 ); // rises ~12px/sec
		const fx = ( vw >> 1 ) - ( text.length * 8 >> 1 ) + 20 + i * 6;
		const fy = 64 - rise;

		Draw_String( fx, fy, text );

	}

}
