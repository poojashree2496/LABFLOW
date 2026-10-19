# HOD access and department scope

B1/B3 implement HOD-only read access and department scope. The HOD screens and admin configuration controls are in progress.

A HOD sees labs with the same department (case/whitespace normalized) plus labs with no department, which are shared. A HOD account with no department sees shared labs only. Department values come from current server-side account records; payloads cannot choose a department or widen report scope. Lab/account edits preserve the existing department when it is omitted. Onboarding preserves an imported student's official department.

HOD-only accounts can read department views and export reports, but cannot check students in, manage sessions/events, change projects, issue/return equipment, approve records, or change configuration. A central explicit action policy covers generic `user`/`any` routes as well as named-role routes. Two personal actions remain allowed: update their own mobile/consent and mark their own notifications read. These do not grant roles or change departments. System status/quota, settings, ERP/audit report exports, credential administration and private photo retrieval remain outside HOD access.

Read checks apply to lists, direct session/asset/loan/project ids, the public occupancy response, catalog/kits, activity, dashboard counts, audit records and CSV/PDF reports. Public occupancy cache entries remain nameless and are filtered by lab before returning them. Audit reads include only records linked to accessible entities; global audit entries are omitted. Aggregate report counts and zero-row lab sections are scoped before export, not just filtered on screen.

Student directories include the HOD's department and participants associated with accessible courses, sessions, groups or projects. That allows a department HOD to see a visitor from another department in a shared/department lab, while that visitor's report includes only attendance in accessible labs. Global categories remain reference data. Account directories expose the existing minimal account fields rather than personal mobile numbers.

An account with explicitly combined roles keeps those role grants: adding coordinator (`staff`) or super admin (`admin`) gives the existing global operational access. HOD-only read restrictions do not remove separately assigned student/faculty/coordinator/admin permissions. Department-scoped reads apply to HOD accounts unless coordinator/admin access takes precedence.

`test/hod.test.js` covers persisted fields, shared/own/other department data, direct-id checks, all report families and exports, a sweep of every business mutation, personal-action isolation and fresh department updates. Google runtime performance and real department configuration still need deployment checks.
