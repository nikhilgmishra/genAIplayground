#!/usr/bin/env python3
"""Illustrative capacity and cost model (specification section 12).

Every input below is a PLANNING ASSUMPTION copied from the specification's
illustrative model. None is measured company traffic, a vendor promise, a quote
or a contract term. Replace the inputs only with approved, dated evidence
(at least 30 days of half-hour arrivals, handle-time distributions, language mix,
queue mix, transfer rates, abandonment and seasonality) and record the source.

The script recomputes every figure in section 12 from the stated inputs, prints a
table and asserts the specification's rounded figures within tolerance, so the
documented numbers cannot drift from the arithmetic. It also prints an Erlang C
illustration whose only purpose is to show that the "occupancy and shrinkage"
shortcut is not a staffing plan: workforce modelling with real distributions,
abandonment and service-level targets set by support operations is required.

Usage:
    python3 scripts/capacity_model.py              # table + assertions, exit 0 on success
    python3 scripts/capacity_model.py --json       # machine-readable figures
    python3 scripts/capacity_model.py --markdown   # markdown table (embedded in docs/capacity-cost-model.md)

Standard library only. Deterministic output. No network access.
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from dataclasses import dataclass, field

# ---------------------------------------------------------------- inputs
# All values: specification section 12, "illustrative" / "planning assumptions".
INPUTS: dict[str, dict[str, object]] = {
    "calls_per_day": {"value": 25_000, "unit": "calls/day", "kind": "ASSUMED", "source": "spec 12: minimum design baseline"},
    "avg_call_minutes": {"value": 8.0, "unit": "min", "kind": "ASSUMED", "source": "spec 12: average telephone duration assumed"},
    "busy_hour_share": {"value": 0.15, "unit": "fraction of daily calls", "kind": "ASSUMED", "source": "spec 12: busiest hour holds 15 percent"},
    "concentrated_hours": {"value": 12, "unit": "h", "kind": "ASSUMED", "source": "spec 12: arrivals concentrated in 12 hours"},
    "stress_multiplier": {"value": 3.0, "unit": "x busy-hour concurrency", "kind": "ASSUMED", "source": "spec 12: threefold stress"},
    "contracted_concurrency_target": {"value": 2_000, "unit": "concurrent calls", "kind": "TARGET_TO_CONTRACT", "source": "spec 12: contracted initial capacity target incl. headroom"},
    "surge_concurrency_target": {"value": 3_000, "unit": "concurrent calls", "kind": "TARGET_TO_TEST", "source": "spec 12: separately tested surge target with controlled admission"},
    "days_per_month": {"value": 30, "unit": "days", "kind": "CONVENTION", "source": "spec 12: monthly minutes at 30 days"},
    "tool_request_interval_s": {"value": 15.0, "unit": "s per active session", "kind": "ASSUMED", "source": "spec 12: one tool request every 15 seconds"},
    "sustained_tool_test_rps": {"value": 400, "unit": "req/s", "kind": "TEST_TARGET", "source": "spec 12: test at least 400 sustained"},
    "handoff_rate_primary": {"value": 0.20, "unit": "fraction of calls", "kind": "ASSUMED", "source": "spec 12: 20 percent handoff"},
    "handoff_rate_alternative": {"value": 0.10, "unit": "fraction of calls", "kind": "ASSUMED", "source": "spec 12: 10 percent handoff"},
    "human_handle_minutes": {"value": 12.0, "unit": "min incl. wrap-up", "kind": "ASSUMED", "source": "spec 12: 12 minutes of human handling"},
    "occupancy": {"value": 0.80, "unit": "fraction", "kind": "ASSUMED", "source": "spec 12: 80 percent occupancy"},
    "shrinkage": {"value": 0.30, "unit": "fraction", "kind": "ASSUMED", "source": "spec 12: 30 percent shrinkage"},
    "cost_sensitivity_usd_per_min": {"value": [0.01, 0.02, 0.03, 0.04, 0.05], "unit": "USD/min", "kind": "SENSITIVITY", "source": "spec 12: each extra $0.01 / $0.05 per minute (not vendor quotes)"},
    "zero_failure_opportunities": {"value": 3_000, "unit": "independent opportunities", "kind": "ASSUMED", "source": "spec 14: zero failures in 3,000 opportunities"},
    "confidence": {"value": 0.95, "unit": "fraction", "kind": "CONVENTION", "source": "spec 14: rough 95 percent upper bound"},
}


def v(name: str) -> float:
    value = INPUTS[name]["value"]
    assert isinstance(value, (int, float)), name
    return float(value)


# ---------------------------------------------------------------- erlang c
def erlang_c_wait_probability(agents: int, offered_erlangs: float) -> float:
    """Probability an arrival waits (Erlang C). Requires agents > offered load.

    Idealised M/M/N: Poisson arrivals, exponential handle times, no abandonment,
    no retrials, infinite patience, stationary load. Real contact centres violate
    every one of these, which is why workforce modelling is required.
    """
    if agents <= offered_erlangs:
        return 1.0
    # Numerically stable iterative Erlang B, then convert to Erlang C.
    inv_b = 1.0
    for k in range(1, agents + 1):
        inv_b = 1.0 + inv_b * k / offered_erlangs
    erlang_b = 1.0 / inv_b
    rho = offered_erlangs / agents
    return erlang_b / (1.0 - rho + rho * erlang_b)


# ---------------------------------------------------------------- model
@dataclass
class Figure:
    key: str
    label: str
    value: float
    unit: str
    formula: str
    spec_figure: float | None = None
    tolerance: float = 0.0
    kind: str = "DERIVED"
    notes: str = ""


@dataclass
class Model:
    figures: list[Figure] = field(default_factory=list)

    def add(self, fig: Figure) -> float:
        self.figures.append(fig)
        return fig.value


def build() -> Model:
    m = Model()
    calls = v("calls_per_day")
    aht = v("avg_call_minutes")

    daily_minutes = m.add(Figure("daily_minutes", "Daily telephone minutes", calls * aht, "min/day", "calls_per_day * avg_call_minutes", 200_000, 0.5))
    m.add(Figure("avg_concurrency_24h", "Average simultaneous calls over 24 h", daily_minutes / (24 * 60), "calls", "daily_minutes / 1440", 139, 0.5))
    m.add(Figure("avg_concurrency_12h", "Average simultaneous calls if arrivals concentrate in 12 h", daily_minutes / (v("concentrated_hours") * 60), "calls", "daily_minutes / (12 * 60)", 278, 0.5))
    busy_arrivals = m.add(Figure("busy_hour_arrivals", "Busy-hour arrivals (15 % of daily calls)", calls * v("busy_hour_share"), "calls/h", "calls_per_day * busy_hour_share", 3_750, 0.5))
    busy_conc = m.add(Figure("busy_hour_concurrency", "Busy-hour concurrency (Little's law, 8 min)", busy_arrivals * aht / 60, "calls", "busy_hour_arrivals * avg_call_minutes / 60", 500, 0.5))
    stress = m.add(Figure("stress_concurrency", "Threefold stress over busy-hour concurrency", busy_conc * v("stress_multiplier"), "calls", "busy_hour_concurrency * 3", 1_500, 0.5))
    contracted = m.add(Figure("contracted_target", "Contracted initial capacity target incl. headroom", v("contracted_concurrency_target"), "calls", "input (target to contract, not a vendor promise)", 2_000, 0.0, "INPUT"))
    m.add(Figure("contracted_headroom_over_stress", "Headroom of contracted target over stress", contracted / stress, "x", "contracted_target / stress_concurrency", None, 0.0, "DERIVED", "about 1.33x over stress, 4x over busy hour"))
    m.add(Figure("surge_target", "Separately tested surge target (controlled admission)", v("surge_concurrency_target"), "calls", "input (test target)", 3_000, 0.0, "INPUT"))
    m.add(Figure("monthly_minutes", "Monthly minutes at 30 days", daily_minutes * v("days_per_month"), "min/month", "daily_minutes * 30", 6_000_000, 0.5))
    tool_rps = m.add(Figure("tool_rps_at_contracted", "Average gateway tool requests at 2,000 sessions", contracted / v("tool_request_interval_s"), "req/s", "contracted_target / 15 s", 133, 0.5))
    sustained = m.add(Figure("sustained_tool_test_rps", "Sustained tool test target (minimum)", v("sustained_tool_test_rps"), "req/s", "input (test at least this; plus larger bounded bursts)", 400, 0.0, "INPUT"))
    m.add(Figure("sustained_over_average", "Sustained test over average tool load", sustained / tool_rps, "x", "sustained_tool_test_rps / tool_rps_at_contracted", None, 0.0, "DERIVED", "must be >= 3x average"))
    m.add(Figure("call_starts_per_s", "Call starts at 2,000 occupied slots, one call per 8 min per slot", contracted / (aht * 60), "starts/s", "contracted_target / (avg_call_minutes * 60)", 4.17, 0.005))

    # Human capacity (spec 12 "Human capacity and graceful degradation").
    handle = v("human_handle_minutes")
    occ = v("occupancy")
    shrink = v("shrinkage")
    for label, rate_key, spec_arrivals, spec_busy, spec_sched in (
        ("20 % handoff", "handoff_rate_primary", 750, 150, 268),
        ("10 % handoff", "handoff_rate_alternative", 375, 75, 134),
    ):
        tag = "20" if rate_key.endswith("primary") else "10"
        arrivals = m.add(Figure(f"human_arrivals_{tag}", f"Human arrivals per busy hour at {label}", busy_arrivals * v(rate_key), "calls/h", f"busy_hour_arrivals * {v(rate_key):.2f}", spec_arrivals, 0.5))
        busy_agents = m.add(Figure(f"busy_agents_{tag}", f"Continuously busy agents at {label} (12 min)", arrivals * handle / 60, "agents", "human_arrivals * human_handle_minutes / 60", spec_busy, 0.5))
        m.add(Figure(f"scheduled_agents_{tag}", f"Scheduled agents at {label} (80 % occupancy, 30 % shrinkage)", busy_agents / occ / (1 - shrink), "agents", "busy_agents / occupancy / (1 - shrinkage)", spec_sched, 0.5))

    # Derived illustration: sudden 100 % AI outage at the same busy hour (not a spec figure).
    outage_busy = m.add(Figure("busy_agents_ai_outage", "Continuously busy agents if 100 % of busy-hour calls need humans", busy_arrivals * handle / 60, "agents", "busy_hour_arrivals * human_handle_minutes / 60", None, 0.0, "DERIVED_ILLUSTRATION", "a small residual queue cannot absorb a sudden 100 % AI outage"))
    m.add(Figure("scheduled_agents_ai_outage", "Scheduled agents implied by a 100 % AI outage (same shortcut)", outage_busy / occ / (1 - shrink), "agents", "busy_agents_ai_outage / occupancy / (1 - shrinkage)", None, 0.0, "DERIVED_ILLUSTRATION", "illustrates why outage service mode prioritises safety queues"))

    # Cost sensitivity (spec 12 "Cost controls"); not vendor quotes.
    monthly = daily_minutes * v("days_per_month")
    sens = INPUTS["cost_sensitivity_usd_per_min"]["value"]
    assert isinstance(sens, list)
    for delta in sens:
        spec_val = {0.01: 60_000, 0.05: 300_000}.get(delta)
        m.add(Figure(f"cost_delta_{int(round(delta * 100)):02d}c", f"Monthly cost of an extra ${delta:.2f}/min", monthly * delta, "USD/month", f"monthly_minutes * {delta:.2f}", spec_val, 0.5 if spec_val else 0.0, "SENSITIVITY"))

    # Statistical bound (spec 14): zero failures in n opportunities.
    n = v("zero_failure_opportunities")
    conf = v("confidence")
    m.add(Figure("zero_failure_upper_bound", "95 % upper bound on failure rate after 0 failures in 3,000", 1 - (1 - conf) ** (1 / n), "fraction", "1 - 0.05^(1/n)  (~ 3/n, rule of three)", 0.001, 0.00001, "DERIVED", "not proof of perfection"))
    return m


def erlang_illustration(model: Model) -> list[dict[str, float | int | str]]:
    """Erlang C at the 'occupancy shortcut' head-count. Illustration only."""
    rows: list[dict[str, float | int | str]] = []
    figs = {f.key: f.value for f in model.figures}
    for tag in ("20", "10"):
        offered = figs[f"busy_agents_{tag}"]  # Erlangs = arrival rate * handle time
        agents_on_phones = math.ceil(offered / v("occupancy"))
        rows.append(
            {
                "handoff": f"{tag} %",
                "offered_erlangs": round(offered, 2),
                "agents_on_phones": agents_on_phones,
                "p_wait_erlang_c": round(erlang_c_wait_probability(agents_on_phones, offered), 4),
                "note": "idealised M/M/N; service-level target UNKNOWN (support operations)",
            }
        )
    return rows


def check(model: Model) -> list[str]:
    failures: list[str] = []
    for f in model.figures:
        if f.spec_figure is None:
            continue
        if abs(f.value - f.spec_figure) > f.tolerance:
            failures.append(f"{f.key}: computed {f.value} differs from spec {f.spec_figure} by more than {f.tolerance}")
    figs = {f.key: f.value for f in model.figures}
    if figs["sustained_over_average"] < 3.0 - 1e-9:
        failures.append("sustained tool test target must be at least 3x the average tool load")
    if figs["contracted_target"] < figs["stress_concurrency"]:
        failures.append("contracted target must not be below the stress concurrency")
    if figs["surge_target"] <= figs["contracted_target"]:
        failures.append("surge target must exceed the contracted target")
    return failures


def fmt(value: float, unit: str) -> str:
    if unit == "fraction":
        return f"{value * 100:.4f} %"
    if unit == "x":
        return f"{value:.2f}x"
    if unit.startswith("USD"):
        return f"${value:,.0f}"
    if abs(value - round(value)) < 1e-9:
        return f"{value:,.0f}"
    return f"{value:,.2f}"


def spec_str(f: Figure) -> str:
    if f.spec_figure is None:
        return "-"
    return fmt(f.spec_figure, f.unit)


def render_text(model: Model, erlang: list[dict[str, float | int | str]]) -> str:
    out = ["ILLUSTRATIVE CAPACITY AND COST MODEL (spec section 12) - planning assumptions, not measurements or quotes", ""]
    out.append(f"{'figure':<34} {'computed':>16} {'spec':>14}  unit")
    out.append("-" * 90)
    for f in model.figures:
        out.append(f"{f.key:<34} {fmt(f.value, f.unit):>16} {spec_str(f):>14}  {f.unit}")
    out.append("")
    out.append("Erlang C illustration (NOT a staffing plan; workforce modelling required):")
    for r in erlang:
        out.append(f"  handoff {r['handoff']}: offered {r['offered_erlangs']} Erlangs, {r['agents_on_phones']} agents on phones -> P(wait) {r['p_wait_erlang_c']} ({r['note']})")
    return "\n".join(out)


def render_markdown(model: Model, erlang: list[dict[str, float | int | str]]) -> str:
    out = [
        "| Figure | Computed | Spec figure | Unit | Formula | Kind |",
        "|---|---:|---:|---|---|---|",
    ]
    for f in model.figures:
        note = f" ({f.notes})" if f.notes else ""
        out.append(f"| {f.label}{note} | {fmt(f.value, f.unit)} | {spec_str(f)} | {f.unit} | `{f.formula}` | {f.kind} |")
    out.append("")
    out.append("| Handoff | Offered load (Erlangs) | Agents on phones at 80 % occupancy | Erlang C P(wait) | Note |")
    out.append("|---|---:|---:|---:|---|")
    for r in erlang:
        out.append(f"| {r['handoff']} | {r['offered_erlangs']} | {r['agents_on_phones']} | {r['p_wait_erlang_c']} | {r['note']} |")
    return "\n".join(out)


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--json", action="store_true", help="print figures as JSON")
    group.add_argument("--markdown", action="store_true", help="print markdown tables")
    args = parser.parse_args(argv)

    model = build()
    erlang = erlang_illustration(model)
    failures = check(model)

    if args.json:
        payload = {
            "status": "ILLUSTRATIVE_PLANNING_ASSUMPTIONS",
            "inputs": INPUTS,
            "figures": [f.__dict__ for f in model.figures],
            "erlangIllustration": erlang,
            "checks": {"passed": not failures, "failures": failures},
        }
        print(json.dumps(payload, indent=2, sort_keys=True))
    elif args.markdown:
        print(render_markdown(model, erlang))
    else:
        print(render_text(model, erlang))
        print("")
        print("checks:", "PASS (all spec section 12 figures reproduced within tolerance)" if not failures else "FAIL")

    for failure in failures:
        print(f"CHECK FAILED: {failure}", file=sys.stderr)
    return 0 if not failures else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
