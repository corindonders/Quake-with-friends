# Development plan

Working plan for active development plus the unordered feature backlog,
combined into one file, organized by category. **v1 (below) is the only
actively scheduled work** — everything else is future/backlog, ordered
to come after v1 ships, and grouped by area so related ideas sit together
regardless of when they were discussed.

## v1: No main menu, worldspace hub UI

**Goal:** players never see a traditional menu. They connect and spawn
directly into a shared hub world. Everyone currently in the hub is
implicitly "the party" — when one player starts a map or gamemode from a
worldspace kiosk, everyone in the hub travels into that room together.
Special gamemodes (deathmatch, horde, etc.) are also started from the hub,
not from a menu screen.

### Current state (as of 2026-09-13)

- Party/travel-together plumbing already works: everyone connected to the
  shared `HUBWLD` room gets a broadcast `TRAVEL_TO` when someone starts a
  map, via `RoomClients_Broadcast` in `server/lobby_server.js` and
  deterministic room ids in `src/hub_config.js`.
- A first-pass hub trigger exists in `src/hub_kiosk.js` — a proximity-based
  box mesh that pops a **DOM** panel (not worldspace) to pick map/mode and
  calls `WS_SendHubStart`.
- Two separate menu systems currently run: the legacy canvas-drawn WinQuake
  menu (`src/menu.js`, driven from `src/host.js`), and newer DOM overlay
  panels (`src/travel_ui.js`, `src/hub_kiosk.js`).
- `horde` mode is fully implemented (`src/horde.js`) but not wired into
  `HUB_MODES` in `src/hub_config.js` — the hub only knows about
  ffa/teams/teams_ai/coop today.
- The hub currently reuses Copper's `start` map as a stand-in; there's no
  purpose-built hub level.

### Decisions locked in

- Players spawn straight into the hub — no connect/name screen first.
- Starting a map/mode is host-picks-for-everyone (whoever interacts with
  the kiosk starts it for the whole hub) — no vote/ready-up in v1.
- Single shared hub world for v1, not sharded/instanced.
- v1 hub interactions are minimal: pick a map + pick a gamemode. No
  per-mode settings (frag limits, wave counts, etc.) or loadout selection
  yet — that's future work below.

### Build order

1. **Kill the legacy menu boot path.** Skip `M_Menu_Main_f`/canvas menu on
   connect entirely; go straight from connect → spawn in hub. Keep
   `menu.js` around only if still needed for options/keybinds, reachable
   from inside the hub, never blocking boot.
2. **Generic worldspace UI framework.** A reusable primitive: a panel
   rendered *in* the 3D world (billboard/quad with canvas-texture, or
   CSS3DRenderer-backed) attached to a hub entity, with proximity + look-at
   + interact detection. Replaces the ad-hoc per-frame distance check in
   `hub_kiosk.js` so future hub interactions don't each reinvent this.
3. **Rebuild the kiosk on top of that framework** — map + gamemode
   selection panel that's actually part of the 3D scene, not a flat DOM
   overlay.
4. **Add horde to `HUB_MODES`.** Thread it through
   `Hub_NormalizeModeConfig` → `RoomManager_CreateRoom` → the room process
   the same way ffa/teams/coop already work.
5. **Confirm "host starts for all" edge cases** — player joins hub
   mid-interaction, someone starts a room while another player has the
   kiosk panel open, etc. The broadcast mechanism mostly exists; this is a
   verification/hardening pass, not new plumbing.
6. **Real hub level.** Either a small purpose-built hub map (blocked on: no
   qbsp/vis/light compiler toolchain in-repo, so a real custom .bsp can't
   be authored without setting that up first) or a deliberately chosen and
   cleaned-up existing map used permanently as the hub, with kiosks placed
   at real fixed points instead of the current regex-found spawn position.
7. **Polish pass.** No menu-flash on connect, leaving a level returns you
   to the hub, multiplayer smoke test with 2+ clients starting coop /
   deathmatch / horde together from the hub.

---

## Everything below is post-v1

Nothing in this section is scheduled ahead of the v1 build order above.
Pick items up once v1 ships, in whatever order sounds fun.

## Engine & rendering

### Modern Quake engine feature parity

Community source ports (Ironwail, vkQuake, QuakeSpasm-Spiked/QSS, FTEQW)
have accumulated a large set of quality-of-life and rendering upgrades
over 25+ years since vanilla WinQuake/GLQuake. Worth cherry-picking from
for this engine. Not all of these make sense for a browser/Three.js
engine, but listed for reference:

