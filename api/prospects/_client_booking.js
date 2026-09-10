/**
 * Client-account booking package: what a prospect and the CLIENT get when a
 * rep books a client-account lead (client_id set) from the lead drawer.
 *
 * A client-account booking is NOT a STILO discovery call. For Blason it is a
 * showroom visit at a street address. So instead of the STILO flow (Google
 * Meet event + STILO confirmation + VSL), this sends:
 *
 *   1. Prospect confirmation EMAIL, client-branded sender, with date, time,
 *      the showroom address and a thank-you. Spanish when the lead's
 *      primary_language is 'es'.
 *   2. Prospect confirmation SMS from the rep's line (falls back to Remy's),
 *      same content, short. Both logged to lead_messages with dedupe keys.
 *   3. Brief EMAIL to the client contact (Manuel at Blason): business name,
 *      business phone, owner name + cell, date/time, and the tail of
 *      rep_notes so he knows what they want before they walk in.
 *
 * Copy rules enforced here: never a price, and the Blason address renders
 * "Miami", never "Hialeah" (standing hard rule for Blason copy; the street +
 * zip still route GPS correctly).
 *
 * The proven template is the Chanel Studio manual flow of 2026-09-10
 * (lead 31622, dedupe keys showroom-confirm-*). This module is that flow,
 * made permanent.
 */
const { sendSms, REMY_LINE } = require('./_sms');

// Per-client branded sender. Falls back to the STILO transactional sender
// with client-branded copy when a client has no dedicated address yet.
const CLIENT_SENDERS = {
    // Blason Spa Equipment
    '2efae6bf-69d8-4c4d-ac25-6a693db50f8b': 'Remy Leon <reps@blason.stiloaipartners.com>'
};

function displayAddress(raw) {
    // Blason copy says Miami, never Hialeah. Street + zip still route GPS.
    return String(raw || '').replace(/hialeah/ig, 'Miami');
}

function whenStrings(whenIso, es) {
    const d = new Date(whenIso);
    const opts = { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'America/New_York' };
    const tOpts = { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' };
    const date = new Intl.DateTimeFormat(es ? 'es-US' : 'en-US', opts).format(d);
    const time = new Intl.DateTimeFormat('en-US', tOpts).format(d);
    return { date, time };
}

async function sendEmail(from, to, subject, text, replyTo) {
    if (!process.env.RESEND_API_KEY) return { skipped: 'resend_not_configured' };
    const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from, to: [to], reply_to: replyTo || 'remyleon@stiloaipartners.com', subject, text })
    });
    const j = await r.json().catch(() => ({}));
    return { status: r.status, id: j.id || null, error: r.ok ? null : (j.message || 'send_failed') };
}

