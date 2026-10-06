/**
 * api/prospects/_alert_to.js
 *
 * ONE recipient list for every internal alert (video watch, SMS reply, email
 * reply, missed call, booking, quiz, new lead). Before this, each alert module
 * built its own list and they drifted: watch alerts went to the work inbox only,
 * reply alerts to work + personal, bookings to work + David. Remy's rule
 * (2026-10-06): every alert from every rep and every source lands at
 * remyleon@stiloaipartners.com AND davidcoira@stiloaipartners.com.
 *
 * Extra addresses (the rep who owns the lead, an SDR who booked) are passed in
 * and deduped. ALERT_ALSO (comma list) adds more without a deploy.
 */
const BASE = ['remyleon@stiloaipartners.com', 'davidcoira@stiloaipartners.com'];

function alertTo() {
    const extra = Array.prototype.slice.call(arguments);
    const env = String(process.env.ALERT_ALSO || '').split(',');
    return Array.from(new Set(
        BASE.concat(env, extra)
            .map(function (e) { return String(e || '').toLowerCase().trim(); })
            .filter(function (e) { return e && /.+@.+\..+/.test(e); })
    ));
}

/** https page that opens the number in the Quo app (desktop or phone) and falls
 *  back to the Quo web dialer. A bare tel: link rings the rep's personal line,
 *  off the recorded Quo number, which is what Remy saw on 2026-10-06. */
function callLink(phone) {
    const d = String(phone || '').replace(/[^\d+]/g, '');
    if (!d) return '';
    const e164 = d.startsWith('+') ? d : (d.length === 10 ? '+1' + d : '+' + d);
    return 'https://stiloaipartners.com/call/?to=' + encodeURIComponent(e164);
}

module.exports = { alertTo, callLink, BASE };
