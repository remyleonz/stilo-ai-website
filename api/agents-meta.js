/**
 * GET /api/agents-meta
 *
 * Returns the public catalog of agents with their onboarding step names and
 * schema definitions. Used by the client dashboard wizard so the browser
 * doesn't have to mirror api/_agents.js.
 *
 * Response shape:
 *   { agents: { echo: { code, shortName, name, onboardingSteps, onboardingSchema }, ignite: ..., ... } }
 *
 * No auth: all fields returned here are already public (visible on the
 * marketing site quiz / pricing). Pricing internals + env var names are
 * stripped before returning.
 */

const { AGENTS } = require('./_agents');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Cache aggressively — schemas only change with code deploys.
  res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=600');

  const out = {};
  for (const code of Object.keys(AGENTS)) {
    const a = AGENTS[code];
    out[code] = {
      code: a.code,
      name: a.name,
      shortName: a.shortName,
      purchaseMode: a.purchaseMode,
      onboardingSteps: a.onboardingSteps,
      onboardingSchema: a.onboardingSchema || null,
    };
  }

  return res.status(200).json({ agents: out });
};
