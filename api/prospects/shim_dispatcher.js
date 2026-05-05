/**
 * sites/stilo-ai/api/prospects/shim_dispatcher.js
 *
 * In-process stand-in for David's Python prospecting backend. Activated when
 * PROSPECTING_API_URL is unset or equals "local"/"shim"/"supabase". Reads
 * from the public.prospects + public.prospect_calls Supabase tables and
 * returns responses shaped exactly like the upstream contract so callable.js,
 * detail.js, log-call.js, dnc.js, stats.js, etc. stay untouched.
 *
 * Tomorrow when David's Cloud Run is live, set PROSPECTING_API_URL to his
 * URL and `forwardToProspecting()` skips this dispatcher entirely.
 *
 * Supported upstream paths:
 *   GET  /api/prospects/callable
 *   GET  /api/prospects/emailable
 *   GET  /api/prospects/dead
 *   GET  /api/prospects/stats
 *   GET  /api/prospects/detail        (lookup by phone | email | business_name)
 *   GET  /api/prospects/{id}
 *   POST /api/prospects/{id}/log-call
 *   POST /api/prospects/{id}/dnc
 *   GET  /api/prospects/callbacks
 *   POST /api/prospects/{id}/callback
 */

const { createClient } = require('@supabase/supabase-js');

function sb() {
    return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
        auth: { persistSession: false }
    });
}

function ok(json) { return { status: 200, json: json }; }
function err(status, code, detail) { return { status: status, json: { error: code, detail: detail } }; }

function applyFilters(query, q) {
    if (!q) return query;
    if (q.tier) query = query.eq('tier', q.tier);
    if (q.min_score) query = query.gte('prospect_score', Number(q.min_score) || 0);
    if (q.q) query = query.or('business_name.ilike.%' + q.q + '%,owner_name.ilike.%' + q.q + '%');
    if (q.niche) {
        const niches = String(q.niche).split(',').map(function (s) { return s.trim(); }).filter(Boolean);
        if (niches.length === 1) query = query.eq('niche', niches[0]);
        else if (niches.length > 1) query = query.in('niche', niches);
    }
    return query;
}

async function listCallable(q) {
    const limit = Math.min(Number(q.limit) || 200, 500);
    let query = sb().from('prospects')
        .select('*')
        .eq('status', 'callable')
        .not('owner_phone', 'is', null)
        .order('prospect_score', { ascending: false, nullsFirst: false })
        .limit(limit);
    query = applyFilters(query, q);
    const { data, error } = await query;
    if (error) return err(500, 'shim_query_failed', error.message);
    return ok({ results: data || [] });
}

async function listEmailable(q) {
    const limit = Math.min(Number(q.limit) || 200, 500);
    let query = sb().from('prospects')
        .select('*')
        .in('status', ['callable', 'callback', 'called'])
        .not('owner_email', 'is', null)
        .order('prospect_score', { ascending: false, nullsFirst: false })
        .limit(limit);
    query = applyFilters(query, q);
    const { data, error } = await query;
    if (error) return err(500, 'shim_query_failed', error.message);
    return ok({ results: data || [] });
}

async function listDead(q) {
    const page = Math.max(1, Number(q.page) || 1);
    const limit = Math.min(Number(q.limit) || 50, 200);
    const from = (page - 1) * limit;
    const to = from + limit - 1;
    const { data, error, count } = await sb().from('prospects')
        .select('*', { count: 'exact' })
        .eq('status', 'dead')
        .order('updated_at', { ascending: false })
        .range(from, to);
    if (error) return err(500, 'shim_query_failed', error.message);
    return ok({
        results: data || [],
        page: page,
        total_pages: Math.max(1, Math.ceil((count || 0) / limit))
    });
}

async function getStats() {
    const client = sb();
    const { data: rows, error } = await client.from('prospects')
        .select('tier, status, niche, owner_phone_strict, owner_email');
    if (error) return err(500, 'shim_query_failed', error.message);
    const tierCounts = { HOT: 0, WARM: 0, COOL: 0, DEAD: 0 };
    const byNiche = {};
    let strictPhone = 0;
    let ownerEmail = 0;
    (rows || []).forEach(function (r) {
        const t = (r.tier || '').toUpperCase();
        if (r.status === 'dead') tierCounts.DEAD = (tierCounts.DEAD || 0) + 1;
        else if (tierCounts[t] != null) tierCounts[t] = tierCounts[t] + 1;
        if (r.niche) byNiche[r.niche] = (byNiche[r.niche] || 0) + 1;
        if (r.owner_phone_strict) strictPhone++;
        if (r.owner_email) ownerEmail++;
    });
    return ok({
        tier_counts: tierCounts,
        by_niche: byNiche,
        owner_phone_strict_count: strictPhone,
        owner_email_count: ownerEmail
    });
}

