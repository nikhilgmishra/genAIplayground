#!/usr/bin/env bash
# Fetches a pinned, SHA256-verified CI security tool into ./.tools (gitignored).
#   scripts/ci/fetch-ci-tool.sh gitleaks|trivy|cosign
# Pins (version + linux amd64 SHA256) were copied from each project's published
# checksums file for that release. Update version and hash together, in review.
# Trust note: the hashes pin what was published at review time (trust on first use);
# upstream signature verification of the checksums files (cosign/sigstore) is a
# recorded prerequisite and not performed by this script.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TOOLS="${ROOT}/.tools"
mkdir -p "${TOOLS}"

GITLEAKS_VERSION="8.30.1"
GITLEAKS_SHA256="551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb"
TRIVY_VERSION="0.72.0"
TRIVY_SHA256="bbb64b9695866ce4a7a8f5c9592002c5961cab378577fa3f8a040df362b9b2ea"
COSIGN_VERSION="3.0.4"
COSIGN_SHA256="10dab2fd2170b5aa0d5c0673a9a2793304960220b314f6a873bf39c2f08287aa"

verify() {
  local file="$1" expected="$2" actual
  actual="$(sha256sum "${file}" | awk '{print $1}')"
  if [[ "${actual}" != "${expected}" ]]; then
    echo "fetch-ci-tool: checksum mismatch for $(basename "${file}"): expected ${expected} got ${actual}" >&2
    rm -f "${file}"
    exit 1
  fi
}

tool="${1:?usage: fetch-ci-tool.sh gitleaks|trivy|cosign}"
tmp="$(mktemp -d)"
trap 'rm -rf "${tmp}"' EXIT

case "${tool}" in
  gitleaks)
    if [[ -x "${TOOLS}/gitleaks" ]] && "${TOOLS}/gitleaks" version 2>/dev/null | grep -q "${GITLEAKS_VERSION}"; then exit 0; fi
    curl -fsSL -o "${tmp}/gitleaks.tar.gz" \
      "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz"
    verify "${tmp}/gitleaks.tar.gz" "${GITLEAKS_SHA256}"
    tar -xzf "${tmp}/gitleaks.tar.gz" -C "${tmp}" gitleaks
    install -m 0755 "${tmp}/gitleaks" "${TOOLS}/gitleaks"
    ;;
  trivy)
    if [[ -x "${TOOLS}/trivy" ]] && "${TOOLS}/trivy" --version 2>/dev/null | grep -q "${TRIVY_VERSION}"; then exit 0; fi
    curl -fsSL -o "${tmp}/trivy.tar.gz" \
      "https://github.com/aquasecurity/trivy/releases/download/v${TRIVY_VERSION}/trivy_${TRIVY_VERSION}_Linux-64bit.tar.gz"
    verify "${tmp}/trivy.tar.gz" "${TRIVY_SHA256}"
    tar -xzf "${tmp}/trivy.tar.gz" -C "${tmp}" trivy
    install -m 0755 "${tmp}/trivy" "${TOOLS}/trivy"
    ;;
  cosign)
    if [[ -x "${TOOLS}/cosign" ]] && "${TOOLS}/cosign" version 2>/dev/null | grep -q "${COSIGN_VERSION}"; then exit 0; fi
    curl -fsSL -o "${tmp}/cosign" \
      "https://github.com/sigstore/cosign/releases/download/v${COSIGN_VERSION}/cosign-linux-amd64"
    verify "${tmp}/cosign" "${COSIGN_SHA256}"
    install -m 0755 "${tmp}/cosign" "${TOOLS}/cosign"
    ;;
  *)
    echo "fetch-ci-tool: unknown tool ${tool}" >&2
    exit 2
    ;;
esac
echo "fetch-ci-tool: ${tool} installed in ${TOOLS}"
