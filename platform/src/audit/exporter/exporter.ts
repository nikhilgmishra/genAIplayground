/**
 * Audit exporter (follow-on FO-01-13, FO-15-37, FO-15-38, FO-22-08): ships the local audit outbox to the
 * independently administered sink (S3 Object Lock in the audit account) with a signature on every
 * manifest. It is the AuditShipper composed with a ManifestSigner and the exporter's identities:
 *   - database role app_worker (the only role that may mark rows shipped and plan manifests);
 *   - the sink WRITER credentials (s3:PutObject only; cannot read evidence back, OPS-AUD-02);
 *   - kms:Sign on the audit manifest key only.
 * It never verifies its own output: AuditExportVerifier (verifier.ts) runs under a different, read-only
 * identity. The entry point that runs it as a separate service is platform/src/main/audit-exporter.ts
 * (WP-07); its service and IAM are WP-39.
 */
import type { Db } from "../../db/types.js";
import { noopMetrics } from "../../observability/metrics.js";
import type { Logger, Metrics } from "../../observability/ports.js";
import type { Clock } from "../../shared/clock.js";
import type { AuditSink } from "../ports.js";
import { AuditShipper } from "../shipper.js";
import type { ShipRunResult } from "../shipper.js";
import type { ManifestSigner } from "./signer.js";

export interface AuditExporterOptions {
  db: Db;
  /** Sink with the exporter's WRITER credentials. */
  sink: AuditSink;
  signer: ManifestSigner;
  clock: Clock;
  logger?: Logger;
  metrics?: Metrics;
  batchSize?: number;
  maxBatchesPerStream?: number;
  sinkId?: string;
}

export class AuditExporter {
  private readonly shipper: AuditShipper;
  private readonly metrics: Metrics;

  constructor(opts: AuditExporterOptions) {
    this.metrics = opts.metrics ?? noopMetrics;
    this.shipper = new AuditShipper({
      db: opts.db,
      sink: opts.sink,
      clock: opts.clock,
      signer: opts.signer,
      role: "app_worker",
      ...(opts.logger ? { logger: opts.logger } : {}),
      ...(opts.batchSize !== undefined ? { batchSize: opts.batchSize } : {}),
      ...(opts.maxBatchesPerStream !== undefined ? { maxBatchesPerStream: opts.maxBatchesPerStream } : {}),
      ...(opts.sinkId !== undefined ? { sinkId: opts.sinkId } : {}),
    });
  }

  /** Ships every stream with pending events; every shipped manifest is signed. */
  async runOnce(): Promise<ShipRunResult> {
    const r = await this.shipper.runOnce();
    try {
      if (r.batchesShipped > 0) this.metrics.increment("vsp_audit_manifest_signatures_total", { result: "signed" }, r.batchesShipped);
      for (const s of r.streams) if (s.reasonCode === "AUDIT_SIGNER_UNAVAILABLE" || s.reasonCode === "AUDIT_SIGNER_RESPONSE_INVALID") this.metrics.increment("vsp_audit_manifest_signatures_total", { result: "sign_failed" });
    } catch {
      // metrics never change what is shipped
    }
    return r;
  }
}
