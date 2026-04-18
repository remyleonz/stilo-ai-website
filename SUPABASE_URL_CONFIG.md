# Supabase URL Configuration — Magic Link Fix

## The bug (diagnosed 2026-04-17)

Magic link emails land clients on the STILO AI marketing site instead of the client dashboard.

**Root cause:** Supabase only honors `emailRedirectTo` when the URL is on the project's **Redirect URL allowlist**. When it isn't, Supabase silently falls back to the **Site URL**. Our deployed `auth.html` passes `emailRedirectTo: '/dashboard.html'` (both in `signInWithOtp` and `signUp`), but `/dashboard.html` was never added to the allowlist, so Supabase was ignoring it and falling back to the root Site URL (the marketing homepage).

**Code already correct:** No code changes needed. The deployed `auth.html` at commit `fbd072a Phase 4: live auth + dynamic dashboard` already does the right thing.

## One-time fix (Supabase Dashboard — manual)

Project ref: `zsrskphpvgautfgklgxf` (stilo-ai-partners)

1. Open https://supabase.com/dashboard/project/zsrskphpvgautfgklgxf/auth/url-configuration
2. **Site URL** — set to:
   ```
   https://stiloaipartners.com/dashboard.html
   ```
3. **Additional Redirect URLs** — add these entries (keep existing ones):
   ```
   https://stiloaipartners.com/dashboard.html
   https://stiloaipartners.com/dashboard.html?*
   http://localhost:8081/dashboard.html
   http://localhost:8081/dashboard.html?*
   ```
   The `?*` variant allows query-string parameters (Supabase appends `?access_token=...` to the redirect).
4. Click **Save**.

## Verify

1. Go to https://stiloaipartners.com/auth.html
2. Enter a real email + click "Sign in with magic link"
3. Open the email and click the link
4. Confirm the browser lands on `https://stiloaipartners.com/dashboard.html` and the "Client Dashboard" renders (not the marketing homepage)

If it still lands on the homepage, paste the full redirect URL from the email (before clicking) so we can check whether Supabase is appending it correctly.

## Future migration to `/app/`

When ready to move the dashboard to `/app/` (precursor to `app.stiloaipartners.com` subdomain), update:
- `auth.html` — change both `emailRedirectTo` values from `/dashboard.html` to `/app/`
- Supabase dashboard — add `/app/` variants to the allowlist and update Site URL
- Leave `/dashboard.html` allowlist entries for 48 hours as a fallback

Not needed for today's outreach.
