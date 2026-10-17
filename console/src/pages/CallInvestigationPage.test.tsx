import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { OPAQUE_ID_PATTERN, SUPPORT_REFERENCE_PATTERN } from "../api/contract";
import { PRIMARY_CALL, SAFETY_CALL, TRANSCRIPT_CANARY, callDetail, destinations, staffView } from "../test/fixtures";
import { createMockApi } from "../test/mock-api";
import { findPage, renderConsole } from "../test/render";

const OPAQUE = OPAQUE_ID_PATTERN.slice(1, -1);
const SR = SUPPORT_REFERENCE_PATTERN.slice(1, -1);
/** Every console URL is one of these shapes: static section paths or a single opaque reference. */
const ALLOWED_HREF = new RegExp(`^(/[a-z-]*|/calls/${OPAQUE}|/support-requests/${SR}|#main-content)$`);

function allHrefs(): string[] {
  return Array.from(document.querySelectorAll("a[href]")).map((a) => a.getAttribute("href") ?? "");
}

describe("call investigation", () => {
  it("[DATA-01] [SPEC-16.console] renders no transcript, audio or recording content even if the backend sends some", async () => {
    const api = createMockApi();
    api.setHandler("calls.get", ({ req }) => {
      const detail = callDetail(req.params.callId);
      return {
        status: 200,
        body: {
          ...detail,
          transcript: TRANSCRIPT_CANARY,
          recordingUrl: "https://recordings.local.invalid/synthetic.wav",
          versions: { ...detail.versions, transcriptExcerpt: TRANSCRIPT_CANARY },
          timeline: [
            ...detail.timeline,
            { kind: "utterance", eventId: "evt_synthTimelineLeak01", at: detail.call.startedAt, auditEventId: null, turnId: null, sessionGeneration: 2, text: TRANSCRIPT_CANARY },
          ].map((e) => ({ ...e, utteranceText: TRANSCRIPT_CANARY })),
        },
      };
    });
    renderConsole({ path: `/calls/${PRIMARY_CALL}`, staff: staffView("supervisor"), api });
    await findPage("Call investigation");
    await screen.findByText(/Content-free event timeline/);
    expect(document.body.textContent).not.toContain("SYNTHETIC-TRANSCRIPT-CANARY");
    expect(document.body.textContent).not.toContain("recordings.local.invalid");
    expect(screen.queryByRole("link", { name: /transcript|recording|download|audio/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /transcript|recording|download|audio/i })).not.toBeInTheDocument();
    expect(screen.getByText(/Transcripts, audio and recording links are never available in this console/)).toBeInTheDocument();
    expect(screen.getByText(/1 event\(s\) of an unrecognized kind were not displayed/)).toBeInTheDocument();
  });

  it("[SPEC-13.console] the timeline shows tool invocations with status and reason codes, policy decisions, actions and support request refs", async () => {
    renderConsole({ path: `/calls/${PRIMARY_CALL}`, staff: staffView("agent") });
    await findPage("Call investigation");
    const table = await screen.findByRole("table", { name: /Content-free event timeline/ });
    const t = within(table);
    expect(t.getByText("get_appointment_options@1.0.0")).toBeInTheDocument();
    expect(t.getByText("Policy decision")).toBeInTheDocument();
    expect(t.getByText("SELF_RELATIONSHIP")).toBeInTheDocument();
    expect(t.getByText("appointment.reschedule")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Trace SR-7KQM-W4XP" })).toHaveAttribute("href", "/support-requests/SR-7KQM-W4XP");
    expect(screen.getByText(/Join: unavailable/)).toHaveTextContent("TALKDESK_CONTROL_UNAVAILABLE");
  });

  it("[SPEC-6.no-phi-url] every link in the calls list and investigation uses opaque ids only", async () => {
    const { user, locations } = renderConsole({ path: "/calls", staff: staffView("supervisor") });
    await findPage("Active calls");
    await screen.findByText(/Active calls \(2\)/);
    for (const href of allHrefs()) expect(href).toMatch(ALLOWED_HREF);
    await user.click(screen.getByRole("link", { name: `Investigate call ${SAFETY_CALL}` }));
    await findPage("Call investigation");
    await screen.findByText(/Content-free event timeline/);
    for (const href of allHrefs()) expect(href).toMatch(ALLOWED_HREF);
    for (const l of locations) expect(l).toMatch(ALLOWED_HREF);
  });

  it("[SPEC-6.no-phi-url] a non-opaque reference in the address bar is rejected without a request and without being echoed", async () => {
    const api = createMockApi();
    renderConsole({ path: `/calls/${encodeURIComponent("+15555550101")}`, api });
    await findPage("Call investigation");
    expect(screen.getByRole("alert")).toHaveTextContent("does not contain a valid opaque call reference");
    expect(document.body.textContent).not.toContain("5555550101");
    expect(api.calls("calls.get")).toHaveLength(0);
  });

  it("[SAFE-05] the transfer dialog offers only allowlisted destinations and posts destination id and reason", async () => {
    const api = createMockApi();
    const { user } = renderConsole({ path: `/calls/${PRIMARY_CALL}`, staff: staffView("safety"), api });
    await findPage("Call investigation");
    await user.click(await screen.findByRole("button", { name: "Transfer call" }));
    const dialog = within(screen.getByRole("dialog", { name: "Transfer this call" }));
    const select = await dialog.findByLabelText("Destination (allowlist)");
    await dialog.findByRole("option", { name: /dst_safety_priority/ });
    const offered = within(select).getAllByRole("option").map((o) => o.getAttribute("value")).filter(Boolean);
    expect(offered).toEqual(destinations().destinations.map((d) => d.destinationId));
    expect(dialog.queryByRole("textbox")).not.toBeInTheDocument();
    const submit = dialog.getByRole("button", { name: "Request transfer" });
    expect(submit).toBeDisabled();
    await user.selectOptions(select, "dst_safety_priority");
    await user.selectOptions(dialog.getByLabelText("Transfer reason"), "SAFETY_PRIORITY");
    await user.click(submit);
    const calls = api.calls("calls.transfer");
    expect(calls[0]?.path).toBe(`/console/api/v1/calls/${PRIMARY_CALL}/transfer`);
    expect(calls[0]?.body).toEqual({ destinationId: "dst_safety_priority", reason: "SAFETY_PRIORITY" });
    expect(await screen.findByText(/It is not complete until the receiver accepts and the caller is confirmed connected/)).toBeInTheDocument();
  });
});
