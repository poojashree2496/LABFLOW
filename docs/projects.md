# Projects

Project management implements task C1 of the [v2 requirements](requirements.md). It uses the agreed Projects schema and routes without changing their contracts.

## Workflow

1. A verified student creates an individual project or, as an active group leader, a group project. Choose an active lab, an active faculty supervisor, a description and a start/end date. A group assigned to a lab must use that lab.
2. The project starts as `pending`. Its supervisor is notified. `Projects.usableBy(studentId, projectId)` permits pending and active projects owned by that student or shared through their active group. The actual project picker at check-in remains task C3.
3. The named supervisor, coordinator or super admin approves or rejects it. The owner receives the decision and any note as a notification.
4. After approval, the owner or a current group leader submits the outcome and an optional HTTP(S) result link. The project remains `active` while the supervisor reviews it. The student may revise it during this stage.
5. Only the named supervisor accepts the submitted outcome, setting the project to `completed`. Completed outcomes cannot be edited.

Every creation, decision, outcome submission and acceptance is audited. Phone numbers and other account contact data are not included in project responses.

The shared project screen appears under My projects for students and Projects for faculty, coordinators and super admins. On phones it is in the More menu. Group members can read their shared projects; creation and outcome submission require the permissions above.

## API payloads

All handlers return `{ project }`, except the list handlers, which return `{ projects, truncated }`.

| Route | Payload |
|---|---|
| `projects.create` | `title`, `description`, `labId`, `supervisorFacultyId`, `startDate`, `endDate`; optional `groupId`, `projectId` |
| `projects.mine` / `projects.list` | Optional `status` and `labId` filters |
| `projects.get` | `projectId` |
| `projects.decide` | `projectId`, boolean `approve`; optional `note` |
| `projects.outcome` (submit) | `projectId`, `outcome`; optional `outcomeLink` |
| `projects.outcome` (accept) | `projectId`, `accept: true`, `outcomeAt` from the outcome being reviewed |

The server takes the owner from the authenticated caller. Payload owner, status and approval fields are never trusted. Lists return the newest 200 matching visible projects and report truncation; older records remain available by id.

Students read their own/group projects. Faculty read projects they supervise. Coordinators and super admins read all projects. HOD reads use `Auth.labScope(ctx)`; **B3 has not implemented this helper yet**, so HOD project reads currently return `NOT_IMPLEMENTED` rather than exposing unscoped data.

## Retry and concurrency behaviour

The UI allocates a valid `PRJ-` id before creation and preserves the payload on an uncertain response. Repeating that id with identical details returns the existing project; different details or a different owner are refused. Mutations refresh authorization and check their current state inside the script lock.

Outcome submissions with identical content are idempotent. Revisions receive a strictly increasing `outcomeAt`, including when two submissions happen in the same millisecond. Acceptance must include the reviewed version; a stale review returns `CONFLICT` and the screen refreshes for another review.

An uncertain editor keeps its payload and disabled fields when closed and reopened while the app remains loaded. Drafts are held in page memory, so a page reload discards them. Check saved projects before starting another creation after a reload.

## Verification

- `npm run check`: includes 14 backend project cases covering lifecycle, ownership, groups, department-scope integration, validation, retries and authorization changes before the write lock.
- `npm run e2e:projects`: 27 browser checks covering the actual screens, phone navigation/layout, approval, outcomes, stale reviews, group access, rejection, text rendering and creation retries after a server-committed response is lost.
- Google services are local fakes. Deployment identity, real Sheets/Drive behaviour and notifications still require a real Workspace check.
