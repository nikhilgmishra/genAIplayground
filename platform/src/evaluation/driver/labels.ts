/**
 * Labels shown on every artefact the LOCAL evaluation driver, demo and load smoke
 * produce. Nothing here is vendor, telephone, sandbox or production evidence
 * (spec sections 15 and 16: "explicit local-adapter badge").
 */
export const LOCAL_FIXTURE_BADGE = "LOCAL FIXTURE — SYNTHETIC DATA — NOT PRODUCTION";

/** The rule-based stand-in for the Talkdesk conversational layer is NEVER a model and never model evaluation. */
export const SIMULATED_COORDINATOR_LABEL =
  "LOCAL SIMULATED COORDINATOR — deterministic rule-based stand-in for the Talkdesk conversational layer (keyword rules over synthetic utterances); NOT a language model and NOT model evaluation";

export const DRIVER_LABEL =
  "LocalConversationDriver (LOCAL FIXTURE): full local stack — buildContainer(local) + real buildBusiness + worker loops over PGlite, OPA WASM and labelled local adapter fixtures; Studio steps over the HTTP telephony-control API, tools over MCP or the HTTP tool route, portal approvals via the LOCAL FIXTURE OIDC provider";

export const LOAD_LABEL = "LOCAL LOOPBACK, PGlite single connection, NOT the vendor/telephone path, NOT capacity evidence";
