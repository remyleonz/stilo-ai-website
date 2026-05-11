/**
 * Per-agent provisioning handlers, called by /api/agents-provision after the
 * admin clicks Approve. Each handler is async (config) => result, where result
 * carries any IDs / URLs / numbers we want to stamp back onto client_agents.config.
 *
 * Handlers MUST be idempotent. The orchestrator may invoke them multiple times
 * (admin approves, then edits config, then approves again).
 *
 * Handler shape:
 *   {
 *     async run({ supabase, agent, config, profile, niche }) -> {
 *       provisioned: bool,
 *       updates?: { ...keys to merge into client_agents.config },
 *       human_review?: string,   // human-readable note shown back to admin
 *     }
 *   }
 *
 * If a handler throws, the orchestrator returns 502 and admin can retry.
 *
 * What each handler does:
 *   echo / ignite -> hand off to the existing Retell provisioner (Cloud Run or local script)
 *   revive        -> 10DLC TrustHub register if SMS enabled + write config to disk for LCR runtime
 *   scout         -> POST per-client config to the SCOUT prospecting Cloud Run service
 *   forge         -> write deployment manifest; actual Vercel deploy is queued
 *   signal        -> register the site + keywords with the SEO tracker
 *   oracle        -> write the merged config to disk for the ontology agent's first run
 *   business_profile / flux -> refuse (profile is not a deployable agent, flux is custom)
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// ──────────────────────────────────────────────────────────────────────────
// Shared helpers
// ──────────────────────────────────────────────────────────────────────────

function clientSlugFor(profile, agent) {
  return (profile && (profile.client_slug || profile.business_slug))
    || (agent && agent.config && (agent.config.client_slug || agent.config.business_slug))
    || agent.client_id; // last resort
}

function clientsDirFor(slug, folder) {
  const base = process.env.STILO_CLIENTS_DIR;
  if (!base) return null;
  return path.join(base, slug, 'agents', folder, 'config', 'agent_config.json');
}

function writeConfigFile(filePath, mergedConfig) {
  if (!filePath) return { written: false, note: 'STILO_CLIENTS_DIR not set on this host' };
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    let existing = {};
    try { existing = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch (_) {}
    const next = Object.assign({}, existing, mergedConfig, {
      config_version: (existing.config_version || 0) + 1,
      last_provisioned_at: new Date().toISOString(),
    });
    fs.writeFileSync(filePath, JSON.stringify(next, null, 2));
    return { written: true, file: filePath };
  } catch (e) {
    return { written: false, note: 'File write failed: ' + e.message };
  }
}

// Cloud Run + shell-out helpers reused for echo/ignite (Retell-driven)
async function provisionRetellViaCloudRun(clientSlug, mode) {
  const baseUrl = (process.env.STILO_PROVISIONER_URL || '').replace(/\/$/, '');
  if (!baseUrl) throw new Error('STILO_PROVISIONER_URL not set');
  const url = baseUrl + '/provision/' + mode + '/' + encodeURIComponent(clientSlug);
  const headers = { 'Content-Type': 'application/json' };
  if (process.env.PROVISIONER_AUTH_TOKEN) {
    headers['Authorization'] = 'Bearer ' + process.env.PROVISIONER_AUTH_TOKEN;
  }
  const resp = await fetch(url, { method: 'POST', headers, body: JSON.stringify({}) });
  if (!resp.ok) {
    const t = await resp.text();
    throw new Error('Provisioner returned ' + resp.status + ': ' + t.slice(0, 400));
  }
  return await resp.json();
}

function provisionRetellViaShell(clientSlug, mode) {
  const agentRoot = process.env.STILO_AGENT_ROOT;
  if (!agentRoot) return Promise.reject(new Error('STILO_AGENT_ROOT not set'));
  const script = path.join(agentRoot, 'AI Receptionist Agent', 'python', 'retell_agent_provisioner.py');
  return new Promise((resolve, reject) => {
    const proc = spawn('python3', [script, '--setup', mode, clientSlug], {
      env: process.env,
      cwd: path.join(agentRoot, 'AI Receptionist Agent', 'python'),
    });
    let stdout = '', stderr = '';
    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('close', code => {
      if (code !== 0) return reject(new Error('Provisioner exited ' + code + ': ' + stderr.slice(0, 400)));
      resolve({ ok: true, stdout: stdout.slice(-400) });
    });
  });
}

// ──────────────────────────────────────────────────────────────────────────
// Twilio TrustHub 10DLC helpers (for REVIVE SMS)
// ──────────────────────────────────────────────────────────────────────────

function twilioBasicAuth() {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const tok = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !tok) return null;
  return 'Basic ' + Buffer.from(sid + ':' + tok).toString('base64');
}

async function tcr10dlcEnsureBrand(profile, config) {
  // Returns { brand_sid, status, ... } or { skipped: true, reason }
  const auth = twilioBasicAuth();
  if (!auth) return { skipped: true, reason: 'TWILIO_ACCOUNT_SID/AUTH_TOKEN missing' };

  const legalName = config.sms_brand_legal_name || profile.business_legal_name;
  const ein = config.sms_brand_ein || profile.business_ein;
  if (!legalName || !ein) return { skipped: true, reason: 'Missing legal name or EIN for 10DLC' };

  // 1) Customer profile (TrustHub) — high-level. We POST to /TrustHub/v1/CustomerProfiles
  // with the business identity fields. Returns a customer_profile SID.
  // Many Twilio accounts already have a primary CustomerProfile created. Lookup first.
  let customerProfileSid = config.twilio_customer_profile_sid || null;
  if (!customerProfileSid) {
    const listResp = await fetch('https://trusthub.twilio.com/v1/CustomerProfiles?Status=twilio-approved&PageSize=5', { headers: { 'Authorization': auth } });
    if (listResp.ok) {
      const list = await listResp.json().catch(() => ({}));
      const first = (list.results || [])[0];
      if (first) customerProfileSid = first.sid;
    }
  }
  if (!customerProfileSid) {
    return { skipped: true, reason: 'No approved Twilio CustomerProfile on file. Create one in Twilio console first.' };
  }

  // 2) Brand registration. POST /v1/a2p/BrandRegistrations
  // Most clients are "STARTER" tier (low-volume). Higher volume needs "STANDARD" with vetting fee.
  const a2pTier = (config.sms_expected_volume_per_day || 0) > 200 ? 'STANDARD' : 'STARTER';
  const brandBody = new URLSearchParams({
    A2PProfileBundleSid: customerProfileSid,
    BrandType: a2pTier,
    Mock: 'false',
  });
  const brandResp = await fetch('https://messaging.twilio.com/v1/a2p/BrandRegistrations', {
    method: 'POST',
    headers: { 'Authorization': auth, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: brandBody.toString(),
  });
  const brand = await brandResp.json().catch(() => ({}));
  if (!brandResp.ok) {
    return { skipped: true, reason: 'Brand registration failed: ' + (brand.message || brandResp.status) };
  }
  return {
    brand_sid: brand.sid,
    status: brand.status,
    a2p_tier: a2pTier,
    customer_profile_sid: customerProfileSid,
    submitted_at: new Date().toISOString(),
  };
}

async function tcr10dlcEnsureCampaign(brandSid, profile, config, sampleMessages) {
  // POST /v1/a2p/MessagingServices to create a messaging service, then attach a campaign.
  // For brevity, this assumes one campaign per client.
  const auth = twilioBasicAuth();
  if (!auth || !brandSid) return { skipped: true, reason: 'Missing Twilio creds or brand SID' };

  // Create a messaging service if we don't have one
  let serviceSid = config.twilio_messaging_service_sid;
  if (!serviceSid) {
    const msResp = await fetch('https://messaging.twilio.com/v1/Services', {
      method: 'POST',
      headers: { 'Authorization': auth, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        FriendlyName: 'STILO REVIVE - ' + (profile.business_legal_name || 'client'),
      }).toString(),
    });
    const ms = await msResp.json().catch(() => ({}));
    if (!msResp.ok) return { skipped: true, reason: 'MessagingService create failed: ' + (ms.message || msResp.status) };
    serviceSid = ms.sid;
  }

  const sample1 = (sampleMessages && sampleMessages[0]) || 'Hi {first_name}, this is {sender_name}. We have a special offer for past customers. Reply STOP to opt out.';
  const sample2 = (sampleMessages && sampleMessages[1]) || 'Hi again from {sender_name}. Want to book your next visit? Reply YES or call {phone}.';

  const campResp = await fetch('https://messaging.twilio.com/v1/Services/' + encodeURIComponent(serviceSid) + '/Compliance/Usa2p', {
    method: 'POST',
    headers: { 'Authorization': auth, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      BrandRegistrationSid: brandSid,
      Description: 'Customer reactivation, retention, and recall messaging from ' + (profile.business_legal_name || 'this business') + ' to opted-in past customers.',
      MessageSamples: JSON.stringify([sample1, sample2]),
      UsAppToPersonUsecase: 'CUSTOMER_CARE',
      HasEmbeddedLinks: 'true',
      HasEmbeddedPhone: 'true',
      MessageFlow: 'Customers opt in via existing business relationship at sign-up, booking, or in-store.',
      OptInMessage: 'Reply YES to confirm. Reply STOP to unsubscribe.',
      OptInKeywords: JSON.stringify(['YES', 'START']),
      OptOutMessage: 'You are unsubscribed and will not receive any more messages. Reply START to resubscribe.',
      OptOutKeywords: JSON.stringify([config.sms_optout_keyword || 'STOP']),
      HelpMessage: 'For help, call ' + (profile.main_business_phone || profile.support_email || 'us'),
      HelpKeywords: JSON.stringify(['HELP', 'INFO']),
    }).toString(),
  });
  const camp = await campResp.json().catch(() => ({}));
  if (!campResp.ok) return { skipped: true, reason: 'Campaign create failed: ' + (camp.message || campResp.status) };

  return {
    messaging_service_sid: serviceSid,
    campaign_status: camp.campaign_status || camp.us_app_to_person_usecase || 'PENDING',
    submitted_at: new Date().toISOString(),
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Per-agent handlers
// ──────────────────────────────────────────────────────────────────────────

const HANDLERS = {

  business_profile: {
    async run() {
      throw new Error('business_profile is a pseudo-agent and is not deployable. It activates automatically when the client completes the wizard.');
    },
  },

  flux: {
    async run() {
      throw new Error('FLUX is custom-implemented per client. Provisioning happens out-of-band.');
    },
  },

  echo: {
    async run({ agent, config, profile }) {
      const slug = clientSlugFor(profile, agent);
      let res;
      if (process.env.STILO_PROVISIONER_URL) {
        res = await provisionRetellViaCloudRun(slug, 'inbound');
      } else {
        res = await provisionRetellViaShell(slug, 'inbound');
      }
      const updates = { provisioned: true };
      if (res && res.retell_agent_id) {
        updates.retell_agent_id = res.retell_agent_id;
        updates.phone_number = res.phone_number;
        updates.voice_id = res.voice_id;
      }
      return { provisioned: true, updates };
    },
  },

  ignite: {
    async run({ agent, config, profile }) {
      const slug = clientSlugFor(profile, agent);
      let res;
      if (process.env.STILO_PROVISIONER_URL) {
        res = await provisionRetellViaCloudRun(slug, 'outbound');
      } else {
        res = await provisionRetellViaShell(slug, 'outbound');
      }
      const updates = { provisioned: true };
      if (res && res.retell_agent_id) {
        updates.retell_agent_id = res.retell_agent_id;
        updates.phone_number = res.phone_number;
        updates.voice_id = res.voice_id;
      }
      return { provisioned: true, updates };
    },
  },

  revive: {
    async run({ agent, config, profile, niche }) {
      const updates = { provisioned: true };
      const notes = [];

      // 1) Write merged config to disk for LCR Agent Python runtime
      const slug = clientSlugFor(profile, agent);
      const filePath = clientsDirFor(slug, 'lcr');
      const writeRes = writeConfigFile(filePath, Object.assign({}, profile, config, { niche }));
      updates.disk_synced = writeRes.written;
      if (!writeRes.written) notes.push(writeRes.note);

      // 2) 10DLC: only if SMS enabled
      if (config.enable_sms === true) {
        const brandRes = await tcr10dlcEnsureBrand(profile || {}, config);
        if (brandRes.skipped) {
          notes.push('10DLC brand: ' + brandRes.reason);
        } else {
          updates.tendlc_brand_sid = brandRes.brand_sid;
          updates.tendlc_brand_status = brandRes.status;
          updates.tendlc_a2p_tier = brandRes.a2p_tier;
          updates.tendlc_customer_profile_sid = brandRes.customer_profile_sid;
          updates.tendlc_submitted_at = brandRes.submitted_at;

          if (brandRes.brand_sid && (brandRes.status || '').toLowerCase().indexOf('failed') === -1) {
            const sampleMessages = [config.sms_sample_message_1, config.sms_sample_message_2].filter(Boolean);
            const campRes = await tcr10dlcEnsureCampaign(brandRes.brand_sid, profile || {}, config, sampleMessages);
            if (campRes.skipped) {
              notes.push('10DLC campaign: ' + campRes.reason);
            } else {
              updates.tendlc_messaging_service_sid = campRes.messaging_service_sid;
              updates.tendlc_campaign_status = campRes.campaign_status;
            }
          }
        }
      }

      return {
        provisioned: true,
        updates,
        human_review: notes.length ? notes.join(' | ') : null,
      };
    },
  },

  scout: {
    async run({ agent, config, profile }) {
      const updates = { provisioned: true };
      const url = (process.env.PROSPECTING_API_URL || '').replace(/\/$/, '');
      const token = process.env.PROSPECTING_API_TOKEN;

      if (!url) {
        return {
          provisioned: false,
          updates,
          human_review: 'PROSPECTING_API_URL not set; SCOUT config saved but no Cloud Run instance to push to. Deploy the prospecting backend and set the env var.',
        };
      }

      // POST per-client config to the prospecting Cloud Run service
      const headers = { 'Content-Type': 'application/json' };
      if (token) headers['Authorization'] = 'Bearer ' + token;

      const resp = await fetch(url + '/clients/' + encodeURIComponent(agent.client_id) + '/scout-config', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          niche: profile.niche,
          icp: {
            industry_terms: (config.icp_industry_terms || '').split(',').map(s => s.trim()).filter(Boolean),
            geography_zips: (config.icp_geography_zips || '').split(',').map(s => s.trim()).filter(Boolean),
            radius_miles: config.icp_geography_radius_miles || 25,
            min_rating: config.icp_min_rating || 4.0,
            min_reviews: config.icp_min_reviews || 25,
            exclude_chains: config.icp_exclude_chains === true,
            exclude_terms: (config.icp_exclude_terms || '').split(',').map(s => s.trim()).filter(Boolean),
            other_signals: config.icp_size_signals || '',
          },
          sources: {
            google_maps: config.source_google_maps !== false,
            yelp: !!config.source_yelp,
            bbb: !!config.source_bbb,
            linkedin: !!config.source_linkedin,
            facebook_pages: !!config.source_facebook_pages,
            niche_specific: (config.source_niche_specific || '').split(',').map(s => s.trim()).filter(Boolean),
          },
          destination: {
            csv_email: config.destination_csv_email === true,
            csv_email_recipient: config.csv_email_recipient || profile.owner_email,
            crm_push: config.destination_crm_push === true,
            crm_push_choice: config.crm_push_choice || null,
            crm_push_credentials: config.crm_push_credentials || {},
            crm_push_tags: (config.crm_push_tags || 'scout').split(',').map(s => s.trim()).filter(Boolean),
            ignite_handoff: config.destination_ignite_handoff === true,
          },
          volume: {
            leads_per_week_target: config.leads_per_week_target || 100,
            max_total_leads: config.max_total_leads || null,
            paid_sources_budget_usd: config.paid_sources_budget_usd || 0,
            priority_signals: config.priority_signals || '',
          },
          owner_email_rule: {
            unconfirmed_handling: config.unconfirmed_email_handling || 'include_with_flag',
          },
          client_email: profile.owner_email,
          business_name: profile.business_legal_name,
        }),
      });

      if (!resp.ok) {
        const t = await resp.text();
        throw new Error('SCOUT push to Cloud Run returned ' + resp.status + ': ' + t.slice(0, 400));
      }
      const json = await resp.json().catch(() => ({}));
      updates.scout_config_id = json.config_id || null;
      updates.scout_pushed_at = new Date().toISOString();
      return { provisioned: true, updates };
    },
  },

  forge: {
    async run({ agent, config, profile, niche }) {
      const updates = { provisioned: true };
      const notes = [];

      // FORGE deploys run via the Website Builder Agent skill. We don't trigger
      // that here (it's a Claude Code skill, not an HTTP API). What we do:
      //   1. Write the deployment manifest to a queue dir on disk
      //   2. Stamp the request so Remy/automation picks it up
      const manifest = {
        client_id: agent.client_id,
        client_agent_id: agent.id,
        domain_strategy: config.domain_strategy,
        domain: config.existing_domain || config.desired_domain || (config.subdomain_choice ? config.subdomain_choice + '.stiloaipartners.com' : null),
        archetype: config.archetype,
        primary_goal: config.primary_goal,
        pages: (config.pages || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean),
        has_blog: !!config.has_blog,
        has_gallery: !!config.has_gallery,
        has_team_page: !!config.has_team_page,
        has_faq: !!config.has_faq,
        booking_method: config.booking_method,
        target_keywords: (config.target_keywords || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean),
        gbp_url: config.google_business_profile_url || null,
        profile: profile,
        niche: niche,
        requested_at: new Date().toISOString(),
      };

      const queueDir = process.env.STILO_FORGE_QUEUE_DIR || (process.env.STILO_CLIENTS_DIR ? path.join(process.env.STILO_CLIENTS_DIR, '_forge_queue') : null);
      if (queueDir) {
        try {
          fs.mkdirSync(queueDir, { recursive: true });
          const fname = path.join(queueDir, agent.client_id + '_' + Date.now() + '.json');
          fs.writeFileSync(fname, JSON.stringify(manifest, null, 2));
          updates.forge_manifest_file = fname;
          notes.push('Manifest queued for FORGE skill at ' + fname);
        } catch (e) {
          notes.push('Could not write manifest: ' + e.message);
        }
      } else {
        notes.push('STILO_FORGE_QUEUE_DIR / STILO_CLIENTS_DIR not set; manifest not queued. Storing in DB only.');
        updates.forge_manifest_inline = manifest;
      }

      return {
        provisioned: true,
        updates,
        human_review: 'FORGE site queued for build. Run the Website Builder Agent skill to deploy. ' + notes.join(' '),
      };
    },
  },

  signal: {
    async run({ agent, config, profile }) {
      const updates = { provisioned: true };
      const notes = [];

      // SIGNAL has two halves:
      //   1. Register the site for weekly rank tracking with DataForSEO
      //   2. Apply schema markup + GBP optimizations (handled by FORGE if linked, else manual)
      const dfsLogin = process.env.DATAFORSEO_LOGIN;
      const dfsPass = process.env.DATAFORSEO_PASSWORD;
      const keywords = (config.target_keywords || []).filter(k => k && k.keyword).map(k => k.keyword);
      const siteUrl = config.site_url;

      if (!dfsLogin || !dfsPass) {
        notes.push('DATAFORSEO_LOGIN/PASSWORD missing; rank tracking not registered.');
      } else if (!siteUrl || !keywords.length) {
        notes.push('Missing site_url or keywords; cannot register rank tracking.');
      } else {
        // Register a rank-tracking task with DataForSEO. Single live request; their
        // API charges per check, so this is a minimal baseline run.
        try {
          const resp = await fetch('https://api.dataforseo.com/v3/serp/google/organic/live/regular', {
            method: 'POST',
            headers: {
              'Authorization': 'Basic ' + Buffer.from(dfsLogin + ':' + dfsPass).toString('base64'),
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(keywords.slice(0, 5).map(k => ({
              keyword: k,
              language_code: 'en',
              location_name: (profile.city + ', ' + profile.state) || 'United States',
              depth: 30,
            }))),
          });
          const json = await resp.json().catch(() => ({}));
          updates.signal_dataforseo_baseline = {
            registered_at: new Date().toISOString(),
            response_status: resp.status,
            tasks_count: (json.tasks || []).length,
          };
        } catch (e) {
          notes.push('DataForSEO baseline failed: ' + e.message);
        }
      }

      // Stamp citation + GBP work-list for the admin to walk through (or for an
      // automated worker if we add one later).
      updates.signal_citation_worklist = (config.citation_priorities || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      updates.signal_gbp_status = config.gbp_status || 'unknown';

      return {
        provisioned: true,
        updates,
        human_review: notes.length ? notes.join(' | ') : null,
      };
    },
  },

  oracle: {
    async run({ agent, config, profile, niche }) {
      const updates = { provisioned: true };

      // ORACLE config is pulled by the Ontology Python agent on its scheduled run.
      // We just need the disk write so the agent picks up the new client.
      const slug = clientSlugFor(profile, agent);
      const filePath = clientsDirFor(slug, 'oracle');
      const writeRes = writeConfigFile(filePath, Object.assign({}, profile, config, { niche }));
      updates.disk_synced = writeRes.written;

      return {
        provisioned: true,
        updates,
        human_review: writeRes.written
          ? 'ORACLE config written. Next scheduled run picks it up.'
          : (writeRes.note + ' Push manually if running off-host.'),
      };
    },
  },

};

module.exports = { HANDLERS };
