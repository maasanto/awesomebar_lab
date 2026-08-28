// Copyright (c) 2026, Antoine Maas and contributors
// For license information, please see license.txt

// Runs the bundle against a stubbed desk: node awesomebar_lab/tests/test_route_recording.js
//
// What these check is the boundary with the framework. Recording a route the framework
// already records would double every visit and skew the very scores this app ranks on,
// and recording none of the skipped ones puts desk Pages and singles back where they
// started — unrankable however often they are opened.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const BUNDLE = path.join(__dirname, "../public/js/awesomebar_lab.bundle.js");

function visit(routes) {
	let on_route_change;
	const inserted = [];

	const desk = {
		console: { ...console, log: () => {} },
		localStorage: { getItem: () => null, setItem: () => {} },
		document: {},
		$: () => ({ on: () => {} }),
		__: (text) => text,
		frappe: {
			provide(namespace) {
				desk[namespace] = desk[namespace] || {};
			},
			boot: {
				page_info: { "bank-reconciliation": { title: "Bank Reconciliation" } },
				single_types: ["Bank Clearance"],
			},
			session: { user: "Administrator" },
			datetime: { now_datetime: () => "2026-08-28 12:00:00" },
			utils: { icon: () => "", debounce: (fn) => fn },
			router: {
				on: (event, handler) => {
					if (event === "change") on_route_change = handler;
				},
			},
			xcall: (method, args) => {
				inserted.push({ method: method, routes: args.routes });
				return Promise.resolve();
			},
			search: { AwesomeBar: class {} },
		},
	};

	vm.createContext(desk);
	vm.runInContext(fs.readFileSync(BUNDLE, "utf8"), desk, { filename: BUNDLE });

	routes.forEach((route) => {
		desk.frappe.get_route = () => route;
		desk.frappe.get_route_str = () => route.join("/");
		on_route_change();
	});

	return inserted;
}

// A desk Page is a one-segment route, which is exactly what the framework drops.
const page = visit([["bank-reconciliation"]]);
assert.equal(page.length, 1);
assert.equal(page[0].method, "frappe.desk.doctype.route_history.route_history.deferred_insert");
// Spread to drop the vm realm's prototype, which strict equality would trip over.
assert.deepEqual([...page[0].routes.map((visit) => visit.route)], ["bank-reconciliation"]);

// A single repeats its doctype as the document name; a real document does not, and is
// left to the framework's own Form skip.
const singles = visit([
	["Form", "Bank Clearance", "Bank Clearance"],
	["Form", "Sales Invoice", "SINV-0001"],
]);
assert.deepEqual(
	singles.flatMap((call) => call.routes.map((visit) => visit.route)),
	["Form/Bank Clearance/Bank Clearance"]
);

// Everything the framework already records has to stay out, or every visit counts twice.
assert.deepEqual(
	visit([
		["List", "Sales Invoice", "List"],
		["Workspaces", "Accounting"],
		["query-report", "General Ledger"],
		["dashboard-view", "Accounts"],
	]),
	[]
);

// An unknown one-segment route is not a Page this user can open, so it is not a visit.
assert.deepEqual(visit([["some-removed-page"], [""]]), []);

console.log("only the routes the framework skips are recorded");
