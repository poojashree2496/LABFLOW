# Reference photo and device approval audit — 2026-10-27

Main was already current at `32404d9`. Baseline lint, 335 backend tests and 27 scenarios passed. This audit targeted identity-sensitive operations adjacent to account recovery, using the real RPC gateway and services with local Google-service fakes.

## Findings and fixes

| Finding | Result |
|---|---|
| The desk offered a reference-photo upload, and the service supported it, but `photo.set` allowed only students. | The existing route now permits coordinators and super admins as intended by the desk screen. Faculty and HOD remain excluded. Student uploads remain restricted to their own profile, with verified reference photos protected. |
| An upload could use an earlier profile snapshot after staff added a verified photo, or after unlink/reclaim changed the owner. | Uploads decode first, then refresh identity, ownership and photo protection under the write lock. Desk uploads include the reviewed email, so a stale dialog cannot upload to a different account's claim. |
| A delayed onboarding photo could overwrite a newer desk photo or attach to a new claim. Its final response could also return the new claim's data. | Photo storage compares the current owner and photo reference under the lock. Onboarding refuses a final response if ownership changed. A photo failure remains best effort and preserves the newer reference for the same claim. |
| A faculty photo read could finish after the pending spot check granting access had been resolved. | Photo reads refresh identity and inspect the current spot-check permission under the lock, through Drive access. |
| Replacement approval could act after the student became disabled/rejected or the operator lost their desk role. | Approval refreshes desk authorization, requires a currently verified/active student account, and checks that the pending credential belongs to that account before replacing either phone. |

No schema columns or frozen v2 contracts changed. Replacement approvals still require in-person ID confirmation and prohibit approving one's own phone.

## Verification

- Seven photo regressions/controls in `test/identity-audit.test.js`; four replacement-approval regressions in `test/device-approval-audit.test.js`.
- The test harness now supports the Blob overload of Drive folder `createFile`, Blob names/types and file `getBlob`, so uploaded photo bytes can be read and rendered instead of testing only missing photos.
- `npm run check`: lint and **346 backend tests passed**.
- `npm run sim`: **27/27 scenarios passed**.
- Isolated Brave/Chromium: general **85/85**, identity **15/15**, recovery **10/10**.
- `e2e:identity` uploads synthetic JPEGs through the actual file control as coordinator and super admin, renders saved photos, checks phone layout and student replacement refusal, tests disabled-profile/valid replacement approvals, and refuses a stale photo dialog after reclaim.
- `git diff --check` passed.

## Limits

No real Google account, personal browser profile, photograph or production database was used. These runs do not verify Workspace identity, real Drive behaviour, quotas, HtmlService storage/camera support or physical ID checks. Photo operations now hold the script lock through Drive access; real latency and contention still need deployment measurement. This is a targeted audit, not a claim that every application workflow or failure mode has been verified.
