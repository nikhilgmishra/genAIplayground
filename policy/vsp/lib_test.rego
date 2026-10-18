package vsp.lib_test

import data.vsp.lib

# Reference values computed with JavaScript Date.parse for the same instants.
test_ts_ms_epoch if lib.ts_ms("1970-01-01T00:00:00.000Z") == 0

test_ts_ms_reference_instant if lib.ts_ms("2026-10-17T15:00:00.000Z") == 1792249200000

test_ts_ms_leading_zeros if lib.ts_ms("2026-01-09T08:09:01.007Z") == 1767946141007

test_ts_ms_leap_day if lib.ts_ms("2028-02-29T00:00:00.000Z") == 1835395200000

test_ts_ms_end_of_year if lib.ts_ms("2026-12-31T23:59:59.999Z") == 1798761599999

test_ts_ms_millisecond_ordering if {
	lib.ts_ms("2026-10-17T15:00:00.001Z") - lib.ts_ms("2026-10-17T15:00:00.000Z") == 1
	lib.before("2026-10-17T14:59:59.999Z", "2026-10-17T15:00:00.000Z")
	not lib.before("2026-10-17T15:00:00.000Z", "2026-10-17T15:00:00.000Z")
}

# Non-canonical forms are undefined so callers fail closed.
test_ts_ms_rejects_missing_millis if not lib.ts_ms("2026-10-17T15:00:00Z")

test_ts_ms_rejects_offset if not lib.ts_ms("2026-10-17T15:00:00.000+00:00")

test_ts_ms_rejects_micros if not lib.ts_ms("2026-10-17T15:00:00.000000Z")

test_ts_ms_rejects_month_13 if not lib.ts_ms("2026-13-17T15:00:00.000Z")

test_ts_ms_rejects_hour_24 if not lib.ts_ms("2026-10-17T24:00:00.000Z")

test_ts_ms_rejects_non_string if {
	not lib.ts_ms(1792249200000)
	not lib.ts_ms(null)
}

test_before_undefined_for_garbage if not lib.before("garbage", "2026-10-17T15:00:00.000Z")

test_string_set_filters_non_strings if lib.string_set(["a", 1, "b", null]) == {"a", "b"}

test_string_set_non_collection_is_empty if lib.string_set("abc") == set()

test_assurance_rank_order if {
	lib.assurance_rank.A0 < lib.assurance_rank.A1
	lib.assurance_rank.A1 < lib.assurance_rank.A2
	lib.assurance_rank.A2 < lib.assurance_rank.A3
}
