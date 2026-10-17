/** Shown wherever actions are filtered by role. */
export function ServerEnforcedNote() {
  return (
    <p className="hint server-note">
      Actions are shown according to your roles. The server enforces the same rules on every request; hiding a control is not the control.
    </p>
  );
}
