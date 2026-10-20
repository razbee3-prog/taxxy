"""Generate Tier 1 oracle values from PolicyEngine US for tax year 2026.

Run:  uv run --python ~/pe/.venv/bin/python packages/engine/scripts/policyengine_oracle.py
Writes test/fixtures/policyengine-2026.json. Re-run (and review the diff) whenever constants change.
"""
import json, sys, pathlib
from policyengine_us import Simulation
from importlib.metadata import version as _v

YEAR = 2026
PROFITS = [5_000, 25_000, 60_000, 120_000, 190_000, 260_000]
WAGES = [0, 50_000]
EDGE = [(300, 0), (1_500, 0), (20_000, 0), (170_000, 50_000), (210_000, 0)]
VARS = [
    "self_employment_tax", "additional_medicare_tax", "self_employment_tax_ald",
    "adjusted_gross_income", "standard_deduction", "qualified_business_income_deduction",
    "taxable_income", "income_tax_main_rates", "income_tax_before_credits",
]

def run(profit, wages):
    sim = Simulation(situation={
        "people": {"you": {"age": {YEAR: 40}, "self_employment_income": {YEAR: profit},
                           "employment_income": {YEAR: wages}}},
        "tax_units": {"tu": {"members": ["you"]}},
        "families": {"f": {"members": ["you"]}},
        "spm_units": {"s": {"members": ["you"]}},
        "marital_units": {"m": {"members": ["you"]}},
        "households": {"h": {"members": ["you"], "state_name": {YEAR: "TX"}}},
    })
    out = {"netProfit": profit, "w2Wages": wages}
    for v in VARS:
        out[v] = round(float(sim.calculate(v, YEAR).sum()), 2)
    return out

cases = [run(p, w) for p in PROFITS for w in WAGES] + [run(p, w) for p, w in EDGE]
doc = {"source": f"policyengine-us {_v("policyengine-us")}", "taxYear": YEAR,
       "filingStatus": "SINGLE", "state": "TX", "cases": cases}
dest = pathlib.Path(__file__).resolve().parents[1] / "test" / "fixtures" / "policyengine-2026.json"
dest.write_text(json.dumps(doc, indent=2) + "\n")
print(f"wrote {len(cases)} cases to {dest}")
for c in cases[:3]: print(c)
