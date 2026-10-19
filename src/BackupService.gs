/**
 * BackupService.gs - nightly Drive copies of the spreadsheet (task A3) and the yearly archive that moves old
 * event-level rows into a per-year archive spreadsheet (task A4). Contract: docs/requirements.md section 4.
 */
var Backup = {
  /** Make a backup copy now (super admin) and return it. */
  now: function () { notBuilt_('A3'); },
  /** The nightly job step: copy, then rotate (30 daily + 12 monthly). */
  nightly: function () { notBuilt_('A3'); },
  list: function () { notBuilt_('A3'); },
  archiveYear: function () { notBuilt_('A4'); }
};
