# Supabase Email Templates — STILO AI Partners

Go to: https://supabase.com/dashboard/project/zsrskphpvgautfgklgxf/auth/templates

Update two templates: "Magic Link" and "Confirm signup". Use Source mode for each.

Blue palette: Core #2563EB | Bright #3B82F6 | Cyan #06B6D4 | Glow rgba(59,130,246,0.35)

---

## Template 1: Magic Link

**Subject:**
```
Your STILO AI Partners sign-in link
```

**Body (Source mode):**
```html
<div style="font-family:Inter,-apple-system,sans-serif;background:#080B14;padding:48px 24px;">
  <div style="max-width:520px;margin:0 auto;background:#0D1117;border-radius:16px;border:1px solid rgba(59,130,246,0.35);overflow:hidden;">
    <div style="background:linear-gradient(135deg,#2563EB 0%,#06B6D4 100%);padding:40px;border-bottom:1px solid rgba(59,130,246,0.3);">
      <div style="font-size:11px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:rgba(255,255,255,0.75);margin-bottom:12px;">STILO AI PARTNERS</div>
      <h1 style="color:#ffffff;font-size:22px;font-weight:700;margin:0;line-height:1.3;">Your sign-in link</h1>
    </div>
    <div style="padding:40px;">
      <p style="color:#8B9AB3;font-size:15px;line-height:1.65;margin:0 0 28px;">Here's your one-click link to get into your dashboard. It works once and expires in an hour.</p>
      <a href="{{ .ConfirmationURL }}" style="display:inline-block;background:linear-gradient(135deg,#2563EB,#06B6D4);color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;padding:14px 32px;border-radius:10px;letter-spacing:0.01em;">Sign in to my dashboard →</a>
      <p style="color:#4B5563;font-size:13px;margin:28px 0 0;line-height:1.6;">If the button doesn't work, copy this into your browser:<br><span style="color:#3B82F6;word-break:break-all;">{{ .ConfirmationURL }}</span></p>
    </div>
    <div style="padding:20px 40px;border-top:1px solid rgba(59,130,246,0.15);">
      <p style="color:#4B5563;font-size:12px;margin:0;line-height:1.7;">Talk soon,<br><strong style="color:#8B9AB3;">Remy — STILO AI Partners</strong><br>Questions? Just reply to this email.</p>
    </div>
  </div>
</div>
```

---

## Template 2: Confirm Signup

**Subject:**
```
Confirm your STILO AI Partners account
```

**Body (Source mode):**
```html
<div style="font-family:Inter,-apple-system,sans-serif;background:#080B14;padding:48px 24px;">
  <div style="max-width:520px;margin:0 auto;background:#0D1117;border-radius:16px;border:1px solid rgba(59,130,246,0.35);overflow:hidden;">
    <div style="background:linear-gradient(135deg,#2563EB 0%,#06B6D4 100%);padding:40px;border-bottom:1px solid rgba(59,130,246,0.3);">
      <div style="font-size:11px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:rgba(255,255,255,0.75);margin-bottom:12px;">STILO AI PARTNERS</div>
      <h1 style="color:#ffffff;font-size:22px;font-weight:700;margin:0;line-height:1.3;">Confirm your account</h1>
    </div>
    <div style="padding:40px;">
      <p style="color:#8B9AB3;font-size:15px;line-height:1.65;margin:0 0 28px;">One click and you're in. This link expires in 24 hours.</p>
      <a href="{{ .ConfirmationURL }}" style="display:inline-block;background:linear-gradient(135deg,#2563EB,#06B6D4);color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;padding:14px 32px;border-radius:10px;letter-spacing:0.01em;">Confirm my account →</a>
      <p style="color:#4B5563;font-size:13px;margin:28px 0 0;line-height:1.6;">If the button doesn't work, copy this into your browser:<br><span style="color:#3B82F6;word-break:break-all;">{{ .ConfirmationURL }}</span></p>
    </div>
    <div style="padding:20px 40px;border-top:1px solid rgba(59,130,246,0.15);">
      <p style="color:#4B5563;font-size:12px;margin:0;line-height:1.7;">Talk soon,<br><strong style="color:#8B9AB3;">Remy — STILO AI Partners</strong><br>Questions? Just reply to this email.</p>
    </div>
  </div>
</div>
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
