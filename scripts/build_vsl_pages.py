#!/usr/bin/env python3
"""
build_vsl_pages.py — generate the niche VSL landing pages and the confirmation page.

    python3 scripts/build_vsl_pages.py

Writes sites/stilo-ai/vsl/<slug>.html for each niche, plus vsl/pre-meeting.html.

SEQUENCE (changed 2026-08-05). A prospect who books off a cold call used to get
ONLY the 3-minute "who I am / how we charge" video and never saw the demo, so
nothing made them WANT the meeting. Show rate was 65%. Now:
  confirmation email -> /vsl/<niche>?confirm=1   the 6-min demo + Confirm button
  after they confirm -> /vsl/pre-meeting          the 3-min objection-handler
Desire first, doubt-killing second.

WHY GENERATED. The old /agents/*.html were eight hand-maintained 32KB files that
each carried their own copy of the CSS, footer, booking modal and player. They
drifted. Everything structural here comes from ONE template (agents/receptionist.html,
the last page that was actually styled) and only the hero, copy, FAQ and video
differ per niche. Change the design once, re-run, all six stay identical.

WHY /vsl/ AND NOT /agents/. These URLs are sent to prospects. After the pivot,
stiloaipartners.com/agents/roofing advertises the product we stopped selling.
vercel.json redirects every old /agents/* path here so links already sitting in
inboxes keep working.
"""
import os, re, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TEMPLATE = os.path.join(ROOT, "agents", "receptionist.html")
OUTDIR = os.path.join(ROOT, "vsl")

# Confirmation video. Re-recorded on Loom 2026-08-06, so it now uses the same
# click-to-play player as the five niche pages instead of a self-hosted mp4.
CONFIRM_LOOM = os.environ.get("CONFIRM_VSL_LOOM", "cd10f731ce3241a49fbae438a6f26183")
CONFIRM_THUMB = os.environ.get("CONFIRM_VSL_THUMB", "f45f949535d5ad0a")

NICHES = [
    dict(
        slug="commercial-cleaning", name="Commercial Cleaning",
        loom="2558bfb9c4fc419db9bbcb0e44d933c0", thumb="5318064cdbcd3431",
        h1="More buildings under contract,<br>booked onto your calendar for you.",
        title="Commercial Cleaning: More Buildings on Contract - STILO AI Partners",
        desc="We find every building in your area that fits, work them across email, phone and text, "
             "and put the people who sign the janitorial contract on your calendar. Watch the walkthrough.",
        buyer="the people who sign the janitorial contract",
        meetings="12",
        qualified="a decision maker over the janitorial contract, at a facility of 10,000 sq ft or more "
                  "in your radius, with the contract actually in play",
    ),
    dict(
        slug="commercial-roofing", name="Commercial Roofing",
        loom="f3cc25a09e9c41c5b259feab0a409b28", thumb="1ac9f32398727c10",
        h1="Commercial re-roofs on your calendar,<br>booked before it turns into a bid war.",
        title="Commercial Roofing: Get in Before the Bid - STILO AI Partners",
        desc="We find the building owners whose roofs are at end of life, work them across email, phone "
             "and text, and put them on your calendar before it turns into a three-way bid.",
        buyer="building owners and property managers",
        meetings="8",
        qualified="someone with authority over roofing spend, on a commercial building 15 years or older "
                  "or with a known active issue, with budget or a claim in play",
    ),
    dict(
        slug="staffing", name="Staffing",
        loom="501bdda7a0304e3b8534223489c34392", thumb="83a960ae7a2510c8",
        h1="New client accounts on your calendar,<br>booked while your team keeps recruiting.",
        title="Staffing: More Client Accounts on the Calendar - STILO AI Partners",
        desc="We find the employers who are actively hiring the roles you fill, work them across email, "
             "phone and text, and put the hiring authority on your calendar.",
        buyer="hiring managers and HR directors",
        meetings="10",
        qualified="a hiring authority at a company with 20 or more employees, actively hiring three or "
                  "more roles in your specialty in the next 90 days",
    ),
    dict(
        slug="freight", name="Freight",
        loom="55a25c927eec46f7a91e756f18eae0e7", thumb="70a401efcc32f10e",
        h1="Direct shipper accounts on your calendar,<br>booked off the load boards for good.",
        title="Freight: Direct Shipper Accounts - STILO AI Partners",
        desc="We find the shippers running your lanes, work them across email, phone and text, and put "
             "the person who picks carriers on your calendar.",
        buyer="logistics and supply chain managers",
        meetings="10",
        qualified="a decision maker over carrier and broker selection, at a shipper moving five or more "
                  "loads a week on lanes you actually run",
    ),
    dict(
        slug="industrial-supplies", name="Industrial Supplies & Equipment",
        loom="e55a0424e276441cbaf973fa2817ac75", thumb="b3fb48c17d54dc82",
        h1="In the room before the spec is written,<br>on meetings booked for you.",
        title="Industrial Supplies & Equipment: In Before the Spec - STILO AI Partners",
        desc="We find the plants running your equipment class, work them across email, phone and text, "
             "and get you in the conversation before the spec is written.",
        buyer="plant, operations and procurement leads",
        meetings="6",
        qualified="someone with budget authority or direct influence, at a facility running your "
                  "equipment class, with a capex need inside 12 months",
    ),
]

