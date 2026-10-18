#!/usr/bin/env bash
# Secret scanning with a pinned, checksum-verified gitleaks (spec section 14).
#   scripts/ci/gitleaks.sh [git|dir] [report.sarif]
#     git  (default in CI): scans the git history reachable from HEAD
#     dir: scans the working tree (useful before committing)
# Findings are redacted in output (--redact) so a detected secret is not re-leaked
# into CI logs. Configuration: .github/gitleaks.toml (default rules + a narrow
# allowlist for SYNTHETIC fixtures only).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
bash "${ROOT}/scripts/ci/fetch-ci-tool.sh" gitleaks >/dev/null
GITLEAKS="${ROOT}/.tools/gitleaks"
CONFIG="${ROOT}/.github/gitleaks.toml"
mode="${1:-git}"
report="${2:-}"

args=(--config "${CONFIG}" --redact --no-banner --exit-code 1)
if [[ -n "${report}" ]]; then
  mkdir -p "$(dirname "${report}")"
  args+=(--report-format sarif --report-path "${report}")
fi

case "${mode}" in
  git) "${GITLEAKS}" git "${args[@]}" "${ROOT}" ;;
  dir) "${GITLEAKS}" dir "${args[@]}" "${ROOT}" ;;
  *)
    echo "usage: gitleaks.sh [git|dir] [report.sarif]" >&2
    exit 2
    ;;
esac