- **Uncapped/high framerate physics** — decoupling simulation rate from
  frame rate so gameplay doesn't break above the original engine's
  assumed tick rate (QSS/Ironwail).
- **Colored lighting (`.lit` files)** — already flagged as a gap elsewhere
  in this doc; every modern port supports this.
- **Dynamic/RTLights** — real-time dynamic lights and shadows instead of
  fully baked lightmaps (FTE, some vkQuake builds via ericw-tools rtlights
  data).
- **High-resolution external texture replacement** — loading upscaled or
  hand-made replacement textures/skins over the base WAD/BSP textures,
  keyed by original texture name.
- **Higher-poly replacement models (MD3/glTF-style) for classic .mdl
  monsters/weapons**, with fallback to the original low-poly model.
- **Increased/removed engine limits** — MAX_EDICTS, max visible entities,
  max particles, max dlights, etc. raised or made dynamic instead of
  vanilla's hardcoded caps.
- **BSP2 / 2PSB support and large coordinate range** — needed for big
  modern maps (Arcane Dimensions-scale); already partially present per
  earlier work (`hub_config.js` notes, recent commits mention BSP2).
- **Particle system upgrades** — better explosion/blood/trail particles,
  scriptable particle effects (QSS `.pfx`-style scripting).
- **Full 32-bit color rendering and post-process AA/upscaling.**
- **Wider FOV / widescreen-correct rendering** without the vanilla
  fisheye distortion at high FOV.
- **Mouse smoothing / raw input / high-DPI mouse support** for modern
  precision aiming.
- **OGG/MP3 music support** instead of requiring raw CD audio tracks.
- **Searchable level-select / skill-select menus with map descriptions**
  (Ironwail) — worth revisiting once v1's worldspace hub UI framework
  exists, as a hub-native equivalent.
- **Modern crosshair options** — configurable style, size, color, opacity.
- **QuakeSpasm-Spiked protocol extensions** — `getentity`,
  `forceinfokey`, and other builtins that let mods query more engine
  state without new protocol messages; relevant if a real QuakeC VM
  (CSQC) ever gets built (see below).
- **Demo recording/playback quality improvements**, PNG screenshots,
  video capture hooks.
- **In-game console autocomplete** for cvars/commands.

### Other engine ideas

- **Modern lighting** — dynamic shadow maps, colored lightmaps (`.lit`
  support doesn't exist at all currently — imported map packages' `.lit`
  files are preserved on disk but ignored by the renderer).
- **PBR-ish material upgrade path** for glTF-based assets (any non-Quake-
  native content) so they don't look flat next to classic Quake textures.
- **Postprocessing pipeline** (bloom, color grading, screen-space effects)
  — `server/postprocess_addon_shim.js` suggests groundwork may already be
  started here; worth reviewing before designing this fresh.
- **Full CSQC engine support** — a real second QuakeC VM for the client,
  new protocol messages, new draw builtins. Multi-day scope; previously
  considered and deferred in favor of a native JS HUD (`cl_modernhud`).
  Would become worth revisiting if mods start requiring real client-side
  QuakeC.
- **QuakeC compiler toolchain in-repo** — currently blocks several
  gameplay ideas (weapon-stay ruleset, random loadouts, CTF tuning) that
  need QuakeC source changes. Standing this up unblocks a whole class of
  items at once.
- **Non-.mdl model pipeline** — a parallel rendering + animation path for
  glTF monsters/props (Three.js GLTFLoader) alongside the classic
  alias-model (`gl_model.js`/`gl_mesh.js`) pipeline, plus a JS-driven think
  path for entities without compiled QuakeC (`ent._jsThink` dispatched from
  `SV_RunThink`).
- **Netcode scalability** — revisit room-process-per-match model
  (`room_process_manager.ts`) if concurrent room count grows; interest
  management / area-of-interest replication if player counts per room grow
  significantly beyond current design targets.
- **WebTransport dead code cleanup** — `src/net_webtransport.js` and
  `server/net_webtransport_server.ts` are unused leftovers from before the
  WebSocket migration.

## Content: other game support

