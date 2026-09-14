#!/bin/zsh
# Blason daily autopilot. Runs from launchd (com.stilo.blason-sms-refill / -email-daily).
# SMS leg: enqueue yesterday's connected dials into campaign 4, generate copy, then
# STRIP any body that fails the banned-pattern check so fallback junk can never send.
# Email leg: run the client sequence with --send, cap 50.
# Logs: ~/Library/Logs/blason-autopilot.log
set -u
ENVF="/Users/remyleon/Desktop/AI Agency/sites/stilo-ai/.env.local"
export ENVF
CRON=$(grep '^CRON_SECRET=' "$ENVF" | cut -d= -f2- | tr -d '"')
LOG="$HOME/Library/Logs/blason-autopilot.log"
STAMP=$(date '+%Y-%m-%d %H:%M')
LEG="${1:-sms}"
{
echo "[$STAMP] === autopilot leg: $LEG ==="
if [ "$LEG" = "sms" ]; then
  curl -s -X POST "https://stiloaipartners.com/api/prospects/outbound-enqueue" \
    -H "Authorization: Bearer $CRON" -H "Content-Type: application/json" \
    -d '{"campaign_id":4,"audience":"warm"}' | head -c 300; echo ""
  curl -s -X POST "https://stiloaipartners.com/api/prospects/outbound-generate" \
    -H "Authorization: Bearer $CRON" -H "Content-Type: application/json" \
    -d '{"campaign_id":4,"step":1,"limit":60}' | head -c 200; echo ""
  # Validation gate: wipe unsent bodies carrying banned patterns (retired question,
  # Hialeah, any price talk). A bodyless target just waits; a bad body would SEND.
  node -e '
  const fs=require("fs");
  const env=fs.readFileSync(process.env.ENVF,"utf8");
  const get=k=>(env.match(new RegExp("^"+k+"=\"?([^\"\n]+)","m"))||[])[1];
  const U=get("SUPABASE_URL"),K=get("SUPABASE_SERVICE_KEY");
  const H={apikey:K,Authorization:"Bearer "+K,"Accept-Profile":"prospecting","Content-Profile":"prospecting","Content-Type":"application/json"};
  const banned=/hialeah|price|precio|\$|cost of|financing|cannot do|can.t do|no pueden hacer|asking for that/i;
  (async()=>{
    const r=await fetch(U+"/rest/v1/outbound_targets?campaign_id=eq.4&step1_sent_at=is.null&step1_body=not.is.null&select=id,step1_body",{headers:H});
    const rows=await r.json(); let wiped=0;
    for(const t of rows){ if(banned.test(t.step1_body||"")){
      await fetch(U+"/rest/v1/outbound_targets?id=eq."+t.id,{method:"PATCH",headers:H,body:JSON.stringify({step1_body:null,body_generated_at:null})}); wiped++; } }
    console.log("validation gate: "+rows.length+" unsent bodies checked, "+wiped+" wiped");
  })().catch(e=>console.log("gate ERR "+e.message));'
else
  node "/Users/remyleon/Desktop/AI Agency/sites/stilo-ai/scripts/send_client_sequence.js" --limit 50 --send 2>&1 | tail -3
fi
echo "[$STAMP] === leg $LEG done ==="
} >> "$LOG" 2>&1
