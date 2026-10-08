// Schemas self-check (Hive #31, #42): pattern parsing, the counter, duplicate
// detection, attachments (per-container counters, precedence, 0.1.0 migration),
// the apply path against a fake context, i18n coverage and the manifest.   node plugins/notible-schemas/self-check.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const m = await import(pathToFileURL(join(here, "main.js")).href);
let checks = 0;
const eq = (actual, expected, message) => { assert.deepEqual(actual, expected, message); checks += 1; };
const ok = (value, message) => { assert.ok(value, message); checks += 1; };

// 1. Pattern parsing.
const oct7 = new Date(2026, 9, 7);
eq(m.renderTitle("FV/{counter:3}/{mm}/{yyyy}", oct7, 12), "FV/012/10/2026", "invoice pattern");
eq(m.renderTitle("{yyyy}-{mm}-{dd} standup", oct7, 0), "2026-10-07 standup", "dates");
eq(m.renderTitle("T-{counter}", oct7, 1234), "T-1234", "{counter} is width 1 and never truncates");
eq(m.renderTitle("{ counter:2 }", oct7, 3), "03", "spaces inside a token");
eq(m.parsePattern("Plain").counter, null, "no counter");
eq(m.parsePattern("A{counter:4}").counter, { width: 4 }, "counter width");
eq(m.parsePattern("{yyyy}").errors, [], "valid pattern");
ok(m.parsePattern("{year}").errors[0].key.startsWith("Unknown token"), "unknown token");
ok(m.parsePattern("{counter:0}").errors.length === 1, "width 0");
ok(m.parsePattern("{counter:10}").errors.length === 1, "width 10");
ok(m.parsePattern("{counter}{counter}").errors.some((e) => e.key === "Only one counter per pattern."), "two counters");
ok(m.parsePattern("FV/{counter:3").errors.some((e) => e.key === "A brace without its pair."), "unclosed brace");
ok(m.parsePattern("FV}").errors.length === 1, "stray closing brace");
eq(m.parsePattern("").errors, [], "empty pattern is allowed (title unchanged)");

// 2. Periods and the counter: max issued in the period + 1.
eq(m.periodKey("never", oct7), "", "never");
eq(m.periodKey("yearly", oct7), "2026", "yearly");
eq(m.periodKey("monthly", new Date(2026, 0, 31)), "2026-01", "monthly pads the month");
const issued = [
  { schemaApplied: "s1", schemaPeriod: "2026", schemaNumber: 4 },
  { schemaApplied: "s1", schemaPeriod: "2026", schemaNumber: 9 },
  { schemaApplied: "s1", schemaPeriod: "2025", schemaNumber: 40 },
  { schemaApplied: "s2", schemaPeriod: "2026", schemaNumber: 100 },
  { schemaApplied: "s1", schemaPeriod: "2026", schemaNumber: "77" },
  { schemaApplied: "s1", schemaPeriod: "2026", schemaNumber: 2.5 },
  {},
];
eq(m.nextNumber(issued, "s1", "2026"), 10, "max in period + 1, gaps not filled, other schema and junk ignored");
eq(m.nextNumber(issued, "s1", "2027"), 1, "a new period starts at 1");
eq(m.nextNumber([], "s1", ""), 1, "first number");
eq(m.nextNumber([{ schemaApplied: "s1", schemaNumber: 3 }], "s1", ""), 4, "missing period counts as never-reset");

