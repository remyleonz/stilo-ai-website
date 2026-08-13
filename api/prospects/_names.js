/**
 * Shared, hardened name handling for anything we mail-merge at a prospect.
 *
 * owner_name is scraped and only ~70% real names. The rest is cities
 * ("Hallandale Beach"), business names ("Brakes Complete", "Affinity
 * Construction") and junk ("Program", "Executives"). A dry run of the VSL
 * campaign produced "Hi Program," and "Hi Executives,". A wrong name is worse
 * than no name: it is an instant spam complaint and it tells the reader we
 * scraped them. So the bar is high and the no-name fallback is always safe.
 *
 * This lived in vsl-campaign.js. It was pulled out when the nurture SMS
 * sequence shipped and a production dry run texted "Hey there, looking forward
 * to the meeting tomorrow" to a lead with a null owner_name. One definition,
 * used by every outbound path.
 */
const NOT_A_NAME = new RegExp('^(' + [
    'program', 'programs', 'executive', 'executives', 'team', 'teams', 'alert', 'alerts',
    'system', 'systems', 'group', 'inc', 'llc', 'corp', 'company', 'co',
    'complete', 'construction', 'service', 'services', 'auto', 'realty', 'realtors',
    'office', 'sales', 'info', 'contact', 'admin', 'support', 'billing',
    'manager', 'owner', 'president', 'ceo', 'director', 'department', 'dept',
    'main', 'front', 'desk', 'customer', 'client', 'new', 'the', 'best', 'top',
    'north', 'south', 'east', 'west', 'beach', 'harbour', 'harbor', 'park',
    'miami', 'florida', 'doral', 'hialeah', 'brickell', 'kendall', 'aventura',
    // David's placeholder text, which is what owner_name holds ~30% of the
    // time: "ask for owner", "verify on call", "N/A", "TBD".
    'ask', 'verify', 'confirm', 'tbd', 'na', 'none', 'unknown', 'whoever',
    'someone', 'anybody', 'receptionist', 'gatekeeper', 'supervisor',
    'coordinator', 'principal', 'staff', 'hr', 'practice',
].join('|') + ')$', 'i');

/**
 * Returns a usable first name, or null when we cannot trust it.
 * Callers MUST handle null by dropping the name, never by substituting
 * "there" / "friend" / the business name.
 */
function firstName(ownerName, business, address) {
    const raw = String(ownerName || '').trim();
    if (!raw) return null;
    const first = raw.split(/\s+/)[0];
    if (!first || first.length < 2 || first.length > 20) return null;
    // Must be capitalised. A blocklist alone cannot keep up with free-text
    // placeholders, and every real name in this data is capitalised while
    // David's placeholder prose ("ask for owner", "verify on call") is not.
    if (!/^[A-Z][A-Za-z'’.-]+$/.test(first)) return null;
    if (NOT_A_NAME.test(first)) return null;
    const f = first.toLowerCase();
    // The business/address guard exists to catch a first name DERIVED from the
    // company ("Tom's Forklift Services" -> Tom), which is a guess rather than
    // a contact anyone confirmed. But plenty of real owner-operators name the
    // business after themselves ("Dr. Ryan Ballent, D.C.", "KELLY JOSEPH DMD"),
    // and blanket-suppressing those threw away 189 real first names per 1000.
    // A full name is evidence of a real person; a lone token that echoes the
    // company is not. So only apply the guard to single-token values.
    // A value carrying a company suffix is a BUSINESS sitting in the owner
    // field ("Animal Cancer Care Clinic"), not a person, however many tokens it
    // has. Credentials (DMD, MD, CPA) are deliberately absent: those follow a
    // real person's name.
    if (/\b(inc|llc|corp|corporation|co|company|services|service|clinic|center|centre|group|associates|holdings|enterprises|solutions|systems|realty|properties|studio|salon|spa|agency|team)\b/i.test(raw)) return null;

    const isFullName = raw.split(/\s+/).length > 1;
    if (!isFullName) {
        if (String(business || '').toLowerCase().includes(f)) return null;
        if (String(address || '').toLowerCase().includes(f)) return null;
    }
    return first;
}

/**
 * Greeting that degrades cleanly. greet('Hey', 'Max') -> 'Hey Max, '
 * greet('Hey', null) -> 'Hey, ' — which reads as a normal text opener rather
 * than the tell-tale "Hey there," of an untargeted blast.
 */
function greet(word, first) {
    return first ? word + ' ' + first + ', ' : word + ', ';
}

module.exports = { firstName, greet, NOT_A_NAME };