CTA = "Book a 15-Minute Meeting with a Partner"


def faq(n):
    """One shared FAQ. The offer is identical across niches, so only the buyer
    wording and the guaranteed meeting count change."""
    qa = [
        ("What exactly do I get?",
         "Qualified meetings with %s, on your calendar, with a brief on who you're meeting and why "
         "they're in the market. Before that, in week one, you get the researched list itself: every "
         "company in your territory that fits, with the person who signs by name, their direct email "
         "and their direct line." % n["buyer"]),
        ("What does &ldquo;qualified&rdquo; actually mean?",
         "It's defined in writing before you pay anything. For your business it means %s, who confirmed "
         "the meeting and knows what it's about. If a meeting we book doesn't meet that standard it "
         "doesn't count, you're not billed for it, and we replace it free." % n["qualified"]),
        ("How do you charge?",
         "Two pieces: a setup fee to build it, and a flat fee for each qualified meeting that shows up. "
         "No retainer, and no monthly invoice that arrives "
         "whether it worked or not. The exact numbers depend on what a customer is worth in your "
         "business, which is why we ask about that on the call before quoting you."),
        ("What's the guarantee?",
         "%s qualified meetings on your calendar in your first 60 days. If we don't hit it we keep "
         "working your list at no additional cost until we do, and your setup fee comes back." % n["meetings"]),
        ("Do I have to do the calling?",
         "No. You get a rep assigned to your account and nobody else's, working your list on the phone "
         "every day, alongside the email and text sequences. Your team's job starts when someone is "
         "already sitting on the calendar."),
        ("Do you work with my competitors?",
         "No. One company per market. We build your list out of the same pool your competitors sit in, "
         "so we can't ethically work both sides of it. When a territory is taken it's taken."),
    ]
    out = []
    for i, (q, a) in enumerate(qa):
        out.append(
            '      <details class="qa"%s>\n'
            '        <summary>%s<span class="plus"></span></summary>\n'
            '        <div class="a"><p>%s</p></div>\n'
            '      </details>' % (" open" if i == 0 else "", q, a)
        )
    return "\n".join(out)


def build_page(tpl, n):
    s = tpl

    # ---- head ----
    s = re.sub(r"<title>.*?</title>", "<title>%s</title>" % n["title"], s, count=1, flags=re.S)
    s = re.sub(r'(<meta name="description" content=")[^"]*(")', lambda m: m.group(1) + n["desc"] + m.group(2), s, count=1)
    s = re.sub(r'(<meta property="og:title" content=")[^"]*(")', lambda m: m.group(1) + n["title"] + m.group(2), s, count=1)
    s = re.sub(r'(<meta property="og:description" content=")[^"]*(")', lambda m: m.group(1) + n["desc"] + m.group(2), s, count=1)

    # ---- hero: headline + player + CTA ----
    hero = (
        '<section class="hero">\n'
        '  <div class="container">\n'
        '    <h1>%s</h1>\n'
        '    <div class="videowrap">\n'
        '      <!-- %s VSL (Loom). Generated by scripts/build_vsl_pages.py. -->\n'
        '      <button type="button" class="vsl-play" '
        'style="background-image:url(https://cdn.loom.com/sessions/thumbnails/%s-%s.jpg)" '
        'onclick="startVsl(this)" '
        'data-loom="%s" data-agent="%s" aria-label="Play the walkthrough">'
        '<span class="vsl-orb"></span></button>\n'
        '    </div>\n'
        '    <div class="ctaband">\n'
        '      <h2>%s</h2>\n'
        '      <a class="btn-primary js-book">Book</a>\n'
        '    </div>\n'
        '  </div>\n'
        '</section>' % (n["h1"], n["name"], n["loom"], n["thumb"], n["loom"], n["slug"], CTA)
    )
    s = re.sub(r'<section class="hero">.*?</section>', lambda _: hero, s, count=1, flags=re.S)

    # ---- FAQ ----
    s = re.sub(r'(<div class="faq-list">).*?(\s*</div>\s*<div class="faq-foot")',
               lambda m: m.group(1) + "\n" + faq(n) + "\n    " + m.group(2).lstrip("\n"),
               s, count=1, flags=re.S)

    # ---- confirm helper moved with the pages ----
    s = s.replace('src="/agents/_confirm.js"', 'src="/vsl/_confirm.js"')
    return s