// 3. Duplicates.
const items = [
  { id: "b", props: { schemaApplied: "s1", schemaPeriod: "2026", schemaNumber: 5 } },
  { id: "a", props: { schemaApplied: "s1", schemaPeriod: "2026", schemaNumber: 5 } },
  { id: "c", props: { schemaApplied: "s1", schemaPeriod: "2025", schemaNumber: 5 } },
  { id: "d", props: { schemaApplied: "s2", schemaPeriod: "2026", schemaNumber: 5 } },
  { id: "e", props: { schemaApplied: "s1", schemaPeriod: "2026", schemaNumber: 6 } },
  { id: "f", props: { schemaApplied: "s1" } },
  { id: "g", props: { schemaApplied: "s1" } },
];
eq(m.findDuplicates(items), [{ key: "s1||2026|5", schemaId: "s1", scope: "", period: "2026", number: 5, ids: ["a", "b"] }], "only the same schema + period + number clash");
// #42: the same number in two attachments is not a clash; a 0.1.0 item counts in the schema's legacy scope.
const scoped = [
  { id: "p1", props: { schemaApplied: "inv", schemaScope: "P", schemaPeriod: "", schemaNumber: 1 } },
  { id: "q1", props: { schemaApplied: "inv", schemaScope: "Q", schemaPeriod: "", schemaNumber: 1 } },
  { id: "old", props: { schemaApplied: "inv", schemaPeriod: "", schemaNumber: 1 } },
];
eq(m.findDuplicates(scoped.slice(0, 2)), [], "one number per attachment: P and Q both have 1");
eq(m.findDuplicates(scoped, { inv: "P" }).map((g) => g.ids), [["old", "p1"]], "a 0.1.0 item clashes inside its legacy scope");
eq(m.nextNumber(scoped.map((x) => x.props), "inv", "", 0, "Q"), 2, "next in Q ignores P");
eq(m.nextNumber(scoped.map((x) => x.props), "inv", "", 0, "P", "P"), 2, "legacy items continue P");
eq(m.nextNumber(scoped.map((x) => x.props), "inv", "", 0, ""), 2, "legacy items count globally without a legacy scope");
eq(m.findDuplicates([]), [], "nothing to flag");

// 4. Properties and tags fields.
const kv = m.parseKeyValues("status = doing\npriority=high\nestimate = 3\nbillable = true\ncode = 007\n\nbad line\ntags = x\n_hidden = 1\n__proto__ = 1");
eq(kv.props, { status: "doing", priority: "high", estimate: 3, billable: true, code: "007" }, "typed values, plain text fallback");
eq(kv.errors.length, 4, "missing =, tags, _hidden, __proto__ refused");
eq(Object.getPrototypeOf(kv.props), Object.prototype, "no prototype pollution");
eq(m.parseKeyValues(m.formatKeyValues({ a: "x y", n: 2, b: false })).props, { a: "x y", n: 2, b: false }, "format round-trips");
eq(m.parseTags("#invoice, 2026,, invoice\nclient"), ["invoice", "2026", "client"], "tags: trimmed, # dropped, unique");