- **DOOM / DOOM II WAD support.** Load and play original DOOM/DOOM II IWADs
  (and compatible PWADs) inside this engine. This is a genuinely separate
  renderer/gameplay stack from Quake, not a reskin:
  - **Different data format entirely** — DOOM WADs are 2.5D BSP-like maps
    built from linedefs/sidedefs/sectors with a different node/subsector
    structure than Quake's true-3D BSP, plus DOOM's own IWAD lump-based
    asset layout (`WAD_LoadMod`-equivalent needed, distinct from
    `COM_LoadMod`/`src/pak.js`'s Quake PAK/BSP path).
  - **Software-renderer-style level geometry** (sectors with floor/ceiling
    heights, no true room-over-room without hacks) needs its own
    Three.js scene-building path — can't reuse `gl_model.js`/BSP renderer
    as-is.
  - **DOOM's own entity/AI/weapon logic** is not QuakeC — would need a
    parallel gameplay layer (similar in spirit to the JS-driven `_jsThink`
    idea above) rather than running through the QuakeC VM at all.
  - **Networking**: DOOM has no native multiplayer protocol compatible
    with this project's room/lobby system, so multiplayer DOOM would ride
    on the existing WebSocket relay/room infrastructure, translating DOOM's
    simpler deathmatch/coop model onto it — not the original DOOM netcode.
  - **Licensing**: the DOOM/DOOM II source (id Tech 1) is GPL, so a
    from-scratch or ported renderer is legally fine; IWADs themselves
    still need to be user-supplied (same expectation as this repo already
    has for Quake's shareware/registered paks).
  - Given the scope, this is realistically its own multi-week subproject:
    a WAD loader, a DOOM-specific level renderer, a DOOM-specific
    gameplay/AI layer, and a bridge from that layer into the existing
    room/lobby/hub-travel system so DOOM maps can be launched the same
    way Quake maps are from the hub.

## Gameplay & modes

- **Persistent progression** — cosmetic unlocks, XP, or similar tied to
  the existing per-account player-progress persistence, surfaced in the
  hub worldspace rather than a menu screen.
- **Capture the Flag** — Threewave CTF or similar, integrated the way
  Quoth was.
- **Weapon-stay/arena ruleset, random loadout on spawn, low-gravity mode,
  friendly-fire toggle** — see details below; these become hub-selectable
  mode variants once the worldspace UI framework (v1 build order item 2)
  exists, rather than needing their own bespoke UI each.
- **Duel/1v1 matchmaking** — a real room-type in the lobby server,
  selectable from the hub.
- **Cross-hub presence** — "who's online / doing what" shown as worldspace
  UI in the hub itself (e.g. a scoreboard/status panel), rather than an
  out-of-game wiki page, once the hub is the permanent home screen.
- **Low-gravity mode** — `sv_gravity` is already a real cvar; just needs
  exposing as a room option.
- **Friendly-fire toggle** — Copper already supports `teamplay`; wire a
  toggle into room creation.
- **Weapon-stay / classic "arena" DM ruleset** — weapons don't disappear
  on pickup, everyone always has full ammo. Needs a small QuakeC change
  in `mods/copper/src/item_weap_ammo.qc` (blocked on the QuakeC compiler
  toolchain item above).
- **Random loadout on spawn** — roll a random starting weapon instead of
  always the shotgun. QuakeC change in `client.qc`'s `PutClientInServer`.

## Infra / social / admin

- **Persistent stats/leaderboard** — frags/deaths/playtime tally, shown in
  the hub or wiki. Player-progress persistence already exists per account;
  this is mostly a small extension of that.
- **Loadout or difficulty presets on Travel** — pick a starting weapon or
  monster-difficulty multiplier when launching a room.
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

## Done this session (for reference, not scheduled work)

- Horde/wave survival mode (`horde_start`/`horde_stop`/`horde_status`,
  `sv_horde_*` cvars) — `src/horde.js`.
- Modern corner HUD (`cl_modernhud`) — `src/sbar.js`.
- Kill feed + damage flash HUD — `src/hud_feed.js`.
- Quoth mod support, BSP2 format support, wiki 3D model preview.

## Notes

- Session-scoped implementation notes (file:line specifics, decisions made
  mid-build) should get folded into this file's "Current state" section as
  work progresses, not left to rot in chat history.
- When starting a new post-v1 item, move it under a "v2" (or similarly
  named) build-order section at the top the same way v1 is structured now,
  rather than leaving it mixed into the category lists below.
