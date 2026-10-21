#!/usr/bin/env bash
# Authorization policy bundle: tests and WebAssembly build with the pinned OPA.
#
#   scripts/policy.sh test      opa fmt check + opa check --strict (WASM capabilities) + opa test -v
#   scripts/policy.sh build     compile policy/vsp to a WASM bundle in policy/build (skips when fresh)
#   scripts/policy.sh rebuild   build even when policy/build is fresh
#   scripts/policy.sh digest    print the sources digest (what policy/build/sources.sha256 must hold)
#   scripts/policy.sh coverage  opa test --coverage and print the overall percentage
#
# Build outputs (policy/build is gitignored):
#   bundle.tar.gz   opa build -t wasm, entrypoints vsp/authz/decision and vsp/console/decision,
#                   revision = policy/VERSION, test files excluded
#   policy.wasm, data.json, .manifest   extracted from the bundle for inspection
#   bundle.sha256   sha256 of bundle.tar.gz (pinned as bundleDigest in the ReleaseManifest)
#   sources.sha256  digest over VERSION, wasm-capabilities.json and the non-test bundle sources;
#                   platform/src/policy/ensure-bundle.ts rebuilds when it is stale
#
# The capabilities file restricts compilation to builtins the opa-wasm SDK implements
# (time.parse_rfc3339_ns is NOT one of them; see policy/vsp/lib.rego).
# A successful build is not a policy release: releases need the POLICY_RELEASE
# approval (PRQ-031, docs/RUNBOOKS/policy-release.md).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OPA="${OPA_BIN:-${ROOT}/.tools/opa}"
OPA_VERSION="1.21.0"
POLICY_DIR="${ROOT}/policy"
BUILD_DIR="${POLICY_DIR}/build"
CAPABILITIES="wasm-capabilities.json"
ENTRYPOINTS=(vsp/authz/decision vsp/console/decision)

die() {
  echo "policy: $*" >&2
  exit 1
}

require_opa() {
  [[ -x "${OPA}" ]] || die "pinned OPA not found at ${OPA}; run bash scripts/fetch-tools.sh"
  local reported
  reported="$("${OPA}" version)"
  # Compare captured output (grep -q on a live pipe can SIGPIPE under pipefail).
  [[ "${reported}" == *$'\n'"Version: ${OPA_VERSION}"$'\n'* || "${reported}" == "Version: ${OPA_VERSION}"$'\n'* ]] ||
    die "OPA ${OPA_VERSION} required (got: ${reported%%$'\n'*})"
}

read_version() {
  local v
  v="$(tr -d '[:space:]' <"${POLICY_DIR}/VERSION")"
  [[ "${v}" =~ ^[0-9]{4}\.[0-9]{2}\.[0-9]{2}-[0-9]+$ ]] || die "policy/VERSION must look like YYYY.MM.DD-N (got '${v}')"
  printf '%s' "${v}"
}

# Files that determine the built bundle, relative to policy/, in byte order.
source_files() {
  (
    cd "${POLICY_DIR}"
    {
      printf '%s\n' VERSION "${CAPABILITIES}"
      find vsp -type f \( -name '*.rego' -o -name '*.json' \) ! -name '*_test.rego'
    } | LC_ALL=C sort
  )
}

sources_digest() {
  (
    cd "${POLICY_DIR}"
    source_files | while IFS= read -r f; do sha256sum "${f}"; done
  ) | sha256sum | cut -d' ' -f1
}

is_fresh() {
  [[ -f "${BUILD_DIR}/sources.sha256" && -f "${BUILD_DIR}/bundle.tar.gz" && -f "${BUILD_DIR}/bundle.sha256" ]] || return 1
  [[ "$(tr -d '[:space:]' <"${BUILD_DIR}/sources.sha256")" == "$(sources_digest)" ]] || return 1
  (cd "${BUILD_DIR}" && sha256sum --check --status bundle.sha256)
}

