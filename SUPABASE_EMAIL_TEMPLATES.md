# Supabase Email Templates — STILO AI Partners

Go to: https://supabase.com/dashboard/project/zsrskphpvgautfgklgxf/auth/templates

Update two templates: "Magic Link" and "Confirm signup". Use **Source mode** for each, and paste the FULL block (including the `<style>` head) for each.

These templates use a `<table>` layout with `bgcolor` attributes AND a `color-scheme: dark` lock so the dark background renders consistently. The lock is the fix for the iOS Mail / Gmail bug where the email inverted to a washed-out light blue and the text became unreadable. Three things do the work:

1. `<meta name="color-scheme" content="dark">` + `:root { color-scheme: dark; }` tells Apple Mail the email is dark-aware, so it stops auto-inverting it.
2. `@media (prefers-color-scheme: dark)` and `[data-ogsc]` / `[data-ogsb]` rules re-assert the dark palette if Gmail tries to swap colors.
3. Solid hex `bgcolor` fallbacks sit under every gradient, so if a client strips the gradient the area stays blue, never white.

Do not convert back to a div-based layout or strip the `<style>` head.

After pasting, send yourself a test link and open it on the iPhone Mail app AND the Gmail app. That real-device check is the only true confirmation (a browser preview can't reproduce mobile dark-mode inversion).

Blue palette: Core #2563EB | Bright #3B82F6 | Cyan #06B6D4 | Body text #C7D2E0 | Muted #8B9AB3

---

## Template 1: Magic Link

**Subject:**
```
Your STILO AI Partners sign-in link
```

**Body (Source mode):**
```html
<!DOCTYPE html>
<html lang="en" style="color-scheme:dark;supported-color-schemes:dark;">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="color-scheme" content="dark">
  <meta name="supported-color-schemes" content="dark">
  <style>
    :root { color-scheme: dark; supported-color-schemes: dark; }
    /* Re-assert the dark palette if the client tries to auto-tint the email
       (the iOS Mail / Gmail "everything goes washed-out light" bug). */
    @media (prefers-color-scheme: dark) {
      .so-page  { background-color:#080B14 !important; }
      .so-card  { background-color:#0D1117 !important; }
      .so-h1    { color:#ffffff !important; }
      .so-body  { color:#C7D2E0 !important; }
      .so-muted { color:#8B9AB3 !important; }
      .so-link  { color:#7FB2FF !important; }
    }
    /* Gmail dark-mode color-swap hooks. */
    [data-ogsc] .so-page,  [data-ogsb] .so-page  { background-color:#080B14 !important; }
    [data-ogsc] .so-card,  [data-ogsb] .so-card  { background-color:#0D1117 !important; }
    [data-ogsc] .so-h1    { color:#ffffff !important; }
    [data-ogsc] .so-body  { color:#C7D2E0 !important; }
    [data-ogsc] .so-muted { color:#8B9AB3 !important; }
  </style>
</head>
<body class="so-page" style="margin:0;padding:0;background-color:#080B14;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:#080B14;">Your one-click sign-in link for STILO AI Partners. Works once, expires in an hour.</div>
  <table role="presentation" class="so-page" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#080B14" style="background-color:#080B14;">
    <tr>
      <td align="center" style="padding:48px 24px;">
        <table role="presentation" class="so-card" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#0D1117" style="max-width:520px;border-radius:16px;border:1px solid #1E3A6E;overflow:hidden;background-color:#0D1117;">
          <!-- Header -->
          <tr>
            <td bgcolor="#1D4FD7" style="background-color:#1D4FD7;background:linear-gradient(135deg,#2563EB 0%,#06B6D4 100%);padding:40px;">
              <p style="font-size:11px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:#E5EEFF;margin:0 0 12px 0;font-family:Arial,Helvetica,sans-serif;">STILO AI PARTNERS</p>
              <h1 class="so-h1" style="color:#ffffff;font-size:22px;font-weight:700;margin:0;line-height:1.3;font-family:Arial,Helvetica,sans-serif;">Your sign-in link</h1>
            </td>
          </tr>
          <!-- Body -->
          <tr>
            <td class="so-card" bgcolor="#0D1117" style="padding:40px;background-color:#0D1117;">
              <p class="so-body" style="color:#C7D2E0;font-size:15px;line-height:1.65;margin:0 0 28px;font-family:Arial,Helvetica,sans-serif;">Here's your one-click link to get into your dashboard. It works once and expires in an hour.</p>
              <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td align="center" bgcolor="#1D4FD7" style="border-radius:10px;background-color:#1D4FD7;background:linear-gradient(135deg,#2563EB,#06B6D4);">
                    <a href="{{ .ConfirmationURL }}" style="display:inline-block;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;padding:14px 32px;border-radius:10px;font-family:Arial,Helvetica,sans-serif;">Sign in to my dashboard &rarr;</a>
                  </td>
                </tr>
              </table>
              <p class="so-muted" style="color:#8B9AB3;font-size:13px;margin:28px 0 0;line-height:1.6;font-family:Arial,Helvetica,sans-serif;">If the button doesn't work, copy this into your browser:<br><span class="so-link" style="color:#7FB2FF;word-break:break-all;">{{ .ConfirmationURL }}</span></p>
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td class="so-card" bgcolor="#0D1117" style="padding:20px 40px;border-top:1px solid #16233D;background-color:#0D1117;">
              <p class="so-muted" style="color:#8B9AB3;font-size:12px;margin:0;line-height:1.7;font-family:Arial,Helvetica,sans-serif;">Talk soon,<br><strong style="color:#C7D2E0;">Remy at STILO AI Partners</strong><br>Questions? Just reply to this email.</p>
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
<html lang="en" style="color-scheme:dark;supported-color-schemes:dark;">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="color-scheme" content="dark">
  <meta name="supported-color-schemes" content="dark">
  <style>
    :root { color-scheme: dark; supported-color-schemes: dark; }
    @media (prefers-color-scheme: dark) {
      .so-page  { background-color:#080B14 !important; }
      .so-card  { background-color:#0D1117 !important; }
      .so-h1    { color:#ffffff !important; }
      .so-body  { color:#C7D2E0 !important; }
      .so-muted { color:#8B9AB3 !important; }
      .so-link  { color:#7FB2FF !important; }
    }
    [data-ogsc] .so-page,  [data-ogsb] .so-page  { background-color:#080B14 !important; }
    [data-ogsc] .so-card,  [data-ogsb] .so-card  { background-color:#0D1117 !important; }
    [data-ogsc] .so-h1    { color:#ffffff !important; }
    [data-ogsc] .so-body  { color:#C7D2E0 !important; }
    [data-ogsc] .so-muted { color:#8B9AB3 !important; }
  </style>
</head>
<body class="so-page" style="margin:0;padding:0;background-color:#080B14;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:#080B14;">Confirm your STILO AI Partners account. This link expires in 24 hours.</div>
  <table role="presentation" class="so-page" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#080B14" style="background-color:#080B14;">
    <tr>
      <td align="center" style="padding:48px 24px;">
        <table role="presentation" class="so-card" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#0D1117" style="max-width:520px;border-radius:16px;border:1px solid #1E3A6E;overflow:hidden;background-color:#0D1117;">
          <!-- Header -->
          <tr>
            <td bgcolor="#1D4FD7" style="background-color:#1D4FD7;background:linear-gradient(135deg,#2563EB 0%,#06B6D4 100%);padding:40px;">
              <p style="font-size:11px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:#E5EEFF;margin:0 0 12px 0;font-family:Arial,Helvetica,sans-serif;">STILO AI PARTNERS</p>
              <h1 class="so-h1" style="color:#ffffff;font-size:22px;font-weight:700;margin:0;line-height:1.3;font-family:Arial,Helvetica,sans-serif;">Confirm your account</h1>
            </td>
          </tr>
          <!-- Body -->
          <tr>
            <td class="so-card" bgcolor="#0D1117" style="padding:40px;background-color:#0D1117;">
              <p class="so-body" style="color:#C7D2E0;font-size:15px;line-height:1.65;margin:0 0 28px;font-family:Arial,Helvetica,sans-serif;">One click and you're in. This link expires in 24 hours.</p>
              <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td align="center" bgcolor="#1D4FD7" style="border-radius:10px;background-color:#1D4FD7;background:linear-gradient(135deg,#2563EB,#06B6D4);">
                    <a href="{{ .ConfirmationURL }}" style="display:inline-block;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;padding:14px 32px;border-radius:10px;font-family:Arial,Helvetica,sans-serif;">Confirm my account &rarr;</a>
                  </td>
                </tr>
              </table>
              <p class="so-muted" style="color:#8B9AB3;font-size:13px;margin:28px 0 0;line-height:1.6;font-family:Arial,Helvetica,sans-serif;">If the button doesn't work, copy this into your browser:<br><span class="so-link" style="color:#7FB2FF;word-break:break-all;">{{ .ConfirmationURL }}</span></p>
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td class="so-card" bgcolor="#0D1117" style="padding:20px 40px;border-top:1px solid #16233D;background-color:#0D1117;">
              <p class="so-muted" style="color:#8B9AB3;font-size:12px;margin:0;line-height:1.7;font-family:Arial,Helvetica,sans-serif;">Talk soon,<br><strong style="color:#C7D2E0;">Remy at STILO AI Partners</strong><br>Questions? Just reply to this email.</p>
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

To fix the "30-minute slot" copy:

1. Go to https://app.retellai.com
2. Open your agent settings
3. Find **Booking / Calendar** or **Post-call actions**
4. Look for the email notification template — change "30-minute" to "15-minute" everywhere it appears
5. Also update the Calendly link there if it's hardcoded to the old URL

The new Calendly link for all booking flows: `https://calendly.com/stiloaipartners/free-ai-strategy-call`
