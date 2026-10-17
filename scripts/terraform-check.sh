#!/usr/bin/env bash
# Offline Terraform quality gate for every module and environment:
#   fmt -check  ->  init -backend=false (provider from the verified mirror)  ->
#   validate    ->  terraform test (mock providers, command = plan)
#
# Nothing is planned against AWS and nothing is applied. Modules that declare
# configuration_aliases (audit, stack) cannot be validated standalone by Terraform
# (it reports a missing aliased provider); they are validated by their own
# `terraform test` suites, which supply mock aliased providers, and through the
# environment roots that pass real provider aliases.
#
# Usage: scripts/terraform-check.sh [--report <file>]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TF="${ROOT}/.tools/terraform"
RC="${ROOT}/.tools/terraformrc"
TFROOT="${ROOT}/infra/terraform"
REPORT=""
if [[ "${1:-}" == "--report" ]]; then
  REPORT="${2:?--report needs a file}"
fi

[[ -x "${TF}" ]] || { echo "terraform-check: ${TF} missing; run scripts/fetch-tools.sh" >&2; exit 1; }
[[ -f "${RC}" ]] || bash "${ROOT}/scripts/terraform-mirror.sh"

export TF_CLI_CONFIG_FILE="${RC}" TF_IN_AUTOMATION=1 TF_INPUT=0 CHECKPOINT_DISABLE=1

log="$(mktemp)"
trap 'rm -f "${log}"' EXIT
results=()
failures=0

record() {
  results+=("$1")
  echo "$1"
}

"${TF}" version | head -1
if "${TF}" fmt -recursive -check -diff "${TFROOT}" >"${log}" 2>&1; then
  record "PASS fmt infra/terraform"
else
  cat "${log}"
  record "FAIL fmt infra/terraform"
  failures=$((failures + 1))
fi

for dir in "${TFROOT}"/modules/*/ "${TFROOT}"/envs/*/; do
  dir="${dir%/}"
  rel="${dir#"${ROOT}/"}"

  lockflag=()
  [[ -f "${dir}/.terraform.lock.hcl" ]] && lockflag=(-lockfile=readonly)
  if ! "${TF}" -chdir="${dir}" init -backend=false -input=false -no-color "${lockflag[@]}" >"${log}" 2>&1; then
    cat "${log}"
    record "FAIL init ${rel}"
    failures=$((failures + 1))
    continue
  fi

  if grep -q "configuration_aliases" "${dir}"/*.tf; then
    record "SKIP validate ${rel} (configuration_aliases: validated by its terraform test and env roots)"
  elif "${TF}" -chdir="${dir}" validate -no-color >"${log}" 2>&1; then
    record "PASS validate ${rel}"
  else
    cat "${log}"
    record "FAIL validate ${rel}"
    failures=$((failures + 1))
  fi

  if ! compgen -G "${dir}/tests/*.tftest.hcl" >/dev/null; then
    record "FAIL test ${rel} (no tests/*.tftest.hcl: every module and env must carry plan tests)"
    failures=$((failures + 1))
    continue
  fi
  if "${TF}" -chdir="${dir}" test -no-color >"${log}" 2>&1; then
    record "PASS test ${rel} ($(grep -Eo '[0-9]+ passed, [0-9]+ failed' "${log}" | tail -1))"
  else
    cat "${log}"
    record "FAIL test ${rel}"
    failures=$((failures + 1))
  fi
done

if [[ -n "${REPORT}" ]]; then
  mkdir -p "$(dirname "${REPORT}")"
  {
    echo "# terraform-check (offline: mock providers, plan only; nothing applied)"
    echo "terraform: $("${TF}" version | head -1)"
    echo "generated: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    printf '%s\n' "${results[@]}"
    echo "failures: ${failures}"
  } >"${REPORT}"
fi

if [[ "${failures}" -gt 0 ]]; then
  echo "terraform-check: ${failures} failure(s)" >&2
  exit 1
fi
echo "terraform-check: all checks passed"
