/**
 * ProjectService.gs - student projects with a supervisor, a timeline and an outcome (task C1).
 *
 * A student or group leader creates a project and names a faculty supervisor, who approves it. A pending project can
 * be picked at check-in straight away. Statuses: pending -> active | rejected ; active -> completed | archived.
 * Contract: docs/requirements.md section 4.
 */
var Projects = {
  create: function () { notBuilt_('C1'); },
  mine: function () { notBuilt_('C1'); },
  get: function () { notBuilt_('C1'); },
  list: function () { notBuilt_('C1'); },
  decide: function () { notBuilt_('C1'); },
  outcome: function () { notBuilt_('C1'); },
  /** True when the student owns the project (or is in its group) and it is pending or active. */
  usableBy: function () { notBuilt_('C1'); }
};
