// Copyright (c) 2026, Antoine Maas and contributors
// For license information, please see license.txt

frappe.provide("awesomebar_lab");

// Ranking knobs, resolved server side and shipped with boot so they can be tuned from
// Awesomebar Lab Settings without a rebuild. The fallbacks cover a desk booted before
// the doctype was migrated in; the shipped feature will inline the settled values.
const TUNING_FALLBACKS = {
	// Results scoring within this fraction of the best match are close enough that
	// personal history, not the fuzzy score, should decide their order.
	frecency_band: 0.85,
	// Low enough that a single pick already pins, the way Raycast and Alfred learn. What
	// makes that safe is the decay: a one-off fades in about three idle days, while a
	// habit worth keeping lasts weeks.
	memory_min_confidence: 0.65,
	// How long a remembered pick keeps half its weight once the query goes unused.
	memory_half_life_days: 14,
};

// Read per call rather than once at load: this bundle runs before frappe.boot exists.
function tuning(key) {
	const value = (frappe.boot.awesomebar_lab_settings || {})[key];
	return value == null ? TUNING_FALLBACKS[key] : value;
}

// The framework emits the same route from several sources, so the redistributed scores
// contain duplicates — and Awesomplete's sort is stable, which resolves a tie by the
// original position. Without a nudge a promoted result only ever ties the copies that
// kept the top score, and renders behind them. Kept far below the 0.01 offsets the
// framework itself uses as tie-breakers.
const RANK_EPSILON = 1e-6;

const MEMORY_KEY = "awesomebar_lab_selections";
// Digit-only queries ("2024") would otherwise become integer-like object keys, which
// JavaScript enumerates in numeric order before insertion order — silently breaking
// the LRU eviction below.
const MEMORY_KEY_PREFIX = "q:";
const MEMORY_MAX_QUERIES = 100;

const DEBUG_KEY = "awesomebar_lab_debug";

/**
 * Ranking traces for the console, off unless someone asks for them. Read once at load
 * rather than per keystroke, and every payload below is built inside a guard, so with
 * logging off the whole facility costs one boolean test per search.
 *
 * Toggle from the console with awesomebar_lab.debug() / awesomebar_lab.debug(false).
 */
let debug_enabled = false;
try {
	debug_enabled = localStorage.getItem(DEBUG_KEY) === "1";
} catch (e) {
	// storage disabled: tracing simply stays off
}

awesomebar_lab.debug = function (enable = true) {
	debug_enabled = Boolean(enable);
	try {
		localStorage.setItem(DEBUG_KEY, debug_enabled ? "1" : "0");
	} catch (e) {
		// not persisted, but it still applies for this page
	}
	console.log(
		`[awesomebar_lab] ranking trace ${debug_enabled ? "on" : "off"}` +
			(debug_enabled ? " — open ⌘K and type to see it" : "")
	);
};

