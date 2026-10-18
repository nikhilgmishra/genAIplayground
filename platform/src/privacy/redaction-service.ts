/**
 * Redaction pipeline with quarantine routing (spec section 6, DATA-01, DATA-02).
 *
 * `RedactionService.process()` redacts an artifact's text. On failure or low
 * confidence the artifact is QUARANTINED: the content is handed only to a
 * restricted quarantine store whose destination the egress guard approves for
 * PHI_RESTRICTED. If the store is not approved, nothing is sent anywhere and
 * the caller must keep the artifact in its original restricted location. The
 * raw content is never forwarded to a debugging vendor or returned in the
 * result.
 *
 * Successful redaction does NOT make the output de-identified: the result keeps
 * the PHI classification of a redacted transcript (classification.ts).
 */
import type { Logger, Metrics } from "../observability/ports.js";
import { silentLogger } from "../observability/logger.js";
import type { Clock } from "../shared/clock.js";
import { iso, systemClock } from "../shared/clock.js";
import { sha256Hex } from "../shared/canonical.js";
import { newId } from "../shared/ids.js";
import { classifyArtifact } from "./classification.js";
import type { ArtifactClassification } from "./classification.js";
import type { EgressGuard } from "./egress.js";
import { redactText } from "./redaction.js";
import type { RedactionContext, RedactionResult } from "./redaction.js";

export interface QuarantineRecord {
  quarantineId: string;
  artifactId: string;
  artifactKind: "PRE_REDACTION_TRANSCRIPT" | "REDACTED_TRANSCRIPT";
  reasonCodes: string[];
  classification: "PHI_RESTRICTED";
  /** Digest of the content for integrity; never the content itself. */
  contentDigest: string;
  quarantinedAt: string;
}

/** Restricted, access-controlled store for quarantined artifacts. */
export interface QuarantineStore {
  readonly kind: "local_fixture" | "live";
  /** Egress destination id of the store (must be approved for PHI_RESTRICTED). */
  readonly destinationId: string;
  put(record: QuarantineRecord, content: string): Promise<void>;
}

/** LOCAL FIXTURE quarantine store (SYNTHETIC data only; in-memory, not durable). */
export class InMemoryQuarantineStoreFixture implements QuarantineStore {
  readonly kind = "local_fixture" as const;
  readonly records: QuarantineRecord[] = [];
  private readonly contents = new Map<string, string>();
  constructor(readonly destinationId: string) {}
  async put(record: QuarantineRecord, content: string): Promise<void> {
    this.records.push(record);
    this.contents.set(record.quarantineId, content);
  }
  /** Test-only accessor for the restricted copy. */
  contentFor(quarantineId: string): string | undefined {
    return this.contents.get(quarantineId);
  }
}

export interface ProcessedArtifact {
  artifactId: string;
  result: RedactionResult;
  classification: ArtifactClassification;
  quarantine: { quarantineId: string; stored: boolean; reasonCode: string } | null;
}

export class RedactionService {
  private readonly logger: Logger;
  private readonly clock: Clock;

  constructor(
    private readonly deps: {
      quarantine: QuarantineStore;
      egress: EgressGuard;
      logger?: Logger;
      clock?: Clock;
      defaults?: RedactionContext;
      /** Content-free metrics: vsp_redaction_results_total{result: redacted | quarantined}. */
      metrics?: Metrics;
    },
  ) {
    this.logger = deps.logger ?? silentLogger;
    this.clock = deps.clock ?? systemClock;
  }

  private count(result: "redacted" | "quarantined"): void {
    try {
      this.deps.metrics?.increment("vsp_redaction_results_total", { result });
    } catch {
      // Metrics never change a redaction or quarantine decision.
    }
  }

  async process(artifact: { artifactId: string; text: string }, ctx: RedactionContext = {}): Promise<ProcessedArtifact> {
    const result = redactText(artifact.text, { ...this.deps.defaults, ...ctx });
    this.count(result.status === "REDACTED" ? "redacted" : "quarantined");
    if (result.status === "REDACTED") {
      return {
        artifactId: artifact.artifactId,
        result,
        classification: classifyArtifact({ kind: "REDACTED_TRANSCRIPT", redactionStatus: "REDACTED", derivedFrom: ["PRE_REDACTION_TRANSCRIPT"] }),
        quarantine: null,
      };
    }
    const quarantineId = newId("qrn");
    const classification = classifyArtifact({ kind: "REDACTED_TRANSCRIPT", redactionStatus: "QUARANTINED", derivedFrom: ["PRE_REDACTION_TRANSCRIPT"] });
    const decision = this.deps.egress.check({ destinationId: this.deps.quarantine.destinationId }, "PHI_RESTRICTED");
    if (!decision.allowed) {
      this.logger.error("privacy.redaction.quarantine_store_not_approved", { reasonCode: decision.reasonCode, quarantineId });
      return { artifactId: artifact.artifactId, result, classification, quarantine: { quarantineId, stored: false, reasonCode: "QUARANTINE_STORE_NOT_APPROVED" } };
    }
    const record: QuarantineRecord = {
      quarantineId,
      artifactId: artifact.artifactId,
      artifactKind: "PRE_REDACTION_TRANSCRIPT",
      reasonCodes: result.reasonCodes,
      classification: "PHI_RESTRICTED",
      contentDigest: sha256Hex(typeof artifact.text === "string" ? artifact.text : ""),
      quarantinedAt: iso(this.clock.now()),
    };
    try {
      await this.deps.quarantine.put(record, typeof artifact.text === "string" ? artifact.text : "");
    } catch {
      this.logger.error("privacy.redaction.quarantine_store_failed", { reasonCode: "QUARANTINE_STORE_FAILED", quarantineId });
      return { artifactId: artifact.artifactId, result, classification, quarantine: { quarantineId, stored: false, reasonCode: "QUARANTINE_STORE_FAILED" } };
    }
    this.logger.warn("privacy.redaction.quarantined", { reasonCode: result.reasonCodes[0] ?? "REDACTION_QUARANTINED", quarantineId });
    return { artifactId: artifact.artifactId, result, classification, quarantine: { quarantineId, stored: true, reasonCode: "QUARANTINED" } };
  }
}
