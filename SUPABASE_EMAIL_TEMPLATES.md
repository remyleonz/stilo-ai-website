# Supabase Email Templates — STILO AI Partners

Go to: https://supabase.com/dashboard/project/zsrskphpvgautfgklgxf/auth/templates

Update two templates: "Magic Link" and "Confirm signup". Use **Source mode** for each.

These templates use `<table>` layout with `bgcolor` attributes so the dark background renders correctly on iOS Mail, Gmail mobile, and Outlook. Do not convert back to div-based layout.

Blue palette: Core #2563EB | Bright #3B82F6 | Cyan #06B6D4 | Glow rgba(59,130,246,0.35)

---

## Template 1: Magic Link

**Subject:**
```
Your STILO AI Partners sign-in link
```

**Body (Source mode):**
```html
<table width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#080B14" style="background-color:#080B14;">
  <tr>
    <td align="center" style="padding:48px 24px;">
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;border-radius:16px;border:1px solid rgba(59,130,246,0.35);overflow:hidden;background-color:#0D1117;" bgcolor="#0D1117">
        <!-- Header -->
        <tr>
          <td style="background:linear-gradient(135deg,#2563EB 0%,#06B6D4 100%);padding:40px;border-bottom:1px solid rgba(59,130,246,0.3);" bgcolor="#2563EB">
            <p style="font-size:11px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:rgba(255,255,255,0.75);margin:0 0 12px 0;font-family:Arial,sans-serif;">STILO AI PARTNERS</p>
            <h1 style="color:#ffffff;font-size:22px;font-weight:700;margin:0;line-height:1.3;font-family:Arial,sans-serif;">Your sign-in link</h1>
          </td>
        </tr>
        <!-- Body -->
        <tr>
          <td style="padding:40px;background-color:#0D1117;" bgcolor="#0D1117">
            <p style="color:#8B9AB3;font-size:15px;line-height:1.65;margin:0 0 28px;font-family:Arial,sans-serif;">Here's your one-click link to get into your dashboard. It works once and expires in an hour.</p>
            <table cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td align="center" style="border-radius:10px;background:linear-gradient(135deg,#2563EB,#06B6D4);" bgcolor="#2563EB">
                  <a href="{{ .ConfirmationURL }}" style="display:inline-block;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;padding:14px 32px;border-radius:10px;letter-spacing:0.01em;font-family:Arial,sans-serif;">Sign in to my dashboard &rarr;</a>
                </td>
              </tr>
            </table>
            <p style="color:#4B5563;font-size:13px;margin:28px 0 0;line-height:1.6;font-family:Arial,sans-serif;">If the button doesn't work, copy this into your browser:<br><span style="color:#3B82F6;word-break:break-all;">{{ .ConfirmationURL }}</span></p>
          </td>
        </tr>
        <!-- Footer -->
        <tr>
          <td style="padding:20px 40px;border-top:1px solid rgba(59,130,246,0.15);background-color:#0D1117;" bgcolor="#0D1117">
            <p style="color:#4B5563;font-size:12px;margin:0;line-height:1.7;font-family:Arial,sans-serif;">Talk soon,<br><strong style="color:#8B9AB3;">Remy — STILO AI Partners</strong><br>Questions? Just reply to this email.</p>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
```

---

## Template 2: Confirm Signup

**Subject:**
```
Confirm your STILO AI Partners account
```

**Body (Source mode):**
```html
<table width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#080B14" style="background-color:#080B14;">
  <tr>
    <td align="center" style="padding:48px 24px;">
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;border-radius:16px;border:1px solid rgba(59,130,246,0.35);overflow:hidden;background-color:#0D1117;" bgcolor="#0D1117">
        <!-- Header -->
        <tr>
          <td style="background:linear-gradient(135deg,#2563EB 0%,#06B6D4 100%);padding:40px;border-bottom:1px solid rgba(59,130,246,0.3);" bgcolor="#2563EB">
            <p style="font-size:11px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:rgba(255,255,255,0.75);margin:0 0 12px 0;font-family:Arial,sans-serif;">STILO AI PARTNERS</p>
            <h1 style="color:#ffffff;font-size:22px;font-weight:700;margin:0;line-height:1.3;font-family:Arial,sans-serif;">Confirm your account</h1>
          </td>
        </tr>
        <!-- Body -->
        <tr>
          <td style="padding:40px;background-color:#0D1117;" bgcolor="#0D1117">
            <p style="color:#8B9AB3;font-size:15px;line-height:1.65;margin:0 0 28px;font-family:Arial,sans-serif;">One click and you're in. This link expires in 24 hours.</p>
            <table cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td align="center" style="border-radius:10px;background:linear-gradient(135deg,#2563EB,#06B6D4);" bgcolor="#2563EB">
                  <a href="{{ .ConfirmationURL }}" style="display:inline-block;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;padding:14px 32px;border-radius:10px;letter-spacing:0.01em;font-family:Arial,sans-serif;">Confirm my account &rarr;</a>
                </td>
              </tr>
            </table>
            <p style="color:#4B5563;font-size:13px;margin:28px 0 0;line-height:1.6;font-family:Arial,sans-serif;">If the button doesn't work, copy this into your browser:<br><span style="color:#3B82F6;word-break:break-all;">{{ .ConfirmationURL }}</span></p>
          </td>
        </tr>
        <!-- Footer -->
        <tr>
          <td style="padding:20px 40px;border-top:1px solid rgba(59,130,246,0.15);background-color:#0D1117;" bgcolor="#0D1117">
            <p style="color:#4B5563;font-size:12px;margin:0;line-height:1.7;font-family:Arial,sans-serif;">Talk soon,<br><strong style="color:#8B9AB3;">Remy — STILO AI Partners</strong><br>Questions? Just reply to this email.</p>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
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

To fix the "30-minute slot" copy:

1. Go to https://app.retellai.com
2. Open your agent settings
3. Find **Booking / Calendar** or **Post-call actions**
4. Look for the email notification template — change "30-minute" to "15-minute" everywhere it appears
5. Also update the Calendly link there if it's hardcoded to the old URL

The new Calendly link for all booking flows: `https://calendly.com/stiloaipartners/free-ai-strategy-call`
