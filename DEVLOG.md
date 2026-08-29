# Dev log

Notes on decisions that outlive a commit message — chiefly what this app works around in
the framework, and what to do with each workaround when the framework catches up.

## 2026-08-29 — Ranking "New Quotation" by how often you start one

Extends the 2026-08-28 entry below to a third destination, and takes two things to work
rather than one.

### Drafts have to be collapsed before they can be counted

An unsaved document is named `new-<slugged doctype>-<random>` (`frappe.model.get_new_name`
in `create_new.js`), so every draft routes somewhere different. Recorded as-is, a hundred
new quotations are a hundred routes visited once each, and frecency has nothing to add up.
`route_key` folds any `Form/<doctype>/new-<slug>-…` to `New/<doctype>` — the same trick it
already plays on list views, which is why it belongs there rather than at the call site.

The framework has no "is this a new document name?" predicate. It inlines the prefix test
in `model.js` and again in `breadcrumbs.js`, so this app inlines it a third time rather
than depending on a private helper that does not exist.

### The creatable has no route

`get_doctypes` and `get_creatables` build "New Quotation" with an `onclick` that calls
`frappe.new_doc`, and no `route` at all — so `score_of` returned `0` for creatables no
matter what the table held. Its `match` field carries the doctype, which is the only thing
tying the option back to the drafts, so `score_of` special-cases `type === "New"` and keys
on `match` instead.

### Known gaps

Quick Entry doctypes never earn a score. `frappe.new_doc` opens a dialog instead of routing
when the doctype has `quick_entry` set (`create_new.js` → `quick_entry.js`), so Customer,
Item and Contact produce no route to record. Quotation, Sales Invoice and the rest of the
transactional doctypes route to a full form and work. Fixing it would mean recording from
somewhere other than the router, which is a bigger change than the gap deserves for now.

An abandoned draft counts the same as a saved one. That is intended — the signal is "how
often do you come here to create one of these", not "how many did you create" — but it
does mean a doctype whose form is opened and closed repeatedly ranks as if it were used.

## 2026-08-28 — Recording visits the framework refuses to record

### Symptom

Typing `rappr` on the okté site put `Ouvrir Rapprochement bancaire` in sixth place, below
five results the user had never opened. Every candidate in the near-tie band scored a
frecency of `0`, so the rerank had nothing to reorder and left the fuzzy order intact.

### Cause

`is_route_useful` in dodock (`frappe/public/js/frappe/router_history.js`) decides what
reaches the Route History table, and it drops two shapes this app ranks:

- `!route[1]` drops every single-segment route. A desk Page is exactly that —
  `bank-reconciliation` routes to `["bank-reconciliation"]` — so no Page has ever been
  recorded.
- `routes_to_skip` contains `Form`, which drops single doctypes along with real
  documents. A single routes to `["Form", X, X]`.

Both shapes are offered by the awesome bar (`get_pages` and the `single_types` branch of
`get_doctypes` in `search_utils.js`), so both could be ranked — they just had no history
to rank on, permanently, no matter how often they were opened.

### Workaround in this app

`awesomebar_lab.bundle.js` registers a second `frappe.router.on("change")` listener that
queues exactly those two shapes and flushes them through the same whitelisted
`route_history.deferred_insert` on the same 10s debounce. The two conditions are disjoint
from `is_route_useful`, so nothing is recorded twice.

It lives here rather than in dodock because this app runs on a production site: an
app-side diff ships and rolls back with the app, while a framework patch means deploying
a dodock change for an experiment.

### Upstreaming it

The workaround is a stand-in for a framework fix. `is_route_useful` is module-local with
no override point, which is the only reason the logic had to be duplicated instead of
extended.

The equivalent change in dodock is contained to `is_route_useful`:

```js
function is_route_useful(route) {
	if (!route[1]) {
		// A desk Page is a single-segment route.
		return Boolean(frappe.boot.page_info?.[route[0]]);
	} else if (route[0] === "Form") {
		// Singles are one row per doctype, not one per document, so they do not carry
		// the write volume that put Form in routes_to_skip.
		return route[1] === route[2] && (frappe.boot.single_types || []).includes(route[1]);
	} else if ((route[0] === "List" && !route[2]) || routes_to_skip.includes(route[0])) {
		return false;
	} else {
		return true;
	}
}
```

Worth saying in the MR: this is not only an awesomebar_lab concern. The framework's own
`frequently_visited_links` (`route_history.py`) reads the same table, so today it can
never suggest a Page or a single either.

One question to settle with the reviewer: `_is_permitted_link` passes non-report routes
through unchecked, so a Page the user has since lost access to would resurface in the
framework's suggestions. This app is unaffected — it re-checks `page_info`, which boot
already permission-filters — but upstream may want the same check.

### When it lands

Delete the listener, `is_fixed_destination`, and the flush helper from
`awesomebar_lab.bundle.js`, along with `tests/test_route_recording.js`, which tests the
boundary with the framework rather than anything this app ranks on. Nothing else here
depends on them: `route_key` already maps both shapes to the same key from either side,
and `frecency.py` reads whatever the table holds.

Until then that test is also the guard against the workaround outliving the gap — once
the framework records these routes itself, "the framework already records this" cases
start failing and every visit is counted twice.

Verify by opening a desk Page and a single, waiting out the debounce, and confirming a
`Route History` row for `bank-reconciliation` and for `Form/Bank Clearance/Bank Clearance`.