// 5. Picking a schema and filling; attachments.
const schema = (id, extra) => m.schemaFromObject({ id, type: m.SCHEMA_TYPE, title: id, updated_at: 1, props: JSON.stringify({ targetType: "task", titlePattern: "", ...extra }) });
const attachment = (id, schemaId, containerId, extra = {}) => m.attachmentFromObject({ id, type: m.ATTACHMENT_TYPE, props: JSON.stringify({ schemaId, containerId, ...extra }) });
const anywhere = schema("any", {});
const inX = schema("inX", {});
const inY = schema("inY", {});
const groups = m.groupAttachments([attachment("a1", "inX", "X"), attachment("a2", "inY", "Y")]);
eq(m.pickSchema([anywhere, inX, inY], groups, "task", ["X", "root"]), { schema: inX, scope: "X" }, "an attached schema wins, in its own scope");
eq(m.pickSchema([anywhere, inX, inY], groups, "task", ["sub", "Y", "X"])?.schema.id, "inY", "nearest ancestor wins");
eq(m.pickSchema([anywhere, inX], groups, "task", []), { schema: anywhere, scope: "" }, "top level gets the global schema");
eq(m.pickSchema([inX], groups, "task", ["Z"]), null, "an attached-only schema does not apply elsewhere");
eq(m.pickSchema([anywhere], groups, "note", []), null, "other type");
ok(m.isGlobal(anywhere, groups) && !m.isGlobal(inX, groups), "no active attachment = global");
const detached = m.groupAttachments([attachment("a1", "inX", "X", { detached: true })]);
eq(m.pickSchema([inX], detached, "task", []), { schema: inX, scope: "" }, "detached everywhere: global again");
const twice = m.groupAttachments([attachment("b2", "inv", "P", { "issued:dev2": { "": 7 } }), attachment("b1", "inv", "P", { detached: true, "issued:dev1": { "": 4 } })]);
eq([...twice.values()].map((g) => [g.primaryId, g.ids, g.active, g.issued]), [["b1", ["b1", "b2"], true, { "": 7 }]], "two devices attaching one pair offline: one attachment, marks merged");
eq(m.attachmentFromObject({ id: "x", type: m.ATTACHMENT_TYPE, props: '{"schemaId":"s"}' }), null, "attachment without a container");
eq(m.schemaFromObject({ id: "n", type: "note", props: "{}" }), null, "not a schema");
eq(m.schemaFromObject({ id: "n", type: m.SCHEMA_TYPE, props: "{oops" }), null, "broken props");
eq(m.schemaFromObject({ id: "n", type: m.SCHEMA_TYPE, props: '{"targetType":"task","defaultProps":{"ok":1,"tags":"x","schemaApplied":"y","schemaScope":"z","__proto__":{"z":1},"_customFields":[]}}' }).defaultProps, { ok: 1 }, "a synced schema can't set reserved props");
eq(m.schemaFromObject({ id: "n", type: m.SCHEMA_TYPE, title: "", props: JSON.stringify({ targetType: "task", counterReset: "hourly" }) }).counterReset, "never", "unknown reset falls back");
eq(m.setCounterWidth("FV/{counter:3}/{yyyy}", 5), "FV/{counter:5}/{yyyy}", "padding field rewrites the token");
eq(m.setCounterWidth("T-{ counter }", 2), "T-{counter:2}", "padding field on a bare counter");

const invoice = schema("inv", { titlePattern: "FV/{counter:3}/{mm}/{yyyy}", counterReset: "monthly", defaultProps: { status: "draft" }, defaultTags: ["invoice"] });
const filled = m.fill(invoice, { status: "todo", tags: ["keep"] }, [{ schemaApplied: "inv", schemaScope: "", schemaPeriod: "2026-10", schemaNumber: 41 }], oct7);
eq(filled.title, "FV/042/10/2026", "next invoice number");
eq(filled.props, { status: "draft", tags: ["keep", "invoice"], schemaApplied: "inv", schemaScope: "", schemaNumber: 42, schemaPeriod: "2026-10" }, "defaults override, tags merge, marks set");
eq(m.fill(invoice, {}, [{ schemaApplied: "inv", schemaScope: "P", schemaPeriod: "2026-10", schemaNumber: 41 }], oct7, "Q", {}).title, "FV/001/10/2026", "attachment Q starts at 1 next to P's 41");
// SCHEMAS-HIGH-WATER: the synced mark is a floor under the scan.
const marked = m.schemaFromObject({ id: "inv", type: m.SCHEMA_TYPE, props: JSON.stringify({ targetType: "note", titlePattern: "FV/{counter:3}", counterReset: "monthly", "issued:aaaa": { "2026-10": 57, "2026-09": 3 }, "issued:bbbb": { "2026-10": 60 }, "issued:bad": [1], other: { "2026-10": 99 } }) });
eq(marked.issued, { "2026-10": 60, "2026-09": 3 }, "high-water: max over every device key, junk ignored");
eq(m.fill(marked, {}, [], oct7).props.schemaNumber, 61, "no visible items: next comes from the mark");
eq(m.fill(marked, {}, [{ schemaApplied: "inv", schemaScope: "", schemaPeriod: "2026-10", schemaNumber: 70 }], oct7).props.schemaNumber, 71, "a visible higher number still wins");
eq(m.marksFor(marked, twice, "P"), { "": 7 }, "an attachment's counter uses the attachment's marks");
eq(m.marksFor(marked, twice, ""), marked.issued, "the global counter uses the schema's marks");
eq(m.nextNumber([], "inv", "2026-11", marked.issued["2026-11"]), 1, "a new period starts at 1");
eq(m.withIssued({ a: 1, "issued:me": { "2026-10": 5 } }, "me", "2026-10", 6), { a: 1, "issued:me": { "2026-10": 6 } }, "the device's own mark is raised");
eq(m.withIssued({ "issued:me": { "2026-10": 9 } }, "me", "2026-10", 6), null, "never lowered");
eq(m.withIssued({ "issued:other": { "": 4 } }, "me", "", 1), { "issued:other": { "": 4 }, "issued:me": { "": 1 } }, "other devices' keys untouched");
eq(m.mergeMarks({ "issued:a": { "": 9, "2026": 1 }, keep: 1 }, { "issued:a": { "": 4, "2026": 3 }, "issued:b": { "": 2 }, junk: 5 }), { "issued:a": { "": 9, "2026": 3 }, "issued:b": { "": 2 }, keep: 1 }, "mergeMarks keeps the higher number per device and period");
const tagOnly = m.fill(schema("t", { defaultTags: ["x"] }), {}, [], oct7);
eq([tagOnly.title, tagOnly.props.schemaNumber], [null, undefined], "no pattern: title unchanged, no number");
// Migration 0.1.0 → 0.2.0, pure part.
const legacy = { targetType: "task", scopeContainerId: "X", titlePattern: "X-{counter:2}", "issued:dev1": { "": 5 }, keep: true };
eq(m.migrateSchemaProps(legacy), { containerId: "X", marks: { "issued:dev1": { "": 5 } }, schemaProps: { targetType: "task", titlePattern: "X-{counter:2}", keep: true, legacyScope: "X" } }, "only-inside X -> attachment with the marks, schema keeps legacyScope");
eq(m.migrateSchemaProps({ targetType: "task", scopeContainerId: null, "issued:d": { "": 2 } }), null, "an anywhere schema stays as it is (global, marks kept)");
eq(m.migrateSchemaProps(m.migrateSchemaProps(legacy).schemaProps), null, "migration is idempotent");

