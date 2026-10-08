// Schemas (Hive #31, #42, SCHEMAS-PLUGIN): saved recipes for kinds of items.
// A schema is an object of type `notible.schemas.schema` (so it syncs and is
// backed up, unlike context.storage). When an item of the schema's type is
// created and still has its default title, the plugin gives it the pattern
// title, the default properties and tags, and marks it `schemaApplied`.
//
// CCS/1 SCHEMAS-ATTACH (Hive #42, 0.2.0)
// DEC:build once, attach many. An attachment is its own hidden object
// `notible.schemas.attachment` {schemaId, containerId, detached?, issued:<device>}, parented to the container.
// WHY:each attachment's counter marks live on that attachment under the device's own key, so a sync merge
// never has two writers on one key (a prop map on the schema would put every project's marks on one object).
// RULE:a schema with no active attachment = global (applies anywhere, counter on the schema itself);
// inside a container an attached schema wins over a global one (nearest ancestor first).
// RULE:items carry `schemaScope` = containerId ("" = global); numbering and duplicates are per schema+scope+period.
// FLOW:0.1.0 "Only inside X" -> migrate(): attachment to X gets the schema's marks, schema gets legacyScope = X
// (items numbered before 0.2.0 have no schemaScope and count in legacyScope), so numbering continues.
//
// Numbering (Szymon 06.10): next = highest number already issued for that
// schema in the current reset period + 1, read from the items themselves, so a
// sync merge never loses an issued number. Two devices offline can still pick
// the same one: that is detected after sync and flagged, never prevented.

export const SCHEMA_TYPE = "notible.schemas.schema";
export const ATTACHMENT_TYPE = "notible.schemas.attachment";
// I18N (Hive #28): pattern/line errors carry their key in `{ key }` and the
// settings labels go through schemas.t(); tr() only lists them for
// scripts/plugin-locale-check.mjs.
const tr = (key) => key;
void [tr("Schemas"), tr("Schemas: manage"), tr("Open the Schemas screen."), tr("The counter width must be 1 to 9: {token}"), tr("Only one counter per pattern."), tr("Unknown token {token}. Use {yyyy}, {mm}, {dd} or {counter:N}."), tr("A brace without its pair."), tr("Line {line}: write it as key = value."), tr("Line {line}: {name} is kept by Notible.")];
export const RESETS = ["never", "yearly", "monthly"];
export const CONTAINER_TYPES = ["project", "folder", "space"];
// Titles Core and the built-in create commands give a new item. Anything else
// was typed by someone (or came from a template) and is left alone.
export const DEFAULT_TITLES = new Set(["", "New task", "New issue", "New project", "New note", "Untitled note", "Untitled"]);
const RESERVED_PROPS = new Set(["tags", "schemaApplied", "schemaNumber", "schemaPeriod", "schemaScope", "__proto__", "constructor", "prototype"]);
const TOKEN = /\{([^{}]*)\}/g;

// ---------- pure logic (self-check.mjs) ----------

/** Parse a title pattern. Errors are English keys, translated by the UI. */
export function parsePattern(pattern) {
  const parts = [];
  const errors = [];
  let counter = null;
  let last = 0;
  const text = String(pattern ?? "");
  for (const match of text.matchAll(TOKEN)) {
    if (match.index > last) parts.push({ text: text.slice(last, match.index) });
    last = match.index + match[0].length;
    const token = match[1].trim();
    if (token === "yyyy" || token === "mm" || token === "dd") { parts.push({ token }); continue; }
    const counterMatch = /^counter(?::(\d+))?$/.exec(token);
    if (counterMatch) {
      const width = counterMatch[1] === undefined ? 1 : Number(counterMatch[1]);
      if (width < 1 || width > 9) errors.push({ key: "The counter width must be 1 to 9: {token}", values: { token: match[0] } });
      else if (counter) errors.push({ key: "Only one counter per pattern.", values: {} });
      else { counter = { width }; parts.push({ token: "counter", width }); }
      continue;
    }
    errors.push({ key: "Unknown token {token}. Use {yyyy}, {mm}, {dd} or {counter:N}.", values: { token: match[0] } });
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  if (/[{}]/.test(parts.filter((p) => p.text).map((p) => p.text).join(""))) errors.push({ key: "A brace without its pair.", values: {} });
  return { parts, counter, errors };
}

/** The pattern with its counter token set to `width` digits (the editor's padding field). */
export function setCounterWidth(pattern, width) {
  return String(pattern ?? "").replace(/\{\s*counter(?::\d+)?\s*\}/, `{counter:${width}}`);
}

const pad = (n, width) => String(n).padStart(width, "0");

/** "" (never resets), "2026" (yearly) or "2026-10" (monthly), in local time. */
export function periodKey(reset, date = new Date()) {
  if (reset === "yearly") return String(date.getFullYear());
  if (reset === "monthly") return `${date.getFullYear()}-${pad(date.getMonth() + 1, 2)}`;
  return "";
}

export function renderTitle(pattern, date, number) {
  return parsePattern(pattern).parts.map((part) => {
    if (part.text !== undefined) return part.text;
    if (part.token === "yyyy") return String(date.getFullYear());
    if (part.token === "mm") return pad(date.getMonth() + 1, 2);
    if (part.token === "dd") return pad(date.getDate(), 2);
    return pad(number, part.width);
  }).join("");
}

/** Which counter an item was numbered in: its `schemaScope`, or the schema's legacy scope for a 0.1.0 item. */
export function scopeOf(props, legacyScope = "") {
  return typeof props?.schemaScope === "string" ? props.schemaScope : legacyScope;
}

/**
 * Highest number issued for `schemaId` in `scope` + `period`, + 1. `items` are
 * parsed props; `floor` is the synced high-water mark for that counter, which
 * covers numbers on items the scan can't see (SCHEMAS-HIGH-WATER).
 */
export function nextNumber(items, schemaId, period, floor = 0, scope = "", legacyScope = "") {
  let max = Number.isSafeInteger(floor) && floor > 0 ? floor : 0;
  for (const props of items) {
    if (props?.schemaApplied !== schemaId || (props.schemaPeriod ?? "") !== period || scopeOf(props, legacyScope) !== scope) continue;
    const n = props.schemaNumber;
    if (Number.isSafeInteger(n) && n > max) max = n;
  }
  return max + 1;
}

/** Groups of two or more items sharing a number: [{ key, schemaId, scope, period, number, ids }]. */
export function findDuplicates(items, legacyScopes = {}) {
  const groups = new Map();
  for (const { id, props } of items) {
    if (typeof props?.schemaApplied !== "string" || !Number.isSafeInteger(props.schemaNumber)) continue;
    const period = props.schemaPeriod ?? "";
    const scope = scopeOf(props, legacyScopes[props.schemaApplied] ?? "");
    const key = `${props.schemaApplied}|${scope}|${period}|${props.schemaNumber}`;
    if (!groups.has(key)) groups.set(key, { key, schemaId: props.schemaApplied, scope, period, number: props.schemaNumber, ids: [] });
    groups.get(key).ids.push(id);
  }
  return [...groups.values()].filter((group) => group.ids.length > 1).map((group) => ({ ...group, ids: group.ids.sort() }));
}

/** "key = value" lines → props. A value that parses as JSON (3, true, "x") keeps its type. */
export function parseKeyValues(text) {
  const props = {};
  const errors = [];
  for (const [index, raw] of String(text ?? "").split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line) continue;
    const eq = line.indexOf("=");
    const key = eq > 0 ? line.slice(0, eq).trim() : "";
    if (!key) { errors.push({ key: "Line {line}: write it as key = value.", values: { line: index + 1 } }); continue; }
    if (RESERVED_PROPS.has(key) || key.startsWith("_") || key.startsWith("$")) { errors.push({ key: "Line {line}: {name} is kept by Notible.", values: { line: index + 1, name: key } }); continue; }
    const value = line.slice(eq + 1).trim();
    let parsed = value;
    try { const json = JSON.parse(value); if (json === null || typeof json !== "object") parsed = json; } catch { /* plain text */ }
    props[key] = parsed;
  }
  return { props, errors };
}

