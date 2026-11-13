# Persistent JSON webhook deliveries

To retain a notification while its receiver is unavailable, edit a webhook channel in
**Settings → Notifications** and enable **Persistent JSON webhook retries**. This is
opt-in and applies only to that channel's `json://` and `jsons://` destinations.
SMTP, other providers, existing channels without this option, and the channel's
manual **Test** button keep their immediate-send behavior. No additional service or
container is required; deliveries live in Dockhand's SQLite or PostgreSQL database.

## Retry policy

Each destination gets its own persisted delivery before its first HTTP request.
A successful destination is not resent when another destination fails. Network
errors, timeouts, HTTP 408, HTTP 429 and HTTP 5xx are retried. Other unsuccessful
HTTP responses, blocked URLs and redirects require attention instead of an
automatic retry. The existing notification URL safety checks also apply here.

Defaults are 10 total attempts, a maximum event age of 1,440 minutes and 7 days
of terminal history. The UI accepts 1–20 attempts, 1–10,080 minutes and 1–30 days
of retention. Backoff starts at 5 seconds, then 15 seconds, 45 seconds, 2 minutes,
5 minutes and 15 minutes, with 10% jitter; later attempts remain at 15 minutes.
`Retry-After` can extend this delay. An attempt is not made past the event deadline.
Requests retain `NOTIFICATION_TIMEOUT_MS` (10 seconds by default), with a further
30-second worker deadline and a 60-second processing lease for crash recovery.

The worker runs in Dockhand, processes up to four deliveries concurrently, and
reclaims interrupted work after its lease expires. Admission stops at approximately
10,000 active deliveries; payloads larger than 64 KiB are rejected. A database or
admission failure is reported as a failed notification, never as an unrecorded send.
Completed history is pruned according to the retention saved with each delivery.

## Payload and deduplication

The title, message, type, environment and original timestamp are frozen at enqueue
time. Opted-in JSON payloads also contain `eventType`, `eventId` and `deliveryId`.
`X-Dockhand-Event-Id` and `X-Dockhand-Delivery-Id` carry the same identifiers. An
event ID is shared across that dispatch; each destination has a distinct delivery
ID, which remains stable through retries and a manual retry.

Delivery is **at least once**. If a receiver accepts a message and its response is
lost, or Dockhand stops before recording success, that delivery can be repeated.
Receivers should deduplicate by delivery ID. Persisting this queue does not capture
Docker events that occur while Dockhand itself is stopped, and does not replace
receiver-side durable storage or protect against losing Dockhand's database.

## History, retry and discard

**Delivery history** below the channels shows status, attempts, timestamps and a
safe failure category. Users with notification edit permission can retry a failed
delivery or discard pending, failed or cancelled work. In-flight deliveries cannot
be manually retried or discarded. Manual retry gives the original delivery another
policy-sized attempt budget and age window without changing its payload or IDs.

Before each attempt, Dockhand checks that the channel is enabled, persistent retries
remain enabled, the original URL still exists, and the environment/event subscription
still applies. Obsolete work is cancelled instead of redirected to a new destination.
Changing URL credentials changes that destination's fingerprint and cancels pending
work for its old URL. Disabling a channel or retries cancels pending work; an HTTP
request already in flight may still finish. Deleting a channel or environment removes
its associated delivery records through database foreign keys.

History access uses existing notification permissions and environment access rules.
Environment-scoped users do not see system-wide deliveries. History responses omit
message bodies, destination URLs, destination fingerprints and internal leases.
Only a URL fingerprint is retained with the queued payload; credentials are resolved
from the current channel at send time. Provider response bodies and raw exceptions
are not retained. Queued message content is stored in the existing database, so its
normal data-directory and database-backup protections still apply.

API endpoints:

- `GET /api/notifications/{id}/deliveries?page=1`: metadata, 25 entries per page;
  requires notification view permission and environment access.
- `POST /api/notifications/{id}/deliveries/{deliveryId}` with
  `{"action":"retry"}` or `{"action":"discard"}`: requires notification edit
  permission and environment access; concurrent or in-flight changes return 409.

## Verification

Run `bun test tests/notification-outbox.test.ts tests/notification-outbox-transport.test.ts`.
The tests use real SQLite databases, close and reopen the database for restart
recovery, and exercise a local HTTP receiver outage. To also run the same storage
and worker tests against PostgreSQL, set `DOCKHAND_OUTBOX_TEST_POSTGRES_URL` to an
isolated test database. Each PostgreSQL fixture creates and drops its own schema;
never use a production database for tests.