async function getDetail(q) {
    const client = sb();
    let prospect = null;
    if (q.phone) {
        const { data } = await client.from('prospects')
            .select('*').eq('owner_phone', q.phone).maybeSingle();
        prospect = data;
    } else if (q.email) {
        const { data } = await client.from('prospects')
            .select('*').eq('owner_email', q.email).maybeSingle();
        prospect = data;
    } else if (q.business_name) {
        const { data } = await client.from('prospects')
            .select('*').ilike('business_name', q.business_name).limit(1).maybeSingle();
        prospect = data;
    }
    if (!prospect) return err(404, 'prospect_not_found');
    const { data: calls } = await client.from('prospect_calls')
        .select('*').eq('prospect_id', prospect.id)
        .order('called_at', { ascending: false }).limit(50);
    return ok(Object.assign({}, prospect, { call_history: calls || [] }));
}

async function getById(id) {
    const client = sb();
    const { data: prospect, error } = await client.from('prospects')
        .select('*').eq('id', id).maybeSingle();
    if (error) return err(500, 'shim_query_failed', error.message);
    if (!prospect) return err(404, 'prospect_not_found');
    const { data: calls } = await client.from('prospect_calls')
        .select('*').eq('prospect_id', id)
        .order('called_at', { ascending: false }).limit(50);
    return ok(Object.assign({}, prospect, { call_history: calls || [] }));
}

async function logCall(id, body) {
    const client = sb();
    const outcome = body.outcome;
    const nowIso = new Date().toISOString();
    const callRow = {
        prospect_id: id,
        outcome: outcome,
        notes: body.notes || null,
        logged_by: body.logged_by || null,
        called_at: nowIso,
        direction: body.direction || 'outbound',
        recording_url: body.recording_url || null,
        transcript: body.transcript || null,
        duration_seconds: body.duration_seconds || null,
        openphone_call_id: body.openphone_call_id || null
    };
    const { error: callErr } = await client.from('prospect_calls').insert(callRow);
    if (callErr) return err(500, 'shim_call_insert_failed', callErr.message);

    const updates = { last_called_at: nowIso, updated_at: nowIso };
    if (outcome === 'dnc_request') updates.status = 'dnc';
    else if (outcome === 'wrong_number' || outcome === 'disconnected') updates.status = 'dead';
    else if (outcome === 'not_interested') updates.status = 'dead';
    else if (outcome === 'booked_meeting') updates.status = 'called';
    else if (body.next_callback_at) {
        updates.status = 'callback';
        updates.next_callback_at = body.next_callback_at;
        updates.callback_reason = outcome;
    } else {
        updates.status = 'called';
    }
    const { error: updErr } = await client.from('prospects').update(updates).eq('id', id);
    if (updErr) return err(500, 'shim_prospect_update_failed', updErr.message);
    return ok({ ok: true, id: id });
}

async function setDnc(id, body) {
    const { error } = await sb().from('prospects')
        .update({ status: 'dnc', updated_at: new Date().toISOString() })
        .eq('id', id);
    if (error) return err(500, 'shim_dnc_failed', error.message);
    await sb().from('prospect_calls').insert({
        prospect_id: id,
        outcome: 'dnc_request',
        logged_by: body && body.logged_by || null,
        called_at: new Date().toISOString()
    });
    return ok({ ok: true });
}

async function listCallbacks(q) {
    const client = sb();
    const dueBefore = q.due_before
        ? new Date(q.due_before).toISOString()
        : new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await client.from('prospects')
        .select('*')
        .eq('status', 'callback')
        .or('next_callback_at.lte.' + dueBefore + ',next_callback_at.is.null')
        .order('next_callback_at', { ascending: true, nullsFirst: false })
        .limit(Number(q.limit) || 200);
    if (error) return err(500, 'shim_query_failed', error.message);
    return ok({ results: data || [] });
}

async function setCallback(id, body) {
    const updates = {
        status: 'callback',
        next_callback_at: body.when || new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString(),
        callback_reason: body.reason || 'manual',
        updated_at: new Date().toISOString()
    };
    const { error } = await sb().from('prospects').update(updates).eq('id', id);
    if (error) return err(500, 'shim_callback_failed', error.message);
    return ok({ ok: true, id: id, next_callback_at: updates.next_callback_at });
}

async function dispatch(opts) {
    const method = (opts.method || 'GET').toUpperCase();
    const path = opts.path || '';
    const q = opts.query || {};
    const body = opts.body || {};

    if (method === 'GET' && path === '/api/prospects/callable') return listCallable(q);
    if (method === 'GET' && path === '/api/prospects/emailable') return listEmailable(q);
    if (method === 'GET' && path === '/api/prospects/dead') return listDead(q);
    if (method === 'GET' && path === '/api/prospects/stats') return getStats();
    if (method === 'GET' && path === '/api/prospects/callbacks') return listCallbacks(q);
    if (method === 'GET' && path === '/api/prospects/detail') return getDetail(q);

    const idMatch = path.match(/^\/api\/prospects\/(\d+)(\/.+)?$/);
    if (idMatch) {
        const id = Number(idMatch[1]);
        const sub = idMatch[2] || '';
        if (method === 'GET' && sub === '') return getById(id);
        if (method === 'POST' && sub === '/log-call') return logCall(id, body);
        if (method === 'POST' && sub === '/dnc') return setDnc(id, body);
        if (method === 'POST' && sub === '/callback') return setCallback(id, body);
    }
    return err(404, 'shim_route_not_found', method + ' ' + path);
}

module.exports = async function (_req, res) {
    res.status(405).json({ error: 'not_a_handler' });
};
module.exports.dispatch = dispatch;