// 6. The plugin against a fake host: migrate, apply on create, attach, skip applied/renamed, queue, duplicates notice.
const db = new Map();
let clock = 1000;
let seq = 0;
const events = new Map();
const notices = [];
const commands = new Map();
const storage = new Map();
const registered = { views: [], tabs: [], settings: [] };
const make = (input) => ({ id: input.id ?? `o${++seq}`, type: input.type, title: input.title, props: input.props ?? "{}", content: "", parent_id: input.parentId ?? null, created_at: clock, updated_at: ++clock, archived_at: null, trashed_at: null });
const context = {
  i18n: { t: (key, values = {}) => key.replace(/\{(\w+)\}/g, (w, k) => (k in values ? String(values[k]) : w)), locale: "en" },
  data: {
    types: { upsert: async () => ({}), list: async () => [] },
    objects: {
      get: async (id) => (db.has(id) ? { ...db.get(id) } : null),
      create: async (input) => { const o = make(input); db.set(o.id, o); queueMicrotask(() => events.get("object.created")?.({ id: o.id, type: o.type })); return { ...o }; },
      update: async (id, patch, expected) => {
        await new Promise((r) => setTimeout(r, 1)); // let other creates interleave if the queue fails
        const o = db.get(id);
        if (expected !== undefined && o.updated_at !== expected) throw "stale";
        Object.assign(o, patch, { updated_at: ++clock });
        return { ...o };
      },
      trash: async (id) => { db.delete(id); return null; },
      // Like Core: newest updated_at first, capped (5000 max).
      query: async ({ type, limit = 5000 } = {}) => [...db.values()].filter((o) => !type || o.type === type).sort((a, b) => b.updated_at - a.updated_at).slice(0, Math.min(limit, 5000)).map((o) => ({ ...o })),
    },
  },
  events: { on: (name, handler) => { events.set(name, handler); return { dispose() {} }; } },
  settings: { register: (entry) => { registered.settings.push(entry); return { dispose() {} }; } },
  views: { register: (entry) => { registered.views.push(entry); return { dispose() {} }; }, registerObjectTab: (tab) => { registered.tabs.push(tab); return { dispose() {} }; } },
  commands: { register: (c) => { commands.set(c.id, c); return { dispose: () => commands.delete(c.id) }; } },
  ui: { notice: (text, options) => { notices.push({ text, options }); return { dispose() {} }; }, openObject: async () => {}, openView: async () => true, openPluginSettings: async () => {} },
  storage: { get: (k) => storage.get(k) ?? null, set: (k, v) => storage.set(k, v) },
};
const plugin = m.default;
const P = (id) => JSON.parse(db.get(id).props);
const attachmentsOf = (schemaId) => [...db.values()].filter((o) => o.type === m.ATTACHMENT_TYPE && P(o.id).schemaId === schemaId);
db.set("X", make({ id: "X", type: "project", title: "Project X" }));
db.set("sub", make({ id: "sub", type: "folder", title: "Sub", parentId: "X" }));
// A 0.1.0 "Only inside X" schema that already issued X-01..X-05 (one still visible, without schemaScope).
db.set("S1", make({ id: "S1", type: m.SCHEMA_TYPE, title: "X task", props: JSON.stringify({ targetType: "task", scopeContainerId: "X", titlePattern: "X-{counter:2}", defaultTags: ["projx"], "issued:olddev": { "": 5 } }) }));
db.set("old3", make({ id: "old3", type: "task", title: "X-03", parentId: "X", props: JSON.stringify({ schemaApplied: "S1", schemaPeriod: "", schemaNumber: 3 }) }));
db.set("S2", make({ id: "S2", type: m.SCHEMA_TYPE, title: "Invoice", props: JSON.stringify({ targetType: "note", titlePattern: "FV/{counter:3}/{yyyy}", counterReset: "yearly" }) }));
await plugin.onload(context);
const settle = () => new Promise((r) => setTimeout(r, 60));
await settle();
const schemasApi = plugin._schemas;
eq(registered.views.map((v) => [v.id, v.nav]), [["schemas", true]], "a full-page Schemas view with a nav entry");
eq(registered.tabs.map((tab) => [tab.id, tab.objectTypes]), [["schemas", ["project", "folder", "space"]]], "a Schemas tab on projects, folders and spaces");
eq(registered.settings.length, 1, "the settings entry stays (as a link)");
const ids = [...registered.views, ...registered.settings, ...commands.values()].map((entry) => entry.id);
eq(ids.length, new Set(ids).size, "view, settings and command ids are unique (the host namespaces them together)");
ok(commands.has("new-S1") && commands.has("new-S2"), "a New … command per schema");
eq(commands.get("new-S2").creates, { objectType: "note", label: "Invoice" }, "creates metadata for the + menu");

