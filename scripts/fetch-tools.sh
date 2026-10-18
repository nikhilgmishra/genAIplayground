#!/usr/bin/env bash
# Fetches pinned, checksum-verified developer tools into ./.tools (gitignored).
# Versions are pinned here and recorded in docs/INVENTORY.md. Update both together.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TOOLS="${ROOT}/.tools"
mkdir -p "${TOOLS}"

OPA_VERSION="1.21.0"
OPA_SHA256="5eef70644868bb04d0556bcc795ee42f2ab379e73f51d1bfa30f83e1305bc9b9"
TERRAFORM_VERSION="1.16.4"
TERRAFORM_SHA256="dc94af0eef1147718ad7c8daea792ed199e3e0492eec180d0adafa2a65a879df"

verify() {
  local file="$1" expected="$2"
  local actual
  actual="$(sha256sum "${file}" | awk '{print $1}')"
  if [[ "${actual}" != "${expected}" ]]; then
    echo "checksum mismatch for ${file}: expected ${expected} got ${actual}" >&2
    rm -f "${file}"
    exit 1
  fi
}

# Capture tool output before matching: piping into `grep -q`/`head` can SIGPIPE the
# producer, which `set -o pipefail` turns into a spurious failure (exit 141).
version_of() { "$@" 2>/dev/null || true; }

if [[ ! -x "${TOOLS}/opa" ]] || [[ "$(version_of "${TOOLS}/opa" version)" != *"Version: ${OPA_VERSION}"* ]]; then
  curl -fsSL -o "${TOOLS}/opa" \
    "https://github.com/open-policy-agent/opa/releases/download/v${OPA_VERSION}/opa_linux_amd64_static"
  verify "${TOOLS}/opa" "${OPA_SHA256}"
  chmod +x "${TOOLS}/opa"
fi

if [[ ! -x "${TOOLS}/terraform" ]] || [[ "$(version_of "${TOOLS}/terraform" version)" != *"v${TERRAFORM_VERSION}"* ]]; then
  tmp="$(mktemp -d)"
  curl -fsSL -o "${tmp}/tf.zip" \
    "https://releases.hashicorp.com/terraform/${TERRAFORM_VERSION}/terraform_${TERRAFORM_VERSION}_linux_amd64.zip"
  verify "${tmp}/tf.zip" "${TERRAFORM_SHA256}"
  unzip -o -q "${tmp}/tf.zip" terraform -d "${TOOLS}"
  rm -rf "${tmp}"
fi

opa_version="$("${TOOLS}/opa" version)"
terraform_version="$("${TOOLS}/terraform" version)"
echo "${opa_version%%$'\n'*}"
echo "${terraform_version%%$'\n'*}"