def build_confirmation(tpl):
    """Full-screen face video. No Loom, no poster: a plain <video> so it can be
    served from Supabase Storage and scrubbed."""
    s = tpl
    title = "Before we talk - STILO AI Partners"
    desc = ("A short video before our call: who I am, what STILO does, how we charge, and exactly "
            "what will happen on the call.")
    s = re.sub(r"<title>.*?</title>", "<title>%s</title>" % title, s, count=1, flags=re.S)
    s = re.sub(r'(<meta name="description" content=")[^"]*(")', lambda m: m.group(1) + desc + m.group(2), s, count=1)
    s = re.sub(r'(<meta property="og:title" content=")[^"]*(")', lambda m: m.group(1) + title + m.group(2), s, count=1)
    s = re.sub(r'(<meta property="og:description" content=")[^"]*(")', lambda m: m.group(1) + desc + m.group(2), s, count=1)

    hero = (
        '<section class="hero">\n'
        '  <div class="container">\n'
        '    <h1>You are confirmed.<br>Here is who you are meeting.</h1>\n'
        '    <div class="videowrap">\n'
        '      <button type="button" class="vsl-play" '
        'style="background-image:url(https://cdn.loom.com/sessions/thumbnails/'
        + CONFIRM_LOOM + '-' + CONFIRM_THUMB + '.jpg)" '
        'onclick="startVsl(this)" data-loom="' + CONFIRM_LOOM + '" '
        'data-agent="confirmation" aria-label="Play the confirmation walkthrough">'
        '<span class="vsl-orb"></span></button>\n'
        '    </div>\n'
        '    <div class="mtg" id="mtgCard">\n'
        '      <div class="mtg-when">\n'
        '        <span class="mtg-k" id="mtgKey">Your meeting</span>\n'
        '        <strong id="mtgWhen">Check your calendar invite</strong>\n'
        '        <span class="mtg-sub" id="mtgSub">15 minutes with Remy Leon, founder</span>\n'
        '        <a class="mtg-link" id="mtgLink" target="_blank" rel="noopener" hidden>Join on Google Meet</a>\n'
        '      </div>\n'
        '      <div class="mtg-agenda">\n'
        '        <span class="mtg-k">What we will cover</span>\n'
        '        <ol id="mtgAgenda">\n'
        '          <li>What one closed customer is actually worth to you</li>\n'
        '          <li>Who you are trying to get in front of, specifically</li>\n'
        '          <li>Whether your market has the density to hit a number</li>\n'
        '          <li>What your first 30 days would look like</li>\n'
        '        </ol>\n'
        '        <p class="mtg-foot">Nothing to prepare. If the numbers do not work in your market, '
        'I will tell you on the call.</p>\n'
        '      </div>\n'
        '    </div>\n'
        '  </div>\n'
        '</section>'
    )
    s = re.sub(r'<section class="hero">.*?</section>', lambda _: hero, s, count=1, flags=re.S)

    qa = [
        ("What happens on the call?",
         "Fifteen to twenty minutes. I'll ask what a customer is worth to you, what you close today, and "
         "what your territory looks like. If it's a fit I'll show you exactly what we'd do and what it "
         "costs. Then I'll ask you for a decision, and no is a completely fine answer."),
        ("What should I bring?",
         "Your numbers, and whoever else has to say yes. If there's a partner in the decision, get them "
         "on with us. I'd rather answer their questions myself than have you sell it for me secondhand."),
        ("How do you charge?",
         "A setup fee and a flat fee per qualified meeting we book. No "
         "retainer. The exact figures depend on what a customer is worth in your business, which is "
         "why I want to hear yours before quoting."),
        ("I've been burned by an agency before.",
         "Most people I talk to have, usually a retainer where someone ran ads and sent a report. That's "
         "why there's no retainer here. If the meetings don't show up on your calendar you don't pay "
         "for them, and the meeting count is guaranteed in writing."),
        ("Can I reschedule?",
         "Yes, just reply to the confirmation email and we'll find a better time. I'd rather move it "
         "than have you sit through it distracted."),
    ]
    items = "\n".join(
        '      <details class="qa"%s>\n        <summary>%s<span class="plus"></span></summary>\n'
        '        <div class="a"><p>%s</p></div>\n      </details>' % (" open" if i == 0 else "", q, a)
        for i, (q, a) in enumerate(qa))
    s = re.sub(r'(<div class="faq-list">).*?(\s*</div>\s*<div class="faq-foot")',
               lambda m: m.group(1) + "\n" + items + "\n    " + m.group(2).lstrip("\n"),
               s, count=1, flags=re.S)

    s = s.replace('</style>', '\n  /* ===== pre-meeting: their real meeting, not another booking CTA ===== */\n  .mtg{width:min(920px,94vw);margin:34px auto 0;display:grid;grid-template-columns:minmax(0,.85fr) minmax(0,1.15fr);\n    gap:0;border:1px solid var(--stroke-hi);border-radius:var(--radius-lg);overflow:hidden;\n    background:linear-gradient(168deg,#101018,#0A0B10 70%)}\n  .mtg-when{padding:30px 30px 32px;border-right:1px solid var(--stroke);display:flex;flex-direction:column}\n  .mtg-agenda{padding:30px 32px 32px}\n  .mtg-k{display:block;font-family:var(--font-mono);font-size:.62rem;letter-spacing:.16em;text-transform:uppercase;\n    color:var(--fg-3);margin-bottom:14px}\n  .mtg-when strong{font-family:var(--font-display);font-weight:600;font-size:clamp(1.3rem,2.3vw,1.72rem);\n    line-height:1.18;color:var(--fg);letter-spacing:.004em}\n  .mtg-sub{margin-top:10px;font-size:.94rem;color:var(--fg-2)}\n  .mtg-link{margin-top:auto;padding-top:20px;font-family:var(--font-mono);font-size:.72rem;letter-spacing:.1em;\n    text-transform:uppercase;color:var(--accent-glow)}\n  .mtg-link:hover{color:#fff}\n  .mtg-agenda ol{margin:0;padding:0;list-style:none;counter-reset:ag}\n  .mtg-agenda li{counter-increment:ag;position:relative;padding:0 0 0 34px;margin-bottom:13px;\n    color:var(--fg-2);font-size:1rem;line-height:1.45}\n  .mtg-agenda li:last-of-type{margin-bottom:0}\n  .mtg-agenda li::before{content:counter(ag,decimal-leading-zero);position:absolute;left:0;top:2px;\n    font-family:var(--font-mono);font-size:.68rem;color:var(--accent-glow)}\n  .mtg-foot{margin-top:20px;padding-top:16px;border-top:1px solid var(--stroke);\n    color:var(--fg-3);font-size:.9rem;line-height:1.5}\n  @media(max-width:720px){\n    .mtg{grid-template-columns:1fr}\n    .mtg-when{border-right:0;border-bottom:1px solid var(--stroke);padding:24px 22px 26px}\n    .mtg-agenda{padding:24px 22px 26px}\n    .mtg-link{margin-top:18px;padding-top:0}\n  }\n' + '</style>', 1)
    s = s.replace('</body>', "\n<script>\n/* Pre-meeting: fill in the prospect's real meeting. The page is reached from the\n   confirmation link, so lid+t are on the URL; without them we leave the static\n   copy in place rather than showing a wrong time. */\n(function(){\n  var q=new URLSearchParams(location.search), lid=q.get('lid'), t=q.get('t');\n  if(!lid||!t) return;\n  // leads.niche is free text off the source list ('Janitorial service',\n  // 'Employment agency', ...), not one of our five slugs, so match on keywords.\n  var NICHE=[\n    [/janitor|clean|custodial|maid/, 'the buildings in your service radius'],\n    [/roof/,                          'the building owners with a roof at end of life'],\n    [/staff|employ|recruit|temp|personnel/, 'the employers hiring in your specialty right now'],\n    [/freight|truck|logistic|carrier|haul/, 'the shippers running your lanes'],\n    [/equipment|industrial|supply|machin|tool/, 'the plants running your equipment class']\n  ];\n  function nicheLine(n){ n=String(n||'').toLowerCase();\n    for(var i=0;i<NICHE.length;i++){ if(NICHE[i][0].test(n)) return NICHE[i][1]; } return null; }\n  fetch('/api/public/meeting-details?lid='+encodeURIComponent(lid)+'&t='+encodeURIComponent(t))\n    .then(function(r){ return r.ok?r.json():null; })\n    .then(function(d){\n      if(!d) return;\n      if(d.when_iso){\n        try{\n          var dt=new Date(d.when_iso);\n          document.getElementById('mtgWhen').textContent=\n            dt.toLocaleString('en-US',{weekday:'long',month:'long',day:'numeric',hour:'numeric',minute:'2-digit',timeZone:'America/New_York'})+' ET';\n        }catch(e){}\n      }\n      var mins=d.duration_min||15;\n      document.getElementById('mtgSub').textContent=mins+' minutes with Remy Leon, founder';\n      if(d.business){ document.getElementById('mtgKey').textContent='Your meeting \\u00b7 '+d.business; }\n      var meet=d.meet_link||d.event_link;\n      if(meet){ var a=document.getElementById('mtgLink'); a.href=meet; a.hidden=false; }\n      var line=nicheLine(d.niche);\n      if(line){\n        var li=document.querySelectorAll('#mtgAgenda li')[1];\n        if(li) li.textContent='Which of '+line+' we would go after first';\n      }\n    })\n    .catch(function(){});\n})();\n</script>\n" + '</body>', 1)
    # Nobody who has already booked should be offered a booking modal. The
    # inherited FAQ foot and footer both carry .js-book, so on this page the
    # foot becomes a reply prompt and the footer links become plain mailto.
    s = s.replace(
        '<p>Still have a question? The fastest way to get it answered is 15 minutes with a partner.</p>\n'
        '      <a class="btn-primary js-book">Book</a>',
        '<p>Anything else you want covered? Reply to your confirmation email and '
        'I will have an answer ready on the call.</p>\n'
        # The only booking affordance on the page, and deliberately the last
        # thing on it: they already hold a slot, so this exists to MOVE it, not
        # to sell a second meeting. A prospect who cannot find reschedule ghosts.
        '      <p class="reschedule">Need a different time? '
        '<a class="js-book">Pick a new slot</a></p>')
    s = s.replace('</style>',
        '  .faq-foot .reschedule{margin:30px 0 0;font-size:.95rem;color:var(--fg-3)}\n'
        '  .faq-foot .reschedule a{color:var(--accent-glow);cursor:pointer;'
        'border-bottom:1px solid transparent;transition:border-color .2s}\n'
        '  .faq-foot .reschedule a:hover{border-bottom-color:var(--accent-glow)}\n'
        '</style>', 1)
    s = s.replace('<a class="js-book">Talk to a partner</a>',
                  '<a href="mailto:stiloaiconsulting@gmail.com">Email us</a>')
    s = s.replace('src="/agents/_confirm.js"', 'src="/vsl/_confirm.js"')
    # This page IS the confirmation step, so every event is flow=confirm. The
    # inherited expression keys off ?confirm=1, which is only ever set on the
    # niche pages, so without this both view and play post flow=organic and the
    # confirmation funnel reads empty. Applies to the view tracker and startVsl.
    s = s.replace('flow=q.get("confirm")==="1"?"confirm":(lid?"campaign":"organic")',
                  'flow="confirm"')
    return s


