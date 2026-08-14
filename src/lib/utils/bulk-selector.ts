// The stack env-var name(s) that carry the external-secret-provider bulk selector.
// OP_ENVIRONMENT_ID is the legacy 1Password name; DOCKHAND_SECRET_SELECTOR is the
// generic one the UI writes now. The server resolves either (BULK_SELECTOR_VARS in
// stacks.ts), so both keep working.
//
// The stack modal shows the selector both as a labelled field AND as its plain
// DOCKHAND_SECRET_SELECTOR env row - they are one and the same value (the field is a
// live view of the env var), so the user sees plainly that it IS that variable.
export const SELECTOR_VARS = ['OP_ENVIRONMENT_ID', 'DOCKHAND_SECRET_SELECTOR'];

/** The canonical name the field writes to (a legacy OP_ENVIRONMENT_ID is normalized to this). */
export const BULK_SELECTOR_VAR = 'DOCKHAND_SECRET_SELECTOR';
