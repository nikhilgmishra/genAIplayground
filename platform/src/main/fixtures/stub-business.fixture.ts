/**
 * LOCAL TEST FIXTURE: a stub BusinessModule for composition-root and worker
 * tests (the real module is platform/src/business, built by another engineer).
 * Tools are the gateway's labelled fixture tools; handoff/outcomes record
 * requests; the support-request service refuses every call (not exercised);
 * consumers are injected by the test. SYNTHETIC data only.
 */
import type { BuildBusiness, BusinessModule, SupportRequestService } from "../../business/contract.js";
import { RecordingHandoffFixture, RecordingOutcomeFixture } from "../../gateway/fixtures/app-harness.fixture.js";
import {
  FixtureFaults,
  fixtureAppointmentsTool,
  fixtureHumanTool,
  fixtureIntakeTool,
  fixturePublicFaqTool,
} from "../../gateway/fixtures/tools.fixture.js";
import type { ToolModule } from "../../gateway/ports.js";
import { ValidationError } from "../../shared/errors.js";

export const STUB_TOOL_NAMES = ["fixture_get_appointments", "fixture_public_faq", "fixture_request_human", "fixture_create_request"] as const;

const refuse = async (): Promise<never> => {
  throw new ValidationError("STUB_SUPPORT_REQUESTS_NOT_IMPLEMENTED");
};

export const stubSupportRequests: SupportRequestService = {
  create: refuse,
  handleSyncMessage: refuse,
  get: refuse,
  getByReference: refuse,
  trace: refuse,
  listUnsynced: refuse,
};

export interface StubBusiness {
  build: BuildBusiness;
  faults: FixtureFaults;
  handoff: RecordingHandoffFixture;
  outcomes: RecordingOutcomeFixture;
  consumers: BusinessModule["consumers"];
}

export function createStubBusiness(consumers: BusinessModule["consumers"] = {}): StubBusiness {
  const faults = new FixtureFaults();
  const handoff = new RecordingHandoffFixture();
  const outcomes = new RecordingOutcomeFixture();
  return {
    faults,
    handoff,
    outcomes,
    consumers,
    build: (deps) => ({
      tools: [
        fixtureAppointmentsTool(deps.adapters.scheduling, faults),
        fixturePublicFaqTool(faults),
        fixtureHumanTool(faults),
        fixtureIntakeTool(faults),
      ] as unknown as ToolModule[],
      providers: {},
      contracts: [],
      handoff,
      supportRequests: stubSupportRequests,
      outcomes,
      consumers,
    }),
  };
}
