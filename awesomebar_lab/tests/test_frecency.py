# Copyright (c) 2026, Antoine Maas and contributors
# For license information, please see license.txt

from datetime import date, timedelta

import frappe
from frappe.tests import IntegrationTestCase, UnitTestCase

from awesomebar_lab.frecency import (
	TUNING_DEFAULTS,
	frequently_visited_links,
	score_visits,
	visit_key,
)

TODAY = date(2026, 7, 30)
HALF_LIFE_DAYS = TUNING_DEFAULTS["frecency_half_life_days"]


def visits(route: str, count: int, days_ago: float) -> list[dict]:
	"""One day-bucket, the shape daily_visits returns."""
	return [{"route": route, "day": TODAY - timedelta(days=days_ago), "count": count}]


class TestScoreVisits(UnitTestCase):
	def test_a_visit_halves_in_value_every_half_life(self):
		scores = score_visits(
			visits("List/Item/List", 1, 0) + visits("List/Customer/List", 1, HALF_LIFE_DAYS),
			TODAY,
			HALF_LIFE_DAYS,
		)

		self.assertAlmostEqual(scores["List/Item/List"], 1.0)
		self.assertAlmostEqual(scores["List/Customer/List"], 0.5)

	def test_recent_use_outranks_a_larger_but_stale_count(self):
		scores = score_visits(
			visits("List/Sales Invoice/List", 10, 1) + visits("List/Purchase Invoice/List", 30, 60),
			TODAY,
			HALF_LIFE_DAYS,
		)

		self.assertGreater(scores["List/Sales Invoice/List"], scores["List/Purchase Invoice/List"])

	def test_a_days_visits_are_worth_their_count(self):
		"""Buckets carry a count; scoring one as a single visit would flatten heavy days."""
		scores = score_visits(visits("List/Item/List", 7, 0), TODAY, HALF_LIFE_DAYS)

		self.assertAlmostEqual(scores["List/Item/List"], 7.0)

	def test_future_dated_visits_score_no_more_than_fresh_ones(self):
		scores = score_visits(visits("List/Item/List", 1, -2 * HALF_LIFE_DAYS), TODAY, HALF_LIFE_DAYS)

		self.assertAlmostEqual(scores["List/Item/List"], 1.0)

	def test_frequency_still_decides_between_equally_recent_routes(self):
		scores = score_visits(
			visits("List/Sales Invoice/List", 10, 3) + visits("List/Purchase Invoice/List", 2, 3),
			TODAY,
			HALF_LIFE_DAYS,
		)

		self.assertGreater(scores["List/Sales Invoice/List"], scores["List/Purchase Invoice/List"])

	def test_drafts_of_a_doctype_are_scored_as_one_destination(self):
		"""Counted raw, each draft is a singleton that never survives the boot cut."""
		scores = score_visits(
			visits("Form/Sales Invoice/new-sales-invoice-fjqbxlmzvd", 1, 0)
			+ visits("Form/Sales Invoice/new-sales-invoice-qpwoeiruty", 1, 0),
			TODAY,
			HALF_LIFE_DAYS,
		)

		self.assertEqual(list(scores), ["New/Sales Invoice"])
		self.assertAlmostEqual(scores["New/Sales Invoice"], 2.0)

	def test_a_day_read_back_as_text_is_aged_like_a_date(self):
		"""sqlite's DATE() returns a string, where the other backends return a date."""
		bucket = visits("List/Item/List", 1, HALF_LIFE_DAYS)
		bucket[0]["day"] = bucket[0]["day"].isoformat()

		scores = score_visits(bucket, TODAY, HALF_LIFE_DAYS)

		self.assertAlmostEqual(scores["List/Item/List"], 0.5)


class TestVisitKey(UnitTestCase):
	def test_a_stored_document_keeps_its_own_route(self):
		self.assertEqual(visit_key("Form/Quotation/QTN-0001"), "Form/Quotation/QTN-0001")

	def test_the_prefix_is_anchored(self):
		"""A stored document may be named anything, including something draft-shaped."""
		self.assertEqual(
			visit_key("Form/Quotation/QTN-new-quotation-0001"),
			"Form/Quotation/QTN-new-quotation-0001",
		)

	def test_the_doctype_is_matched_whole(self):
		"""Without the trailing dash `Quotation` would swallow every neighbouring doctype."""
		self.assertEqual(
			visit_key("Form/Quotation/new-quotationx-fjqbxlmzvd"),
			"Form/Quotation/new-quotationx-fjqbxlmzvd",
		)

	def test_a_two_word_doctype_is_slugged(self):
		self.assertEqual(visit_key("Form/Sales Invoice/new-sales-invoice-fjqbxlmzvd"), "New/Sales Invoice")

	def test_other_routes_pass_through_untouched(self):
		self.assertEqual(visit_key("List/Sales Invoice/List"), "List/Sales Invoice/List")
		self.assertEqual(visit_key("bank-reconciliation"), "bank-reconciliation")


class TestFrequentlyVisitedLinks(IntegrationTestCase):
	def setUp(self):
		frappe.db.delete("Route History", {"user": frappe.session.user})

	def visit(self, route: str):
		return frappe.get_doc(
			{"doctype": "Route History", "route": route, "user": frappe.session.user}
		).insert()

	def test_days_are_bucketed_on_this_backend(self):
		"""A day read back as anything but that day (sqlite's CAST returns the year) would
		age every visit by centuries and score it as nothing."""
		self.visit("List/Note/List")

		self.assertAlmostEqual(frequently_visited_links()[0]["score"], 1.0)
