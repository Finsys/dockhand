/**
 * Conservative default retention for SCHEDULED configs created without a policy -
 * otherwise their snapshots grow forever, since pruning is gated on a non-empty
 * keep-* policy. Shared so the config form shows what the server will store.
 */
export const DEFAULT_SCHEDULED_RETENTION = { keepDaily: 7, keepWeekly: 4, keepMonthly: 6 };
