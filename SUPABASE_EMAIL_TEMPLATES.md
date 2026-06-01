# Supabase Email Templates — STILO AI Partners

Go to: https://supabase.com/dashboard/project/zsrskphpvgautfgklgxf/auth/templates

Update two templates: "Magic Link" and "Confirm signup". Use **Source mode** for each, and paste the FULL block.

## Why these are LIGHT, not dark

The earlier dark version looked great on desktop but broke on the **iPhone Gmail app with dark mode on**: Gmail's mobile dark mode does a full color INVERSION it won't let you opt out of (the `color-scheme` meta + `[data-ogsc]` tricks work in Apple Mail but Gmail's iOS app ignores them). So a dark email got flipped to a washed-out white one.

The reliable fix is to author the email **light**. Then:
- **Light mode / desktop:** clean white card with blue accents.
- **Dark mode (iPhone Gmail/Mail):** the client inverts the light email to a clean **dark** look. Light emails are exactly the case those inverters handle well.

So this is "dark where it matters" (your phone) and readable everywhere, instead of "dark on desktop, broken on mobile." Do NOT add a forced dark background or a `color-scheme:dark` lock back in — that reintroduces the bug. Keep all text dark-on-light and use blue only as an accent (top bar, brand name, button, links); avoid white-text-on-color blocks, which is the thing Gmail inverts unpredictably.

Blue palette: Core #2563EB | Link #2563EB | Heading #0F172A | Body #475569 | Muted #64748B

---

## Template 1: Magic Link

**Subject:**
```
Your STILO AI Partners sign-in link
```

**Body (Source mode):**
```html
<!DOCTYPE html>
<html lang="en" style="color-scheme:light dark;supported-color-schemes:light dark;">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="color-scheme" content="light dark">
  <meta name="supported-color-schemes" content="light dark">
</head>
<body style="margin:0;padding:0;background-color:#EEF1F6;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:#EEF1F6;">Your one-click sign-in link for STILO AI Partners. Works once, expires in an hour.</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#EEF1F6" style="background-color:#EEF1F6;">
    <tr>
      <td align="center" style="padding:40px 24px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#FFFFFF" style="max-width:520px;background-color:#FFFFFF;border-radius:16px;border:1px solid #E2E8F0;overflow:hidden;">
          <tr><td bgcolor="#2563EB" style="background-color:#2563EB;height:4px;line-height:4px;font-size:0;">&nbsp;</td></tr>
          <tr>
            <td style="padding:40px;">
              <p style="margin:0 0 22px;font-size:12px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:#2563EB;font-family:Arial,Helvetica,sans-serif;">STILO AI PARTNERS</p>
              <h1 style="margin:0 0 14px;font-size:22px;font-weight:700;line-height:1.3;color:#0F172A;font-family:Arial,Helvetica,sans-serif;">Your sign-in link</h1>
              <p style="margin:0 0 28px;font-size:15px;line-height:1.65;color:#475569;font-family:Arial,Helvetica,sans-serif;">Here's your one-click link to get into your dashboard. It works once and expires in an hour.</p>
              <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td align="center" bgcolor="#2563EB" style="border-radius:10px;background-color:#2563EB;">
                    <a href="{{ .ConfirmationURL }}" style="display:inline-block;padding:14px 32px;font-size:15px;font-weight:600;color:#FFFFFF;text-decoration:none;border-radius:10px;font-family:Arial,Helvetica,sans-serif;">Sign in to my dashboard &rarr;</a>
                  </td>
                </tr>
              </table>
              <p style="margin:28px 0 0;font-size:13px;line-height:1.6;color:#64748B;font-family:Arial,Helvetica,sans-serif;">If the button doesn't work, copy this into your browser:<br><a href="{{ .ConfirmationURL }}" style="color:#2563EB;word-break:break-all;">{{ .ConfirmationURL }}</a></p>
            </td>
          </tr>
          <tr>
            <td style="padding:20px 40px;border-top:1px solid #E2E8F0;">
              <p style="margin:0;font-size:12px;line-height:1.7;color:#64748B;font-family:Arial,Helvetica,sans-serif;">Talk soon,<br><strong style="color:#0F172A;">Remy at STILO AI Partners</strong><br>Questions? Just reply to this email.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
```

---

## Template 2: Confirm Signup

**Subject:**
```
Confirm your STILO AI Partners account
```

**Body (Source mode):**
```html
<!DOCTYPE html>
<html lang="en" style="color-scheme:light dark;supported-color-schemes:light dark;">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="color-scheme" content="light dark">
  <meta name="supported-color-schemes" content="light dark">
</head>
<body style="margin:0;padding:0;background-color:#EEF1F6;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:#EEF1F6;">Confirm your STILO AI Partners account. This link expires in 24 hours.</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#EEF1F6" style="background-color:#EEF1F6;">
    <tr>
      <td align="center" style="padding:40px 24px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#FFFFFF" style="max-width:520px;background-color:#FFFFFF;border-radius:16px;border:1px solid #E2E8F0;overflow:hidden;">
          <tr><td bgcolor="#2563EB" style="background-color:#2563EB;height:4px;line-height:4px;font-size:0;">&nbsp;</td></tr>
          <tr>
            <td style="padding:40px;">
              <p style="margin:0 0 22px;font-size:12px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:#2563EB;font-family:Arial,Helvetica,sans-serif;">STILO AI PARTNERS</p>
              <h1 style="margin:0 0 14px;font-size:22px;font-weight:700;line-height:1.3;color:#0F172A;font-family:Arial,Helvetica,sans-serif;">Confirm your account</h1>
              <p style="margin:0 0 28px;font-size:15px;line-height:1.65;color:#475569;font-family:Arial,Helvetica,sans-serif;">One click and you're in. This link expires in 24 hours.</p>
              <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td align="center" bgcolor="#2563EB" style="border-radius:10px;background-color:#2563EB;">
                    <a href="{{ .ConfirmationURL }}" style="display:inline-block;padding:14px 32px;font-size:15px;font-weight:600;color:#FFFFFF;text-decoration:none;border-radius:10px;font-family:Arial,Helvetica,sans-serif;">Confirm my account &rarr;</a>
                  </td>
                </tr>
              </table>
              <p style="margin:28px 0 0;font-size:13px;line-height:1.6;color:#64748B;font-family:Arial,Helvetica,sans-serif;">If the button doesn't work, copy this into your browser:<br><a href="{{ .ConfirmationURL }}" style="color:#2563EB;word-break:break-all;">{{ .ConfirmationURL }}</a></p>
            </td>
          </tr>
          <tr>
            <td style="padding:20px 40px;border-top:1px solid #E2E8F0;">
              <p style="margin:0;font-size:12px;line-height:1.7;color:#64748B;font-family:Arial,Helvetica,sans-serif;">Talk soon,<br><strong style="color:#0F172A;">Remy at STILO AI Partners</strong><br>Questions? Just reply to this email.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
```

---

## Resend SMTP setup (send from remy@stiloaipartners.com)

Once Resend domain is verified, go to:
https://supabase.com/dashboard/project/zsrskphpvgautfgklgxf/auth/smtp

```
Host:           smtp.resend.com
Port:           465
Username:       resend
Password:       [Resend API key]
Sender name:    Remy at STILO AI Partners
Sender email:   remy@stiloaipartners.com
```

---

## Retell AI — Fix "30-minute" copy

The booking confirmation email that Retell sends after the AI receptionist books a meeting is configured inside Retell's dashboard, not in this codebase.

1. Go to https://app.retellai.com
2. Open your agent settings
3. Find **Booking / Calendar** or **Post-call actions**
4. Change "30-minute" to "15-minute" everywhere it appears
5. Update the Calendly link if it's hardcoded

New Calendly link for all booking flows: `https://calendly.com/stiloaipartners/free-ai-strategy-call`
