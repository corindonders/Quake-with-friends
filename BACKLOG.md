# Feature backlog

Ideas discussed but not yet built. Not ordered by priority within each
section — pick whatever sounds fun next.

## Infra / social

- **Spectator mode** — watch an in-progress room without joining. Useful
  whenever the group size is odd or someone just wants to watch.
- **Persistent stats/leaderboard** — frags/deaths/playtime tally, shown in
  the hub or wiki. Player-progress persistence already exists per account;
  this is mostly a small extension of that.
- **Presence indicator** — "who's online / which room" shown in the hub or
  wiki, so people don't have to guess before joining.
- **Ready-up / vote-to-start** for a room, so a match doesn't kick off
  with only half the group loaded in.
- **Loadout or difficulty presets on Travel** — pick a starting weapon or
  monster-difficulty multiplier when launching a room.
- **WebTransport dead code cleanup** — `src/net_webtransport.js` and
  `server/net_webtransport_server.ts` are unused leftovers from before the
  WebSocket migration.
- **Duel/1v1 matchmaking** — real room-type logic in the lobby server
  (not just a cvar flip).
- **Full CSQC engine support** — a real second QuakeC VM for the client,
  new protocol messages, new draw builtins. Multi-day scope; considered
  and explicitly deferred in favor of building the modern HUD natively
  instead (see `cl_modernhud`).

- **Admin: import map packages by URL** — let an admin paste a direct
  `.zip` URL (e.g. a quaddicted.com filebase link) in `admin_maps.html`
  and have the server download + extract it instead of copying files
  onto the box by hand. Scoped and partially prototyped (2026-09-11),
  then deferred so the user can build it themselves with Claude. Design
  notes for picking this back up:
  - No map-loading code needs to change. `COM_LoadMod`/`COM_AddModSearchDir`
    (`src/pak.js`) already turn a mapdb entry's `layers: [...]` array into
    a loose-file search dir, and `src/travel_ui.js` already passes
    `layers` straight through as the room's `-mod` list. So: extract the
    zip as-is into `custom_maps/<id>/` and add that path to the map's
    `layers` -- the existing pipeline (both browser client and
    `game_server.js`) picks it up with zero changes.
  - New server module (e.g. `server/map_import.ts`): fetch the URL with a
    timeout + size cap, unzip in-memory (no zip lib in the repo yet --
    `fflate` via `npm:fflate` worked fine in Deno), zip-slip guard on
    every entry path, write into `../custom_maps/<id>/`, verify
    `maps/<id>.bsp` exists in the result (else clean up and report which
    `.bsp` files *were* found, so the admin can fix the Map ID field).
  - New admin-only route `POST /admin/api/maps/import` (`{id, url}`) --
    keep it single-purpose (fetch+extract only), let the client fold the
    returned `custom_maps/<id>` dir into the Layers field and then call
    the existing `POST`/`PATCH /admin/api/maps` unchanged.
  - Confirmed scope with the user: URL import only (no manual file
    upload), and the URL must be a **direct .zip link**, not a
    quaddicted.com metadata/db page (those need HTML scraping to find
    the actual download, deliberately skipped).
  - `custom_maps/` should be gitignored (large, reproducible from the
    source URL, same reasoning as pak files).
  - Note: this engine has no `.lit` (colored lightmap) support at all
    today -- an imported package's `.lit` file would be preserved on
    disk but ignored by the renderer. Separate feature if wanted.

## Gameplay modes / rules

- **Low-gravity mode** — `sv_gravity` is already a real cvar; just needs
  exposing as a room option.
- **Friendly-fire toggle** — Copper already supports `teamplay`; wire a
  toggle into room creation.
- **Instagib** — one-hit-kill, single-weapon arena mode.
- **Weapon-stay / classic "arena" DM ruleset** — weapons don't disappear
  on pickup, everyone always has full ammo. Needs a small QuakeC change
  in `mods/copper/src/item_weap_ammo.qc` (no compiler toolchain in this
  repo currently — would need one set up first).
- **Random loadout on spawn** — roll a random starting weapon instead of
  always the shotgun. QuakeC change in `client.qc`'s
  `PutClientInServer`.
- **Capture the Flag** — layer in a free, well-tested QuakeC CTF mod
  (e.g. Threewave CTF) the same way Quoth was added. Bigger asset+rule
  integration than a cvar flip.
- **Vagrant Story Goblin/Goblin Leader enemies** — two glTF models are
  already sitting in `Vagrant story/` at the repo root. Prototyped and
  reverted (2026-09-10): since there's no QuakeC compiler in this repo, a
  new monster classname needs its spawn/AI/pain/die logic written in
  plain JS rather than compiled QuakeC, driven through the edict's think
  field via a plain JS callback (`ent._jsThink`) instead of
  `PR_ExecuteProgram`, dispatched from `SV_RunThink` (`sv_phys.js`).
  Rendering needs a parallel non-.mdl model path (Three.js GLTFLoader
  instead of the alias-model pipeline in `gl_model.js`/`gl_mesh.js`).
  The prototype got monsters spawning, chasing, and melee-attacking
  correctly, but the model precache/index handshake only works if the
  two fake model paths are precached *unconditionally at every map load*
  (`SV_SpawnServer` in `sv_main.js`) rather than lazily on first spawn —
  precaching late means any client already connected by then never
  learns the model exists (`sv.model_precache` is only sent to clients
  once, at signon). Known gaps if this gets picked back up: no pain
  flinch animation (QuakeC's `th_pain` calling convention isn't
  reconstructed in JS), and the rendered model's on-screen appearance
  was never actually visually verified before this got shelved.

## Done this session (for reference, not backlog)

- Horde/wave survival mode (`horde_start`/`horde_stop`/`horde_status`,
  `sv_horde_*` cvars) — `src/horde.js`.
- Modern corner HUD (`cl_modernhud`) — `src/sbar.js`.
- Kill feed + damage flash HUD — `src/hud_feed.js`.
- Quoth mod support, BSP2 format support, wiki 3D model preview.
