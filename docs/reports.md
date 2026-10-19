# Attendance, system and project reports

B5 implements student attendance totals, system usage and project reports. Report controls and the student home display are in progress.

The student report preserves its attendance columns and adds summary totals (verified hours, distinct attendance dates, visits and automatic sign-outs) and a per-lab section. Re-entry counts as another visit; absent sessions do not create attendance dates. Open visits use the same conservative verification policy as attendance. Historical summaries without events retain hours/days, but visits are counted only from available events and unknown visit-session counts are recorded in metadata. No re-entry count is invented from one summary row.

The system report requires `assetId` for an individually tracked asset whose category is marked `workstation`. It lists reported use, checked-in people, distinct attendance visits and verified hours. Effective IN/WORK/OUT boundaries split system and project assignments. The exact attendance credit caps are used; WORK never verifies presence, missed exits/rescans stay uncredited and breaks are excluded. Usage is clipped to the selected IST date range. Project titles or linked workstation-booking purposes describe the work.

Reservations (including their purposes/statuses) and equipment loan records appear in separate sections. They add no attendance hours. A loan closing time is the whole loan's closing time, not evidence of when an individual item was returned. “Checked-in people” and “Attendance visits” refer only to attendance records.

The project report lists owner, supervisor, planned timeline, status, outcome/link, attendance visits and verified hours. It includes projects with overlapping planned timelines or recorded work in the selected range. Faculty see only projects they supervise; staff/admin see all within any supplied lab filter. Student report access remains self-only for students and roster/session-scoped for faculty.

HOD report access requires B1's report-route roles and B3's department helper. Those prerequisites remain unfinished. The new report authorization path is ready to consume a valid lab-id scope and fails closed when it is absent; existing route roles are unchanged.

The existing CSV and PDF exporters handle the new summaries and sections, enforce their existing row limits and neutralize spreadsheet formulas. Report generation uses a script-locked snapshot. The student dashboard also exposes per-lab statistics for the past 90 days; its existing overall totals keep their original all-history scope.

`test/reports.test.js` covers re-entry/day totals, work changes/voids, breaks, missed rescans/exits, automatic closing, date clipping, reservations/loans, permissions, historical fallback and CSV/PDF export on fakes. Real Google service performance and PDF rendering still require deployment checks.
