# CloudpunkVR ⇄ World protocol (version 2)

TCP on `127.0.0.1:<port>` (default 47660). The plugin listens on the loopback address only and the World connects.
Messages are one JSON object per line (UTF-8) in both directions. If the connection drops, the World redials every
2 s. A newer connection replaces an older one. The plugin handles every message on Unity's main thread.

Version 2 removed the hologram (`say`, `speaking`, `skin`, `hologram`, `showChat`), the flat-mode first-person head
(`look`, view `firstperson`) and the pilot's buttons (`interact`, `continue`, `back`), and added the call channel, the
mirrored stream overlay and the Spout preview.

## Plugin → World

| `type` | When | Fields |
|---|---|---|
| `hello` | on connect | `protocol` (2), `game` ("cloudpunk"), `vr` (headset mode), `plugin` (version) |
| `state` | 4 times a second | see below |
| `event` | when something changes | `name` and fields, below |
| `reply` | answer to a request | `id`, `ok`, `result` or `error` (a sentence for the model) |

`state`:
- `mode`: `loading` / `menu` / `dialogue` / `map` / `window` / `car` / `car_chase` / `foot` / `none`
- `vr`
- `sector`
- `pos: [x,y,z]`
- `money`
- `car: { speedKmh, fuel, maxFuel, floor, inParking, pos }`
- `quests: [{ id, who, text, progress?, marker?, markerKind?, distance?, otherLevel? }]` (`otherLevel`: the quest is on another level; `marker` and `distance` are then the lift the game's own map marker points at)
- `dialogue?: { speaker, text, remote }`
- `interact?`
- `autopilot: { phase, planning?, viaLift?, target?, goal?, remainingM?, next?: { kind, inM } }` (`phase` lift: in a lift on the way to another level; `planning`: a route is being planned) (`next`: the next turn or climb while guiding)

`event` names:

| `name` | Fields |
|---|---|
| `mode` | `from`, `to` |
| `sector` | `sector` |
| `money` | `money`, `change` |
| `quest_added` / `quest_updated` | the quest fields |
| `quest_done` | `id` |
| `dialogue` | `speaker`, `text`, `remote` (a call), sent once the line has finished typing out |
| `interact` | `target`: the name the game shows (character, pickup, the prompt of a trigger); objects it shows no name for are not reported |
| `unlocked` | `title`, `name`, `amount`: the pop-up for something received (item, credits with the reason, a new place) |
| `hint` | `text`: a tutorial hint on screen |
| `fuel` | `fuel`, `maxFuel`, `percent`: under a quarter, then under a tenth, once each until refuelled |
| `maneuver` | `kind` (left / right / uturn / up / down / arrive / lift), `inM`, `remainingM`, `target`: while the player drives a shown route, about eight seconds (at least 120 m) before each turn or climb, and once near the destination |
| `rerouted` | `target`, `routeM`, `afterLift?`: the player left the shown route for 3 s; a new one from where they are. With `afterLift` the car has come out of a lift on the quest's way and the route goes on from the new level |
| `arrived` | `target`, `how` (已停车 / 走到了 / 到达附近), `was`, `mode` |
| `autopilot` | `state` (off / guide), `why`, `was` |
| `channel` | `busy` (an NPC's dialogue box is up: the call boxes hide), `speaker`, `speaking` (the bot's line was showing). Only while on air |

## World → Plugin

Requests (`{ type: "request", id, method, args }`):

| `method` | `args` | `result` |
|---|---|---|
| `state` | — | a state frame |
| `navigate` | `quest?`, `place?` (parking / car / a place id / a place name or kind), `pos?: [x,y,z]`, `drive?`, `park?` | `target`, `goal`, `routeM`, `straightM`, `phase` (guide / drive / walk), `parking?`, `viaLift?` (the route ends in a lift; planning runs over several frames, so the reply can take a second or two) |
| `walk_to` | like `navigate` | like `navigate` |
| `places` | `query?`, `limit?` (8) | `places: [{ id, name, kind, pos, distance, dy, bearing }]` best match first then nearest, `total`, `kinds` ("商店×30", ...) |
| `stop` | — | `stopped` |
| `snapshot` | `width?` | `mime`, `width`, `height`, `data` (base64 JPEG of the window; in VR the left eye) |
| `live` | — | `onAir`, `channel: { where, npc, speaking, spout: { sender, width, height, format } \| null, problem }`, `overlay: { built, visible, layers, live }`, `senders` (Spout sender names) |
| `preview` | `width?` | `live`; when receiving: `sender`, `width`, `height`, `frame` (the whole Spout frame as JPEG), `box` (the call box picture as JPEG), `crop: { x, y, w, h }` (UV, y up); else `problem`. Keeps the receiver open 10 s even off air |

`channel.where`: `off` (off air), `npc` (an NPC holds the channel), `idle` (no picture and no line), `car_screen`,
`hud`, `hud+wrist`, `wrist`, `hidden` (menus, the full map, loading).

Messages without a reply:

| `type` | Fields | Effect |
|---|---|---|
| `config` | `onAir`, `view` (off / spectator), `autopilotSpeed`, `corti: { name, sender, zoom, x, y, flip, holo, car, foot, wrist, popOut, popZoom, popSize }`, `overlay: { on, yaw, pitch, distance, width, opacity, canvas: [w, h], layers: [{ x, y, w, h, on }] }` (canvas pixels, top left as in OBS) | settings; nothing of the stream shows off air or without a connection |
| `corti_line` | `text`, `seconds` | the bot's current line in the call boxes, typed out over `seconds` |
| `corti_cut` | — | the line stops |
| `overlay_frame` | `layer` (index into `config.overlay.layers`), `png` (base64, 8-bit RGBA) | the layer's new picture; sent when it changed, at most `fps` times a second per layer, and all again after `hello` |