awesomebar_lab.frecency = {
	scores: null,

	/**
	 * Route History stores the visited route ("List/Sales Invoice/List") while
	 * awesome bar options carry the route that opens it (["List", "Sales Invoice"]).
	 * Collapse both to the same key so a list and its views count as one entry.
	 */
	route_key(route) {
		const parts = typeof route === "string" ? route.split("/") : route;
		const is_list_view = parts[0] === "List" && !["Report", "Inbox"].includes(parts[2]);
		return (is_list_view ? parts.slice(0, 2) : parts).join("/");
	},

	// Summed, not assigned: a doctype's list, kanban and calendar routes all collapse
	// to one key, and they are the same page as far as ranking goes.
	load() {
		this.scores = {};
		(frappe.boot.awesomebar_lab_frecency || []).forEach((link) => {
			const key = this.route_key(link.route);
			this.scores[key] = (this.scores[key] || 0) + link.score;
		});
		if (debug_enabled) {
			console.log(
				`[awesomebar_lab] frecency loaded from boot: ${
					Object.keys(this.scores).length
				} routes (scored and decayed server side)`,
				this.scores
			);
		}
		return this.scores;
	},

	score_of(option) {
		if (!this.scores) this.load();
		return option.route ? this.scores[this.route_key(option.route)] || 0 : 0;
	},

	/**
	 * Reorders only the results that are already near-ties on match quality, so a
	 * frequently visited page can win a close call but never outrank a better match.
	 *
	 * Swaps their scores rather than their positions: Awesomplete re-sorts the list
	 * by `index` before rendering, so anything expressed as array order is discarded.
	 * Options must arrive sorted by `index` descending.
	 *
	 * Returns the trace logger, for the caller to run once the pin has had its say.
	 */
	rerank(options) {
		// fuzzy_match can go negative on long labels, and a non-positive top score
		// puts the multiplicative cutoff above it — nothing near-tie-worthy there anyway.
		if (!options.length || options[0].index <= 0) return;

		const band = tuning("frecency_band");
		// Read before the loop below overwrites it, or the band is reported against
		// whatever score landed on the first option instead of the best match.
		const top_score = options[0].index;
		const cutoff = top_score * band;
		const near_ties = options.filter((option) => option.index >= cutoff);
		const scores_to_share = near_ties.map((option) => option.index);

		// Captured before the loop overwrites `index`; the rows keep the option itself
		// so the trace can read the final score back off it afterwards.
		const trace = debug_enabled
			? near_ties.map((option) => ({
					option: option,
					was: option.index,
					frecency: this.score_of(option),
			  }))
			: null;

		// Comparing scores would miss a result that moved up without gaining one, which is
		// what happens whenever the score it moved past was a duplicate of its own.
		const rank_before = new Map(near_ties.map((option, rank) => [option, rank]));

		near_ties
			.sort((a, b) => this.score_of(b) - this.score_of(a) || b.index - a.index)
			.forEach((option, rank) => {
				option.boosted_by_history = rank < rank_before.get(option);
				option.index = scores_to_share[rank] + (near_ties.length - rank) * RANK_EPSILON;
			});

		// Deferred rather than logged here: the pin runs after this and can outrank
		// everything the rerank just decided. A trace read mid-pipeline reports scores
		// and promotions that no longer match what the dropdown renders.
		return trace && (() => this.log_rerank(trace, cutoff, top_score, band));
	},

	log_rerank(trace, cutoff, top_score, band) {
		const pinned = trace.filter((row) => row.option.pinned_for_query).length;
		const promoted = trace.filter(
			(row) => row.option.boosted_by_history && !row.option.pinned_for_query
		).length;
		const summary =
			[
				promoted && `${promoted} moved up by how often you open them`,
				pinned && `${pinned} pinned by what you keep picking for this search`,
			]
				.filter(Boolean)
				.join(", ") || "history agreed with the match ranking, nothing moved";

		console.groupCollapsed(
			`[awesomebar_lab] ${trace.length} near-tie(s) within ${
				band * 100
			}% of ${top_score} (cutoff ${cutoff.toFixed(2)}) — ${summary}`
		);
		// Rows in final rank order, so the table can be read against the dropdown.
		console.table(
			trace
				.sort((a, b) => b.option.index - a.option.index)
				.map((row) => ({
					result: row.option.value,
					match_score: row.was,
					frecency: row.frecency,
					final_score: row.option.index,
					promoted: Boolean(row.option.boosted_by_history),
					pinned: Boolean(row.option.pinned_for_query),
				}))
		);
		console.groupEnd();
	},
};

/**
 * Remembers what you picked for a given query, so picking Sales Invoice once for "inv"
 * pins it for "inv" next time. Conditioned on the query rather than on the result, so
 * it only fires where the habit was actually formed.
 *
 * Device-local by design: no schema, no boot payload, and nothing to migrate.
 */
