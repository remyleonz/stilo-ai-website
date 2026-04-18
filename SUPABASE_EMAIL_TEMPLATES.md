# Supabase Email Templates — STILO AI Partners

Go to: https://supabase.com/dashboard/project/zsrskphpvgautfgklgxf/auth/templates

Update **two** templates: "Confirm signup" and "Magic Link". Paste the HTML below into each.

---

## Template 1: Confirm Signup

**Subject line:**
```
Confirm your STILO AI Partners account
```

**Body (paste into the HTML editor):**
```html
<div style="font-family: Inter, -apple-system, sans-serif; background: #0a0a0f; padding: 48px 24px; min-height: 100vh;">
  <div style="max-width: 520px; margin: 0 auto; background: #12121a; border-radius: 16px; border: 1px solid rgba(168,85,247,0.2); overflow: hidden;">

    <!-- Header -->
    <div style="background: linear-gradient(135deg, rgba(124,58,237,0.4) 0%, rgba(10,10,15,0.9) 100%); padding: 40px 40px 32px; border-bottom: 1px solid rgba(168,85,247,0.15);">
      <div style="font-size: 11px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; color: #c084fc; margin-bottom: 16px;">STILO AI PARTNERS</div>
      <h1 style="color: #f0f0f5; font-size: 24px; font-weight: 700; margin: 0; line-height: 1.3;">Confirm your account</h1>
    </div>

    <!-- Body -->
    <div style="padding: 40px;">
      <p style="color: #8888a0; font-size: 15px; line-height: 1.6; margin: 0 0 28px;">
        Click the button below to confirm your email and access your client dashboard. This link expires in 24 hours.
      </p>

      <a href="{{ .ConfirmationURL }}"
         style="display: inline-block; background: linear-gradient(135deg, #7c3aed, #a855f7); color: #fff; font-size: 15px; font-weight: 600; text-decoration: none; padding: 14px 32px; border-radius: 10px; letter-spacing: 0.01em;">
        Confirm my account
      </a>

      <p style="color: #555570; font-size: 13px; margin: 28px 0 0; line-height: 1.6;">
        If the button doesn't work, copy and paste this link into your browser:<br>
        <span style="color: #a855f7; word-break: break-all;">{{ .ConfirmationURL }}</span>
      </p>
    </div>

    <!-- Footer -->
    <div style="padding: 24px 40px; border-top: 1px solid rgba(168,85,247,0.1);">
      <p style="color: #555570; font-size: 12px; margin: 0; line-height: 1.6;">
        You're receiving this because you created an account at stiloaipartners.com.<br>
        If you didn't sign up, you can safely ignore this email.
      </p>
    </div>

  </div>
</div>
```

---

## Template 2: Magic Link

**Subject line:**
```
Your STILO AI Partners sign-in link
```

**Body (paste into the HTML editor):**
```html
<div style="font-family: Inter, -apple-system, sans-serif; background: #0a0a0f; padding: 48px 24px; min-height: 100vh;">
  <div style="max-width: 520px; margin: 0 auto; background: #12121a; border-radius: 16px; border: 1px solid rgba(168,85,247,0.2); overflow: hidden;">

    <!-- Header -->
    <div style="background: linear-gradient(135deg, rgba(124,58,237,0.4) 0%, rgba(10,10,15,0.9) 100%); padding: 40px 40px 32px; border-bottom: 1px solid rgba(168,85,247,0.15);">
      <div style="font-size: 11px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; color: #c084fc; margin-bottom: 16px;">STILO AI PARTNERS</div>
      <h1 style="color: #f0f0f5; font-size: 24px; font-weight: 700; margin: 0; line-height: 1.3;">Your sign-in link</h1>
    </div>

    <!-- Body -->
    <div style="padding: 40px;">
      <p style="color: #8888a0; font-size: 15px; line-height: 1.6; margin: 0 0 28px;">
        Click the button below to sign in to your client dashboard. This link is single-use and expires in 1 hour.
      </p>

      <a href="{{ .ConfirmationURL }}"
         style="display: inline-block; background: linear-gradient(135deg, #7c3aed, #a855f7); color: #fff; font-size: 15px; font-weight: 600; text-decoration: none; padding: 14px 32px; border-radius: 10px; letter-spacing: 0.01em;">
        Sign in to my dashboard
      </a>

      <p style="color: #555570; font-size: 13px; margin: 28px 0 0; line-height: 1.6;">
        If the button doesn't work, copy and paste this link into your browser:<br>
        <span style="color: #a855f7; word-break: break-all;">{{ .ConfirmationURL }}</span>
      </p>
    </div>

    <!-- Footer -->
    <div style="padding: 24px 40px; border-top: 1px solid rgba(168,85,247,0.1);">
      <p style="color: #555570; font-size: 12px; margin: 0; line-height: 1.6;">
        You requested this link from stiloaipartners.com. If you didn't, you can safely ignore this email.<br>
        Questions? Reply to this email and Remy will get back to you.
      </p>
    </div>

  </div>
</div>
```

---

## Optional: Custom SMTP (to send from your own email address)

Right now emails come from `noreply@mail.app.supabase.io`. To send from `hello@stiloaipartners.com` or similar:

1. Sign up at https://resend.com (free up to 3,000 emails/month)
2. Add and verify your domain `stiloaipartners.com`
3. Get your Resend SMTP credentials
4. In Supabase → Authentication → SMTP Settings:
   - Host: `smtp.resend.com`
   - Port: `465`
   - Username: `resend`
   - Password: your Resend API key
   - Sender name: `STILO AI Partners`
   - Sender email: `hello@stiloaipartners.com`

Do this once you have a custom domain email set up. Until then the templates above are a big improvement over the default.
