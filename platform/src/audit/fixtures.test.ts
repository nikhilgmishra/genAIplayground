import { describe, expect, it } from "vitest";
import type { Queryable } from "../db/types.js";
import { FakeClock } from "../shared/clock.js";
import { AuditUnavailableError } from "../shared/errors.js";
import { verifyChain } from "./chain.js";
import { AUDIT_FIXTURE_BADGE, AuditWriterOutageFixture, InMemoryAuditWriterFixture, createAuditFixtures } from "./fixtures.js";
import { AuditEventInvalidError } from "./schema.js";
import { sampleAuditInput } from "./testing.js";

const clock = new FakeClock();
const noTx = {} as Queryable;

describe("audit LOCAL FIXTURES for other modules", () => {
  it("[OPS-04] fixtures are labelled local_fixture and carry a badge", () => {
    const { memory, writer } = createAuditFixtures();
    expect(memory.kind).toBe("local_fixture");
    expect(writer.kind).toBe("local_fixture");
    expect(AUDIT_FIXTURE_BADGE).toContain("NOT DURABLE");
  });

  it("[SPEC-13.4] InMemoryAuditWriterFixture applies the same validation and hash chaining", async () => {
    const memory = new InMemoryAuditWriterFixture("fixture.chain");
    for (let i = 0; i < 4; i++) await memory.append(noTx, sampleAuditInput(clock));
    expect(verifyChain(memory.events, { sourceStream: "fixture.chain", expectedSequence: 1, expectedPrevHash: null }).findings).toEqual([]);
    expect(memory.byAction("action.commit.succeeded")).toHaveLength(4);
    await expect(memory.appendStandalone({ ...sampleAuditInput(clock), reasonCode: "not a code" })).rejects.toBeInstanceOf(AuditEventInvalidError);
    expect(memory.events[0]!.sessionRef).toMatch(/^sref_/);
  });

  it("[OPS-01] AuditWriterOutageFixture throws AuditUnavailableError with the chosen reason while toggled", async () => {
    const outage = new AuditWriterOutageFixture();
    outage.setOutage(true, "AUDIT_SINK_STALE");
    expect(outage.outage).toBe(true);
    await expect(outage.appendStandalone(sampleAuditInput(clock))).rejects.toEqual(new AuditUnavailableError("AUDIT_SINK_STALE"));
    await expect(outage.append(noTx, sampleAuditInput(clock))).rejects.toMatchObject({ reasonCode: "AUDIT_SINK_STALE", retryable: true });
    expect(outage.attemptsDuringOutage).toBe(2);
    outage.setOutage(false);
    await expect(outage.appendStandalone(sampleAuditInput(clock))).resolves.toMatchObject({ sequence: 1 });
  });
});
