/**
 * Smart 1 Suite — Promotions Proxy
 * --------------------------------------------------------------
 * The GoHighLevel Private Integration Token lives ONLY here (as an
 * environment variable). The promotions page calls this service; this
 * service calls GoHighLevel. The token never reaches the browser.
 *
 * Reads promotion OPPORTUNITIES and maps their custom fields to the six
 * display fields, resolving fields automatically by their key (no manual
 * field IDs needed).
 *
 * Opportunity custom fields used (folder "Promo"):
 *   promo_name            -> Promotion Name
 *   this_promo_is_for     -> This Promotion is for
 *   promo_start_date      -> Starts
 *   promo_end_date        -> Ends
 *   description_of_promo   -> Details
 *   promo_code_or_neccessary_item, promo_upload -> also returned (extra)
 *   (Contact comes from the opportunity's linked contact.)
 *
 * Environment variables (Render dashboard):
 *   GHL_PIT             (required)  Private Integration Token: pit-xxxx...
 *   GHL_LOCATION_ID     (required)  Sub-account / location ID
 *   ALLOWED_ORIGIN      (optional)  Default "*"
 *   PROMO_PIPELINE_ID   (optional)  If set, only this pipeline's opps show.
 *                                   If not set, any opp with promo_name shows.
 *
 * PIT scopes required:
 *   opportunities.readonly  AND  locations/customFields.readonly
 */

import express from "express";

const app = express();

const GHL_BASE = "https://services.leadconnectorhq.com";
const GHL_VERSION = "2021-07-28";

const {
  GHL_PIT,
  GHL_LOCATION_ID,
  ALLOWED_ORIGIN = "*",
  PROMO_PIPELINE_ID = "",
  PORT = 10000,
} = process.env;

// Short custom-field keys we care about -> our output field name.
const FIELD_MAP = {
  promo_name: "name",
  this_promo_is_for: "audience",
  promo_start_date: "start",
  promo_end_date: "end",
  description_of_promo: "details",
  promo_code_or_neccessary_item: "promoCode",
  promo_upload: "upload",
};

let cache = { data: null, at: 0 };
const CACHE_MS = 60 * 1000;

// Resolved once: short field key -> custom field id (definitions rarely change)
let fieldIdByKey = null;

// ---- CORS (read-only public promo data) ----
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

function ghlHeaders() {
  return {
    Authorization: `Bearer ${GHL_PIT}`,
    Version: GHL_VERSION,
    Accept: "application/json",
  };
}

async function ghlGet(path) {
  const resp = await fetch(`${GHL_BASE}${path}`, { headers: ghlHeaders() });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    const err = new Error(`GHL API ${resp.status}: ${body.slice(0, 300)}`);
    err.status = resp.status;
    throw err;
  }
  return resp.json();
}

// Normalize a fieldKey like "opportunity.promo_name" -> "promo_name"
function shortKey(fieldKey) {
  if (!fieldKey) return "";
  const parts = String(fieldKey).split(".");
  return parts[parts.length - 1].toLowerCase();
}

// Build (and cache) the map: short key -> custom field id
async function resolveFieldIds() {
  if (fieldIdByKey) return fieldIdByKey;
  const data = await ghlGet(
    `/locations/${encodeURIComponent(GHL_LOCATION_ID)}/customFields?model=opportunity`
  );
  const map = {};
  for (const f of data.customFields || []) {
    map[shortKey(f.fieldKey)] = f.id;
  }
  fieldIdByKey = map;
  return map;
}

// Read a custom field value off an opportunity by field id
function valueById(opp, id) {
  if (!id || !Array.isArray(opp.customFields)) return "";
  const m = opp.customFields.find(
    (f) => f.id === id || f.customFieldId === id
  );
  if (!m) return "";
  const v =
    m.fieldValue ??
    m.value ??
    m.field_value ??
    m.fieldValueString ??
    m.fieldValueArray ??
    m.selectedOptions ??
    "";
  return Array.isArray(v) ? v.join(", ") : String(v ?? "");
}

function toPromotion(opp, idMap) {
  const out = { id: opp.id };
  for (const [key, outName] of Object.entries(FIELD_MAP)) {
    out[outName] = valueById(opp, idMap[key]);
  }
  // Promotion Name falls back to the opportunity's own title
  if (!out.name) out.name = opp.name || "";
  // Contact from the linked contact record
  const c = opp.contact || {};
  out.contact =
    c.email || c.name || [c.firstName, c.lastName].filter(Boolean).join(" ") || "";
  return out;
}

function isPromotion(opp, idMap) {
  if (PROMO_PIPELINE_ID) return opp.pipelineId === PROMO_PIPELINE_ID;
  // Otherwise: treat it as a promotion if the promo_name field is filled
  return !!valueById(opp, idMap.promo_name);
}

async function fetchOpportunities() {
  const path =
    `/opportunities/search?location_id=${encodeURIComponent(GHL_LOCATION_ID)}&limit=100`;
  const data = await ghlGet(path);
  return data.opportunities || [];
}

async function buildPromotions() {
  const idMap = await resolveFieldIds();
  const opps = await fetchOpportunities();
  return opps
    .filter((o) => isPromotion(o, idMap))
    .map((o) => toPromotion(o, idMap));
}

// ---- Routes ----
function configOK(res) {
  if (!GHL_PIT || !GHL_LOCATION_ID) {
    res.status(500).json({ error: "Server not configured: set GHL_PIT and GHL_LOCATION_ID." });
    return false;
  }
  return true;
}

app.get("/", (req, res) => {
  res.json({ ok: true, service: "smart1-promos-proxy" });
});

app.get("/promotions", async (req, res) => {
  if (!configOK(res)) return;
  if (cache.data && Date.now() - cache.at < CACHE_MS) {
    return res.json({ promotions: cache.data, cached: true });
  }
  try {
    const promotions = await buildPromotions();
    cache = { data: promotions, at: Date.now() };
    res.json({ promotions, cached: false });
  } catch (err) {
    console.error(err);
    res.status(err.status || 502).json({ error: err.message });
  }
});

// Raw diagnostics: field-id resolution + what GHL returns for opportunities.
app.get("/debug", async (req, res) => {
  if (!configOK(res)) return;
  try {
    const idMap = await resolveFieldIds();
    const opps = await fetchOpportunities();
    res.json({
      resolvedFieldIds: idMap,
      totalOpportunities: opps.length,
      matchedAsPromotions: opps.filter((o) => isPromotion(o, idMap)).length,
      filter: PROMO_PIPELINE_ID
        ? `pipelineId === ${PROMO_PIPELINE_ID}`
        : "opportunities where promo_name is filled",
      rawSample: opps.slice(0, 2),
      mappedSample: opps.slice(0, 3).map((o) => toPromotion(o, idMap)),
    });
  } catch (err) {
    res.status(err.status || 502).json({ error: err.message });
  }
});

// List opportunity custom field definitions (ids + keys)
app.get("/custom-fields", async (req, res) => {
  if (!configOK(res)) return;
  try {
    const data = await ghlGet(
      `/locations/${encodeURIComponent(GHL_LOCATION_ID)}/customFields?model=opportunity`
    );
    res.json({
      customFields: (data.customFields || []).map((f) => ({
        id: f.id, name: f.name, fieldKey: f.fieldKey, dataType: f.dataType,
      })),
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Smart 1 promos proxy listening on ${PORT}`);
});
