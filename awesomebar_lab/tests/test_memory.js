// Copyright (c) 2026, Antoine Maas and contributors
// For license information, please see license.txt
//
// Runs the bundle against a stubbed desk: node awesomebar_lab/tests/test_memory.js
//
// What a remembered pick is worth, and for how long. The prefix walk is the subtle part:
// a pick is recorded against whatever was typed when it was chosen, which is usually
// shorter than what gets typed next time.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const BUNDLE = path.join(__dirname, "../public/js/awesomebar_lab.bundle.js");
const STORAGE_KEY = "awesomebar_lab_selections:Administrator";

const storage = new Map();

const desk = {
	console: { ...console, log: () => {} },
	localStorage: {
		getItem: (key) => (storage.has(key) ? storage.get(key) : null),
		setItem: (key, value) => storage.set(key, String(value)),
	},
	document: {},
	$: () => ({ on: () => {} }),
	__: (text) => text,
	frappe: {
		provide(namespace) {
			desk[namespace] = desk[namespace] || {};
		},
		boot: { awesomebar_lab_settings: {}, awesomebar_lab_frecency: [] },
		session: { user: "Administrator" },
		utils: { icon: () => "", debounce: (fn) => fn, escape_html: (text) => text },
		router: { on: () => {} },
		search: { AwesomeBar: class {} },
	},
};

vm.createContext(desk);
vm.runInContext(fs.readFileSync(BUNDLE, "utf8"), desk, { filename: BUNDLE });

const memory = desk.awesomebar_lab.memory;

// "sal" is settled; "salei" picks up one contradiction and is left undecided.
memory.record("sal", "Liste : Sales Invoice");
memory.record("sal", "Liste : Sales Invoice");
memory.record("sal", "Liste : Sales Invoice");
memory.record("salei", "Liste : Sales Invoice");
memory.record("salei", "Liste : Sales Invoice");
memory.record("salei", "Autre chose");

const settled = memory.confidence(memory.load()["q:sal"]);
const undecided = memory.confidence(memory.load()["q:salei"]);
assert.ok(settled > 0.65, `settled prefix should be trusted, got ${settled}`);
assert.ok(undecided <= 0.65, `contested prefix should not be trusted, got ${undecided}`);

// Typing one more letter must not throw away the pin the shorter query still earns.
assert.equal(memory.recall("sal"), "Liste : Sales Invoice");
assert.equal(memory.recall("salei"), "Liste : Sales Invoice");

// The most specific evidence still wins once it is trusted again.
memory.record("salei", "Autre chose");
memory.record("salei", "Autre chose");
assert.equal(memory.recall("salei"), "Autre chose");

// The in-memory cache must write through, or a pick made now is invisible until reload.
assert.ok(
	storage.get(STORAGE_KEY).includes("Autre chose"),
	"record() did not persist through the cache"
);

// A pin nobody uses expires on its own, without needing a contradiction.
memory.load()["q:sal"].last_used = Date.now() - 60 * 24 * 60 * 60 * 1000;
assert.equal(memory.recall("sal"), null);

// A remembered pick only ever reorders what already matched.
const options = [{ value: "Liste : Purchase Invoice", index: 240 }];
memory.record("achat", "Liste : Sales Invoice");
memory.pin(options, "achat");
assert.equal(options[0].pinned_for_query, undefined);
assert.equal(options[0].index, 240);

// A contradicting pick on a habit that has long expired must replace it, not revive it:
// the write resets last_used, so weighing raw counts would pin the old pick at full strength.
memory.load()["q:inv"] = {
	value: "Liste : Sales Invoice",
	hits: 5,
	misses: 0,
	last_used: Date.now() - 60 * 24 * 60 * 60 * 1000,
};
memory.record("inv", "Invoice Discounting");
assert.equal(memory.recall("inv"), "Invoice Discounting");

console.log("remembered picks survive a longer query, persist, and expire when idle");
