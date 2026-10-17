#!/usr/bin/env bash
# Infrastructure policy gate (spec section 14) with the pinned OPA binary.
#
#   scripts/terraform-policy.sh test             opa check --strict + opa test (unit fixtures)
#   scripts/terraform-policy.sh eval <plan.json>...  gate: fail if data.vsp.terraform.deny is non-empty
#   scripts/terraform-policy.sh offline [outdir]  offline fake-credential plans of every env + gate
#
# `eval` is what .github/workflows/deploy.yml runs against the real `terraform show -json`
# plan (that path needs AWS credentials and approval and is NOT RUN locally).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OPA="${ROOT}/.tools/opa"
POLICY="${ROOT}/infra/terraform/policy"
[[ -x "${OPA}" ]] || { echo "terraform-policy: run scripts/fetch-tools.sh first" >&2; exit 1; }

cmd="${1:-test}"
shift || true

run_tests() {
  "${OPA}" fmt --fail --list "${POLICY}" >/dev/null || { echo "terraform-policy: rego not formatted (opa fmt -w ${POLICY})" >&2; exit 1; }
  "${OPA}" check --strict "${POLICY}"
  "${OPA}" test "${POLICY}" --ignore 'fixtures/*'
}

gate() {
  local status=0 plan summary violations
  for plan in "$@"; do
    [[ -f "${plan}" ]] || { echo "terraform-policy: missing plan ${plan}" >&2; exit 1; }
    summary="$("${OPA}" eval --format raw -d "${POLICY}" --ignore 'fixtures/*' -i "${plan}" 'json.marshal(data.vsp.terraform.summary)')"
    violations="$("${OPA}" eval --format raw -d "${POLICY}" --ignore 'fixtures/*' -i "${plan}" 'concat("\n", sort([m | some m in data.vsp.terraform.deny]))')"
    echo "terraform-policy: $(basename "${plan}") ${summary}"
    if [[ -n "${violations}" ]]; then
      echo "${violations}" | sed 's/^/  DENY /'
      status=1
    fi
  done
  return "${status}"
}

case "${cmd}" in
  test)
    run_tests
    ;;
  eval)
    [[ $# -gt 0 ]] || { echo "usage: terraform-policy.sh eval <plan.json>..." >&2; exit 2; }
    gate "$@"
    ;;
  offline)
    out="${1:-$(mktemp -d)}"
    bash "${ROOT}/scripts/terraform-plan-offline.sh" "${out}"
    gate "${out}"/*.plan.json
    ;;
  *)
    echo "usage: terraform-policy.sh test | eval <plan.json>... | offline [outdir]" >&2
    exit 2
    ;;
esac
