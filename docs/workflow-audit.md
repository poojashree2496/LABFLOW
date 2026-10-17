# Critical workflow audit — 2026-10-17

Scope: attendance in both modes, scanner permissions, device replacement, manual attendance corrections, equipment requests, booking collection, loan issue/return and failure recovery. The review traced the UI payloads into the real RPC router, service validation and sheet writes, and checked existing tests before adding reproductions. No external account or deployment was used.

## Findings and fixes

| Priority | Finding and reproduction | Result after the fix |
|---|---|---|
| High | During P-256 verification, disable the student, reject their profile, demote the faculty scanner or disable the kiosk. The scan still wrote attendance using earlier checks. A QR that went stale during verification also succeeded. | The locked pipeline rechecks freshness, the student/account, lab mode and scanner authorization against current records. Credential revocation is also read directly. Version A rechecks pass expiry, student/account and kiosk/lab before consuming its code. Refusals write neither attendance nor a redemption. |
| High | Book Board 1 when three interchangeable boards exist; issue Board 1 to someone else. Category-level stock protection allowed it. Collecting the booking with Board 2 also marked it fulfilled. | Checkout protects the specific booked asset, including pending holds when enabled. Collection must include the named asset and the promised category quantities. Unreserved units remain usable. |
| High | Attach another student's equipment request to a checkout. The call failed after a loan and stock changes were committed. Issuing unrelated equipment, or too few units, could also mark a request fulfilled. | Request ownership, lab, resource and quantity are validated before loan writes. Successful fulfilment requires all requested units. Additional items may be issued if normal stock checks allow them; partial fulfilment is not silently recorded as complete. |
| High | Fail `Audit.log` for `loan.issue` after stock, booking and request writes. The loan was already `open`, so the rollback skipped it. | The loan stays `issuing` until linked writes and the audit entry succeed. Recovery restores stock, compensates issue ledger entries, restores the booking and reopens the equipment request. Notification failure after commit is logged without failing the successful checkout. |
| High | Return four units and consume three of ten borrowed units; fail the Assets write after updating LoanItems. Retrying failed with `BAD_INPUT`; stock remained at total 20 / available 10 instead of total 17 / available 14. | A durable return plan is written before counters change. Recovery applies absolute item/asset patches, deduplicates ledger entries and writes a completion marker. Retry, the next stock mutation, or inventory reconciliation finishes interrupted plans before proceeding. |
| Medium | Approve a replacement immediately before rejection acquires the write lock. The stale rejection overwrote the approval after the original device had already been replaced. | Rejection and revocation now hold the lock across reading, checking and updating device state. The stale rejection is refused and the approved replacement remains active. |
| Medium | Let a registration challenge expire while its signature is being verified. Registration still succeeded. | Registration rechecks expiry and the student's current verified/active state under the lock before storing a credential. |
| Medium | Enter, exit, re-enter, then manually add an exit timestamp between the first exit and the second entry. The correction was accepted but left the student inside. | A manual exit must follow the current open entry, rather than the first entry of the session. A valid corrected exit produces the expected duration. |
| Medium | Retry an identical booking after reaching the active-booking limit. The retry returned `LIMIT` despite already succeeding. | Duplicate detection precedes the limit check and includes lab and quantity, returning the existing reservation for an identical active request. |

## Return recovery details

`AssetEvents` now includes zero-quantity `return-plan` and `return-complete` entries. The plan stores the validated patches and ledger entries as JSON in its note. This uses existing columns; no schema migration is needed. Plan keys and per-item ledger keys are unique.

Pending plans are recovered under the script lock before loan issue/return, asset edits, condition checks and repairing inventory reconciliation. Completed plans never overwrite later stock changes. Read-only reconciliation does not finish plans. A plan over 40,000 characters is refused before writes, with instructions to split the return into smaller batches.

Notifications are best effort after commit. An interruption after the return audit entry but before the completion marker may produce a repeated audit entry on recovery; quantities and inventory ledger entries remain idempotent. Newly journaled returns can recover; pre-existing inconsistencies from returns without a plan still require review.

## Validation

- Baseline: syntax checks and all 138 existing backend tests passed.
- Added `test/workflow-audit.test.js`: 29 regression cases. Reproductions failed on the original implementation where applicable; controls cover valid alternatives and recovery boundaries.
- Final `npm run check`: syntax checks and **167 backend tests passed**.
- Final `npm run sim`: **27 of 27 scenarios passed**.
- `git diff --check`: passed.
- `npm run e2e`: could not start because `playwright-core` is not installed in this checkout. The previously documented 74 browser checks are historical, not results from this audit. No browser validation is claimed for these changes.

Existing coverage also exercises role routing/ownership, QR tampering and replay, credential replacement/revocation, missing exits, rescans, old-correction approval, loan limits, over-returns, kit components and booking capacity. The new race tests inject deterministic interleavings into the actual service code; they do not simulate real parallel Google executions.

## Remaining checks

- Run the browser suite with its dependencies and Chrome available, especially staff issue/return and both attendance modes.
- Measure real scan latency and lock contention after the new authorization reads. Local fake timings do not predict Workspace throughput.
- Measure inventory operations with a large AssetEvents ledger. Return recovery currently scans that ledger under the lock; an indexed pending-plan store may be appropriate at scale.
- Perform the Workspace identity, camera, location, persistent-key, quota and physical-control checks already tracked in `tasks.md`.

This audit strengthens the local implementation. It does not establish production readiness or remove the documented live-relay, compromised-device or collusion risks.