# The template is agents/receptionist.html, a page written BEFORE the 2026-08
# pivot, so its footer still sells the thing we stopped selling: "Custom AI agents
# ... Receptionist, lead response, customer reactivation" plus an "Other Agents"
# column linking to five retired /agents/* pages.
#
# That footer was riding along on all six generated VSL pages. A prospect watches
# a video about booked qualified meetings, scrolls down, and is told we sell AI
# agents, with five links to prove it. It contradicts the page it sits on and it
# puts AI language in front of a buyer who is being sold on customers.
#
# Rewriting it here rather than in the template keeps the fix with the pages it
# is for, and survives someone regenerating from a template nobody re-reads.
def rewrite_footer(s):
    # The wordmark, not the text. The header already renders the real logo via
    # <picture>; the footer was rendering the brand name as uppercase display
    # type, so the one page a prospect lands on showed two different brands.
    # Same asset and same responsive sources as the header in index.html.
    # The WORDMARK at every breakpoint, deliberately. The header swaps to
    # /assets/STILOMOBILELOGO on narrow screens, but that asset is a 1024x1024
    # square MARK, not a wordmark. It works in the header because the mobile nav
    # is a cramped bar where a square icon is the point. The footer brand column
    # is full width even on a phone, so the same swap would render a stranded
    # 38px square above the description. StiloLogoOfficial is 2508x627 (4:1), so
    # at 34px tall it is ~136px wide and fits a 375px viewport with room to spare.
    old_logo = '<a href="/" class="flogo">STILO AI PARTNERS</a>'
    new_logo = (
        '<a href="/" class="flogo" aria-label="STILO AI Partners, home">\n'
        '          <picture class="flogo-img">\n'
        '            <source srcset="/assets/StiloLogoOfficial.webp" type="image/webp">\n'
        '            <img src="/assets/StiloLogoOfficial.png" alt="STILO AI Partners" loading="lazy" decoding="async">\n'
        '          </picture>\n'
        '        </a>')
    if old_logo not in s:
        sys.exit("build_vsl_pages: footer wordmark not found in template, refusing to write a stale footer")
    s = s.replace(old_logo, new_logo, 1)

    # .flogo is styled as uppercase display TEXT. Once it wraps an <img> those
    # rules do nothing and the image needs its own sizing, or it renders at the
    # asset's natural width and blows the footer grid apart.
    s = s.replace('</style>',
        '  .footer-brand .flogo{display:inline-flex;align-items:center;transition:opacity .2s}\n'
        '  .footer-brand .flogo:hover{opacity:.85}\n'
        '  .flogo-img img{height:44px;width:auto;max-width:100%;object-fit:contain;\n'
        '    filter:brightness(1.22) saturate(1.04) drop-shadow(0 2px 10px rgba(0,0,0,.5))}\n'
        '  @media(max-width:760px){.flogo-img img{height:34px}}\n'
        '</style>', 1)

    # The old blurb sold the pre-pivot product line. The replacement is the
    # positioning from index.html's meta description, which is the canonical
    # description of the offer, so the footer cannot drift from the homepage.
    old_blurb = ('<p>Custom AI agents for growing businesses. Receptionist, lead response, '
                 'customer reactivation, websites, SEO, growth intelligence, and sales coaching.</p>')
    new_blurb = ('<p>We find the buyers in your market, work them for you across email, phone '
                 'and text, and book the ones ready to buy onto your calendar. A setup fee and '
                 'a flat fee per qualified meeting. No retainer.</p>')
    if old_blurb not in s:
        sys.exit("build_vsl_pages: footer blurb not found in template, refusing to write a stale footer")
    s = s.replace(old_blurb, new_blurb, 1)

    # Keep class="x-agent": the inline script at the bottom of the page copies
    # lid/t onto every x-agent href, so cross-links stay attributed to the lead.
    old_col = re.search(r'<div class="footer-col">\s*<h4>Other Agents</h4>.*?</div>', s, re.S)
    if not old_col:
        sys.exit("build_vsl_pages: 'Other Agents' footer column not found, refusing to write a stale footer")
    links = "\n".join(
        '          <li><a class="x-agent" href="/vsl/%s">%s</a></li>' % (n["slug"], n["name"])
        for n in NICHES)
    new_col = ('<div class="footer-col">\n        <h4>Industries</h4>\n        <ul>\n'
               + links + '\n        </ul>\n      </div>')
    s = s[:old_col.start()] + new_col + s[old_col.end():]
    return s


def main():
    # Rewrite the footer ONCE, on the template, so the niche pages and the
    # confirmation page cannot drift apart.
    tpl = rewrite_footer(open(TEMPLATE).read())
    os.makedirs(OUTDIR, exist_ok=True)
    made = []
    for n in NICHES:
        p = os.path.join(OUTDIR, n["slug"] + ".html")
        open(p, "w").write(build_page(tpl, n))
        made.append(p)
    p = os.path.join(OUTDIR, "pre-meeting.html")
    open(p, "w").write(build_confirmation(tpl))
    made.append(p)
    for m in made:
        print("wrote %s (%d KB)" % (os.path.relpath(m, ROOT), os.path.getsize(m) // 1024))


if __name__ == "__main__":
    main()
