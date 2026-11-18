/**
 * Weekly email listing applications that need a follow-up or look ghosted.
 */

function currentFollowUps() {
  return followUps(readApplications(), new Date(), CONFIG.NUDGE.FOLLOW_UP_DAYS, CONFIG.NUDGE.GHOST_DAYS);
}

function sendFollowUpDigest() {
  var f = currentFollowUps();
  if (!f.followUp.length && !f.ghosted.length) return { sent: false };

  function list(items) {
    return '<ul>' + items.map(function (x) {
      var name = x.company + (x.title ? ' (' + x.title + ')' : '');
      var link = x.url ? '<a href="' + x.url + '">' + name + '</a>' : name;
      return '<li>' + link + ': ' + x.days + ' days since you applied</li>';
    }).join('') + '</ul>';
  }

  var html = '';
  if (f.followUp.length) {
    html += '<h3>Worth a follow-up (' + f.followUp.length + ')</h3>' +
      '<p>No human reply after ' + CONFIG.NUDGE.FOLLOW_UP_DAYS + '+ days. A short note to the recruiter or hiring manager can help.</p>' + list(f.followUp);
  }
  if (f.ghosted.length) {
    html += '<h3>Likely ghosted (' + f.ghosted.length + ')</h3>' +
      '<p>No reply at all after ' + CONFIG.NUDGE.GHOST_DAYS + '+ days. Consider marking them "Job Closed - No Rejection".</p>' + list(f.ghosted);
  }
  var appUrl = ScriptApp.getService().getUrl();
  if (appUrl) html += '<p><a href="' + appUrl + '">Open the job tracker</a></p>';

  var count = f.followUp.length + f.ghosted.length;
  MailApp.sendEmail({
    to: Session.getEffectiveUser().getEmail(),
    subject: 'Job search: ' + count + ' application' + (count === 1 ? '' : 's') + ' to follow up on',
    htmlBody: html
  });
  logActivity('Sent follow-up digest', '', count + ' applications');
  return { sent: true, count: count };
}
