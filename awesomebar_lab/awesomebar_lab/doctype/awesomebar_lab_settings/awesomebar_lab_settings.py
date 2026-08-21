# Copyright (c) 2026, Antoine Maas and contributors
# For license information, please see license.txt

import frappe
from frappe.model.document import Document


class AwesomebarLabSettings(Document):
	# begin: auto-generated types
	# This code is auto-generated. Do not modify anything in this block.

	from typing import TYPE_CHECKING

	if TYPE_CHECKING:
		from frappe.types import DF

		boot_link_limit: DF.Int
		frecency_band: DF.Float
		frecency_half_life_days: DF.Float
		memory_half_life_days: DF.Float
		memory_min_confidence: DF.Float
	# end: auto-generated types

	def on_update(self):
		# These values ride along with the boot payload, which is cached per user until
		# the session cache is dropped. Without this a change would only reach whoever
		# logs in next.
		frappe.clear_cache()
