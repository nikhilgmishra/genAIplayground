#!/usr/bin/env bash
# One-shot import of the SYNTHETIC local realms (WP-05) into the composition's Keycloak through its admin
# API (kcadm.sh, HTTPS with the checkout's local CA). Runs as the `keycloak-realm-import` service of
# deploy/local/services/keycloak-realm.compose.yaml (profile `identity-realms`):
#
#   make up PROFILE=core,identity-realms
#
# Existing realms are left untouched (idempotent; never a reconfiguration of a realm someone else uses).
# Templates carry placeholders only; the values come from the generated local state file (/state/env):
#   __VSP_SYNTH_PASSWORD__       password of every synthetic user      (VSP_KEYCLOAK_SYNTH_PASSWORD)
#   __VSP_SYNTH_TOTP_SECRET__    TOTP secret of the MFA users           (VSP_KEYCLOAK_SYNTH_TOTP_SECRET)
#   __VSP_SYNTH_CLIENT_SECRET__  secret of each confidential client    (VSP_KEYCLOAK_SYNTH_CLIENT_SECRET)
# The import refuses to run when one is missing: nothing falls back to a committed value.
set -euo pipefail

: "${KC_URL:?KC_URL missing}"
declare -A state=()
while IFS='=' read -r key value; do
  [[ "$key" =~ ^VSP_[A-Z_]+$ ]] && state["$key"]="$value"
done </state/env
# need <state key> <variable>: assigns in this shell (no subshell, so the refusal really exits).
need() {
  local v="${state[$1]:-}"
  if [[ -z "$v" ]]; then
    echo "keycloak-realm-import: $1 is not set in the generated local state; refusing to import" >&2
    exit 2
  fi
  printf -v "$2" '%s' "$v"
}
need VSP_KEYCLOAK_ADMIN_USER VSP_KEYCLOAK_ADMIN_USER
need VSP_KEYCLOAK_ADMIN_PASSWORD VSP_KEYCLOAK_ADMIN_PASSWORD
need VSP_KEYCLOAK_SYNTH_PASSWORD VSP_SYNTH_PASSWORD
need VSP_KEYCLOAK_SYNTH_TOTP_SECRET VSP_SYNTH_TOTP_SECRET
need VSP_KEYCLOAK_SYNTH_CLIENT_SECRET VSP_SYNTH_CLIENT_SECRET

kcadm=/opt/keycloak/bin/kcadm.sh
trustpass="$(head -c 18 /dev/urandom | base64 | tr -d '/+=')"
keytool -importcert -noprompt -alias vsp-local-ca -file /tls/ca.pem -keystore /tmp/vsp-truststore.p12 -storetype PKCS12 -storepass "$trustpass" >/dev/null
"$kcadm" config truststore --trustpass "$trustpass" /tmp/vsp-truststore.p12
"$kcadm" config credentials --server "$KC_URL" --realm master --user "$VSP_KEYCLOAK_ADMIN_USER" --password "$VSP_KEYCLOAK_ADMIN_PASSWORD"

for file in /realm-import/realms/*.json; do
  realm="$(basename "$file" .json)"
  if "$kcadm" get "realms/$realm" >/dev/null 2>&1; then
    echo "keycloak-realm-import: realm $realm exists; left unchanged"
    continue
  fi
  body="$(<"$file")"
  body="${body//__VSP_SYNTH_PASSWORD__/$VSP_SYNTH_PASSWORD}"
  body="${body//__VSP_SYNTH_TOTP_SECRET__/$VSP_SYNTH_TOTP_SECRET}"
  body="${body//__VSP_SYNTH_CLIENT_SECRET__/$VSP_SYNTH_CLIENT_SECRET}"
  printf '%s' "$body" | "$kcadm" create realms -f -
  # amr reference values (Keycloak "Authenticator Reference"): pwd for the password form, otp for the OTP
  # form, one hour max age (a 0 max age drops the value intermittently; deploy/local/README.md note 5).
  for pair in "auth-username-password-form:pwd" "auth-otp-form:otp"; do
    provider="${pair%%:*}"
    reference="${pair##*:}"
    execution=""
    while IFS=, read -r id provider_id; do
      if [[ "$provider_id" == "$provider" ]]; then execution="$id"; fi
    done < <("$kcadm" get "authentication/flows/browser/executions" -r "$realm" --fields id,providerId --format csv --noquotes)
    if [[ -z "$execution" ]]; then
      echo "keycloak-realm-import: execution $provider not found in realm $realm" >&2
      exit 3
    fi
    "$kcadm" create "authentication/executions/$execution/config" -r "$realm" -s "alias=$provider-amr" \
      -s "config.\"default.reference.value\"=$reference" -s 'config."default.reference.maxAge"=3600'
  done
  echo "keycloak-realm-import: realm $realm imported"
done
