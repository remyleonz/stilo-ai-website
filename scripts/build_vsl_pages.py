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

# Confirmation video. Served from Supabase Storage, not Vercel: the source is a
# 90MB screen recording and Vercel static assets are the wrong place for it.
CONFIRM_VIDEO = os.environ.get(
    "CONFIRM_VSL_URL",
    "https://zsrskphpvgautfgklgxf.supabase.co/storage/v1/object/public/public-video/confirmation-vsl.mp4",
)

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
         "Three pieces: a setup fee to build it, a flat fee for each qualified meeting that shows up, "
         "and a share of what you actually close. No retainer, and no monthly invoice that arrives "
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
        '      <video controls playsinline preload="metadata" poster="/assets/vsl/confirmation-poster.jpg" '
        'style="position:absolute;top:0;left:0;width:100%;height:100%;border:0;background:#000" '
        'onplay="vslEvent(\'play\')">\n'
        '        <source src="' + CONFIRM_VIDEO + '" type="video/mp4">\n'
        '        Your browser cannot play this video. '
        '<a href="' + CONFIRM_VIDEO + '">Download it instead.</a>\n'
        '      </video>\n'
        '    </div>\n'
        '    <div class="ctaband">\n'
        '      <h2>See you on the call</h2>\n'
        '      <a class="btn-primary js-book" href="#faq">Questions before we talk</a>\n'
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
         "A setup fee, a flat fee per qualified meeting we book, and a share of what you close. No "
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

    s = s.replace('src="/agents/_confirm.js"', 'src="/vsl/_confirm.js"')
    # The Loom player is unused here; keep a stub so the shared event call resolves.
    # Page-view and play must both be attributed to the confirmation page. The
    # inherited view tracker reads data-agent off .vsl-play, which does not exist
    # here (a plain <video> replaced it), so it was posting agent:null.
    s = s.replace('var a=document.querySelector(".vsl-play"),agent=a?a.getAttribute("data-agent"):null;',
                  'var agent="confirmation";', 1)
    s = s.replace("function startVsl(btn){",
                  "function vslEvent(ev){try{var q=new URLSearchParams(location.search);"
                  "fetch('/api/public/vsl-event',{method:'POST',"
                  "headers:{'Content-Type':'application/json'},body:JSON.stringify({event:ev,"
                  "agent:'confirmation',lid:q.get('lid'),flow:'confirm',path:location.pathname})});}catch(e){}}\n"
                  "function startVsl(btn){", 1)
    return s


def main():
    tpl = open(TEMPLATE).read()
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