// Migration ran once on load.
eq(attachmentsOf("S1").map((o) => [P(o.id).containerId, P(o.id)["issued:olddev"], o.parent_id]), [["X", { "": 5 }, "X"]], "migration: an attachment to X carrying the old marks, under X");
eq([P("S1").scopeContainerId, P("S1").legacyScope, Object.keys(P("S1")).some((key) => key.startsWith("issued:"))], [undefined, "X", false], "migration: the schema loses its scope and marks, keeps legacyScope");
await schemasApi.migrate();
eq(attachmentsOf("S1").length, 1, "migration is idempotent on the host");

const t1 = await context.data.objects.create({ type: "task", title: "New task", parentId: "sub" });
const t2 = await context.data.objects.create({ type: "task", title: "New task", parentId: "X" });
const t3 = await context.data.objects.create({ type: "task", title: "New task" });
const named = await context.data.objects.create({ type: "task", title: "Call Anna", parentId: "X" });
await settle();
eq([db.get(t1.id).title, db.get(t2.id).title], ["X-06", "X-07"], "migrated counter continues after 0.1.0's X-05 (no restart), serialised");
eq([P(t1.id).tags, P(t1.id).schemaScope], [["projx"], "X"], "default tag + the attachment's scope");
eq(db.get(t3.id).title, "New task", "outside X: untouched (attached-only schema)");
eq(db.get(named.id).title, "Call Anna", "a typed title is left alone");
ok(!events.has("object.updated"), "no object.updated listener (nothing to loop on)");
const devMarks = Object.entries(P(attachmentsOf("S1")[0].id)).filter(([key]) => key.startsWith("issued:") && key !== "issued:olddev");
eq(devMarks.map(([, v]) => v), [{ "": 7 }], "the attachment carries this device's high-water mark");

