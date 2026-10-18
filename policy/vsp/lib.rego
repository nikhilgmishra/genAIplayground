# METADATA
# title: Shared helpers for the voice-support policy bundle
# description: |
#   Deterministic, WebAssembly-safe helpers. time.parse_rfc3339_ns is not
#   implemented by the opa-wasm SDK, so timestamps are parsed in pure Rego.
#   Only the canonical form YYYY-MM-DDTHH:MM:SS.sssZ (what the TypeScript
#   engine normalizes every PolicyInput timestamp to) is accepted; anything
#   else is undefined, and every caller treats undefined as "not valid"
#   (fail closed).
package vsp.lib

canonical_timestamp := `^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$`

assurance_rank := {"A0": 0, "A1": 1, "A2": 2, "A3": 3}

# Days since 1970-01-01 for a proleptic Gregorian date (H. Hinnant's
# days_from_civil). Valid for years 0000-9999, which the regex enforces.
days_from_civil(y, m, d) := days if {
	yy := y - to_number(m <= 2)
	era := floor(yy / 400)
	yoe := yy - (era * 400)
	mp := (m + 9) % 12
	doy := (floor(((153 * mp) + 2) / 5) + d) - 1
	doe := (((yoe * 365) + floor(yoe / 4)) - floor(yoe / 100)) + doy
	days := ((era * 146097) + doe) - 719468
}

# Epoch milliseconds of a canonical UTC timestamp; undefined otherwise.
ts_ms(s) := ms if {
	is_string(s)
	regex.match(canonical_timestamp, s)
	y := to_number(substring(s, 0, 4))
	mo := to_number(substring(s, 5, 2))
	d := to_number(substring(s, 8, 2))
	h := to_number(substring(s, 11, 2))
	mi := to_number(substring(s, 14, 2))
	sec := to_number(substring(s, 17, 2))
	frac := to_number(substring(s, 20, 3))
	mo >= 1
	mo <= 12
	d >= 1
	d <= 31
	h <= 23
	mi <= 59
	sec <= 59
	secs := (((days_from_civil(y, mo, d) * 86400) + (h * 3600)) + (mi * 60)) + sec
	ms := (secs * 1000) + frac
}

# True only when both timestamps parse and a is strictly before b.
before(a, b) if ts_ms(a) < ts_ms(b)

# Set of strings from an array or set; empty for anything else.
string_set(xs) := {x | some x in xs; is_string(x)} if is_array(xs)

string_set(xs) := {x | some x in xs; is_string(x)} if is_set(xs)

string_set(xs) := set() if {
	not is_array(xs)
	not is_set(xs)
}
