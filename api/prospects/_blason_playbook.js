/**
 * api/prospects/_blason_playbook.js
 *
 * The product-and-objection reference that gets appended to the bottom of every
 * Blason cold-call script in the lead drawer.
 *
 * WHY IT LIVES HERE AND NOT IN THE SCRIPT FILES
 *
 * There are 982 generated Blason scripts in Supabase plus David's GCS files,
 * and he regenerates his from a skeleton. Baking this into the files means
 * editing a thousand of them and losing it on his next push. Appending at RENDER
 * time means one edit updates every script, on every path, forever, and David
 * can overwrite his files without wiping it out.
 *
 * WHAT GOES IN HERE
 *
 * Only things a rep needs WHILE THE PHONE IS RINGING. Mechanism in one line,
 * the number that matters, the sentence to say. Anything that needs reading
 * time belongs in the training docs, not here: a rep scrolling past three
 * paragraphs mid-call is a rep who stopped listening to the prospect.
 *
 * Sourcing note: mechanisms and treatment prices are general industry knowledge,
 * medical-director and electrology figures come from Florida DOH and 2026 med
 * spa market guides. Machine specs are NOT confirmed against Blason spec sheets
 * and the copy says so, because a rep promising a wavelength Manuel does not
 * carry is worse than a rep who says "let me check".
 */

