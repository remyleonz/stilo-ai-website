/* STILO AI PARTNERS - Agent Robot Mascots
 * Shared base body (head + eyes + antenna), role-specific prop per agent.
 * Brand stays purple-first; accent color used only on the role prop.
 * Usage: import { ROBOTS } from './robots.js'; el.innerHTML = ROBOTS.echo.svg;
 */

const BASE_BODY = `
  <!-- antenna -->
  <line x1="32" y1="6" x2="32" y2="14" stroke="#c4b5fd" stroke-width="2" stroke-linecap="round"/>
  <circle cx="32" cy="5" r="2.5" fill="#a855f7"/>
  <!-- head -->
  <rect x="18" y="14" width="28" height="22" rx="7" fill="url(#robotHead)" stroke="#a855f7" stroke-width="1.5"/>
  <!-- eyes -->
  <circle cx="26" cy="25" r="2.4" fill="#fff"/>
  <circle cx="38" cy="25" r="2.4" fill="#fff"/>
  <circle cx="26" cy="25" r="1" fill="#1a1033"/>
  <circle cx="38" cy="25" r="1" fill="#1a1033"/>
  <!-- mouth -->
  <rect x="28" y="30" width="8" height="1.5" rx="0.75" fill="#c4b5fd"/>
  <!-- neck -->
  <rect x="28" y="36" width="8" height="3" fill="#6d28d9"/>
  <!-- body -->
  <rect x="14" y="39" width="36" height="20" rx="5" fill="url(#robotBody)" stroke="#a855f7" stroke-width="1.5"/>
  <!-- chest light -->
  <circle cx="32" cy="49" r="2" fill="#a855f7"/>
`;

const GRADS = `
  <defs>
    <linearGradient id="robotHead" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#4c1d95"/>
      <stop offset="1" stop-color="#2e1065"/>
    </linearGradient>
    <linearGradient id="robotBody" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#3b1873"/>
      <stop offset="1" stop-color="#1e0f3d"/>
    </linearGradient>
  </defs>
`;

const wrap = (prop) => `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">${GRADS}${BASE_BODY}${prop}</svg>`;

export const ROBOTS = {
  // ECHO - headset (phone/voice agent)
  echo: {
    accent: '#a855f7',
    svg: wrap(`
      <path d="M15 24 Q15 17 22 17" stroke="#a855f7" stroke-width="2" fill="none" stroke-linecap="round"/>
      <path d="M49 24 Q49 17 42 17" stroke="#a855f7" stroke-width="2" fill="none" stroke-linecap="round"/>
      <rect x="12" y="23" width="5" height="8" rx="2" fill="#a855f7"/>
      <rect x="47" y="23" width="5" height="8" rx="2" fill="#a855f7"/>
      <!-- mic -->
      <line x1="17" y1="29" x2="22" y2="33" stroke="#a855f7" stroke-width="1.5"/>
      <circle cx="22.5" cy="33.5" r="1.8" fill="#a855f7"/>
    `)
  },

  // IGNITE - flame shoulder (instant lead response)
  ignite: {
    accent: '#f97316',
    svg: wrap(`
      <path d="M50 40 Q53 36 52 33 Q55 35 56 39 Q57 45 52 47 Q47 45 48 41 Q49 39 50 40 Z" fill="#f97316"/>
      <path d="M51 42 Q53 40 52.5 38 Q54 40 54 43 Q53 45 51 45 Z" fill="#fbbf24"/>
    `)
  },

  // REVIVE - heart chest (customer reactivation)
  revive: {
    accent: '#ec4899',
    svg: wrap(`
      <path d="M32 55 L26 49 Q23 46 25 43 Q27 41 29 42 Q30 42 32 44 Q34 42 35 42 Q37 41 39 43 Q41 46 38 49 Z" fill="#ec4899"/>
      <path d="M29 44 Q30 43 31 44" stroke="#fff" stroke-width="0.8" fill="none" opacity="0.6"/>
    `)
  },

  // SCOUT - binoculars (prospecting)
  scout: {
    accent: '#06b6d4',
    svg: wrap(`
      <circle cx="25" cy="23" r="4" fill="#1a1033" stroke="#06b6d4" stroke-width="1.5"/>
      <circle cx="39" cy="23" r="4" fill="#1a1033" stroke="#06b6d4" stroke-width="1.5"/>
      <line x1="29" y1="23" x2="35" y2="23" stroke="#06b6d4" stroke-width="1.5"/>
      <circle cx="25" cy="23" r="1.5" fill="#06b6d4"/>
      <circle cx="39" cy="23" r="1.5" fill="#06b6d4"/>
    `)
  },

  // FORGE - hammer (website builder)
  forge: {
    accent: '#eab308',
    svg: wrap(`
      <rect x="45" y="40" width="10" height="6" rx="1.5" fill="#eab308"/>
      <rect x="48" y="46" width="3" height="14" rx="1" fill="#92400e"/>
      <path d="M45 40 L40 45 L43 48 L48 43" fill="#eab308" opacity="0.7"/>
    `)
  },

  // SIGNAL - antenna/broadcast (AI SEO/GEO)
  signal: {
    accent: '#10b981',
    svg: wrap(`
      <path d="M46 30 Q52 30 52 36" stroke="#10b981" stroke-width="1.5" fill="none" stroke-linecap="round"/>
      <path d="M46 26 Q56 26 56 36" stroke="#10b981" stroke-width="1.5" fill="none" stroke-linecap="round"/>
      <path d="M46 22 Q60 22 60 36" stroke="#10b981" stroke-width="1.5" fill="none" stroke-linecap="round"/>
      <circle cx="45" cy="35" r="2" fill="#10b981"/>
    `)
  },

  // ORACLE - crystal ball (business intelligence)
  oracle: {
    accent: '#8b5cf6',
    svg: wrap(`
      <ellipse cx="48" cy="50" rx="8" ry="2.5" fill="#0f0820"/>
      <circle cx="48" cy="45" r="7" fill="url(#oracleBall)" stroke="#8b5cf6" stroke-width="1.2"/>
      <circle cx="45.5" cy="43" r="2" fill="#fff" opacity="0.35"/>
      <defs>
        <radialGradient id="oracleBall" cx="0.4" cy="0.3">
          <stop offset="0" stop-color="#c4b5fd"/>
          <stop offset="1" stop-color="#4c1d95"/>
        </radialGradient>
      </defs>
    `)
  },

  // FLUX - gear swarm (custom automations)
  flux: {
    accent: '#3b82f6',
    svg: wrap(`
      <g transform="translate(48 44)">
        <circle r="5" fill="#3b82f6"/>
        <circle r="1.8" fill="#1a1033"/>
        <g fill="#3b82f6">
          <rect x="-1" y="-7" width="2" height="2.5"/>
          <rect x="-1" y="4.5" width="2" height="2.5"/>
          <rect x="-7" y="-1" width="2.5" height="2"/>
          <rect x="4.5" y="-1" width="2.5" height="2"/>
        </g>
      </g>
      <circle cx="38" cy="52" r="3" fill="#3b82f6" opacity="0.7"/>
      <circle cx="38" cy="52" r="1" fill="#1a1033"/>
    `)
  }
};

// Non-module fallback for inline scripts
if (typeof window !== 'undefined') window.STILO_ROBOTS = ROBOTS;
