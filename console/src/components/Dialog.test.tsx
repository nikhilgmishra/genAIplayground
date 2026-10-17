import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { Dialog } from "./Dialog";

function Harness() {
  const [open, setOpen] = useState(false);
  return (
    <main>
      <h1>Harness</h1>
      <button type="button" onClick={() => setOpen(true)}>
        Open dialog
      </button>
      <button type="button">Background action</button>
      <Dialog open={open} title="Example dialog" description={<p>Example description.</p>} onClose={() => setOpen(false)}>
        <label htmlFor="d-first">First field</label>
        <input id="d-first" />
        <button type="button">Middle action</button>
        <button type="button" onClick={() => setOpen(false)}>
          Close
        </button>
      </Dialog>
    </main>
  );
}

describe("Dialog keyboard behaviour", () => {
  it("[SPEC-16.console-a11y] opening moves focus inside a labelled aria-modal dialog", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: "Open dialog" }));
    const dialog = screen.getByRole("dialog", { name: "Example dialog" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAccessibleDescription("Example description.");
    expect(screen.getByLabelText("First field")).toHaveFocus();
  });

  it("[SPEC-16.console-a11y] Tab and Shift+Tab are trapped inside the dialog", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: "Open dialog" }));
    const first = screen.getByLabelText("First field");
    const middle = screen.getByRole("button", { name: "Middle action" });
    const last = screen.getByRole("button", { name: "Close" });
    expect(first).toHaveFocus();
    await user.tab();
    expect(middle).toHaveFocus();
    await user.tab();
    expect(last).toHaveFocus();
    await user.tab();
    expect(first).toHaveFocus();
    await user.tab({ shift: true });
    expect(last).toHaveFocus();
    expect(screen.getByRole("button", { name: "Background action", hidden: true })).not.toHaveFocus();
  });

  it("[SPEC-16.console-a11y] Escape closes the dialog and returns focus to the opener", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const opener = screen.getByRole("button", { name: "Open dialog" });
    await user.click(opener);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it("[SPEC-16.console-a11y] background content is inert while the dialog is open and restored after", async () => {
    const user = userEvent.setup();
    const { container } = render(<Harness />);
    await user.click(screen.getByRole("button", { name: "Open dialog" }));
    expect(container).toHaveAttribute("inert");
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(container).not.toHaveAttribute("inert");
  });
});