export function formatKeyValues(props) {
  return Object.entries(props ?? {}).map(([key, value]) => `${key} = ${typeof value === "string" ? value : JSON.stringify(value)}`).join("\n");
}

export function parseTags(text) {
  return [...new Set(String(text ?? "").split(/[,\n]/).map((tag) => tag.trim().replace(/^#/, "")).filter(Boolean))];
}

export function parseProps(json) {
  try { const value = JSON.parse(json || "{}"); return value && typeof value === "object" && !Array.isArray(value) ? value : {}; } catch { return {}; }
}

// CCS/1 SCHEMAS-HIGH-WATER (Hive #31, Codex High; per attachment since #42)
// LIMIT:data.objects.query -> max 5000 rows/type, newest first, no props filter
// ERR:other schemas' items push this schema's numbers out of the scan -> counter restarted at 1
// DEC:counter object props `issued:<device>` = {period:max issued}; next = max(mark, visible max)+1.
// The counter object is the schema (global scope) or the attachment (that container's scope).
// WHY:One writer per top-level key, so a sync merge never has two edits of the same key to choose between and no issued number is lost.
// RULE:mark only rises (withIssued); trashed item's number is not reissued
// LIMIT:duplicate scan still sees only the newest 5000 items of the type
export const ISSUED_PREFIX = "issued:";

/** { period: highest } over every device's `issued:*` key. */
export function issuedFromProps(props) {
  const out = {};
  for (const [key, value] of Object.entries(props ?? {})) {
    if (!key.startsWith(ISSUED_PREFIX) || !value || typeof value !== "object" || Array.isArray(value)) continue;
    for (const [period, n] of Object.entries(value)) if (Number.isSafeInteger(n) && n > (out[period] ?? 0)) out[period] = n;
  }
  return out;
}

/** Props with this device's mark raised to `number` for `period` (never lowered); null when nothing changes. */
export function withIssued(props, device, period, number) {
  const key = `${ISSUED_PREFIX}${device}`;
  const own = props[key] && typeof props[key] === "object" && !Array.isArray(props[key]) ? props[key] : {};
  if (Number.isSafeInteger(own[period]) && own[period] >= number) return null;
  return { ...props, [key]: { ...own, [period]: number } };
}

/** Only the `issued:*` keys of `props`. */
export function marksOf(props) {
  return Object.fromEntries(Object.entries(props ?? {}).filter(([key, value]) => key.startsWith(ISSUED_PREFIX) && value && typeof value === "object" && !Array.isArray(value)));
}

/** `props` with every `issued:*` key of `marks` merged in, per device key and period, keeping the higher number. */
export function mergeMarks(props, marks) {
  const out = { ...props };
  for (const [key, periods] of Object.entries(marksOf(marks))) {
    const own = out[key] && typeof out[key] === "object" && !Array.isArray(out[key]) ? { ...out[key] } : {};
    for (const [period, n] of Object.entries(periods)) if (Number.isSafeInteger(n) && !(own[period] >= n)) own[period] = n;
    out[key] = own;
  }
  return out;
}

/**
 * 0.1.0 → 0.2.0 for one schema's props: a schema with "Only inside X" becomes
 * a schema attached to X. Returns null when there is nothing to migrate, else
 * { containerId, marks (for the attachment), schemaProps (scope + marks removed, legacyScope = X) }.
 */
export function migrateSchemaProps(props) {
  const containerId = typeof props?.scopeContainerId === "string" ? props.scopeContainerId : "";
  if (!containerId) return null;
  const marks = marksOf(props);
  const schemaProps = Object.fromEntries(Object.entries(props).filter(([key]) => key !== "scopeContainerId" && !(key in marks)));
  schemaProps.legacyScope = containerId;
  return { containerId, marks, schemaProps };
}

/** A schema object → its recipe, or null when it isn't one. */
export function schemaFromObject(object) {
  if (!object || object.type !== SCHEMA_TYPE) return null;
  const p = parseProps(object.props);
  if (typeof p.targetType !== "string" || !p.targetType) return null;
  return {
    id: object.id,
    name: object.title || p.targetType,
    targetType: p.targetType,
    // 0.1.0 field, only read until migrate() turns it into an attachment.
    legacyContainerId: typeof p.scopeContainerId === "string" && p.scopeContainerId ? p.scopeContainerId : null,
    legacyScope: typeof p.legacyScope === "string" ? p.legacyScope : (typeof p.scopeContainerId === "string" ? p.scopeContainerId : ""),
    titlePattern: typeof p.titlePattern === "string" ? p.titlePattern : "",
    counterReset: RESETS.includes(p.counterReset) ? p.counterReset : "never",
    // Same keys the editor refuses, for a schema that arrived by sync.
    defaultProps: p.defaultProps && typeof p.defaultProps === "object" && !Array.isArray(p.defaultProps)
      ? Object.fromEntries(Object.entries(p.defaultProps).filter(([key]) => !RESERVED_PROPS.has(key) && !key.startsWith("_") && !key.startsWith("$")))
      : {},
    defaultTags: Array.isArray(p.defaultTags) ? p.defaultTags.filter((tag) => typeof tag === "string") : [],
    issued: issuedFromProps(p),
    updatedAt: object.updated_at,
  };
}

/** An attachment object → { id, schemaId, containerId, detached, issued }, or null. */
export function attachmentFromObject(object) {
  if (!object || object.type !== ATTACHMENT_TYPE) return null;
  const p = parseProps(object.props);
  if (typeof p.schemaId !== "string" || !p.schemaId || typeof p.containerId !== "string" || !p.containerId) return null;
  return { id: object.id, schemaId: p.schemaId, containerId: p.containerId, detached: p.detached === true, issued: issuedFromProps(p) };
}

/**
 * Attachment objects grouped by schema + container. Two devices attaching the
 * same pair offline make two objects; they count as one, with their marks merged.
 * Map "schemaId|containerId" → { schemaId, containerId, ids, primaryId, active, issued }.
 */
export function groupAttachments(attachments) {
  const groups = new Map();
  for (const a of [...attachments].sort((x, y) => x.id.localeCompare(y.id))) {
    const key = `${a.schemaId}|${a.containerId}`;
    if (!groups.has(key)) groups.set(key, { schemaId: a.schemaId, containerId: a.containerId, ids: [], primaryId: a.id, active: false, issued: {} });
    const group = groups.get(key);
    group.ids.push(a.id);
    if (!a.detached) group.active = true;
    for (const [period, n] of Object.entries(a.issued)) if (n > (group.issued[period] ?? 0)) group.issued[period] = n;
  }
  return groups;
}

/** True when the schema has no active attachment: it applies anywhere. */
export function isGlobal(schema, groups) {
  for (const group of groups.values()) if (group.active && group.schemaId === schema.id) return false;
  return true;
}

/**
 * The schema for a new item: one attached to its nearest ancestor wins over a
 * global one. → { schema, scope } (scope = container id, "" = global) or null.
 */
export function pickSchema(schemas, groups, type, ancestorIds) {
  const candidates = schemas.filter((schema) => schema.targetType === type);
  for (const ancestor of ancestorIds) {
    const attached = candidates.find((schema) => groups.get(`${schema.id}|${ancestor}`)?.active);
    if (attached) return { schema: attached, scope: ancestor };
  }
  const global = candidates.find((schema) => isGlobal(schema, groups));
  return global ? { schema: global, scope: "" } : null;
}

/** The synced high-water marks of one counter: the schema's for "", the attachment's otherwise. */
export function marksFor(schema, groups, scope) {
  return scope ? groups.get(`${schema.id}|${scope}`)?.issued ?? {} : schema.issued ?? {};
}

/** Title + props for an item made from `schema` in `scope`. `issued` = parsed props of existing items of that type. */
export function fill(schema, currentProps, issued, date = new Date(), scope = "", marks = schema.issued) {
  const { counter } = parsePattern(schema.titlePattern);
  const props = { ...currentProps, ...schema.defaultProps, schemaApplied: schema.id, schemaScope: scope };
  const tags = Array.isArray(currentProps.tags) ? currentProps.tags : [];
  if (schema.defaultTags.length) props.tags = [...new Set([...tags, ...schema.defaultTags])];
  let number = 0;
  if (counter) {
    const period = periodKey(schema.counterReset, date);
    number = nextNumber(issued, schema.id, period, marks?.[period] ?? 0, scope, schema.legacyScope ?? "");
    props.schemaNumber = number;
    props.schemaPeriod = period;
  }
  return { title: schema.titlePattern.trim() ? renderTitle(schema.titlePattern, date, number) : null, props };
}

// ---------- plugin ----------

const reason = (error) => (error instanceof Error ? error.message : String(error));

function createSchemas(context) {
  const t = (key, values) => context.i18n.t(key, values);
  const data = context.data;
  let queue = Promise.resolve();
  // ponytail: one in-memory queue per device. Two quick creates here get
  // different numbers; two devices offline can still collide (flagged below).
  const serial = (task) => { const run = queue.then(task, task); queue = run.catch(() => {}); return run; };
  const listeners = new Set();
  const changed = () => { for (const listener of listeners) listener(); };
  const commands = new Map(); // schemaId → { signature, disposable }
  let duplicates = [];
  // SCHEMAS-STALE-EDITOR: the note screen opens a new item before we fill it.
  // Core's Properties panel used to write its pre-fill copy back over the fill;
  // since Hive #36 (PROPS-PATCH, Core 0.95.1) it writes only the edited keys.

  async function schemas() {
    const rows = await data.objects.query({ type: SCHEMA_TYPE, limit: 500 });
    return rows.map(schemaFromObject).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
  }

  async function groups() {
    const rows = await data.objects.query({ type: ATTACHMENT_TYPE, limit: 5000 });
    return groupAttachments(rows.map(attachmentFromObject).filter(Boolean));
  }

  // CCS/1 IO:type -> newest 5000 items (incl. archived) | DEP:SCHEMAS-HIGH-WATER for numbering
  async function issuedFor(type) {
    const rows = await data.objects.query({ type, includeArchived: true, limit: 5000 });
    return rows.map((row) => ({ id: row.id, title: row.title, props: parseProps(row.props) }));
  }

  /** This device's key for SCHEMAS-HIGH-WATER: random, kept in local storage. */
  function deviceKey() {
    let key = context.storage.get("deviceKey");
    if (typeof key !== "string" || !/^[a-f0-9]{8,32}$/.test(key)) {
      key = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
      context.storage.set("deviceKey", key);
    }
    return key;
  }

  /** Read-modify-write one object's props (in the queue); `change` returns the new props or null. */
  async function updateProps(id, change, extra = {}) {
    for (let attempt = 0; ; attempt += 1) {
      const object = await data.objects.get(id);
      if (!object) return null;
      const next = change(parseProps(object.props));
      if (!next) return object;
      try { return await data.objects.update(id, { ...extra, props: JSON.stringify(next) }, object.updated_at); }
      catch (error) { if (attempt === 1) throw error; } // edited meanwhile: read again once
    }
  }

  /** Raise the counter's synced high-water mark after a number was issued (inside the queue). */
  async function recordIssued(schemaId, scope, props) {
    if (!Number.isSafeInteger(props.schemaNumber)) return;
    const counterId = scope ? (await groups()).get(`${schemaId}|${scope}`)?.primaryId : schemaId;
    if (!counterId) return;
    await updateProps(counterId, (current) => withIssued(current, deviceKey(), props.schemaPeriod ?? "", props.schemaNumber)).catch(() => {});
  }

  async function ancestors(parentId) {
    const ids = [];
    while (parentId && ids.length < 32 && !ids.includes(parentId)) {
      ids.push(parentId);
      parentId = (await data.objects.get(parentId))?.parent_id ?? null;
    }
    return ids;
  }

  // CCS/1 SCHEMAS-MIGRATE-020: once per 0.1.0 scoped schema, idempotent (the scope field is gone after it),
  // and again for one that arrives by sync from a device still on 0.1.0.
  function migrate() {
    return serial(async () => {
      const raw = await data.objects.query({ type: SCHEMA_TYPE, limit: 500 });
      for (const object of raw) {
        const plan = migrateSchemaProps(parseProps(object.props));
        if (!plan) continue;
        const group = (await groups()).get(`${object.id}|${plan.containerId}`);
        if (group) await updateProps(group.primaryId, (props) => mergeMarks({ ...props, detached: false }, plan.marks));
        else {
          const parent = await data.objects.get(plan.containerId);
          await data.objects.create({ type: ATTACHMENT_TYPE, title: object.title, props: JSON.stringify({ schemaId: object.id, containerId: plan.containerId, ...plan.marks }), ...(parent ? { parentId: plan.containerId } : {}) });
        }
        await updateProps(object.id, (props) => migrateSchemaProps(props)?.schemaProps ?? null);
      }
    });
  }

  /** object.created → fill it in, if a schema matches and it still has its default title. */
  function applyTo(id) {
    return serial(async () => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const object = await data.objects.get(id);
        if (!object || object.type === SCHEMA_TYPE || object.type === ATTACHMENT_TYPE || !DEFAULT_TITLES.has(object.title.trim())) return;
        const props = parseProps(object.props);
        // Already applied: a sync arrival, or the "New …" command made it filled.
        if (props.schemaApplied) return;
        const all = await groups();
        const picked = pickSchema(await schemas(), all, object.type, await ancestors(object.parent_id ?? null));
        if (!picked) return;
        const { schema, scope } = picked;
        const next = fill(schema, props, (await issuedFor(object.type)).map((row) => row.props), new Date(), scope, marksFor(schema, all, scope));
        try {
          await data.objects.update(id, { ...(next.title ? { title: next.title } : {}), props: JSON.stringify(next.props) }, object.updated_at);
          await recordIssued(schema.id, scope, next.props);
          changed();
          return;
        } catch (error) {
          // Someone saved in between (the editor opening it): read it again once.
          if (attempt === 1) context.ui.notice(t("Schemas couldn't fill in a new item: {reason}", { reason: reason(error) }), { timeoutMs: 8000 });
        }
      }
    });
  }

  /**
   * "New <schema>" from the "+" menu: created already filled, no rename flash.
   * Inside a container the schema is attached to (or below it), that attachment's
   * counter is used; a global schema counts globally; an attached-only schema used
   * elsewhere goes into its first attached container.
   */
  function createFrom(schemaId, input) {
    return serial(async () => {
      const schema = (await schemas()).find((item) => item.id === schemaId);
      if (!schema) throw new Error(t("This schema no longer exists."));
      const all = await groups();
      const here = input && typeof input === "object" && typeof input.parentId === "string" && input.parentId ? input.parentId : null;
      let parentId = here;
      let scope = (await ancestors(here)).find((ancestor) => all.get(`${schema.id}|${ancestor}`)?.active) ?? null;
      if (scope === null) {
        const first = [...all.values()].find((group) => group.active && group.schemaId === schema.id);
        scope = first ? first.containerId : "";
        if (first) parentId = first.containerId;
      }
      const typed = input && typeof input === "object" && typeof input.title === "string" ? input.title.trim() : "";
      const next = fill(schema, {}, (await issuedFor(schema.targetType)).map((row) => row.props), new Date(), scope, marksFor(schema, all, scope));
      const object = await data.objects.create({ type: schema.targetType, title: typed || next.title || schema.name, props: JSON.stringify(next.props), parentId: parentId || undefined });
      await recordIssued(schema.id, scope, next.props);
      changed();
      return object;
    });
  }

  /** Returns true when a "New …" entry was added or renamed. */
  function syncCommands(list) {
    const live = new Set();
    let added = false;
    for (const schema of list) {
      live.add(schema.id);
      const signature = `${schema.name}|${schema.targetType}`;
      if (commands.get(schema.id)?.signature === signature) continue;
      commands.get(schema.id)?.disposable.dispose();
      added = true;
      commands.set(schema.id, {
        signature,
        disposable: context.commands.register({
          id: `new-${schema.id}`,
          name: t("New {name}", { name: schema.name }),
          description: t("Creates a {type} from the schema \"{name}\".", { type: schema.targetType, name: schema.name }),
          creates: { objectType: schema.targetType, label: schema.name },
          execute: (input) => createFrom(schema.id, input),
        }),
      });
    }
    for (const [id, entry] of commands) if (!live.has(id)) { entry.disposable.dispose(); commands.delete(id); }
    return added;
  }

  /** After sync (any workspace change): migrate, refresh + entries, same number twice in one counter → one notice per new clash. */
  async function scan() {
    await migrate();
    const list = await schemas();
    const added = syncCommands(list);
    const byId = new Map(list.map((schema) => [schema.id, schema]));
    const legacyScopes = Object.fromEntries(list.map((schema) => [schema.id, schema.legacyScope]));
    const found = [];
    for (const type of new Set(list.map((schema) => schema.targetType))) {
      const rows = await issuedFor(type);
      const titles = new Map(rows.map((row) => [row.id, row.title]));
      for (const group of findDuplicates(rows, legacyScopes)) if (byId.has(group.schemaId)) found.push({ ...group, schema: byId.get(group.schemaId), titles: group.ids.map((id) => titles.get(id) ?? id) });
    }
    duplicates = found;
    const seen = new Set(context.storage.get("notifiedDuplicates") ?? []);
    for (const group of found) {
      const key = `${group.key}|${group.ids.join(",")}`;
      if (seen.has(key)) continue;
      seen.add(key);
      context.ui.notice(t("{count} items from \"{name}\" have the same number: {title}. Devices that were offline can pick the same number; rename one.", { count: group.ids.length, name: group.schema.name, title: group.titles[0] }), {
        timeoutMs: 15000,
        action: { label: t("Open"), onSelect: () => context.ui.openObject(group.ids[group.ids.length - 1]) },
      });
    }
    context.storage.set("notifiedDuplicates", [...seen].slice(-200));
    changed();
    return added;
  }

  let scanTimer = null;
  const scanSoon = () => { clearTimeout(scanTimer); scanTimer = setTimeout(() => { void scan().catch(() => {}); }, 1500); };

  /** Create or update a schema; returns its id. `attachTo` attaches a new one on save. */
  async function save(draft, attachTo = null) {
    const props = {
      targetType: draft.targetType,
      titlePattern: draft.titlePattern,
      counterReset: draft.counterReset,
      defaultProps: draft.defaultProps,
      defaultTags: draft.defaultTags,
    };
    let id = draft.id;
    // Onto the current props, in the queue: keeps every `issued:*` mark
    // (SCHEMAS-HIGH-WATER), legacyScope and any key a newer version added.
    if (id) {
      const updated = await serial(() => updateProps(id, (current) => ({ ...current, ...props }), { title: draft.name }));
      if (!updated) throw new Error(t("This schema no longer exists."));
    } else id = (await data.objects.create({ type: SCHEMA_TYPE, title: draft.name, props: JSON.stringify(props) })).id;
    if (attachTo) await attach(id, attachTo);
    // SCHEMAS-PLUS-MENU-REFRESH: Core refreshes the + menu when a plugin
    // registers a command late (Hive #37), so no restart notice is needed.
    await scan();
    return id;
  }

  /** Attach a schema to a container: revive a detached attachment (keeps its marks) or make one. */
  function attach(schemaId, containerId) {
    return serial(async () => {
      const group = (await groups()).get(`${schemaId}|${containerId}`);
      if (group) { for (const id of group.ids) await updateProps(id, (props) => (props.detached ? { ...props, detached: false } : null)); }
      else {
        const schema = await data.objects.get(schemaId);
        await data.objects.create({ type: ATTACHMENT_TYPE, title: schema?.title ?? "", props: JSON.stringify({ schemaId, containerId }), parentId: containerId });
      }
      changed();
    });
  }

  /** Detach: kept as `detached` so attaching again continues the numbering. */
  function detach(schemaId, containerId) {
    return serial(async () => {
      const group = (await groups()).get(`${schemaId}|${containerId}`);
      for (const id of group?.ids ?? []) await updateProps(id, (props) => (props.detached ? null : { ...props, detached: true }));
      changed();
    });
  }

  async function remove(schemaId) {
    for (const group of (await groups()).values()) if (group.schemaId === schemaId) for (const id of group.ids) await data.objects.trash(id);
    await data.objects.trash(schemaId);
    await scan();
  }

  /** The number the next item in `scope` would get. */
  async function previewNumber(schema, scope = "", date = new Date()) {
    if (!schema.id || !parsePattern(schema.titlePattern).counter) return 1;
    const period = periodKey(schema.counterReset, date);
    const stored = (await schemas()).find((item) => item.id === schema.id) ?? schema;
    const marks = marksFor(stored, await groups(), scope);
    return nextNumber((await issuedFor(schema.targetType)).map((row) => row.props), schema.id, period, marks[period] ?? 0, scope, stored.legacyScope ?? "");
  }

  return {
    t, applyTo, scan, scanSoon, migrate, registerCommands: async () => { syncCommands(await schemas()); }, schemas, groups, save, attach, detach, remove, previewNumber,
    duplicates: () => duplicates,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    dispose() { clearTimeout(scanTimer); for (const entry of commands.values()) entry.disposable.dispose(); commands.clear(); },
  };
}

// ---------- UI ----------

const styles = `
.nschemas { display: grid; gap: 14px; color: var(--notible-text); font-size: 13px; }
.nschemas p { margin: 0; max-width: 70ch; color: var(--notible-muted); font-size: 12px; line-height: 1.55; }
.nschemas h2 { margin: 0; font-size: 18px; font-weight: 600; }
.nschemas h3 { margin: 0; font-size: 13px; font-weight: 600; }
.nschemas button { min-height: 30px; padding: 5px 12px; border: 1px solid var(--notible-border); border-radius: 7px; background: transparent; color: var(--notible-text); font: inherit; font-size: 12px; cursor: pointer; }
.nschemas button:hover:not(:disabled) { border-color: var(--notible-accent); background: var(--notible-hover); }
.nschemas button:focus-visible, .nschemas input:focus-visible, .nschemas textarea:focus-visible { outline: 2px solid var(--notible-accent); outline-offset: 2px; }
.nschemas button:disabled { cursor: not-allowed; opacity: .46; }
.nschemas .nschemas-primary { border-color: var(--notible-accent); background: var(--notible-accent); color: var(--notible-on-accent); font-weight: 600; }
.nschemas .nschemas-primary:hover:not(:disabled) { border-color: var(--notible-accent-hover); background: var(--notible-accent-hover); }
.nschemas .nschemas-danger { color: var(--notible-danger); }
.nschemas .nschemas-danger:hover:not(:disabled) { border-color: var(--notible-danger); background: var(--notible-danger-surface); }
.nschemas input, .nschemas textarea { box-sizing: border-box; width: 100%; min-width: 0; padding: 6px 9px; border: 1px solid var(--notible-border); border-radius: 7px; background: var(--notible-surface); color: var(--notible-text); font: inherit; font-size: 12px; }
.nschemas input { height: 32px; }
.nschemas textarea { min-height: 64px; resize: vertical; font-family: ui-monospace, Consolas, monospace; }
.nschemas-page { box-sizing: border-box; height: 100%; padding: 22px 26px; overflow: auto; align-content: start; }
.nschemas-split { display: grid; grid-template-columns: minmax(200px, 280px) minmax(0, 1fr); gap: 20px; align-items: start; }
.nschemas-side { display: grid; gap: 10px; }
.nschemas-list { display: grid; gap: 0; margin: 0; padding: 0; list-style: none; border: 1px solid var(--notible-border-subtle); border-radius: 8px; }
.nschemas-list li { display: flex; align-items: center; gap: 10px; min-width: 0; padding: 8px 10px; }
.nschemas-list li + li { border-top: 1px solid var(--notible-border-subtle); }
.nschemas .nschemas-pick { display: grid; gap: 2px; width: 100%; min-height: 0; padding: 8px 10px; border: 0; border-radius: 0; text-align: left; }
.nschemas .nschemas-pick[aria-current="true"] { box-shadow: inset 2px 0 0 var(--notible-accent); background: var(--notible-hover); }
.nschemas-pick-list li { padding: 0; }
.nschemas-row-text { display: grid; gap: 2px; flex: 1; min-width: 0; }
.nschemas-row-text strong, .nschemas-row-text span, .nschemas-pick strong, .nschemas-pick span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.nschemas-row-text span, .nschemas-pick span { color: var(--notible-muted); font-size: 12px; }
.nschemas-empty { padding: 10px; color: var(--notible-muted); font-size: 12px; }
.nschemas-editor { display: grid; gap: 14px; min-width: 0; padding: 16px; border: 1px solid var(--notible-border-subtle); border-radius: 10px; }
.nschemas-form { display: grid; grid-template-columns: minmax(110px, 160px) minmax(0, 1fr); gap: 10px 14px; align-items: start; }
.nschemas-form > label, .nschemas-label { padding-top: 7px; color: var(--notible-muted); font-size: 12px; }
.nschemas-field { display: grid; gap: 5px; min-width: 0; }
.nschemas-hint { color: var(--notible-faint) !important; font-size: 11px !important; }
.nschemas-error { color: var(--notible-danger) !important; }
.nschemas-preview { padding: 6px 9px; border: 1px dashed var(--notible-border); border-radius: 7px; font-family: ui-monospace, Consolas, monospace; font-size: 12px; overflow-wrap: anywhere; }
.nschemas-actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.nschemas-actions > div { min-width: 180px; }
.nschemas-note { padding: 8px 10px; border: 1px solid var(--notible-accent); border-radius: 8px; }
.nschemas-warning { padding: 8px 10px; border: 1px solid var(--notible-warning); border-radius: 8px; }
.nschemas-warning ul { margin: 6px 0 0; padding-left: 18px; font-size: 12px; }
.nschemas-tab { box-sizing: border-box; max-width: 760px; padding: 18px 20px; }
@media (max-width: 760px) { .nschemas-split { grid-template-columns: minmax(0, 1fr); } }
@media (max-width: 640px) { .nschemas-form { grid-template-columns: minmax(0, 1fr); } .nschemas-form > label, .nschemas-label { padding-top: 0; } .nschemas-page { padding: 16px; } }
`;

function element(tag, properties = {}, children = []) {
  const node = Object.assign(document.createElement(tag), properties);
  for (const child of children) if (child) node.append(child);
  return node;
}

/** A button that asks "again?" instead of opening a dialog. */
function confirmButton(label, confirmLabel, action) {
  const button = element("button", { type: "button", className: "nschemas-danger", textContent: label });
  let armed = false;
  button.onclick = async () => {
    if (!armed) { armed = true; button.textContent = confirmLabel; setTimeout(() => { armed = false; button.textContent = label; }, 4000); return; }
    button.disabled = true;
    await action();
  };
  return button;
}

/** Shared mount scaffolding: a styled root, disposables, re-render on change. */
function surface(container, schemas, className, render) {
  const root = element("div", { className: `nschemas ${className}` });
  container.append(element("style", { textContent: styles }), root);
  const state = { alive: true, disposables: [] };
  state.clear = () => { for (const d of state.disposables) d.dispose(); state.disposables = []; root.replaceChildren(); };
  state.select = (context, value, options, ariaLabel, onChange) => {
    const host = element("div", {});
    state.disposables.push(context.ui.mountSelect(host, { value, options, ariaLabel, onChange }));
    return host;
  };
  const run = () => { if (state.alive) void render(root, state).catch((error) => { if (state.alive) root.replaceChildren(element("p", { className: "nschemas-error", textContent: reason(error) })); }); };
  state.rerender = run;
  // A background change (a fill, a sync scan) must not wipe unsaved input in an editor.
  const unsubscribe = schemas.subscribe(() => { if (!state.busy && !state.dirty) run(); });
  run();
  return { dispose: () => { state.alive = false; unsubscribe(); state.clear(); } };
}

const view = { editing: null, attachTo: null }; // survives remounts: editing = null | "new" | schema id

const containerLabel = (t, object) => `${object?.title || t("Untitled")} (${object?.type ?? "?"})`;

/** Settings → Plugins → Schemas: only a way to the full screen. */
function mountSettingsLink(context, schemas, container) {
  const { t } = schemas;
  return surface(container, schemas, "", async (root, state) => {
    state.clear();
    const open = element("button", { type: "button", className: "nschemas-primary", textContent: t("Open Schemas") });
    open.onclick = () => { void context.ui.openView("schemas"); };
    root.append(
      element("p", { textContent: t("Schemas are built and edited on their own screen, and attached to projects from each project's Schemas tab.") }),
      element("div", { className: "nschemas-actions" }, [open]),
    );
  });
}

/** The configurator: schema list left, editor right. */
function mountConfigurator(context, schemas, container) {
  const { t } = schemas;
  const errorText = (error) => t(error.key, error.values);
  return surface(container, schemas, "nschemas-page", async (root, state) => {
    const rerender = () => { state.dirty = false; state.rerender(); };
    const [list, all] = await Promise.all([schemas.schemas(), schemas.groups()]);
    if (!state.alive) return;
    if (view.editing && view.editing !== "new" && !list.some((schema) => schema.id === view.editing)) view.editing = null;
    if (!view.editing) view.editing = list[0]?.id ?? "new";
    const editing = view.editing === "new" ? {} : list.find((schema) => schema.id === view.editing);
    const [types, containers] = await Promise.all([
      context.data.types.list(),
      Promise.all(CONTAINER_TYPES.map((type) => context.data.objects.query({ type, limit: 500 }))).then((rows) => rows.flat()),
    ]);
    if (!state.alive) return;
    const containerById = new Map(containers.map((object) => [object.id, object]));
    state.clear();

    root.append(
      element("h2", { textContent: t("Schemas") }),
      element("p", { textContent: t("A schema fills in new items of one kind: a title pattern, properties and tags. It applies when you create the item with \"New …\" in the + menu, or to a new item that still has its default title.") }),
      element("p", { className: "nschemas-hint", textContent: t("Build a schema once, then attach it to projects from their Schemas tab; each project counts on its own. A schema attached nowhere applies everywhere.") }),
      element("p", { className: "nschemas-hint", textContent: t("Numbers are the highest one already used + 1. Two devices working offline can give out the same number; Notible tells you after they sync. Numbering can have gaps and is not guaranteed unique.") }),
    );
    const dupes = schemas.duplicates();
    if (dupes.length) {
      root.append(element("div", { className: "nschemas-warning", role: "status" }, [
        element("strong", { textContent: t("Same number used twice") }),
        element("ul", {}, dupes.map((group) => element("li", { textContent: t("{name}: {titles}", { name: group.schema.name, titles: group.titles.join(" · ") }) }))),
      ]));
    }

    // Left: the list.
    const add = element("button", { type: "button", className: "nschemas-primary", textContent: t("New schema") });
    add.onclick = () => { view.editing = "new"; view.attachTo = null; rerender(); };
    const rows = list.map((schema) => {
      const used = [...all.values()].filter((group) => group.active && group.schemaId === schema.id);
      const pick = element("button", { type: "button", className: "nschemas-pick", ariaCurrent: String(schema.id === view.editing) }, [
        element("strong", { textContent: schema.name }),
        element("span", { textContent: `${schema.targetType} · ${used.length ? t("Attached: {count}", { count: used.length }) : t("Everywhere")}` }),
      ]);
      pick.onclick = () => { view.editing = schema.id; view.attachTo = null; rerender(); };
      return element("li", {}, [pick]);
    });
    const side = element("div", { className: "nschemas-side" }, [
      element("div", { className: "nschemas-actions" }, [add]),
      rows.length ? element("ul", { className: "nschemas-list nschemas-pick-list" }, rows) : element("div", { className: "nschemas-empty", textContent: t("No schemas yet.") }),
    ]);

    // Right: the editor.
    const draft = {
      id: editing?.id ?? null,
      name: editing?.name ?? "",
      targetType: editing?.targetType ?? "task",
      titlePattern: editing?.titlePattern ?? "",
      counterReset: editing?.counterReset ?? "never",
    };
    const typeNames = [...new Set(["note", "task", ...types.map((type) => type.name)])].filter((name) => name !== SCHEMA_TYPE && name !== ATTACHMENT_TYPE).sort();
    const form = element("div", { className: "nschemas-form" });
    const row = (label, id, ...fields) => { form.append(element(id ? "label" : "span", id ? { htmlFor: id, textContent: label } : { className: "nschemas-label", textContent: label }), element("div", { className: "nschemas-field" }, fields)); };

    const name = element("input", { id: "nschemas-name", value: draft.name, placeholder: t("Invoice") });
    row(t("Name"), "nschemas-name", name);
    row(t("Kind of item"), "", state.select(context, draft.targetType, typeNames.map((value) => ({ value, label: value })), t("Kind of item"), (value) => { draft.targetType = value; }));
    const pattern = element("input", { id: "nschemas-pattern", value: draft.titlePattern, placeholder: "FV/{counter:3}/{mm}/{yyyy}", spellcheck: false });
    const preview = element("div", { className: "nschemas-preview", ariaLive: "polite" });
    const patternErrors = element("p", { className: "nschemas-error" });
    row(t("Title pattern"), "nschemas-pattern", pattern, preview, patternErrors,
      element("p", { className: "nschemas-hint", textContent: t("{yyyy} year, {mm} month, {dd} day, {counter:3} number padded to 3 digits. Empty keeps the title.") }));
    // Counter padding rewrites the {counter:N} token; shown only when the pattern has one.
    const widthHost = element("div", {});
    let widthDisposable = null;
    let shownWidth = null;
    const syncWidth = () => {
      const width = parsePattern(pattern.value).counter?.width ?? null;
      if (width === shownWidth) return;
      shownWidth = width;
      widthDisposable?.dispose();
      widthHost.replaceChildren();
      if (width === null) { widthHost.append(element("p", { className: "nschemas-hint", textContent: t("Add {counter} to the pattern to number items.") })); return; }
      const host = element("div", {});
      widthDisposable = context.ui.mountSelect(host, {
        value: String(width), ariaLabel: t("Number width"),
        options: [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => ({ value: String(n), label: t("{count} digits: {sample}", { count: n, sample: pad(7, n) }) })),
        onChange: (value) => { pattern.value = setCounterWidth(pattern.value, Number(value)); shownWidth = Number(value); void updatePreview(); },
      });
      widthHost.append(host);
    };
    state.disposables.push({ dispose: () => widthDisposable?.dispose() });
    row(t("Number width"), "", widthHost);
    row(t("Counter restarts"), "", state.select(context, draft.counterReset, [
      { value: "never", label: t("Never") }, { value: "yearly", label: t("Every year") }, { value: "monthly", label: t("Every month") },
    ], t("Counter restarts"), (value) => { draft.counterReset = value; void updatePreview(); }));
    const propsInput = element("textarea", { id: "nschemas-props", value: formatKeyValues(editing?.defaultProps), placeholder: "status = doing\npriority = high", spellcheck: false });
    const propsErrors = element("p", { className: "nschemas-error" });
    row(t("Properties"), "nschemas-props", propsInput, propsErrors, element("p", { className: "nschemas-hint", textContent: t("One per line: key = value.") }));
    const tagsInput = element("input", { id: "nschemas-tags", value: (editing?.defaultTags ?? []).join(", "), placeholder: "invoice, 2026" });
    row(t("Tags"), "nschemas-tags", tagsInput, element("p", { className: "nschemas-hint", textContent: t("Separate with commas.") }));

    // Where it applies, with each counter's next number.
    const used = draft.id ? [...all.values()].filter((group) => group.active && group.schemaId === draft.id) : [];
    const usedList = element("ul", { className: "nschemas-list" });
    row(t("Used in"), "", used.length ? usedList : element("p", { textContent: draft.id ? t("Everywhere: not attached to any project. Attach it from a project's Schemas tab.") : t("Everywhere until you attach it to a project.") }));

    let previewRun = 0;
    async function updatePreview() {
      const run = ++previewRun;
      syncWidth();
      const parsed = parsePattern(pattern.value);
      patternErrors.textContent = parsed.errors.map(errorText).join(" ");
      if (parsed.errors.length) { preview.textContent = "—"; return; }
      if (!pattern.value.trim()) { preview.textContent = t("(title unchanged)"); usedList.replaceChildren(...used.map((group) => element("li", { textContent: containerLabel(t, containerById.get(group.containerId)) }))); return; }
      const candidate = { ...draft, titlePattern: pattern.value, legacyScope: editing?.legacyScope ?? "" };
      const firstScope = used[0]?.containerId ?? "";
      const numbers = await Promise.all([firstScope, ...used.map((group) => group.containerId)].map((scope) => schemas.previewNumber(candidate, scope).catch(() => 1)));
      if (run !== previewRun || !state.alive) return;
      const now = new Date();
      preview.textContent = t("Next: {title}", { title: renderTitle(pattern.value, now, numbers[0]) });
      usedList.replaceChildren(...used.map((group, index) => element("li", {}, [element("div", { className: "nschemas-row-text" }, [
        element("strong", { textContent: containerLabel(t, containerById.get(group.containerId)) }),
        element("span", { textContent: t("Next: {title}", { title: renderTitle(pattern.value, now, numbers[index + 1]) }) }),
      ])])));
    }
    pattern.oninput = () => { void updatePreview(); };
    void updatePreview();

    const status = element("p", { className: "nschemas-error", role: "alert" });
    const saveButton = element("button", { type: "button", className: "nschemas-primary", textContent: t("Save") });
    const actions = [saveButton];
    if (draft.id) actions.push(confirmButton(t("Delete"), t("Delete?"), async () => { view.editing = null; await schemas.remove(draft.id); rerender(); }));
    saveButton.onclick = async () => {
      const parsedPattern = parsePattern(pattern.value);
      const parsedProps = parseKeyValues(propsInput.value);
      propsErrors.textContent = parsedProps.errors.map(errorText).join(" ");
      status.textContent = "";
      if (!name.value.trim()) { status.textContent = t("Give the schema a name."); name.focus(); return; }
      if (parsedPattern.errors.length || parsedProps.errors.length) { status.textContent = t("Fix the fields marked in red."); return; }
      saveButton.disabled = true;
      state.busy = true;
      try {
        const attachTo = draft.id ? null : view.attachTo;
        view.editing = await schemas.save({ ...draft, name: name.value.trim(), titlePattern: pattern.value.trim(), defaultProps: parsedProps.props, defaultTags: parseTags(tagsInput.value) }, attachTo);
        view.attachTo = null;
        state.busy = false;
        state.dirty = false;
        if (attachTo) { await context.ui.openObject(attachTo); return; }
        rerender();
      } catch (error) {
        state.busy = false;
        status.textContent = t("Couldn't save: {reason}", { reason: reason(error) });
        saveButton.disabled = false;
      }
    };
    const markDirty = () => { state.dirty = true; };
    const editor = element("div", { className: "nschemas-editor", oninput: markDirty, onclick: markDirty }, [
      element("h3", { textContent: draft.id ? t("Edit schema") : t("New schema") }),
      view.attachTo && !draft.id ? element("p", { className: "nschemas-note", textContent: t("Saving attaches it to {name}.", { name: containerLabel(t, containerById.get(view.attachTo)) }) }) : null,
      form, status, element("div", { className: "nschemas-actions" }, actions),
    ]);
    root.append(element("div", { className: "nschemas-split" }, [side, editor]));
    if (!draft.id) name.focus();
  });
}

/** The Schemas tab on a project, folder or space. */
function mountContainerTab(context, schemas, container, containerId) {
  const { t } = schemas;
  return surface(container, schemas, "nschemas-tab", async (root, state) => {
    const [list, all] = await Promise.all([schemas.schemas(), schemas.groups()]);
    const here = list.filter((schema) => all.get(`${schema.id}|${containerId}`)?.active);
    const numbers = await Promise.all(here.map((schema) => schemas.previewNumber(schema, containerId).catch(() => 1)));
    if (!state.alive) return;
    state.clear();
    const now = new Date();
    root.append(
      element("h3", { textContent: t("Schemas attached here") }),
      element("p", { textContent: t("New items of these kinds made here (or below) get the schema's title, properties and tags. Each attachment counts on its own.") }),
    );
    root.append(here.length
      ? element("ul", { className: "nschemas-list" }, here.map((schema, index) => element("li", {}, [
        element("div", { className: "nschemas-row-text" }, [
          element("strong", { textContent: schema.name }),
          element("span", { textContent: `${schema.targetType} · ${schema.titlePattern ? t("Next: {title}", { title: renderTitle(schema.titlePattern, now, numbers[index]) }) : t("(title unchanged)")}` }),
        ]),
        confirmButton(t("Detach"), t("Detach?"), async () => { await schemas.detach(schema.id, containerId); }),
      ])))
      : element("div", { className: "nschemas-empty", textContent: t("No schemas attached here.") }));

    const free = list.filter((schema) => !all.get(`${schema.id}|${containerId}`)?.active);
    const actions = element("div", { className: "nschemas-actions" });
    if (free.length) {
      let chosen = free[0].id;
      const attach = element("button", { type: "button", textContent: t("Attach schema") });
      attach.onclick = async () => { attach.disabled = true; await schemas.attach(chosen, containerId); };
      actions.append(state.select(context, chosen, free.map((schema) => ({ value: schema.id, label: `${schema.name} (${schema.targetType})` })), t("Schema to attach"), (value) => { chosen = value; }), attach);
    }
    const create = element("button", { type: "button", className: "nschemas-primary", textContent: t("New schema") });
    create.onclick = () => { view.editing = "new"; view.attachTo = containerId; void context.ui.openView("schemas"); };
    actions.append(create);
    root.append(actions);

    const globals = list.filter((schema) => isGlobal(schema, all));
    if (globals.length) root.append(element("p", { className: "nschemas-hint", textContent: t("Also applies here, unless an attached schema covers the same kind: {names}", { names: globals.map((schema) => schema.name).join(", ") }) }));
  });
}

const plugin = {
  manifest: {
    id: "notible.schemas",
    name: "Schemas",
    version: "0.2.0",
    apiVersion: "1.25",
    permissions: ["data.read", "data.write", "workspace.ui"],
  },
  async onload(context) {
    // treeHidden: schemas and attachments are settings, not rows in the sidebar; search still finds them.
    await context.data.types.upsert(SCHEMA_TYPE, JSON.stringify({ fields: {}, behaviour: { treeHidden: true } }), "🧩");
    await context.data.types.upsert(ATTACHMENT_TYPE, JSON.stringify({ fields: {}, behaviour: { treeHidden: true } }), "🔗");
    const schemas = createSchemas(context);
    this._schemas = schemas;
    // Sync applies don't fire object.created (only workspace.changed), so this
    // sees local creates only; `schemaApplied` covers an item that comes back.
    // No object.updated listener, so our own update can't loop.
    context.events.on("object.created", ({ id }) => { void schemas.applyTo(id); });
    context.events.on("workspace.changed", () => schemas.scanSoon());
    context.views.register({ id: "schemas", title: schemas.t("Schemas"), nav: true, navIcon: "file-text", mount: ({ container }) => mountConfigurator(context, schemas, container) });
    context.views.registerObjectTab({ id: "schemas", label: schemas.t("Schemas"), objectTypes: CONTAINER_TYPES, order: 80, mount: (container, tab) => mountContainerTab(context, schemas, container, tab.objectId) });
    // Views, settings and commands share one id namespace in the host: "schemas" is the view.
    context.settings.register({ id: "settings-link", title: schemas.t("Schemas"), mount: ({ container }) => mountSettingsLink(context, schemas, container) });
    context.commands.register({
      id: "manage",
      name: schemas.t("Schemas: manage"),
      description: schemas.t("Open the Schemas screen."),
      execute: () => context.ui.openView("schemas"),
    });
    // Migrate 0.1.0 scopes first: the + entries and fills below need attachments.
    await schemas.migrate().catch(() => {});
    // Before onload returns: Core builds the + menu right after it.
    await schemas.registerCommands().catch(() => {});
    void schemas.scan().catch(() => {});
  },
  onunload() {
    this._schemas?.dispose();
  },
};

export default plugin;