// Global vs attached: a global task schema fills outside X, X keeps its own.
db.set("G", make({ id: "G", type: m.SCHEMA_TYPE, title: "Any task", props: JSON.stringify({ targetType: "task", titlePattern: "T-{counter:3}" }) }));
const g1 = await context.data.objects.create({ type: "task", title: "New task" });
const g2 = await context.data.objects.create({ type: "task", title: "New task", parentId: "X" });
await settle();
eq([db.get(g1.id).title, db.get(g2.id).title], ["T-001", "X-08"], "global outside, the attached schema wins inside X");

// One schema attached to two projects counts separately in each.
db.set("PA", make({ id: "PA", type: "project", title: "A" }));
db.set("PB", make({ id: "PB", type: "project", title: "B" }));
db.set("BILL", make({ id: "BILL", type: m.SCHEMA_TYPE, title: "Bill", props: JSON.stringify({ targetType: "note", titlePattern: "B/{counter:3}" }) }));
await schemasApi.attach("BILL", "PA");
await schemasApi.attach("BILL", "PB");
await schemasApi.scan();
const made = [];
for (const parent of ["PA", "PA", "PB", "PB"]) made.push(await commands.get("new-BILL").execute({ parentId: parent }));
eq(made.map((o) => `${o.parent_id}:${db.get(o.id).title}`), ["PA:B/001", "PA:B/002", "PB:B/001", "PB:B/002"], "one schema, two attachments, two counters");
const c1 = await context.data.objects.create({ type: "note", title: "New note", parentId: "PB" });
await settle();
eq(db.get(c1.id).title, "B/003", "a default-titled note in B uses B's attachment");
eq(db.get((await commands.get("new-BILL").execute({})).id).parent_id, "PA", "an attached-only schema used elsewhere goes into its first project");
await schemasApi.detach("BILL", "PB");
const c2 = await context.data.objects.create({ type: "note", title: "New note", parentId: "PB" });
await settle();
const year = String(new Date().getFullYear());
eq(db.get(c2.id).title, `FV/001/${year}`, "detached from B: B's new note falls back to the global Invoice schema");
await schemasApi.attach("BILL", "PB");
eq(attachmentsOf("BILL").length, 2, "attaching again revives the same attachment");
eq(db.get((await commands.get("new-BILL").execute({ parentId: "PB" })).id).title, "B/004", "re-attached: B's numbering continues");

const inv1 = await commands.get("new-S2").execute({});
const inv2 = await commands.get("new-S2").execute({ title: "" });
await settle();
eq([db.get(inv1.id).title, db.get(inv2.id).title], [`FV/002/${year}`, `FV/003/${year}`], "a global invoice gets the next number from the command");
eq(P(inv2.id).schemaApplied, "S2", "marked applied");
const before = db.get(inv2.id).updated_at;
events.get("object.created")({ id: inv2.id, type: "note" }); // a second created event (sync arrival)
await settle();
eq(db.get(inv2.id).updated_at, before, "an applied item is not processed again");

