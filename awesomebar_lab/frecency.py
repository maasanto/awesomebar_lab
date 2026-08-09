# Copyright (c) 2026, Antoine Maas and contributors
# For license information, please see license.txt

from collections import Counter
from datetime import datetime

import frappe

# Kept well inside the Route History retention window, which Log Settings defaults to
# 90 days: decay can only separate visits that are still in the table, so cutting
# retention to around one half-life quietly turns this back into a raw visit count.
HALF_LIFE_DAYS = 14
MAX_LINKS = 50
# Beyond this many visits the oldest ones are dropped: after a few half-lives they
# contribute almost nothing, and boot must not pay for an unpruned history.
MAX_SAMPLED_VISITS = 10_000


def score_visits(visits: list[dict], now: datetime) -> Counter:
	"""Score each route by how much *and* how recently it was visited.

	A visit is worth 1 point on the day it happens and half that after every
	HALF_LIFE_DAYS, so a route used daily this week outranks one used twice as
	often but abandoned a month ago. Raw counts can't express that.
	"""
	scores = Counter()
	for visit in visits:
		# Timestamps come from the browser clock via deferred_insert, so a visit can
		# sit ahead of server time — it must never be worth more than one from right now.
		age_days = max(0, (now - visit["creation"]).total_seconds() / 86400)
		scores[visit["route"]] += 0.5 ** (age_days / HALF_LIFE_DAYS)
	return scores


@frappe.whitelist()
def frequently_visited_links(limit: int = 30) -> list[dict]:
	"""Return this user's routes, most frecent first.

	Unlike the framework endpoint of the same name, these are not filtered by
	permission on the underlying report: they only ever reorder results the
	awesome bar already produced and permission-checked, so a route the user can
	no longer open simply never matches anything. Skipping the check keeps a
	report-permission query off every desk boot.
	"""
	limit = min(max(frappe.utils.cint(limit) or 1, 1), MAX_LINKS)

	# Decayed in Python rather than in SQL to stay portable across MariaDB and
	# Postgres. Move the decay into the query if boot latency ever shows up.
	visits = frappe.get_all(
		"Route History",
		fields=["route", "creation"],
		filters={"user": frappe.session.user},
		order_by="creation desc",
		limit=MAX_SAMPLED_VISITS,
	)
	scores = score_visits(visits, frappe.utils.now_datetime())

	return [{"route": route, "score": round(score, 3)} for route, score in scores.most_common(limit)]


def boot_session(bootinfo: "frappe._dict") -> None:
	"""Ship the scores with boot so the awesome bar can rank without a round trip."""
	bootinfo.awesomebar_lab_frecency = frequently_visited_links()
