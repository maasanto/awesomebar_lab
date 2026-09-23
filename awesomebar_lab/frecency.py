# Copyright (c) 2026, Antoine Maas and contributors
# For license information, please see license.txt

from collections import Counter
from datetime import date

import frappe
from frappe.query_builder.functions import Cast_, Count, Date

# Every value here is overridable from Awesomebar Lab Settings while the ranking is
# being tuned; the shipped feature will inline whatever these settle on and drop the
# doctype. The half lives are kept well inside the Route History retention window,
# which Log Settings defaults to 90 days: decay can only separate visits that are
# still in the table, so cutting retention to around one half-life quietly turns this
# back into a raw visit count.
TUNING_DEFAULTS = {
	# How close to the best match a result must score to be reordered by history at all.
	# 1 reorders nothing, 0.5 reorders half the list. Settled at 0.7 in real use: 0.85 was
	# narrow enough that history rarely got to decide anything, since two results that
	# close on fuzzy score are usually the same doctype anyway.
	"frecency_band": 0.7,
	# How long a visit keeps half its weight. Shorter favours what was opened this week,
	# longer favours what is opened most overall.
	"frecency_half_life_days": 14.0,
	# How many of the user's top routes ride along with boot. Anything past this ranks as
	# never visited, so it trades boot payload against how deep the ranking can reach.
	"boot_link_limit": 30,
	# How confident a remembered pick must be before it is pinned. Below about 0.67 a
	# single pick already pins; raise it to demand a repeated habit.
	"memory_min_confidence": 0.65,
	# How long a remembered pick keeps half its weight once its query goes unused, which
	# is what lets a one-off fade instead of needing a contradicting pick to clear it.
	"memory_half_life_days": 14.0,
}

MAX_LINKS = 50


def get_tuning() -> dict:
	"""Read the tuning knobs, falling back to the defaults above.

	A blank or zeroed field means "use the default" rather than "divide by zero", so
	clearing a field in the form is always a way back out of a bad experiment.
	"""
	settings = frappe.get_cached_doc("Awesomebar Lab Settings")
	return {key: settings.get(key) or default for key, default in TUNING_DEFAULTS.items()}


def is_new_document(doctype: str, docname: str) -> bool:
	"""Whether a Form route points at an unsaved draft rather than a stored document.

	Mirrors frappe.model.get_new_name, which names a draft `slug(new-<doctype>-<random>)`,
	and its slug only lowercases and turns spaces into dashes. The trailing dash is what
	keeps `Quotation` from claiming a `Quotation Item` draft; the framework's own inlined
	copies of this test in model.js and breadcrumbs.js leave it off.
	"""
	return docname.startswith(f"new-{doctype.lower().replace(' ', '-')}-")


def visit_key(route: str) -> str:
	"""The key a visit is counted under.

	Every draft of a doctype routes to a different generated name, so counted raw they
	are singletons worth one visit each and none of them survives the top-N cut in
	frequently_visited_links below. Folding them here rather than in the browser is the
	whole point: the cut happens first, and by then the drafts are gone.

	Only routes with a per-visit identity need this. A list view is already one route
	however often it is opened, which is why the client still collapses those itself.
	"""
	parts = route.split("/")
	if len(parts) == 3 and parts[0] == "Form" and is_new_document(parts[1], parts[2]):
		# Kept in step with new_document_key in awesomebar_lab.bundle.js, which is what
		# the awesome bar's routeless "New Quotation" option looks itself up by.
		return f"New/{parts[1]}"
	return route


def day_of(creation):
	"""A timestamp's calendar day, spelled the way each backend understands.

	Postgres has no DATE(); sqlite has no date type, so CAST(x AS DATE) is a numeric cast
	there and returns the year rather than a day. The framework's own query builder only
	grew a portable function for this on develop, which the versions this app supports lack.
	"""
	return Cast_(creation, "date") if frappe.db.db_type == "postgres" else Date(creation)


def scoring_window_days(half_life_days: float) -> int:
	"""Seven half-lives, so a visit left out was worth under 1% of one from today and could
	not have changed an order. Deliberately wider than the default retention window: what it
	bounds is the site that keeps Route History for a year, or forever."""
	return round(7 * half_life_days)


def daily_visits(user: str, window_days: int) -> list[dict]:
	"""One row per route per day, rather than one per visit.

	Grouping in SQL is what keeps this affordable: over the 90-day retention window a
	busy user accumulates tens of thousands of rows, and the decay only needs to know how
	many visits landed on each day. Day granularity is ample against a half life measured
	in weeks.
	"""
	table = frappe.qb.DocType("Route History")
	# Compared against a plain string rather than the backend's NOW(): sqlite has no such
	# function, and a date-only bound matches the day granularity below anyway.
	oldest_scored_day = frappe.utils.add_to_date(days=-window_days, as_string=True)
	return (
		frappe.qb.from_(table)
		.select(
			table.route,
			day_of(table.creation).as_("day"),
			Count("*").as_("count"),
		)
		.where(table.user == user)
		.where(table.creation >= oldest_scored_day)
		.groupby(table.route, day_of(table.creation))
	).run(as_dict=True)


def score_visits(visits: list[dict], today: date, half_life_days: float) -> Counter:
	"""Score each route by how much *and* how recently it was visited.

	A visit is worth 1 point on the day it happens and half that after every
	half_life_days, so a route used daily this week outranks one used twice as
	often but abandoned a month ago. Raw counts can't express that.
	"""
	scores = Counter()
	for visit in visits:
		# Timestamps come from the browser clock via deferred_insert, so a visit can sit
		# ahead of server time — it must never be worth more than one from today.
		# sqlite's DATE() hands back a string where the other backends return a date.
		age_days = max(0, (today - frappe.utils.getdate(visit["day"])).days)
		scores[visit_key(visit["route"])] += visit["count"] * 0.5 ** (age_days / half_life_days)
	return scores


@frappe.whitelist()
def frequently_visited_links(limit: int | None = None) -> list[dict]:
	"""Return this user's routes, most frecent first.

	Unlike the framework endpoint of the same name, these are not filtered by
	permission on the underlying report: they only ever reorder results the
	awesome bar already produced and permission-checked, so a route the user can
	no longer open simply never matches anything. Skipping the check keeps a
	report-permission query off every desk boot.
	"""
	tuning = get_tuning()
	limit = min(max(frappe.utils.cint(limit or tuning["boot_link_limit"]), 1), MAX_LINKS)

	# Decayed in Python rather than in SQL to stay portable across the backends.
	half_life_days = tuning["frecency_half_life_days"]
	visits = daily_visits(frappe.session.user, scoring_window_days(half_life_days))
	scores = score_visits(visits, frappe.utils.now_datetime().date(), half_life_days)

	return [{"route": route, "score": round(score, 3)} for route, score in scores.most_common(limit)]


def boot_session(bootinfo: "frappe._dict") -> None:
	"""Ship the scores with boot so the awesome bar can rank without a round trip."""
	bootinfo.awesomebar_lab_frecency = frequently_visited_links()
	bootinfo.awesomebar_lab_settings = get_tuning()