// A copy from another device with the same number (sync) → one notice, once.
db.set("remote", make({ id: "remote", type: "note", title: `FV/003/${year}`, props: JSON.stringify({ schemaApplied: "S2", schemaScope: "", schemaPeriod: year, schemaNumber: 3 }) }));
events.get("workspace.changed")({});
await new Promise((r) => setTimeout(r, 1700));
const clash = notices.filter((n) => /same number/.test(n.text));
eq(clash.length, 1, "duplicate number flagged");
ok(clash[0].text.includes("Invoice") && clash[0].options.action?.label === "Open", "the notice names the schema and has Open");
events.get("workspace.changed")({});
await new Promise((r) => setTimeout(r, 1700));
eq(notices.filter((n) => /same number/.test(n.text)).length, 1, "the same clash is not announced twice");
const inv3 = await commands.get("new-S2").execute({});
eq(db.get(inv3.id).title, `FV/004/${year}`, "after a clash, numbering continues from the max");
const S2marks = P("S2");
const markKeys = Object.keys(S2marks).filter((key) => key.startsWith("issued:"));
eq([markKeys.length, S2marks[markKeys[0]]?.[year]], [1, 4], "the global schema object carries this device's high-water mark");

// A 0.1.0 schema arriving later by sync (another device still on 0.1.0) is migrated by the scan.
db.set("S9", make({ id: "S9", type: m.SCHEMA_TYPE, title: "Late", props: JSON.stringify({ targetType: "issue", scopeContainerId: "PA", titlePattern: "I-{counter}", "issued:far": { "": 9 } }) }));
events.get("workspace.changed")({});
await new Promise((r) => setTimeout(r, 1700));
eq(attachmentsOf("S9").map((o) => [P(o.id).containerId, P(o.id)["issued:far"]]), [["PA", { "": 9 }]], "a 0.1.0 schema from sync is migrated on the next scan");

// Codex High: more than 5000 newer items of the same type from another schema
// push every invoice out of the scan window; the number must not restart at 1.
db.set("S3", make({ id: "S3", type: m.SCHEMA_TYPE, title: "Meeting", props: JSON.stringify({ targetType: "note", titlePattern: "M-{counter:4}" }) }));
for (let i = 1; i <= 5001; i += 1) db.set(`m${i}`, make({ id: `m${i}`, type: "note", title: `M-${i}`, props: JSON.stringify({ schemaApplied: "S3", schemaPeriod: "", schemaNumber: i }) }));
ok((await context.data.objects.query({ type: "note" })).every((row) => !JSON.parse(row.props).schemaApplied?.startsWith("S2")), "setup: no invoice is in the newest 5000 notes");
const inv4 = await commands.get("new-S2").execute({});
eq(db.get(inv4.id).title, `FV/005/${year}`, "5001 newer notes from another schema: the invoice counter continues at 5, not 1");
plugin.onunload();

// 7. Every UI string has a Polish translation, and the manifest is sane.
const pl = JSON.parse(readFileSync(join(here, "locales/pl.json"), "utf8")).strings;
const source = readFileSync(join(here, "main.js"), "utf8");
const keys = new Set([...source.matchAll(/\bt\("((?:[^"\\]|\\.)*)"/g), ...source.matchAll(/key: "((?:[^"\\]|\\.)*)"/g)].map((x) => JSON.parse(`"${x[1]}"`)));
const missing = [...keys].filter((key) => !(key in pl));
eq(missing, [], "every string has a Polish translation");
for (const [key, value] of Object.entries(pl)) {
  const holes = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((x) => x[1]).sort();
  eq(holes(value), holes(key), `placeholders kept in "${key}"`);
}
const manifest = JSON.parse(readFileSync(join(here, "plugin.json"), "utf8"));
eq([manifest.id, manifest.entry, manifest.locales.pl], ["notible.schemas", "main.js", "locales/pl.json"], "manifest");
for (const key of ["id", "name", "version", "apiVersion", "permissions"]) eq(plugin.manifest[key], manifest[key], `main.js manifest.${key} matches plugin.json`);
ok(m.SCHEMA_TYPE.startsWith(`${manifest.id}.`), "schema type is in the plugin's namespace");
ok(!/innerHTML/.test(source), "no innerHTML");

console.log(`notible.schemas self-check: ${checks} checks passed`);