awesomebar_lab.memory = {
	normalize(query) {
		return (query || "").trim().toLowerCase().replace(/\s\s+/g, " ");
	},

	// localStorage is shared across every user of a browser profile — on a shared
	// terminal one user's habits must not shape another user's ranking.
	storage_key() {
		return `${MEMORY_KEY}:${frappe.session.user}`;
	},

	load() {
		try {
			return JSON.parse(localStorage.getItem(this.storage_key())) || {};
		} catch (e) {
			// Corrupted storage: starting over only costs relearning a few picks.
			return {};
		}
	},

	/**
	 * Laplace-smoothed selection rate, with both counters faded by how long the query
	 * has gone unused. One pick earns a pin and one contradicting pick corrects a fresh
	 * one — it flips a single-pick pin outright and unpins a double-pick one — while a
	 * habit repeated three or more times takes more than one stray pick to dislodge.
	 * A pin you stop using expires without needing a contradiction at all.
	 *
	 * The fade applies to the totals rather than to each pick separately: keeping a
	 * timestamp per pick would grow the payload to sharpen a tie-breaker.
	 */
	confidence(entry) {
		const idle_days = entry.last_used
			? (Date.now() - entry.last_used) / (24 * 60 * 60 * 1000)
			: 0;
		const weight = 0.5 ** (idle_days / tuning("memory_half_life_days"));
		return (entry.hits * weight + 1) / ((entry.hits + entry.misses) * weight + 2);
	},

	record(query, value) {
		const normalized_query = this.normalize(query);
		if (normalized_query.length < 2) return;

		const memory = this.load();
		const stored_key = MEMORY_KEY_PREFIX + normalized_query;
		const entry = memory[stored_key];
		let updated;

		if (!entry || (entry.value !== value && entry.misses + 1 >= entry.hits)) {
			updated = { value: value, hits: 1, misses: 0 };
		} else if (entry.value === value) {
			updated = { ...entry, hits: entry.hits + 1 };
		} else {
			updated = { ...entry, misses: entry.misses + 1 };
		}

		// Reinserting moves the key to the end of the iteration order, so the eviction
		// below drops the least recently used query rather than the oldest one.
		delete memory[stored_key];
		memory[stored_key] = { ...updated, last_used: Date.now() };

		const queries = Object.keys(memory);
		if (queries.length > MEMORY_MAX_QUERIES) delete memory[queries[0]];

		try {
			localStorage.setItem(this.storage_key(), JSON.stringify(memory));
		} catch (e) {
			// storage full or disabled: the boost is optional, dropping it is fine
		}

		if (debug_enabled) {
			const confidence = this.confidence(memory[stored_key]);
			const threshold = tuning("memory_min_confidence");
			console.log(
				`[awesomebar_lab] remembered "${normalized_query}" → "${updated.value}" ` +
					`(${updated.hits} hit(s), ${
						updated.misses
					} miss(es), confidence ${confidence.toFixed(2)}) — ` +
					(confidence > threshold
						? "will be pinned for this query"
						: `below the ${threshold} threshold, not pinned yet`)
			);
		}
	},

	recall(query) {
		const normalized_query = this.normalize(query);
		const memory = this.load();

		// The pick was recorded when the query was usually shorter than what's typed
		// by now, so the longest stored prefix of the current query wins.
		for (let length = normalized_query.length; length >= 2; length--) {
			const entry = memory[MEMORY_KEY_PREFIX + normalized_query.slice(0, length)];
			if (entry) {
				const confidence = this.confidence(entry);
				const trusted = confidence > tuning("memory_min_confidence");
				if (debug_enabled) {
					const via =
						length === normalized_query.length
							? "exact match"
							: `prefix "${normalized_query.slice(0, length)}"`;
					console.log(
						`[awesomebar_lab] recall "${normalized_query}" → "${entry.value}" ` +
							`(${via}, confidence ${confidence.toFixed(2)}) — ` +
							(trusted ? "pinning it" : "too weak, ignored")
					);
				}
				return trusted ? entry.value : null;
			}
		}
		return null;
	},

	/**
	 * Scores the result this user keeps picking for this exact query above every
	 * other match. Only touches what the search already matched, so a remembered
	 * choice never reappears once it stops matching what is being typed.
	 */
	pin(options, query) {
		const remembered = this.recall(query);
		if (!remembered) return;

		// Every copy, not just the first. The framework emits one option per source and
		// only deduplicates those without a description, so a route reachable as both a
		// doctype and a desk entry survives twice — pinning one would leave the pair
		// split apart in the ranking, with only one carrying the history marker.
		const pinned = options.filter((option) => option.value === remembered);
		if (!pinned.length) {
			if (debug_enabled) {
				console.log(
					`[awesomebar_lab] remembered "${remembered}" no longer matches "${query}" — ` +
						"results left alone"
				);
			}
			return;
		}

		const top_index = Math.max(...options.map((option) => option.index)) + 1;
		pinned.forEach((option) => {
			option.index = top_index;
			option.boosted_by_history = true;
			option.pinned_for_query = true;
		});

		if (debug_enabled) {
			console.log(
				`[awesomebar_lab] pinned "${remembered}" to the top for "${query}" ` +
					`(${pinned.length} cop(ies), score raised to ${top_index})`
			);
		}
	},
};

