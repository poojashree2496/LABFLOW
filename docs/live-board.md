# Live lab board

B4 supplies the `labs.live` and `systems.status` handlers in `LabService.gs`. The board screen is in progress.

`labs.live` is restricted to faculty, staff, admin and HOD accounts. Each active lab includes its current visits (student name/register number, session, entry time, current project and system), a distinct student count and its workstation statuses. Optional `labId` selects one accessible active lab. A person inside more than one session has a row per visit and counts once per lab.

Effective attendance events determine the rows: IN/CORR_IN starts a visit; WORK changes its project/system while preserving entry time; OUT/CORR_OUT ends it; VOID and correction decisions use the same derivation as attendance. A read recovers overdue open-lab closing before taking a snapshot, so delayed automatic sign-outs release people and systems.

`systems.status` is available to LABFLOW accounts. It returns system names/tags and availability, with no occupant, project or booking identity. Faculty/staff/admin and scoped HOD accounts see `free`, `busy`, `booked` or `unavailable`. Other accounts receive only `free`/`busy`; reservations and unavailable equipment map to busy. Individual assets qualify only when their category has `workstation: true`. Booking holds match entry protection, including the 15-minute early-collection window; a current occupant takes precedence over a hold.

Both endpoints take one script-locked snapshot and return `serverNow` and `refreshSeconds`. Named data is never stored in the public `labs.occupancy` cache. HOD-only accounts use `Auth.labScope(ctx)` and fail closed while B3 remains a stub; a missing/invalid scope also refuses access. Admin/staff accounts retain their existing global scope.

Backend cases in `test/checkin.test.js` cover assignments, work changes/voids, exits, delayed close recovery, booking boundaries, broken/non-system assets, role denial, anonymous public responses and supplied HOD scopes. Google runtime throughput and department configuration still require deployment checks.
