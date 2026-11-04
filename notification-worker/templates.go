package main

import (
	"fmt"
	"html"
	"time"
)

func renderInvitationEmail(candidateName, recipientEmail, examTitle, passcode, temporaryPassword string, startTime, endTime time.Time, gatewayURL, candidatePortalURL, clientURL, proctoringMode string) string {
	passcodeContent := `<div class="passcode-box"><div style="font-size: 11px; text-transform: uppercase; color: #64748b; font-weight: 600; margin-bottom: 4px;">Single-Use Passcode</div><div class="passcode">` + html.EscapeString(passcode) + `</div></div>`
	if passcode == "" {
		passcodeContent = `<p>Your proctor or organizer will provide the assessment access code at the scheduled time.</p>`
	}
	proctoringText := "Proctoring mode: " + html.EscapeString(proctoringMode)
	if proctoringMode == "" {
		proctoringText = ""
	}
	requirements := `<li>Use the secure desktop client for the assessment.</li><li>Follow your proctor's instructions when the access code is announced.</li>`
	if proctoringMode == "ONLINE_PROCTORING" {
		requirements = `<li>Allow camera and microphone access before starting.</li><li>Use a single active display and follow the proctor's instructions.</li>`
	}
	portalCredentials := ""
	if temporaryPassword != "" {
		portalCredentials = `<div class="passcode-box"><div style="font-size: 11px; text-transform: uppercase; color: #64748b; font-weight: 600; margin-bottom: 4px;">Candidate portal sign-in</div><div>Email: ` + html.EscapeString(recipientEmail) + `</div><div>Temporary password: <code>` + html.EscapeString(temporaryPassword) + `</code></div><p><a href="` + html.EscapeString(candidatePortalURL) + `">Open your candidate portal</a> to view your schedule and graded results.</p></div>`
	}
	return fmt.Sprintf(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f8fafc; margin: 0; padding: 24px; color: #0f172a; }
    .card { max-width: 580px; margin: 0 auto; background: #ffffff; border-radius: 8px; border: 1px solid #e2e8f0; padding: 32px; }
    .badge { display: inline-block; background-color: #e0e7ff; color: #4338ca; font-size: 12px; font-weight: 600; padding: 4px 8px; border-radius: 4px; text-transform: uppercase; letter-spacing: 0.5px; }
    h1 { font-size: 20px; font-weight: 700; margin: 16px 0 8px 0; color: #0f172a; }
    p { font-size: 14px; line-height: 1.6; color: #334155; margin: 8px 0; }
    .passcode-box { background: #f1f5f9; border-radius: 6px; padding: 16px; margin: 20px 0; text-align: center; }
    .passcode { font-family: ui-monospace, Menlo, Monaco, monospace; font-size: 24px; font-weight: 700; letter-spacing: 4px; color: #0284c7; }
    .button { display: inline-block; background: #2563eb; color: #ffffff !important; font-size: 14px; font-weight: 600; text-decoration: none; padding: 12px 24px; border-radius: 6px; margin: 16px 0; }
    .rules { background: #fffbeb; border: 1px solid #fef3c7; border-radius: 6px; padding: 12px 16px; margin-top: 20px; }
    .rules li { font-size: 12px; color: #92400e; margin: 4px 0; }
  </style>
</head>
<body>
  <div class="card">
    <span class="badge">Assessment Invitation</span>
    <h1>%s</h1>
    <p>Hello <b>%s</b>,</p>
    <p>You have been assigned to take the assessment session above.</p>
    %s
    <p>%s</p>
    %s

    <p><b>Slot Start:</b> %s UTC</p>
    <p><b>Slot End:</b> %s UTC</p>

    <p>Open your personal exam gateway during the scheduled window. It will launch the secure desktop client if installed and provide a download link if needed.</p>
    <p style="text-align: center;">
      <a href="%s" class="button">Open Secure Exam Gateway</a>
    </p>
    <p style="text-align: center;"><a href="%s">Download Desktop Client (.exe)</a></p>

    <div class="rules">
      <b>Mandatory System Requirements:</b>
      <ul style="margin: 6px 0 0 0; padding-left: 18px;">
        %s
      </ul>
    </div>
  </div>
</body>
</html>`,
		html.EscapeString(examTitle),
		html.EscapeString(candidateName),
		portalCredentials,
		html.EscapeString(proctoringText),
		passcodeContent,
		startTime.Format(time.RFC822),
		endTime.Format(time.RFC822),
		html.EscapeString(gatewayURL),
		html.EscapeString(clientURL),
		requirements,
	)
}

func renderProctorInviteEmail(fullName, temporaryPassword, loginURL string) string {
	return fmt.Sprintf(`<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;background:#f8fafc;padding:24px;color:#0f172a"><main style="max-width:560px;margin:auto;background:#fff;border:1px solid #e2e8f0;border-radius:8px;padding:28px"><h1>Proctor portal access</h1><p>Hello <b>%s</b>, an organization administrator created your proctor account.</p><p>Sign in to view your assigned assessment events, candidate lists, and access codes.</p><p><b>Temporary password:</b> <code>%s</code></p><p><a href="%s">Open the proctor portal</a></p><p>Keep this password private.</p></main></body></html>`, html.EscapeString(fullName), html.EscapeString(temporaryPassword), html.EscapeString(loginURL))
}

func renderCandidateOrgInviteEmail(fullName, organizationName, registrationURL string) string {
	return fmt.Sprintf(`<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;background:#f8fafc;padding:24px;color:#0f172a"><main style="max-width:560px;margin:auto;background:#fff;border:1px solid #e2e8f0;border-radius:8px;padding:28px"><h1>Join %s on AssessPro</h1><p>Hello <b>%s</b>, your organization invited you to create a candidate account.</p><p>Use the secure invitation link below to set your password and activate your candidate portal account. This link expires in seven days.</p><p><a href="%s">Accept invitation and register</a></p><p>If you were also invited to an assessment, its exam link will arrive separately from the exam assignment workflow.</p></main></body></html>`, html.EscapeString(organizationName), html.EscapeString(fullName), html.EscapeString(registrationURL))
}