cmd_test() {
  require_opa
  cd "${POLICY_DIR}"
  local unformatted
  unformatted="$("${OPA}" fmt --list vsp)"
  if [[ -n "${unformatted}" ]]; then
    "${OPA}" fmt --diff vsp >&2 || true
    die "Rego not formatted (run: ${OPA} fmt -w policy/vsp): ${unformatted}"
  fi
  "${OPA}" check --strict --capabilities "${CAPABILITIES}" vsp
  # An explicit per-test deadline (as scripts/terraform-policy.sh has): OPA's default of 5 s was hit once by a
  # role-matrix test on a loaded 4-CPU runner. The slowest test (the data-driven console read role-set table,
  # policy/vsp/console_test.rego) takes about 3 s; the deadline leaves a wide margin on a loaded runner.
  "${OPA}" test -v --timeout 60s vsp
}

cmd_coverage() {
  require_opa
  cd "${POLICY_DIR}"
  "${OPA}" test --coverage --timeout 60s --format=json vsp | node -e '
    let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      const r = JSON.parse(s);
      const files = Object.entries(r.files || {}).filter(([f]) => !f.endsWith("_test.rego"));
      for (const [f, v] of files) process.stdout.write(`${f} ${(v.coverage ?? 0).toFixed(1)}%\n`);
      process.stdout.write(`overall ${(r.coverage ?? 0).toFixed(1)}%\n`);
    });'
}

do_build() {
  require_opa
  local version tmp
  version="$(read_version)"
  mkdir -p "${BUILD_DIR}"
  tmp="$(mktemp -d "${BUILD_DIR}/.tmp.XXXXXX")"
  BUILD_TMP="${tmp}"
  trap 'rm -rf "${BUILD_TMP:-}"' EXIT
  (
    cd "${POLICY_DIR}"
    args=(build -t wasm --capabilities "${CAPABILITIES}" --revision "${version}" --ignore '*_test.rego')
    for e in "${ENTRYPOINTS[@]}"; do args+=(-e "${e}"); done
    "${OPA}" "${args[@]}" vsp -o "${tmp}/bundle.tar.gz"
  )
  mkdir -p "${tmp}/extract"
  tar -xzf "${tmp}/bundle.tar.gz" -C "${tmp}/extract" 2>/dev/null
  for f in policy.wasm data.json .manifest; do
    [[ -f "${tmp}/extract/${f}" ]] || die "bundle is missing /${f}"
  done
  grep -q "\"revision\":\"${version}\"" "${tmp}/extract/.manifest" || die "bundle manifest revision does not match policy/VERSION"
  for e in "${ENTRYPOINTS[@]}"; do
    grep -q "\"entrypoint\":\"${e}\"" "${tmp}/extract/.manifest" || die "bundle manifest is missing entrypoint ${e}"
  done
  (cd "${tmp}" && sha256sum bundle.tar.gz >bundle.sha256)
  sources_digest >"${tmp}/sources.sha256"
  # Replace outputs file by file (each rename is atomic); sources.sha256 last marks completion.
  rm -f "${BUILD_DIR}/sources.sha256"
  mv -f "${tmp}/bundle.tar.gz" "${BUILD_DIR}/bundle.tar.gz"
  mv -f "${tmp}/bundle.sha256" "${BUILD_DIR}/bundle.sha256"
  for f in policy.wasm data.json .manifest; do mv -f "${tmp}/extract/${f}" "${BUILD_DIR}/${f}"; done
  mv -f "${tmp}/sources.sha256" "${BUILD_DIR}/sources.sha256"
  echo "policy: built revision ${version} bundle sha256 $(cut -d' ' -f1 "${BUILD_DIR}/bundle.sha256")"
}

with_lock() {
  mkdir -p "${BUILD_DIR}"
  exec 9>"${BUILD_DIR}/.lock"
  flock -w 300 9 || die "timed out waiting for the build lock"
  "$@"
}

cmd_build() {
  if is_fresh; then
    echo "policy: build is fresh (sources $(sources_digest))"
    return 0
  fi
  do_build
}

cmd="${1:-test}"
case "${cmd}" in
  test) cmd_test ;;
  coverage) cmd_coverage ;;
  build) with_lock cmd_build ;;
  rebuild) with_lock do_build ;;
  digest) sources_digest ;;
  *) die "usage: scripts/policy.sh test|build|rebuild|digest|coverage" ;;
esac