// --icon-stroke is what .icon paints with, so overriding it here is the only way to
// mute the glyph — a text colour class would not reach it.
function add_history_marker(option) {
	if (!option.boosted_by_history) return;

	// A pin means "you picked this for this exact query", a clock means "you open this a
	// lot" — two different reasons deserve two glyphs. Both live in the lucide sprite,
	// which is the one set frappe 17, dodock 6 and dodock 5 all ship.
	const [icon_name, reason] = option.pinned_for_query
		? ["pin", __("Ranked higher because you keep picking it for this search")]
		: ["history", __("Ranked higher because you open this often")];
	const icon = frappe.utils.icon(icon_name, "xs");

	option.label = `${
		option.label || option.value
	}<span class="ml-2" style="--icon-stroke: var(--text-muted)" title="${reason}">${icon}</span>`;
}

frappe.search.AwesomeBar = class extends frappe.search.AwesomeBar {
	build_options(txt) {
		const options = super.build_options(txt);

		// The rerank wants the array sorted by index, which is how the framework
		// returns it; the pin outranks the rerank.
		const log_trace = awesomebar_lab.frecency.rerank(options);
		awesomebar_lab.memory.pin(options, txt);
		options.forEach(add_history_marker);
		if (log_trace) log_trace();

		return options.sort((a, b) => b.index - a.index);
	}
};

/**
 * Route History skips single-segment routes and every Form route, which silently
 * excludes the two destinations the awesome bar offers as a single fixed page: desk
 * Pages ("Open Bank Reconciliation") and single doctypes. Neither could ever earn a
 * frecency score, however often it was opened.
 *
 * Recorded here rather than by relaxing `is_route_useful`, which is module-local and
 * has no override point. Only routes the framework declines to record are queued, so
 * nothing is inserted twice. See DEVLOG.md for the framework fix this stands in for.
 */
function is_fixed_destination(route) {
	if (route.length === 1) return Boolean(frappe.boot.page_info?.[route[0]]);

	// A single's form route repeats the doctype as the document name (router.js).
	return (
		route[0] === "Form" &&
		route[1] === route[2] &&
		(frappe.boot.single_types || []).includes(route[1])
	);
}

let unrecorded_visits = [];

// Same flush interval the framework uses for the routes it does record, so a burst of
// navigation costs one call either way.
const flush_unrecorded_visits = frappe.utils.debounce(() => {
	const routes = unrecorded_visits;
	unrecorded_visits = [];
	frappe
		.xcall("frappe.desk.doctype.route_history.route_history.deferred_insert", { routes })
		.then(() => {
			if (debug_enabled) {
				console.log(
					`[awesomebar_lab] recorded ${routes.length} visit(s) the framework skips`,
					routes.map((visit) => visit.route)
				);
			}
		});
}, 10000);

frappe.router.on("change", () => {
	const route = frappe.get_route();
	if (!is_fixed_destination(route)) return;

	unrecorded_visits.push({
		creation: frappe.datetime.now_datetime(),
		route: frappe.get_route_str(),
	});
	flush_unrecorded_visits();
});

// Delegated rather than bound to the input: the framework clears the field inside its
// own select handler, so by the time this bubbles up there is nothing left to read.
let last_query = "";
$(document).on("input", "#navbar-search", (e) => {
	last_query = e.target.value;
});

$(document).on("awesomplete-select", "#navbar-search", (e) => {
	awesomebar_lab.memory.record(last_query, e.originalEvent.text.value);
});
