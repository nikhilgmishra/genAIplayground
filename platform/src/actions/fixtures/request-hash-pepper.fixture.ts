/**
 * LOCAL FIXTURE — request-hash pepper for `ToolRequestIdempotency` (DP-02) in the local / ci
 * composition and tests. It is a labelled, NON-SECRET value committed to the repository, so local
 * request hashes are only as private as the SYNTHETIC data they cover. A live deployment loads the
 * pepper from the configured Secrets Manager secret (BLOCKED until provisioned); the production
 * guard (OPS-04) never composes this fixture.
 */
import type { RequestHashPepper } from "../tool-idempotency.js";

export const LOCAL_FIXTURE_REQUEST_HASH_PEPPER: RequestHashPepper = Object.freeze({
  ref: "local-fixture:tool-request-hash-pepper",
  key: Buffer.from("LOCAL-FIXTURE-TOOL-REQUEST-HASH-PEPPER--NOT-A-SECRET--0123456789", "utf8"),
});
