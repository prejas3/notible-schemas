# Schemas (`notible.schemas`)

Saved recipes for kinds of items (Hive #31, #42, grep `SCHEMAS-`). A schema gives a new
item of one type a title pattern, default properties and tags. Display name "Schemas"
since 0.2.0; the id stays `notible.schemas` so installs and data keep working.

- **Where:** the **Schemas** screen in the sidebar (list left, editor right: name, kind,
  title pattern + live preview, number width, counter reset, properties, tags, where it
  is used) and a **Schemas** tab on every project, folder and space (attached schemas
  with their next number, Attach schema, New schema, Detach). Settings → Plugins →
  Schemas is only a link to the screen. EN + PL.
- **Stored as objects** (hidden from the tree), so they sync and are in backups:
  - `notible.schemas.schema`: `targetType`, `titlePattern`, `counterReset`
    (`never|yearly|monthly`), `defaultProps`, `defaultTags`, the global counter's marks
    `issued:<device>`, and `legacyScope` after a 0.1.0 migration.
  - `notible.schemas.attachment` (`SCHEMAS-ATTACH`), parented to its container:
    `schemaId`, `containerId`, `detached`, and that attachment's counter marks
    `issued:<device>`. Chosen over a prop map on the schema so every key has one writer
    in a sync merge. Two devices attaching the same pair offline make two objects;
    they count as one (marks merged). Detach sets `detached: true`, so attaching again
    continues the numbering.
- **Pattern tokens:** `{yyyy}` `{mm}` `{dd}` `{counter:N}` (N = 1–9 digits, one counter).
- **Which schema applies:** a schema with no active attachment is global. For a new item
  the nearest ancestor container with an attached schema of that type wins; otherwise a
  global one. An attached-only schema does not apply outside its containers.
- **Applied** (a) by "+ → <schema name>" (created already filled; inside an attached
  container it uses that attachment, elsewhere a global schema counts globally and an
  attached-only one goes into its first container), and (b) on `object.created` to an
  item still titled `New task` / `New issue` / `Untitled note` / empty… Filled items get
  `props.schemaApplied`, `schemaScope` (container id, `""` = global), `schemaNumber`,
  `schemaPeriod` and are never processed again.
- **Numbering:** per schema + scope + period. next = highest `schemaNumber` already
  issued there + 1, from the items (newest 5000 of the type, incl. archived) and from
  the counter's synced high-water mark (`SCHEMAS-HIGH-WATER`): the schema object for the
  global counter, the attachment for a container's. Each device writes only its own
  `issued:<device>` key, so a trashed item's number isn't reused and numbers never
  restart when other items crowd the 5000-row query. Creates on one device go through
  an in-memory queue. Two devices offline can pick the same number; after a workspace
  change the plugin finds equal numbers in one counter and shows one notice per clash,
  plus a list on the Schemas screen. Never promised gapless or unique.
- **Migration 0.1.0 → 0.2.0** (`SCHEMAS-MIGRATE-020`, on load and on every scan, so a
  0.1.0 schema arriving by sync is migrated too; idempotent): "Anywhere" stays a global
  schema with its marks; "Only inside X" becomes an attachment to X carrying the old
  marks, and the schema gets `legacyScope = X` so items numbered before 0.2.0 (without
  `schemaScope`) count in X. Numbering continues; nothing restarts at 001.

## Known limits (Core follow-ups)

- `object.created` carries only `{ id, type }`; sync applies don't emit it at all
  (`sync.apply` announces `workspace.changed`), so the plugin only reacts to local
  creates. `schemaApplied` still guards an item that comes back.
- `SCHEMAS-PLUS-MENU-REFRESH`: a new or renamed schema's + entry used to need a restart;
  Core now refreshes the + menu when a plugin registers a command late (Hive #37).
- `SCHEMAS-STALE-EDITOR`: the Properties panel used to write its pre-fill copy back
  over the fill. Fixed in Core 0.95.1 (Hive #36, `PROPS-PATCH`), hence `minCoreVersion`.
- A device still on 0.1.0 treats a migrated schema as "Anywhere" until it updates.

## Checks

- `node plugins/notible-schemas/self-check.mjs` — patterns, counter, duplicates per
  scope, key = value parsing, attachments and precedence, migration (counters continue),
  a fake-host run, PL coverage.
- `npm run demo -- --skip-build` — the `note-schemas` sample attaches one Invoice schema
  to two projects and checks both count from FV/001, plus a global task schema.
- The 0.1.0 Settings-panel CDP scenario was removed in 0.2.0. Its behavior is covered
  by the fixture self-check and the maintained `scripts/demo/samples/schemas.cjs` flow.
