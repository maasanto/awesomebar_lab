# Copyright (c) 2026, Antoine Maas and contributors
# For license information, please see license.txt

from collections import Counter
from datetime import datetime

import frappe

# Every value here is overridable from Awesomebar Lab Settings while the ranking is
# being tuned; the shipped feature will inline whatever these settle on and drop the
# doctype. The half lives are kept well inside the Route History retention window,
# which Log Settings defaults to 90 days: decay can only separate visits that are
# still in the table, so cutting retention to around one half-life quietly turns this
# back into a raw visit count.
TUNING_DEFAULTS = {
	"frecency_band": 0.85,
	"frecency_half_life_days": 14.0,
	"boot_link_limit": 30,
	"memory_min_confidence": 0.65,
	"memory_half_life_days": 14.0,
}

MAX_LINKS = 50
# Beyond this many visits the oldest ones are dropped: after a few half-lives they
# contribute almost nothing, and boot must not pay for an unpruned history.
MAX_SAMPLED_VISITS = 10_000


def get_tuning() -> dict:
	"""Read the tuning knobs, falling back to the defaults above.

	A blank or zeroed field means "use the default" rather than "divide by zero", so
	clearing a field in the form is always a way back out of a bad experiment.
	"""
	settings = frappe.get_cached_doc("Awesomebar Lab Settings")
	return {key: settings.get(key) or default for key, default in TUNING_DEFAULTS.items()}


def score_visits(visits: list[dict], now: datetime, half_life_days: float) -> Counter:
	"""Score each route by how much *and* how recently it was visited.

	A visit is worth 1 point on the day it happens and half that after every
	half_life_days, so a route used daily this week outranks one used twice as
	often but abandoned a month ago. Raw counts can't express that.
	"""
	scores = Counter()
	for visit in visits:
		# Timestamps come from the browser clock via deferred_insert, so a visit can
		# sit ahead of server time — it must never be worth more than one from right now.
		age_days = max(0, (now - visit["creation"]).total_seconds() / 86400)
		scores[visit["route"]] += 0.5 ** (age_days / half_life_days)
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

	# Decayed in Python rather than in SQL to stay portable across MariaDB and
	# Postgres. Move the decay into the query if boot latency ever shows up.
	visits = frappe.get_all(
		"Route History",
		fields=["route", "creation"],
		filters={"user": frappe.session.user},
		order_by="creation desc",
		limit=MAX_SAMPLED_VISITS,
	)
	scores = score_visits(visits, frappe.utils.now_datetime(), tuning["frecency_half_life_days"])

	return [{"route": route, "score": round(score, 3)} for route, score in scores.most_common(limit)]


def boot_session(bootinfo: "frappe._dict") -> None:
	"""Ship the scores with boot so the awesome bar can rank without a round trip."""
	bootinfo.awesomebar_lab_frecency = frequently_visited_links()
	bootinfo.awesomebar_lab_settings = get_tuning()
