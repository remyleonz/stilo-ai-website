/**
 * Host-based routing that runs BEFORE the filesystem.
 *
 * vercel.json `rewrites` are evaluated only after Vercel fails to find a file at
 * the requested path. The project root has an index.html, so a request for "/"
 * on ANY host is served the STILO home page and the host rewrites never run
 * (observed 2026-10-02: blasonspaequipment., app. and admin. all returned the
 * marketing page at "/"). Edge Middleware runs first, so the rewrite here wins.
 *
 * blasononline.stiloaipartners.com (and blasonspaequipment.) -> /blason/<path>
 *
 * Excluded from the matcher so they pass straight through to the file or
 * function: /api (the page's own endpoints), /_vercel (analytics), /assets, and
 * /blason itself (the page links its logo as /blason/logo.png, which must still
 * resolve on the subdomain).
 */
export const config = {
    matcher: ['/((?!api/|_vercel/|assets/|blason/).*)'],
};

const HOSTS = {
    'blasononline.stiloaipartners.com': '/blason',      // the one in the emails (matches blasononline.com)
    'blasonspaequipment.stiloaipartners.com': '/blason', // first name used 2026-10-02, kept so old links work
};

export default function middleware(request) {
    const url = new URL(request.url);
    const base = HOSTS[url.hostname];
    if (!base) return;
    // Short link for texts: /v/<lead>/<token>[/es] -> the page with the signed
    // lead params. A text with the full query string is 110 characters of URL;
    // this one is 60. utm_source=sms so the Funnel tab counts it as the text.
    const m = url.pathname.match(/^\/v\/(\d+)\/([A-Za-z0-9_-]{10,40})(?:\/(es|en))?\/?$/);
    if (m) {
        url.pathname = base + '/';
        url.search = '?lid=' + m[1] + '&t=' + m[2] + '&utm_source=sms&utm_campaign=vsl' + (m[3] === 'es' ? '&lang=es' : '');
        return new Response(null, { headers: { 'x-middleware-rewrite': url.toString() } });
    }
    url.pathname = base + (url.pathname === '/' ? '/' : url.pathname);
    return new Response(null, { headers: { 'x-middleware-rewrite': url.toString() } });
}
