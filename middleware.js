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
    url.pathname = base + (url.pathname === '/' ? '/' : url.pathname);
    return new Response(null, { headers: { 'x-middleware-rewrite': url.toString() } });
}