const PLAYBOOK_MD = `

---

# Reference

*Appended to every Blason script. Mechanisms and market rates are general knowledge, not Blason spec sheets. Confirm exact models and wavelengths with Manuel.*

## The one question that routes the call

> **"Do you have a medical director on staff?"**
> **"¿Ustedes tienen director médico?"**

Ask it in the first minute. It decides which half of the catalog you are selling. **A "no" is never the end of the call**, it is the other half plus a roadmap.

| Answer | What they are | What you sell |
|---|---|---|
| Yes | Med spa or physician practice | Full laser catalog. The big sale. |
| No, but looking | Growing spa, real intent | Sub-$3k now, laser in 3-6 months. Book them anyway. |
| No, day spa | Massage, facials, waxing | Sub-$3k only. **Never pitch a laser.** |

## Needs a medical director

| Machine | What it actually does |
|---|---|
| **Laser hair removal** | Melanin absorbs light, turns to heat, kills the follicle. **1064nm is the one that treats dark skin safely.** In Miami a 755nm-only machine turns away a large share of the population. |
| **CO2 laser** | Vaporizes microscopic columns of skin; untreated tissue between them drives healing and collagen. Scars, deep wrinkles. 5-7 days downtime, $1,500-3,000 a treatment. |
| **RF microneedling** | Needles to a set depth, RF fired from the tip, heats the dermis while the surface stays cool. Restricted because it **breaks skin**, not because it is a laser. This is the Morpheus8 category clients ask for by name. |
| **HIFU** | Focused ultrasound at 1.5 / 3.0 / 4.5mm creates thermal points in the SMAS, the layer a surgeon tightens. Non-surgical facelift, $1,500-4,000, no downtime. |
| **IPL** | Broad-spectrum flashlamp, not a laser. Pigment, redness, sun damage. Versatile, less precise. Still restricted. |
| **Q-switched / carbon peel** | Nanosecond pulses shatter ink or carbon. Tattoo removal plus the Hollywood peel from one box. |
| **Carboxy / mesotherapy** | Injections. Unambiguously medical. |

## Esthetician-legal, no supervision

| Machine | What it actually does |
|---|---|
| **Cavitation + RF** | 40kHz ultrasound ruptures fat cell membranes, RF tightens. The default first machine for anyone without a medical director. |
| **Slimming roller** | Rollers + vacuum + RF. **This is the category people mean when they say "Venus" or "Legacy".** Do not claim spec parity, offer the showroom. |
| **ShockWave** | Acoustic waves break the fibrous bands that cause cellulite dimpling. Crosses over into physical therapy work. |
| **Pressotherapy** | Sequenced pneumatic compression, mechanical lymphatic drainage. The machine for any lymphatic or post-surgical practice. |
| **Vacuum therapy** | Suction lifts and shapes tissue. Non-surgical butt lift. Huge in South Florida. |
| **Cryolipolysis** | Cooling crystallizes fat cells, they die off over weeks. **Membranes are a consumable**, so it starts a supply relationship. |
| **Hydradermabrasion** | Suction + exfoliation + serum in one pass. The Hydrafacial category. Fast, no downtime, sells to anyone. |
| **EMS** | Electrical impulses force muscle contraction. Not the same as electromagnetic HIFEM (Emsculpt); say so if they name it. |

## Selling the high ticket

Low ticket sells on cost. **High ticket sells on return.** Get the number from them:

> "What do you charge for a hair removal package right now?"
> "And how many people a month ask you for something you can't do?"

Then stop. Ten packages at $1,200 is $12,000 from one room. It is their number, not your claim.

Three levers that shrink a big figure without naming one: **financing** ("it doesn't come out in one hit"), **the room not the machine** (equipment decides what they can charge), and **the showroom** (nobody else lets you fire it before you buy).

## "We can't use lasers" — the objection that used to end the call

There is no such thing as a medical director certificate. It is a licensed MD or DO. But **almost nobody hires one**, they contract one.

- **Minimal oversight** (signs protocols, reachable by phone, rarely on site): **$500-1,500/month**
- Typical range: $1,500-8,000/month · Active on-site: $5,000-10,000+
- Never a percentage of revenue. That is fee-splitting.

**Or the owner licenses themselves as an electrologist**, the only short path:
320 hours at a Florida-approved school (120 academic, 200 practical) · Prometric exam, literally titled the *Electrology, Laser and IPL Exam* · **$205** in fees · State contact 850-245-4373.

> "The reason most spas your size don't have a laser isn't the machine, it's that they think they have to hire a doctor. They don't. A medical director who signs protocols and picks up the phone runs a few hundred to fifteen hundred a month. What are you charging for a package right now?"

**Then ask:** *"Do you know any doctors already, or would you be starting from scratch?"* Someone whose cousin or former employer is a physician is 30 days from being a laser buyer.

## Objections

| They say | You say |
|---|---|
| "How much is it?" | "Depends which unit fits what your clients are asking for, and Manuel does financing. What's one new treatment worth to you over a year?" **Never a number. Never the website.** |
| "Send me info / a price list" | "Happy to. So I send the right thing: what treatment are they asking for that you can't do? ... Perfect. And let's put 15 minutes on the calendar so it doesn't sit in your inbox." |
| "We're not licensed for that" | "Good to know, that changes what I'd show you. Half of what we carry needs no medical director at all." Then the sub-$3k catalog. |
| "I already bought from [competitor]" | "Congrats. Two quick things: who's training your staff on it, and where's the part coming from when it's down? And what's the next one on your list?" Log the brand, callback in 60 days. |
| "We have all the lasers already" | "Then you're past the hard part. What's the oldest machine in the room, and what did downtime cost you this year?" |
| "Not interested" | One question only: "Is the equipment handled, or is it just a bad time?" Take the answer, log it, move on. |

## Hard rules

- **Never a price.** Not a number, not a range, not a link to the site (it lists prices).
- **Never claim FDA clearance.** Manuel handles regulatory.
- **Never run down cheap imported equipment.** Manuel IS the importer.
- **Never pitch a laser with no medical director.** Sell the other half.
- **Say Blasón correctly.** B-L-A-S-O-N. Spell it when asked.
- **Log the outcome and one line of note before the next dial.**
`;

/**
 * Append the reference to a Blason script.
 *
 * Detection is on content rather than filename, because the same block has to
 * land on David's GCS files, the client-prefixed listing files and the
 * STILO-generated fallback, and only the content is common to all three.
 * Idempotent: a script that already carries the block is returned untouched, so
 * a cached or re-proxied response cannot stack it twice.
 */
function appendPlaybook(contentMd) {
    const md = String(contentMd || '');
    if (!md.trim()) return md;
    if (!/blas[oó]n/i.test(md)) return md;      // not a Blason script, leave it alone
    if (md.includes('# Reference')) return md;  // already appended
    return md.replace(/\s*$/, '') + '\n' + PLAYBOOK_MD;
}

module.exports = { appendPlaybook, PLAYBOOK_MD };
