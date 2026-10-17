import { describe, expect, it } from "vitest";
import { createMemoryLogger, sanitizeValue } from "./logger.js";

describe("content-free logger (DATA-01, AUTH-06)", () => {
  it("keeps opaque ids, codes, timestamps and numbers", () => {
    const { logger, records } = createMemoryLogger();
    logger.info("tool.invoke.allowed", {
      sessionRef: "ses_abcdefghijklmnopqrstuv",
      reasonCode: "ALLOWED",
      tool: "get_invoice_status",
      latencyMs: 41,
      completedAt: "2026-10-17T15:00:00.000Z",
    });
    expect(records[0]?.fields).toEqual({
      sessionRef: "ses_abcdefghijklmnopqrstuv",
      reasonCode: "ALLOWED",
      tool: "get_invoice_status",
      latencyMs: 41,
      completedAt: "2026-10-17T15:00:00.000Z",
    });
  });

  it("redacts names, phone numbers, DOBs, OTP codes and free text", () => {
    const { logger, records } = createMemoryLogger();
    logger.warn("verification.failed", {
      callerName: "Jordan Rivera",
      phone: "+15555550123",
      dateOfBirth: "1990-01-02",
      otpCode: "482913",
      subjectId: "Jordan Rivera",
      utterance: "my date of birth is january second",
      reasonCode: "code 482913",
    });
    const f = records[0]?.fields ?? {};
    for (const v of Object.values(f)) expect(v).toBe("[redacted]");
  });

  it("keeps dotted template and rule ids but still redacts PHI-shaped values under those keys", () => {
    expect(sanitizeValue("templateId", "safety.acknowledgment")).toBe("safety.acknowledgment");
    expect(sanitizeValue("ruleId", "explicit.self_harm.en")).toBe("explicit.self_harm.en");
    expect(sanitizeValue("templateId", "call me at 5555550123")).toBe("[redacted]");
  });

  it("rejects digit runs in token-category values", () => {
    expect(sanitizeValue("intent", "callback_5555550123")).toBe("[redacted]");
    expect(sanitizeValue("version", "2026-10-17.1")).toBe("2026-10-17.1");
  });
});
