// hubspot-closed-won
// Returns closed-won HubSpot deals attributed to affiliate codes.
//
// Attribution chain:
//   affiliate link sets utm_campaign / affiliate_code = <code>
//   -> HubSpot contact (form submission) carries that value
//   -> contact's associated deals -> filter hs_is_closed_won = true
//   -> grouped back to the affiliate code.
//
// Request (POST JSON):  { code: "WILDFLOWER20" }  or  { codes: ["A","B"] }
// Response (always 200): { ok, configured, byCode: { CODE: { count, totalCents, deals[] } } }
//
// SECURITY NOTE: deployed with verify_jwt = false because this project's
// anon key is the new sb_publishable_* format (not a JWT). The endpoint is
// therefore open. Data exposed is closed-won deal names + amounts per code.
// Before production, gate this behind real per-merchant auth so a merchant
// can only request their own code(s).

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const HUBSPOT_TOKEN = Deno.env.get("HUBSPOT_TOKEN");
const HS = "https://api.hubapi.com";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

async function hs(path: string, body: unknown) {
  const res = await fetch(`${HS}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${HUBSPOT_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HubSpot ${path} ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

// Contacts attributed to any of the codes -> Map<contactId, code>
async function contactsForCodes(codes: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  let after: string | undefined;
  do {
    const data = await hs("/crm/v3/objects/contacts/search", {
      filterGroups: [
        { filters: [{ propertyName: "affiliate_code", operator: "IN", values: codes }] },
        { filters: [{ propertyName: "utm_campaign", operator: "IN", values: codes }] },
      ],
      properties: ["affiliate_code", "utm_campaign", "email"],
      limit: 100,
      after,
    });
    for (const c of data.results ?? []) {
      const p = c.properties ?? {};
      const code = codes.includes(p.affiliate_code) ? p.affiliate_code
        : codes.includes(p.utm_campaign) ? p.utm_campaign
        : null;
      if (code) map.set(String(c.id), code);
    }
    after = data.paging?.next?.after;
  } while (after);
  return map;
}

// contact -> deal associations (v4 batch) -> Map<contactId, dealId[]>
async function dealsForContacts(contactIds: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  for (let i = 0; i < contactIds.length; i += 100) {
    const chunk = contactIds.slice(i, i + 100);
    const data = await hs("/crm/v4/associations/contact/deal/batch/read", {
      inputs: chunk.map((id) => ({ id })),
    });
    for (const r of data.results ?? []) {
      const from = String(r.from?.id ?? "");
      const ids = (r.to ?? []).map((t: any) => String(t.toObjectId ?? t.id));
      if (from) out.set(from, ids);
    }
  }
  return out;
}

// deal props (batch) -> Map<dealId, props>
async function readDeals(dealIds: string[]): Promise<Map<string, any>> {
  const out = new Map<string, any>();
  for (let i = 0; i < dealIds.length; i += 100) {
    const chunk = dealIds.slice(i, i + 100);
    const data = await hs("/crm/v3/objects/deals/batch/read", {
      properties: ["dealname", "amount", "closedate", "deal_currency_code", "hs_is_closed_won"],
      inputs: chunk.map((id) => ({ id })),
    });
    for (const d of data.results ?? []) out.set(String(d.id), d.properties ?? {});
  }
  return out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);

  let payload: any = {};
  try { payload = await req.json(); } catch { /* ignore */ }
  let codes: string[] = Array.isArray(payload.codes)
    ? payload.codes
    : typeof payload.code === "string" ? [payload.code] : [];
  codes = codes.map((c) => String(c).trim()).filter(Boolean);

  const byCode: Record<string, { count: number; totalCents: number; deals: any[] }> = {};
  for (const code of codes) byCode[code] = { count: 0, totalCents: 0, deals: [] };

  if (!codes.length) return json({ ok: false, configured: !!HUBSPOT_TOKEN, error: "Provide code or codes[]", byCode });
  if (!HUBSPOT_TOKEN) return json({ ok: false, configured: false, error: "HUBSPOT_TOKEN not set", byCode });

  try {
    const contactCode = await contactsForCodes(codes);
    if (contactCode.size) {
      const contactIds = [...contactCode.keys()];
      const assoc = await dealsForContacts(contactIds);
      const dealCode = new Map<string, string>();
      for (const [cid, dealIds] of assoc) {
        const code = contactCode.get(cid)!;
        for (const did of dealIds) if (!dealCode.has(did)) dealCode.set(did, code);
      }
      const allDealIds = [...dealCode.keys()];
      if (allDealIds.length) {
        const deals = await readDeals(allDealIds);
        for (const [did, props] of deals) {
          if (String(props.hs_is_closed_won) !== "true") continue;
          const code = dealCode.get(did)!;
          const amountCents = Math.round(parseFloat(props.amount || "0") * 100) || 0;
          const bucket = byCode[code];
          bucket.count += 1;
          bucket.totalCents += amountCents;
          bucket.deals.push({
            id: did,
            brand: props.dealname || "(unnamed deal)",
            amountCents,
            currency: props.deal_currency_code || "USD",
            closedate: props.closedate || null,
          });
        }
      }
    }
    for (const code of codes) {
      byCode[code].deals.sort((a, b) => (b.closedate || "").localeCompare(a.closedate || ""));
    }
    return json({ ok: true, configured: true, byCode });
  } catch (e) {
    return json({ ok: false, configured: true, error: String((e as Error)?.message || e), byCode }, 200);
  }
});
