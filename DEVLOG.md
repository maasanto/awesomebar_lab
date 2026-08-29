# Dev log

Notes on decisions that outlive a commit message — chiefly what this app works around in
the framework, and what to do with each workaround when the framework catches up.

## 2026-08-29 — Ranking "New Quotation" by how often you start one

Extends the 2026-08-28 entry below to a third destination, and takes two things to work
rather than one.

### Drafts have to be collapsed before they can be counted, and before the boot cut

An unsaved document is named `new-<slugged doctype>-<random>` (`frappe.model.get_new_name`
in `create_new.js`), so every draft routes somewhere different. Recorded as-is, a hundred
new quotations are a hundred routes visited once each, and frecency has nothing to add up.

The fold lives in `visit_key` in `frecency.py`, on the server, and this is the part that is
easy to get wrong: `frequently_visited_links` ships only `most_common(boot_link_limit)`.
Folding in the browser instead — where `route_key` already folds list views — puts the
fold *after* that cut. Each draft then reaches it as a singleton worth at most one visit,
loses all thirty slots to aggregated routes, and the whole feature scores zero for exactly
the heavy users it was built for. Worse, a light user gets the inverse: drafts do survive
the cut, evict real routes, and the score saturates at whatever slots were left, so it is
not even monotonic in the thing it claims to measure.

The rule this leaves behind: fold anything with a per-visit identity server side. List
views can stay in `route_key` because a list is already one route however often it is
opened, so the cut has nothing to destroy.

The client deliberately does *not* fold drafts, and that is not just redundancy. The
awesome bar offers recently visited Form routes as results (`get_recent_pages` reads
`frappe.route_history`), so a live draft appears with its own full route. Folding client
side would hand that one dead draft the summed score of every draft ever opened and label
it "you open this often". `test_route_recording.js` pins this.

The framework has no "is this a new document name?" predicate. It inlines the prefix test
in `model.js` and again in `breadcrumbs.js`, so this is inlined a third time — once in
`frecency.py` for the fold and once in the bundle for the recording decision — rather than
depending on a private helper that does not exist. Both keep the trailing dash the
framework's copies leave off, without which `Quotation` claims `Quotation Item` drafts.

### The creatable has no route

`get_doctypes` and `get_creatables` build "New Quotation" with an `onclick` that calls
`frappe.new_doc`, and no `route` at all — so `score_of` returned `0` for creatables no
matter what the table held. Its `match` field carries the doctype, which is the only thing
tying the option back to the drafts, so `score_of` special-cases `type === "New"` and keys
on `match` instead.

### Known gaps

Quick Entry doctypes are scored, but biased. `frappe.new_doc` opens a dialog rather than
routing when the doctype has `quick_entry` set (`create_new.js` → `quick_entry.js`), and
the dialog never touches the router — but "Edit Full Form" inside it calls `set_route`
with the draft's own name, so Customer and Item score only on the times you escaped the
dialog. That is a worse signal than no signal, because it looks like the others. Recording
from somewhere other than the router would fix it, and is a bigger change than this
deserves for now.

An abandoned draft counts the same as a saved one. That is intended — the signal is "how
often do you come here to create one of these", not "how many did you create" — but it
does mean a doctype whose form is opened and closed repeatedly ranks as if it were used.

Reloading a draft form counts twice. `formview.js` mints a fresh draft name and re-routes
when it lands on a `new-…` route whose document is not in `locals`, and the first router
change has already fired by then. One refresh is two visits, under two names that both
fold to the same key.

Drafts cost cardinality, not rows. Retention bounds the table either way, but every draft
is a permanent singleton group for the framework's own `group_by route` query, and eats
into the `MAX_SAMPLED_VISITS` window this app samples. Worth watching if a site turns out
to open far more drafts than pages.

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

### What it also changes, and what was left alone

Route History is not this app's private input. `frappe.boot.frequently_visited_links`
reads the same table and feeds the awesome bar's empty-query dropdown — the list shown on
focus, before anything is typed, from the `txt.length > 1` branch in `awesome_bar.js`. So
writing these visits also changes what the framework suggests, where everything else here
only reorders what the framework already produced.

Accepted rather than worked around. `get_recent_pages` already puts Pages and singles in
that dropdown from the in-session `frappe.route_history`; what changes is that they now
persist across sessions and can hold one of the five frequent slots, which is what
"frequently visited" is supposed to mean.

Deliberately not permission-checked, unlike the Page branch: `frappe.boot.single_types` is
every single on the site, while `page_info` is filtered at boot. A single the user cannot
read is never offered by the awesome bar — `get_doctypes` iterates `can_read` — and is not
reachable from the UI, so recording one means typing its URL by hand. A guard would cost
more than the case is worth.

Worth keeping straight when reading a trace: none of this touches the fuzzy score. These
results always matched and always ranked; it was the frecency column that was pinned at
`0`, which is why they sat mid-list rather than missing.

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
