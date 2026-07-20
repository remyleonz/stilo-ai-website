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
    if (!/^[A-Za-z][A-Za-z'’.-]+$/.test(first)) return null;
    if (NOT_A_NAME.test(first)) return null;
    const f = first.toLowerCase();
    if (String(business || '').toLowerCase().includes(f)) return null;
    if (String(address || '').toLowerCase().includes(f)) return null;
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
