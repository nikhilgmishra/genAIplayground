# Local Keycloak realms (WP-05, SYNTHETIC)

Realm templates for the local OpenID Connect identity providers and their one-shot importer. Everything is
SYNTHETIC: user names, groups and clients are invented, and every credential is a placeholder replaced at
import time from the generated local state. Nothing here describes a tenant IdP.

| Template | Purpose | Clients | Users |
|---|---|---|---|
| `realms/vsp-client.json` | Caller (client) IdP for the secure-link approval | `vsp-portal` (confidential, PKCE S256, redirect `http://localhost:5174/verify/callback`) | MFA users (password + TOTP) |
| `realms/vsp-provider.json` | Provider IdP for the secure-link approval | `vsp-provider-portal` (same settings) | MFA users |
| `realms/vsp-partner.json` | Partner IdP | `vsp-partner-portal` (same settings) | MFA user |
| `realms/vsp-workforce.json` | Workforce IdP for console SSO | `vsp-console` (confidential, PKCE S256, redirect `http://localhost:5173/auth/callback`; client roles `support-agent` ... `security-admin`, each granted by its group `/vsp/<role>` and emitted in the `vsp_roles` claim by a client role mapper restricted to `vsp-console`) | One user per staff role in group `/vsp/<role>`, a second security admin (dual control), a password-only user (MFA refusal) |

Placeholders (never committed values):

| Placeholder | Local state key |
|---|---|
| `__VSP_SYNTH_PASSWORD__` | `VSP_KEYCLOAK_SYNTH_PASSWORD` |
| `__VSP_SYNTH_TOTP_SECRET__` | `VSP_KEYCLOAK_SYNTH_TOTP_SECRET` |
| `__VSP_SYNTH_CLIENT_SECRET__` | `VSP_KEYCLOAK_SYNTH_CLIENT_SECRET` |

Import:

```bash
make up PROFILE=core,identity-realms
```

`deploy/local/services/keycloak-realm.compose.yaml` runs `import-realms.sh` once (profile `identity-realms`,
not part of `core`) with the Keycloak image: it reads the generated state file, trusts the checkout's local
CA, logs in to the admin API (`kcadm.sh`), creates each realm that does not exist yet (an existing realm is
left unchanged) and sets the authenticator references `pwd` / `otp` so logins carry `amr`. It refuses to run
(exit 2) when a state value is missing; nothing falls back to a committed value.

Status: the state step (`scripts/vsp/up.mts`) does not generate the three `VSP_KEYCLOAK_SYNTH_*` values yet,
so the importer refuses until it does (hand-off to the owner of `up.mts`). The templates themselves are
verified by the Layer-2 test `platform/test/integration/identity/realm-templates.test.ts`, which imports each
one through the admin API under a throwaway realm name with generated values and deletes it afterwards.

The console maps the `vsp_roles` claim (`membershipSource: CLIENT_ROLES`), never group names: on Keycloak 26
a top-level group whose name contains `/` (for example `vsp/security-admin`) gets the same full path as the
nested managed group, so group paths can be spoofed by anyone who may create a group. The `groups` mapper
stays for inspection only.

The Layer-2 identity suite never depends on these realms: it creates its own throwaway realms.
