#!/usr/bin/env bash
# Produces `terraform show -json` plans for every environment WITHOUT AWS access, so
# the infrastructure policy (infra/terraform/policy) can be evaluated offline and in
# CI on pull requests.
#
# How: each env is copied into a temporary workspace; an override file replaces the
# S3 backend with a local one and gives the providers FAKE credentials with every
# account/credential lookup skipped; allowed_account_ids and assume_role are stripped
# from the copy; every AWS endpoint used is pinned to a dead local address and the
# HTTP(S) proxy is pointed at a dead port, so any accidental API call fails instead of
# reaching AWS. Variables come from SYNTHETIC fixtures in infra/terraform/policy/fixtures.
#
# What this is NOT: a real-account plan. Computed values stay unknown, nothing is
# refreshed or validated by AWS, and nothing can be applied (fake credentials, local
# throwaway state). The real plan runs in .github/workflows/deploy.yml after approval.
#
# Usage: scripts/terraform-plan-offline.sh <out-dir> [env ...]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TF="${ROOT}/.tools/terraform"
RC="${ROOT}/.tools/terraformrc"
OUT="${1:?usage: terraform-plan-offline.sh <out-dir> [env ...]}"
shift || true
ENVS=("$@")
[[ ${#ENVS[@]} -gt 0 ]] || ENVS=(sandbox staging production production-dr)

[[ -x "${TF}" ]] || { echo "terraform-plan-offline: run scripts/fetch-tools.sh first" >&2; exit 1; }
[[ -f "${RC}" ]] || bash "${ROOT}/scripts/terraform-mirror.sh"

mkdir -p "${OUT}"
OUT="$(cd "${OUT}" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT

mkdir -p "${WORK}/infra"
cp -R "${ROOT}/infra/terraform" "${WORK}/infra/terraform"
[[ -d "${ROOT}/infra/stepfunctions" ]] && cp -R "${ROOT}/infra/stepfunctions" "${WORK}/infra/stepfunctions"
find "${WORK}" \( -name .terraform -o -name '*.tfstate*' -o -name tests \) -prune -exec rm -rf {} +

DEAD="http://127.0.0.1:9"
endpoint_block() {
  local svc
  echo "  endpoints {"
  for svc in acm applicationautoscaling budgets cloudwatch dynamodb ec2 ecr ecs elbv2 iam kms logs rds s3 secretsmanager sfn sns sqs sts wafv2; do
    printf '    %s = "%s"\n' "${svc}" "${DEAD}"
  done
  echo "  }"
}

provider_override() {
  local alias="$1"
  echo 'provider "aws" {'
  [[ -n "${alias}" ]] && printf '  alias = "%s"\n' "${alias}"
  cat <<'EOF'
  access_key                  = "offline-fake-access-key"
  secret_key                  = "offline-fake-secret-key"
  skip_credentials_validation = true
  skip_requesting_account_id  = true
  skip_metadata_api_check     = true
  skip_region_validation      = true
  max_retries                 = 1
EOF
  endpoint_block
  echo '}'
}

export TF_CLI_CONFIG_FILE="${RC}" TF_IN_AUTOMATION=1 TF_INPUT=0 CHECKPOINT_DISABLE=1
status=0
for env in "${ENVS[@]}"; do
  dir="${WORK}/infra/terraform/envs/${env}"
  [[ -d "${dir}" ]] || { echo "terraform-plan-offline: unknown env ${env}" >&2; exit 1; }

  # Strip account pinning and role assumption from the throwaway copy only.
  python3 -I - "${dir}/main.tf" <<'PY'
import sys
path = sys.argv[1]
out, skip, depth = [], False, 0
for line in open(path).read().split("\n"):
    s = line.strip()
    if not skip and s.startswith("allowed_account_ids"):
        continue
    if not skip and s.startswith("assume_role {"):
        skip, depth = True, 0
    if skip:
        depth += line.count("{") - line.count("${")
        depth -= line.count("}") - line.count("${")
        if depth <= 0:
            skip = False
        continue
    out.append(line)
open(path, "w").write("\n".join(out))
PY

  {
    echo 'terraform {'
    echo '  backend "local" {'
    echo '    path = "offline.tfstate"'
    echo '  }'
    echo '}'
    provider_override ""
    if grep -q 'alias *= *"audit"' "${dir}/main.tf"; then provider_override "audit"; fi
  } >"${dir}/zz_offline_override.tf"

  fixtures="${ROOT}/infra/terraform/policy/fixtures"
  log="${OUT}/${env}.plan.log"
  if ! (cd "${dir}" &&
    "${TF}" init -input=false -no-color >"${log}" 2>&1 &&
    HTTPS_PROXY="${DEAD}" HTTP_PROXY="${DEAD}" https_proxy="${DEAD}" http_proxy="${DEAD}" NO_PROXY="" no_proxy="" \
      "${TF}" plan -input=false -no-color -refresh=false -lock=false \
      -var-file="${env}.tfvars" \
      -var-file="${fixtures}/offline-common.tfvars" \
      -var-file="${fixtures}/offline-${env}.tfvars" \
      -out="${dir}/offline.tfplan" >>"${log}" 2>&1 &&
    "${TF}" show -json "${dir}/offline.tfplan" >"${OUT}/${env}.plan.json"); then
    echo "terraform-plan-offline: ${env} FAILED (see ${log})" >&2
    tail -20 "${log}" >&2
    status=1
    continue
  fi
  summary="$(grep -E '^Plan:' "${log}" || true)"
  echo "terraform-plan-offline: ${env} ${summary} -> ${OUT}/${env}.plan.json"
done
exit "${status}"