async function sendClientBookingPackage(sb, lead, clientCo, opts) {
    const whenIso = opts.whenIso;
    const repEmail = opts.repEmail || null;
    const es = String(lead.primary_language || '').toLowerCase() === 'es';
    const { date, time } = whenStrings(whenIso, es);
    const address = displayAddress(clientCo.address || '');
    const company = clientCo.business_name || 'the showroom';
    const from = CLIENT_SENDERS[clientCo.id]
        || ((process.env.STILO_SENDER_NAME || 'Remy Leon') + ' <' + (process.env.STILO_SENDER_EMAIL || 'remyleon@stiloaipartners.com') + '>');
    const ownerFirst = String(lead.owner_name || '').trim().split(/\s+/)[0] || null;
    const prospectEmail = opts.prospectEmail || lead.owner_email || lead.email || null;
    const prospectPhone = lead.owner_phone || lead.phone || null;
    const dateKey = String(whenIso).slice(0, 10);
    const out = { email: null, sms: null, client_brief: null };

    // 1. Prospect confirmation email
    const subj = es ? ('Confirmado: ' + date + ' a la ' + time) : ('Confirmed: ' + date + ' at ' + time);
    const emailBody = es
        ? ['Hola' + (ownerFirst ? ' ' + ownerFirst : '') + ',',
           '',
           'Gracias por la llamada. Le confirmo la visita:',
           '',
           'Cuando: ' + date + ', ' + time,
           'Donde: ' + company + (address ? ', ' + address : ''),
           '',
           'Si algo cambia, responda a este correo o mandeme un texto.',
           '',
           'Nos vemos,',
           '',
           'Remy Leon',
           'de parte de ' + company].join('\n')
        : ['Hi' + (ownerFirst ? ' ' + ownerFirst : '') + ',',
           '',
           'Thank you for the call. You are confirmed:',
           '',
           'When: ' + date + ' at ' + time,
           'Where: ' + company + (address ? ', ' + address : ''),
           '',
           'If anything changes, just reply here or text me.',
           '',
           'See you then,',
           '',
           'Remy Leon',
           'on behalf of ' + company].join('\n');
    if (prospectEmail) {
        out.email = await sendEmail(from, prospectEmail, subj, emailBody);
        if (out.email && !out.email.error && !out.email.skipped) {
            try {
                await sb.from('lead_messages').insert({
                    lead_id: lead.id, direction: 'outbound', channel: 'email',
                    to_address: prospectEmail, from_address: from.replace(/^.*</, '').replace(/>$/, ''),
                    subject: subj, body: emailBody, body_preview: emailBody.slice(0, 280),
                    status: 'sent', provider: 'resend', provider_message_id: out.email.id,
                    sent_by: repEmail, sent_at: new Date().toISOString(),
                    dedupe_key: 'client-booking-email-' + lead.id + '-' + dateKey
                });
            } catch (_) { /* logging is best-effort */ }
        }
    }

    // 2. Prospect confirmation SMS (rep line with Remy fallback inside sendSms)
    const smsBody = es
        ? ('Hola' + (ownerFirst ? ' ' + ownerFirst : '') + ', Remy de ' + company + '. Gracias por la llamada. Confirmado: ' + date + ', ' + time + (address ? '. Direccion: ' + address : '') + '. Si algo cambia, escribame aqui.')
        : ('Hi' + (ownerFirst ? ' ' + ownerFirst : '') + ', Remy from ' + company + '. Thank you for the call. Confirmed: ' + date + ' at ' + time + (address ? '. Address: ' + address : '') + '. If anything changes, just text me here.');
    if (prospectPhone) {
        try {
            out.sms = await sendSms(opts.fromLine || REMY_LINE, prospectPhone, smsBody, { leadId: lead.id });
            if (out.sms && !out.sms.err && !out.sms.skip) {
                try {
                    await sb.from('lead_messages').insert({
                        lead_id: lead.id, direction: 'outbound', channel: 'sms',
                        to_address: prospectPhone, from_address: (out.sms.from || opts.fromLine || REMY_LINE),
                        body: smsBody, body_preview: smsBody.slice(0, 280),
                        status: 'sent', provider: 'openphone',
                        sent_by: repEmail, sent_at: new Date().toISOString(),
                        dedupe_key: 'client-booking-sms-' + lead.id + '-' + dateKey
                    });
                } catch (_) { /* best-effort */ }
            }
        } catch (e) { out.sms = { err: String((e && e.message) || e) }; }
    }

    // 3. Brief to the client contact (Spanish for Blason: Manuel)
    if (clientCo.email) {
        const notesTail = String(lead.rep_notes || '').trim().slice(-600);
        const briefSubj = 'Visita confirmada: ' + (lead.name || 'prospecto') + ' (' + date + ', ' + time + ')';
        const briefBody = [
            (clientCo.contact_name ? clientCo.contact_name.split(/\s+/)[0] : 'Hola') + ', te confirmo una visita:',
            '',
            'Cuando: ' + date + ', ' + time,
            'Negocio: ' + (lead.name || 'n/a'),
            'Tel del negocio: ' + (lead.phone || 'n/a'),
            'Contacto: ' + (lead.owner_name || 'por confirmar') + (lead.owner_phone ? ', cel ' + lead.owner_phone : ''),
            '',
            notesTail ? 'Notas de las llamadas:\n' + notesTail : 'Sin notas adicionales.',
            '',
            'Remy'
        ].join('\n');
        out.client_brief = await sendEmail(from, clientCo.email, briefSubj, briefBody);
    }

    return out;
}

module.exports = { sendClientBookingPackage, displayAddress };
