// Copyright (c) 2026, Antoine Maas and contributors
// For license information, please see license.txt

// Runs the bundle against a stubbed desk: node awesomebar_lab/tests/test_ranking.js
//
// The trace is what these check. Its rows are read against the dropdown to explain a
// ranking, so a trace reporting anything other than the order actually rendered sends
// whoever is tuning the knobs after a bug that is not there.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const BUNDLE = path.join(__dirname, "../public/js/awesomebar_lab.bundle.js");

// One doctype opened twice as often as the other, each emitted several times by the
// framework, plus the reports and creatables that share their near-tie band.
const MATCHES = [
	...Array(6).fill(["Liste : Purchase Invoice", 242.05, ["List", "Purchase Invoice"]]),
	["Rapport : Purchase Invoice", 242.04, ["List", "Purchase Invoice", "Report"]],
	["Nouveau Facture d'achat", 242.015, null],
	...Array(7).fill(["Liste : Sales Invoice", 240.05, ["List", "Sales Invoice"]]),
	["Rapport : Sales Invoice", 240.04, ["List", "Sales Invoice", "Report"]],
	["Liste : POS Invoice", 222.05, ["List", "POS Invoice"]],
];
const TOP_MATCH_SCORE = 242.05;

const storage = new Map();
const trace = { header: "", rows: [] };

function rank(query, remembered) {
	storage.clear();
	storage.set("awesomebar_lab_debug", "1");
	if (remembered) {
		storage.set(
			"awesomebar_lab_selections:Administrator",
			JSON.stringify({
				[`q:${query}`]: { value: remembered, hits: 1, misses: 0, last_used: Date.now() },
			})
		);
	}

	const desk = {
		console: {
			...console,
			groupCollapsed: (text) => (trace.header = text),
			table: (rows) => (trace.rows = rows),
			groupEnd: () => {},
			log: () => {},
		},
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
			boot: {
				awesomebar_lab_settings: {},
				awesomebar_lab_frecency: [
					{ route: "List/Purchase Invoice/List", score: 9.7 },
					{ route: "List/Sales Invoice/List", score: 15.8 },
				],
			},
			session: { user: "Administrator" },
			utils: { icon: () => "<history-icon/>", debounce: (fn) => fn },
			router: { on: () => {} },
			search: {
				AwesomeBar: class {
					build_options() {
						return MATCHES.map(([value, index, route]) => ({
							value: value,
							label: value,
							index: index,
							description: "emitted by two sources, so it survives deduplication",
							route: route,
						}));
					}
				},
			},
		},
	};

	vm.createContext(desk);
	vm.runInContext(fs.readFileSync(BUNDLE, "utf8"), desk, { filename: BUNDLE });
	return new desk.frappe.search.AwesomeBar().build_options(query);
}

// Frecency alone: the doctype opened more often wins its near-tie band, and says so.
const by_frecency = rank("facture");
assert.equal(by_frecency[0].value, "Liste : Sales Invoice");
assert.equal(by_frecency[0].boosted_by_history, true);
assert.ok(by_frecency[0].label.includes("<history-icon/>"));
assert.ok(
	trace.header.includes(`of ${TOP_MATCH_SCORE} `),
	`near-tie band reported against the wrong score: ${trace.header}`
);

// A remembered pick outranks frecency, and the trace has to show that rather than the
// intermediate state it held before the pin ran.
const pinned = rank("facture", "Liste : Purchase Invoice");
assert.equal(pinned[0].value, "Liste : Purchase Invoice");
assert.deepEqual(
	trace.rows.map((row) => row.result),
	pinned.slice(0, trace.rows.length).map((option) => option.value)
);
// Spread to drop the vm realm's prototype, which strict equality would trip over.
assert.deepEqual(
	{ ...trace.rows[0] },
	{
		result: "Liste : Purchase Invoice",
		match_score: TOP_MATCH_SCORE,
		frecency: 9.7,
		final_score: pinned[0].index,
		promoted: true,
		pinned: true,
	}
);
assert.ok(trace.header.includes("pinned by what you keep picking"), trace.header);

console.log("ranking trace matches the rendered order");
