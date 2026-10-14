# Local progress and account transfer

Status: implemented and validated locally on 2026-10-14; not deployed.
The replacement lives in `site/progress/`, `server/transfer.js`, and migration
0004. `server/cleanup.js` provides independent scheduled retention cleanup.
The [historical synchronization review](anonymous-progress.md) records the
retired implementation. See [README](../README.md#production-activation) for
the separate production activation steps.

## Product boundary

Keep an anonymous profile and its game progress on one browser profile. Playing,
returning, and saving use IndexedDB without registration, a remote account,
session Cookies, progress API requests, or background synchronization. Transfer
is an explicit, occasional action that moves the complete profile to another
browser. A device here means a browser profile, not a fingerprinted person or
physical machine.

The user has chosen local storage and account transfer over multi-device sync.
The protocol and limits below describe the implemented replacement.

| Situation | Local behavior | Remote data |
| --- | --- | --- |
| Ordinary play | Save and resume on this device. | None. |
| Prepare transfer | Freeze writes and capture every saved game in this profile. | One short-lived transfer package. |
| Receive transfer | Store the whole package, then confirm the handoff. | A temporary claim and completion receipt. |
| Completed transfer | New device continues; old profile becomes read-only. | Remove the package; expire the receipt. |
| Cancelled or expired transfer | Old device resumes only after the outcome is confirmed. | Remove the package; expire the receipt. |

This removes permanent cloud save heads, background uploads, cross-device
merging, conflict selection, recovery codes, and lists of active cloud sessions.
Keep local export/import, reset, schema validation, and writer fencing. An
imported backup creates local progress; it is not a credential that reactivates
the original transferred identity.

Losing or clearing the only device before a transfer, without a file backup,
means losing its progress. State this briefly in **My progress / 我的进度**.
Transfer is not a cloud backup service.

## Player flow

1. On the old device, choose **Transfer to another device / 转移到新设备**.
   Pause the profile's games, finish accepted saves, and show a private one-use
   link. The first release uses a copyable link without a QR dependency. Explain that
   the old profile is paused until the transfer completes or is cancelled.
2. Open the link on the new device and choose **Receive and continue /
   接收并继续**. Merely opening a URL must not change the selected profile.
   If this browser already has progress, explain the switch and preserve its
   previous profile separately; never merge or overwrite it automatically.
3. Import and confirm automatically. Start the selected game only after the
   handoff is confirmed. The old browser shows **Transferred / 已转移** when it
   next checks. It may start a new, empty local profile through a separate action.

There is no extra confirmation step on the old device after acceptance. Check
transfer status only while a transfer is pending or when reopening its pending
screen. Ordinary play needs no polling. Present retry/cancel only when needed.

## Ownership and local durability

The local profile ID travels with the saves but is not an authentication secret.
The normal application flow has at most one writable copy. A recipient that
has not durably staged a package can explicitly cancel receiving and restore
its previous local profile; the remote claim then expires or is cancelled by
the source. After staging, outcome confirmation is required. This is not an
anti-copying guarantee against someone cloning IndexedDB, restoring browser
backups, or changing the client. Strong enforcement against those actions would
require a different, continuously authoritative online model.

Before sending any package, commit a profile-wide `outgoing` marker and advance
its writer generation in IndexedDB. Every save transaction, across every game
and tab, checks this marker and generation. A frozen or offline tab cannot write
merely because it missed a BroadcastChannel message. Drain accepted writes
before freezing, or fail the transfer without claiming that they were saved.

Capture all game slots of the active profile in the same consistent local
snapshot, including games other than the currently open game. Preserve
platform-valid saves for unlisted games and newer game schemas without running
their code. Do not transfer another local profile or session credentials.
Freeze the snapshot bytes and digest for the lifetime of this transfer.

An explicit transfer first obtains server time to avoid depending on device
clock accuracy. The receiving browser persists its claim identity before
contacting the server.
After download it validates the envelope, manifest, sizes, and digest, then
stores all slots and an `incoming` marker in one IndexedDB transaction. Wait for
transaction completion, not individual request success. Staged data is not yet
playable. Never acknowledge receipt from memory alone.

After server confirmation, atomically select the staged profile as active. If
the page closes between these steps, its next load reconciles the persisted
claim before activating anything. The source remains frozen even while offline;
the design does not depend on remotely contacting it to stop gameplay.

Keep the source's last snapshot as a read-only local rescue copy until explicit
cleanup. It is neither an active account nor a second sync branch. Exporting it
does not undo a completed transfer.

## Temporary relay protocol

D1 coordinates the handoff and temporarily holds the package. No permanent
account, device registry, recovery credential, or gameplay history is required.
Use same-origin Pages Functions with bounded requests and prepared SQL.

Each transfer has a random ID, immutable package digest, absolute deadline,
source-control verifier, recipient-link verifier, state, and optional claimed
recipient verifier. Generate independent high-entropy secrets; store only
their verifiers on the server. The source-control secret is not in the link.
The recipient's retry secret is generated and saved locally before claiming.

| State | Allowed transitions | Who can play this profile? |
| --- | --- | --- |
| `ready` | One recipient claims; source cancels; deadline expires. | Neither, while the old device is frozen. |
| `claimed` | The same recipient retries/downloads and commits; source cancels; deadline expires. | Neither. |
| `committed` | Immutable outcome; package removed. | The confirmed recipient. |
| `cancelled` / `expired` | Immutable outcome; package removed. | The source after authenticated confirmation. |

Claim, commit, cancellation, and expiry use conditional state transitions in
the database. A recipient may commit only its own claim, the exact package
digest, and before the deadline. Commit and cancellation racing each other have
one winner. A stale recipient cannot activate a cancelled transfer.

Creating and retrying a transfer use the same ID, body, digest, and absolute
deadline. Retry never extends its life or overwrites its package. A source
cancellation must also fence a delayed creation request: if creation is still
in doubt, record an authenticated terminal cancellation for that ID rather than
treating a missing row as proof that upload never happened. Bound and expire
these cancellation records like other receipts. After the immutable deadline,
an authenticated source cancellation for an absent record can return `expired`
without storing another row, but only within the original receipt-retention
window: new creation is then impossible and any completed transfer must still
have its receipt. This permits recovery even when relay admission is full.

Retries by the same recipient return its existing claim/result. Another browser
cannot claim the same link, and consuming a link is not evidence that durable
receipt or the handoff completed. A network error, generic 404, or missing row
never proves cancellation or completion. Require authenticated outcome checks
and compare the transfer ID, recipient, and digest before changing local state.

Keep terminal receipts briefly to resolve lost responses. Clients must never
automatically unlock a source or activate a recipient whose receipt has already
been purged. Preserve their data read-only and explain that the result could
not be confirmed. Export into a new local profile is a recovery option; it does
not resurrect the uncertain identity. This rare boundary is the tradeoff for
having no permanent remote ownership registry.

Use exact-origin checks, no-store responses, and a custom request header. Keep
link secrets in the URL fragment, remove the fragment before game code runs,
and never put secrets in logs, exports, query strings, or third-party QR/link
services. Explicit recipient acceptance is required even for a fresh browser.
Do not claim end-to-end encryption unless it is separately implemented and
verified; transport and temporary storage protections still apply.

## Retention and storage bounds

Implemented initial settings:

| Data | Limit / lifetime |
| --- | --- |
| Active transfer | One per local profile; 10 minutes from creation, not renewed by polling. |
| Snapshot | Retain the existing 64 KiB JSON-envelope limit per game slot. |
| Transfer package | At most 1 MiB serialized and 128 current/alternate slots, including envelope overhead. Reject oversize packages without omitting games. |
| Terminal receipt | At most 7 days, containing outcome, digest, and verifiers; no save payload or account history. |
| Abuse counters | Short expiry and bounded cardinality, with limits on creation, claims, and status requests. |

The package cap leaves room below D1's current 2,000,000-byte string,
BLOB, and row limit. It is a product limit, not D1's capacity.
[D1 limits](https://developers.cloudflare.com/d1/platform/limits/).

Remove the live package in the same terminal transition that records completion
or cancellation. Expiry checks reject access immediately; scheduled cleanup
removes abandoned packages and later receipts independently of new visitors.
Do not mistake an `expires_at` column or request-triggered housekeeping for a
running deletion job. The cleanup Worker has a five-minute schedule and at most ten batches of 500
records per run. Its deployment and verified execution are required before
production activation.
[Cloudflare Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/).

Index expiry fields, delete in bounded batches, and set a global admission cap
on both live bytes and record counts. At capacity, reject new transfers while
keeping local saves/export usable; never evict an unresolved handoff to admit
another. Cleanup failure must be visible operationally. Receipt/rate-limit rows
count even when their payload-byte count is zero. Under normal operation,
retained data follows recent transfer volume and these time bounds, rather than
the lifetime count of visitors. Admission is capped at 4,096 records and 64 MiB of live payload by database
triggers. Creation/cancellation permits 6 requests per minute per network bucket;
other calls permit 120. Two sets of 256 hashed buckets cap abuse-counter rows at
512, with one-minute windows. Bucket collisions deliberately share limits.

Deletion here means live application records. Document the actual D1 backup
retention before deployment; do not promise immediate erasure of all backups.
A restored relay database must remain closed for seven days plus ten minutes
after the last possible pre-restore relay request; purge its relay rows before
reopening. Removing rows alone is unsafe because it could make a completed
handoff appear absent. The quarantine expires old creation/cancellation
credentials, so a backup cannot reopen a completed/cancelled handoff. Ordinary
local play remains available.

## Replacing the current implementation

Keep the shared player, optional `context.progress` API v1, game checkpoints,
IndexedDB durability, local schema checks, and local writer protection. Games
should not need to know whether the platform is preparing a transfer.

Replace session bootstrapping, save upload/download, device linking, recovery,
and conflict resolution with the transfer lifecycle. Remove automatic network
work on ordinary save, focus, startup, and reconnection. The player menu becomes
local save status, transfer, export/import, and reset/clear. Use a dedicated
transfer capability flag; changing a button label or revoking other sessions
does not turn the existing synchronization protocol into a transfer protocol.

Upgrade existing local records into independent local profile IDs; a former
shared cloud account must not imply multiple owners of one new local identity.
Do not discard guest backups, bound profiles,
pending snapshots, or conflicts. Unconfirmed legacy cloud-only slots remain
blocked until an explicit reset or import; they never become empty saves
automatically. Keep ambiguous alternatives exportable; do not
silently choose a cloud winner. Reject old connection/recovery links once the
replacement API is enabled so they cannot bypass transfer confirmation.

The production build now enables explicit transfer with `FUNDEV_TRANSFER=1`;
legacy cloud flags are ignored. Legacy API routes return 410. Production
activation must include migration 0004 and the scheduled cleanup deployment.
Migration 0005 drops the legacy synchronization tables; production held no
legacy rows when this was checked on 2026-10-14.

## Acceptance requirements

| Scenario | Required result |
| --- | --- |
| First visit, saves, reload, focus, or reconnect without a pending transfer | Local progress works with zero progress API requests and zero remote account rows. |
| Games A and B have saves; transfer starts while B is open | Both games arrive with their exact frozen snapshots. |
| Another tab tries saving during outgoing/incoming/moved state | Transaction rejects the write, including offline and resumed tabs. |
| Creation/claim/download response lost | Retry the same transfer/claim without a second package or recipient. |
| Two receiving browsers, or commit races cancellation | At most one recipient can activate; source cannot resume after commit. |
| Receiving storage is full, denied, aborted, or page closes during import | No acknowledgment of durable receipt; source snapshot remains intact. |
| Commit succeeds but its response is lost | Persisted staging plus authenticated receipt confirms the result on retry. |
| Source is offline after issuing its link | It remains frozen; recipient success does not need a second source approval. |
| Link expires without completion | Reject new claims/commit; source resumes only after confirmed terminal outcome. |
| Receipt already purged or server outcome unknown | No implicit activation or rollback; retain data and offer export. |
| Recipient already has a profile | Opening a link changes nothing; accepted transfer preserves the previous profile separately. |
| No traffic after an abandoned transfer | Scheduled cleanup removes payload/metadata within the documented cleanup window. |
| Huge packet, repeated random IDs, or metadata-only requests | Byte, row, and admission bounds prevent unlimited retained data. |
| Unlisted game, unknown newer schema, reset, or repeat A-to-B-to-C transfer | Preserve valid payloads and local ownership; never revive a moved profile or silently skip a game. |

Validate races and cleanup against local D1/workerd, and persistence/tab behavior
in real browsers. Transfer-specific tests exercise these guarantees and replace the retired
synchronization tests. Production build, link/asset checks, mobile/desktop
checks, and `git diff --check` remain required for the implementation.
