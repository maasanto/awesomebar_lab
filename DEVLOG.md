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
is a permanent singleton group for the framework's own `group_by route` query, and one more
row-per-day group for the aggregate this app reads. Worth watching if a site turns out to
open far more drafts than pages.

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

Settled: the core port now permission-checks `Form/` and `New/` routes, because singles
skew privileged and the framework's list is rendered as navigable links. It stays out of
this app, where the scores only ever reorder results the awesome bar already produced and
permission-checked, so a route the user cannot open simply never matches anything.

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

## What came back from the core review

Four defects found while porting this to `frappe/frappe` were real here too, and are now
fixed in both.

The scores were dead on arrival. Bootinfo is cached per user with no expiry, so the decay
was computed once at boot-cache creation and never moved again — a session left open for a
week ranked on week-old scores. `awesomebar_lab.frecency.refresh()` re-reads them once,
when the bar is first focused, which is also the only place they are used.

Boot paid for a window of up to 10,000 raw rows. `daily_visits` now groups by route and day
in SQL, so the cost is bounded by distinct routes times retention days rather than by visit
count, and day granularity is ample against a half life measured in weeks. Verified against
the previous per-visit implementation: identical scores, 42 visits collapsing to 4 rows.

`recall` walked prefixes but stopped at the first *stored* one, so a half-formed entry for
`salei` could veto a settled pin on `sal` — typing one more letter dropped a pin the shorter
query still earned. It now skips untrusted prefixes and keeps looking.

`memory.load()` re-read and re-parsed the whole store on every keystroke, via `recall`. It
is cached in memory now and written through on `record`.

Also picked up from the core branch: the near-tie cutoff is held at `FUZZY_BASE_SCORE` when
the top score sits just above 100, or a weak best match makes every result a near-tie.

Deliberately not ported: the permission filter (see above), and the framework's own
`get_frequent_links` ordering fix, which this app does not touch.

## What came back from the second core review (2026-09-23)

Five more fixes from the second review of the `frappe/frappe` port, all of them real here.

A contradicting pick revived an expired pin. `record` compared raw hits and misses, then reset
`last_used` to now, which restored the decay weight to 1. A habit of five picks left idle for
two months had long stopped pinning, yet one pick of something else made it `(5+1)/(6+2)`,
0.75, and it pinned again, the opposite of what was just chosen. The counts are now faded
before they are weighed and stored.

A pin could still sit below "Search for …". It only outranked the results `build_options`
returned, while the framework's defaults were already on the list at 100. It now takes the
list built so far as rivals.

A failed refresh popped a server dialog just because the search box got focus, and was never
retried. It is silent now, logs to the console, and retries on the next focus.

Days were bucketed wrong on sqlite, where `CAST(x AS DATE)` is a numeric cast that returns
the year, and `DATE()` hands back text. `day_of` picks the right function per backend and
the scoring reads the day through `getdate`.

The scan was unbounded on a site that keeps Route History forever. Visits older than seven
half-lives, worth under 1% of one from today, are no longer read.

Deliberately not ported: re-pinning once hook results arrive, which would mean replacing the
framework's `fetch_hook_results` (frappe 17 only); ranking workspaces, private ones included,
since the framework's workspace options carry no route for this app to key on; the page and
workspace permission filter, for the reason above; and the index on `Route History.user`,
which an app should not add to a core DocType. The window above bounds that scan instead.
