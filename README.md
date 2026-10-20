# BG3 In-Game Harness

Run scripted test scenarios inside the real Baldur's Gate 3, through Script Extender, from one command:

```bash
pnpm bg3:test --scenario example.runtime-smoke
```

The runner starts BG3 through Steam, loads an exact disposable save (or starts a new campaign), sends the scenario a command over a JSON file channel, waits for the result, closes the game process it started and restores everything it touched. It prints one `PASS`, `FAIL` or `ERROR` line per run and exits with `0` only when every required assertion passed.

Scenarios are Lua functions that run in the game's server context. They make assertions against real engine state: grant passives, spawn temporary actors, cast spells with real resource costs, advance turn-based rounds and check the outcome. Everything a scenario creates is cleaned up in reverse order before the result is accepted.

## Status

`example.runtime-smoke` passed inside BG3 on 2026-10-20 on the author's machine (Linux, Steam with Proton, Hyprland, headless display). Treat other setups as unsupported until someone tries them.

## Requirements

- Baldur's Gate 3, Patch 8, installed through Steam (app 1086940).
- [BG3 Script Extender](https://github.com/Norbyte/bg3se) v32 or later.
- Linux with Steam and Proton. Paths default to `~/.local/share/Steam`; set `BG3_HARNESS_STEAM_ROOT` or `steamRoot` in the config for another location.
- A Steamworks redistributable `libsteam_api.so` (64-bit, exporting `SteamAPI_InitFlat`). Point `BG3_STEAM_API_LIBRARY` at it. The runner falls back to `<steamRoot>/steamrt64/libsteam_api.so`, which Steam stopped shipping in its October 2026 client update. The helper accepts ISteamUtils v010 or v011.
- A C++20 compiler (`c++` or `$CXX`) to build the small Steam Cloud helper on first use.
- Node.js 24 or later and pnpm 12.6.0.
- `lua` for the offline Lua tests (tested with Lua 5.5).
- Hyprland for the default headless display mode (see below).
- [LSLib](https://github.com/Norbyte/lslib) (tested with 1.20.4) and the .NET 10 SDK to pack the mods. Download the LSLib release yourself; `pnpm mods:pack` compiles a small packer in `tools/lslib-packer/` against it. LSLib's own `Divine` CLI rejects every path on Linux (`This operation is not supported for a relative URI`), which is why the packer exists.

## Layout

| Path | Contents |
| --- | --- |
| `src/` | TypeScript runner: CLI, scenario catalog, JSON protocol, Linux/Proton platform, run lock, Steam Cloud, mod settings, engine logs, pointer session |
| `mod/` | The Script Extender harness mod (`BG3InGameHarness`, UUID `41d551b8-e0c1-4c12-8a29-1be03b5f9054`) |
| `bridge/` | Client startup bridge loaded through `LuaBuiltinResourceDirectory`: skips the splash, loads the exact save or drives new-campaign creation |
| `pointer/` | Optional Python pointer backend for scenarios that must hover a target with the real cursor |
| `steam-cloud-helper/` | C++ helper that disables Steam Cloud for the run and restores it afterwards |
| `examples/runtime-smoke/` | Example mod (`mod/`) with one scenario, and an example `harness.config.json` |
| `tools/lslib-packer/`, `scripts/` | Packer built against your LSLib download, and `pnpm mods:pack` |
| `test/`, `lua-tests/` | Vitest and Lua tests. Neither starts BG3 |

## Setup

1. Pack the harness mod and the example mod, then copy both files into the BG3 `Mods` folder of the Proton prefix (`.../compatdata/1086940/pfx/drive_c/users/steamuser/AppData/Local/Larian Studios/Baldur's Gate 3/Mods/`). You do not need to enable them in a mod manager; the runner writes a temporary load order for each run.

   ```bash
   LSLIB_DIR=/path/to/lslib/Packed/Tools pnpm mods:pack   # writes .cache/dist/BG3InGameHarness.pak and HarnessExample.pak
   ```

   The file names must match `packageFile` in your config. Remove the two files when you stop testing; BG3 ignores mods that are not in the load order, but nothing else needs them.
2. Create a disposable save: start a new game with the mods your scenarios depend on, reach a point where the host character is in the world, and let an autosave happen. Do not use this save for anything else. An existing save works too: list its mods first in the fixture's `requiredMods.ordered`, then append the harness mod and your test mods. They do not have to be in the save; the runner loads them on top of it.
3. Find its folder under `.../compatdata/1086940/pfx/drive_c/users/steamuser/AppData/Local/Larian Studios/Baldur's Gate 3/PlayerProfiles/Public/Savegames/Story/`. The folder name is the save ID. Hash its single `.lsv` file:

   ```bash
   sha256sum "<save folder>"/*.lsv
   ```

4. Copy `examples/runtime-smoke/harness.config.example.json` to `harness.config.json` in your working directory (or point `BG3_HARNESS_CONFIG` at it). Fill in:
   - the save ID and hash;
   - one `mods` entry for every mod in the fixture chain. Copy `Folder`, `MD5`, `Name`, `PublishHandle`, `UUID` and `Version64` from that mod's `ModuleShortDesc` node in your current `PlayerProfiles/Public/modsettings.lsx` (or from its `meta.lsx`), and set `packageFile` to the `.pak` file name in `Mods/`. The entries for the harness and example mods are already in the example;
   - every save you care about under `protectedSaves`. Prefixes are the easiest way to cover a whole campaign (for example the character name that starts its save folders).
5. Install dependencies and run the offline checks:

   ```bash
   pnpm install
   pnpm check
   ```

6. Close any manual BG3 session, then run a scenario:

   ```bash
   export BG3_STEAM_API_LIBRARY=/path/to/steamworks/redistributable/linux64/libsteam_api.so
   pnpm bg3:test --scenario example.runtime-smoke
   ```

   A passing run prints:

   ```text
   PASS mods-loaded: Required BG3 mods are loaded in order
   PASS host-entity: The runtime fixture host resolves to a loaded entity (...)
   PASS host-party-member: The runtime fixture host belongs to the active party (...)
   PASS example.runtime-smoke
   ```

   If Steam is not running, the runner starts it with `steam -silent` and leaves it open afterwards. BG3 rewrites `PlayerProfiles/Public/config.lsf` when it exits; the settings stay the same but the file bytes change, so do not expect that one file to match a backup byte for byte.

Run artifacts, including passing runs, are archived under `.cache/bg3-test-runs/<runId>/` with the new network, Gold and Script Extender logs, any crash dumps from that launch, and a manifest of sizes and SHA-256 hashes. `BG3_HARNESS_WORK_DIR` moves `.cache/`.

## Configuration

`harness.config.json` holds everything machine- or project-specific. Unknown fields are rejected.

| Field | Meaning |
| --- | --- |
| `protectedSaves` | `ids` and `prefixes` of saves that can never be a fixture or be changed by a run. An ID also matches `<id>.`, `<id>_` and `<id>-` variants |
| `mods` | `modsettings.lsx` descriptors (`folder`, `md5`, `name`, `packageFile`, `publishHandle`, `uuid`, `version64`) for every mod a scenario may require |
| `preloadModuleUuids` | Required mods that must be written before all others |
| `modDiagnostics` | Extra `Script Extender/<directory>` files (matched by a regular expression) to archive when they change during a launch |
| `allowedRuntimeSaveIds` | Exact allowlist of save IDs a runtime fixture may name |
| `runtimeFixtures` | `id`, `saveId`, `expectedLsvSha256` and the ordered mod list the save was created with |
| `scenarios` | Catalog entries, described below |
| `harnessModUuid` | Override only if you repackage the harness mod under another UUID |
| `steamRoot` | Steam root; `BG3_HARNESS_STEAM_ROOT` wins over it |

## Writing a scenario

A scenario has two halves that must agree: a Lua registration in your mod and a catalog entry in the config.

Lua, in your mod's server bootstrap (declare the harness mod as a dependency so it loads first):

```lua
Mods.BG3InGameHarness.TestHarness.RegisterScenario({
    Id = "mymod.fire-bolt-cost",
    Mode = "runtime",
    SavePolicy = "never",
    Run = function(context)
        local host = Osi.GetHostCharacter()
        local fixture = context:CreateFixture()
        fixture:PrepareActor(host, { Spells = { "Projectile_FireBolt" } }, function()
            context:Assert("fire-bolt-ready", Osi.HasSpell(host, "Projectile_FireBolt") == 1,
                "The host can cast Fire Bolt")
            context:Finish()
        end)
    end
})
```

Catalog entry in `harness.config.json`:

```json
{
  "id": "mymod.fire-bolt-cost",
  "ownerModUuid": "<your mod UUID>",
  "savePolicy": "never",
  "timeoutMs": 180000,
  "launch": { "kind": "runtime", "fixtureId": "baseline" },
  "requiredAssertionIds": ["fire-bolt-ready"]
}
```

The run fails if any assertion fails, if a required assertion is missing, or if cleanup does not complete. The harness mod must appear before the owner mod in the fixture's `requiredMods.ordered`.

The context passed to `Run` offers:

- `Assert(id, passed, message, expected, actual)`, `Finish()`, `Error(code, message)`.
- `Checkpoint(phase, fields)`: small diagnostic records kept even when the game crashes.
- `Defer(callback)`: compensation run in reverse order during cleanup. `DeferCheck(label, predicate)` waits up to 5 s for asynchronous cleanup. `BeforeCleanup(label, predicate)` holds compensations until a pending client task closes.
- `CreateFixture()`: a scope for temporary changes, only in runtime scenarios that never save (or new campaigns that are discarded). It offers `PrepareActor`, `WaitUntil`, `SpawnNear`, `Boost`, `CastSpell`, `CastSpellTargets`, `CastSpellAtPosition`, `CastZoneAtActor`, `EndForceTurnBasedTurn` and `OnForceTurnBasedRound`. Each change registers its own undo before it is applied. Casts go through `ServerCastRequest` so the engine keeps its normal costs and validation.
- `GetDeadlineEpochMs()`, `GetCreationPlan()` and, for character-creation scenarios with `create-test-fixture`, `RequestTestSave()`.

`TestHarness.ExtendContext(function(context, run) ... end)` adds your own operations to every context. `run` exposes the validated `Command`, `IsActive()`, `OwnsFixture(fixture)` and `EpochMilliseconds()`. Extensions cannot replace the core methods. On the client, `Mods.BG3InGameHarness.ClientHarness.NewCampaignUI` and `.RuntimeUI` give extensions the same authorization checks the harness uses.

### Character-creation scenarios

`"launch": { "kind": "character-creation", "creationPlan": { ... } }` starts a new campaign instead of loading a save. The plan selects a background by UUID, and optionally a class, race, subrace and race passive. The client drives the menus through Noesis commands, skips intro movies and confirms the avatar. `create-test-fixture` keeps exactly one new save after all assertions pass; `discard-campaign` closes the game without saving. Creation scenarios declare their own `requiredMods` and need a mod that skips the opening sequence (`requiredTransitionModUuid`).

## Display modes

- `--display headless` (default) creates one Hyprland headless output and a reserved workspace once per Hyprland session, and moves BG3 there with temporary window rules. BG3 never takes focus. The rules are removed when the run ends, guarded by a watchdog inside Hyprland, so a crashed runner cannot capture a BG3 you start by hand later.
- `--display visible` places a floating, centered BG3 window on the focused monitor.

Without Hyprland, use `--display visible` and expect to adapt `src/node-platform.ts`.

### Pointer input (optional)

Some client checks need the real cursor over a target, for example a spell preview. A scenario opts in with a `pointer` policy in its catalog entry (`operation`, `spellId` and the ordered `steps`), and must then run with `--display visible`. The client renders a unique label over the target; `pointer/bg3-pointer.py` finds it by OCR and moves a temporary relative pointer device to it. It never clicks or presses keys, and it closes the device as soon as the run loses authorization or focus.

The backend needs `python`, `python-evdev`, Pillow, `tesseract` with English data, `grim`, `hyprctl` and write access to `/dev/uinput`. It supports a full BG3 window on a monitor with scale 1 and no rotation. Check the dependencies without starting BG3 or touching the mouse:

```bash
python pointer/bg3-pointer.py --check
```

The client side that asks for pointer input (`RuntimeUI.ReportSpellPointer`) has no caller in this repository yet; your scenario or extension provides it.

## Safety guarantees

- **Disposable save only.** A runtime scenario loads one exact save ID from the allowlist. Before changing anything, and again right before launching, the runner checks that the save folder holds a single non-empty `.lsv` whose SHA-256 matches the catalog, and refuses protected saves.
- **Never saves over your saves.** Runtime scenarios must use `savePolicy: "never"`; the harness suppresses autosave and refuses save requests. The runner snapshots every save before launch and fails the run if any existing save changes. A creation scenario may add exactly one new save, and only after all its assertions pass.
- **Mod configuration restored byte for byte.** `modsettings.lsx` and `ScriptExtenderSettings.json` are replaced for the run and restored from the exact original bytes afterwards. If another program changed either file meanwhile, the runner fails instead of overwriting it.
- **Steam Cloud left as it was.** Cloud sync for BG3 is disabled through a journal before launch and restored afterwards, including after a crashed run.
- **Run lock.** One run at a time, guarded by `flock` on a stable file. Abandoned locks are recovered only after strict age and identity checks.
- **Only its own process.** The runner records the PID and start time of the BG3 it launched and only ever terminates that process. It refuses to start if another BG3 is running.
- **Crash marker.** BG3 can leave an empty `ModCrashSanityCheck` folder after an unclean exit, which disables mods on the next start. The runner removes only that exact empty directory and refuses anything else.

## Development

```bash
pnpm check          # tsc, Vitest and the Lua tests
pnpm test:python    # pointer backend tests (needs Pillow)
```

None of these start BG3, Steam or touch the desktop.

## Acknowledgements

- [BG3 Script Extender](https://github.com/Norbyte/bg3se) by Norbyte (MIT with the Commons Clause). The harness mod runs on it. It is a runtime dependency you install yourself.
- [LSLib](https://github.com/Norbyte/lslib) by Norbyte (MIT), used to pack the mods into `.pak` files.

This is an unofficial fan project. It is not affiliated with or endorsed by Larian Studios. Baldur's Gate 3 is a trademark of its owners.

## License

MIT. See [LICENSE](LICENSE).
