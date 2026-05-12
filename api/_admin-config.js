/**
 * Shared admin config. Single source of truth for who can sign into
 * /admin/ and call admin-gated endpoints. Was duplicated across
 * api/prospects/_shared.js, api/admin/impersonate.js, api/client-leads.js,
 * api/client-leads/state.js. Maintenance gotcha: adding a new admin
 * required four edits.
 *
 * Note: app/leads.html (frontend) inlines the same list — keep it in
 * sync manually until we ship a public /api/admin-emails endpoint.
 */
module.exports = {
    ADMIN_EMAILS: [
        'remyleon11@gmail.com',
        'stiloaiconsulting@gmail.com',
        'remyleon@stiloaipartners.com',
        'davidcoira@stiloaipartners.com'
    ]
};
