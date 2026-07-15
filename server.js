/**
 * Smart 1 Suite — Promotions Proxy
 * --------------------------------------------------------------
 * This tiny web service is the ONLY place the GoHighLevel Private
 * Integration Token lives. The public promotions page calls THIS
 * service; this service calls GoHighLevel. The token is never sent
 * to the browser.
 *
 * This follows GoHighLevel's own guidance: the Private Integration
 * Token is stored as a secure server environment variable.
 *
 * Environment variables (set these in the Render dashboard):
 *   GHL_PIT          (required)  Your Private Integration Token: pit-xxxxxxxx...
 *   GHL_LOCATION_ID  (required)  The sub-account / location ID
 *   ALLOWED_ORIGIN   (optional)  Origin allowed to read this feed.
 *                                Default "*" (fine — this feed is public promo info).
 *                                To lock it down: https://your-promos-domain.com
 *
 * Custom field mapping (set the ones you use — get IDs from GET /custom-fields):
 *   CF_AUDIENCE_ID   Custom field ID for "This Promotion is for"
 *   CF_START_ID      Custom field ID for the promotion Start date
 *   CF_END_ID        Custom field ID for the promotion End date
 *   CF_DETAILS_ID    Custom field ID for the promotion Details/Description
 *
 * Optional filtering:
 *   PROMO_PIPELINE_ID   If set, only opportunities in this pipeline are returned.
 *   PROMO_KEYWORDS      Comma-separated keywords; if set (and no pipeline id),
 *                       only opportunities whose name matches are returned.
 *                       Default: "promo,sale,offer,discount,deal"
 */

import express from "express";

const app = express();

const GHL_BASE = "https://services.leadconnectorhq.com";
const GHL_VERSION = "2021-07-28";

const {
  GHL_PIT,
  GHL_LOCATION_ID,
  ALLOWED_ORIGIN = "*",
  CF_AUDIENCE_ID = "",
  CF_START_ID = "",
  CF_END_ID = "",
  CF_DETAILS_ID = "",
  PROMO_PIPELINE_ID = "",
  PROMO_KEYWORDS = "promo,sale,offer,discount,deal",
  PORT = 10000,
} = process.env;

// ---- Simple in-memory cache so we don't hammer the GHL API ----
let cache = { data: null, at: 0 };
const CACHE_MS = 60 * 1000; // 60 seconds

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

/**
 * Pull a custom field value off an opportunity by its field id.
 * GHL has returned custom field values under a few different keys over
 * time, so we check all of the likely ones.
 */
function getCustomField(opp, fieldId) {
  if (!fieldId || !Array.isArray(opp.customFields)) return "";
  const match = opp.customFields.find(
    (f) => f.id === fieldId || f.customFieldId === fieldId || f.key === fieldId
  );
  if (!match) return "";
  const v =
    match.fieldValue ??
    match.value ??
    match.field_value ??
    match.fieldValueString ??
    match.selectedOptions ??
    "";
  return Array.isArray(v) ? v.join(", ") : String(v ?? "");
}

/** Map a raw GHL opportunity to the clean shape the page renders. */
function toPromotion(opp) {
  const contact = opp.contact || {};
  return {
    id: opp.id,
    name: opp.name || "",
    audience: getCustomField(opp, CF_AUDIENCE_ID), // "This Promotion is for"
    start: getCustomField(opp, CF_START_ID),
    end: getCustomField(opp, CF_END_ID),
    details: getCustomField(opp, CF_DETAILS_ID),
    contact:
      contact.email ||
      contact.name ||
      [contact.firstName, contact.lastName].filter(Boolean).join(" ") ||
      "",
    status: opp.status || "",
  };
}

function passesFilter(opp) {
  if (PROMO_PIPELINE_ID) return opp.pipelineId === PROMO_PIPELINE_ID;
  const keywords = PROMO_KEYWORDS.split(",")
    .map((k) => k.trim().toLowerCase())
    .filter(Boolean);
  if (keywords.length === 0) return true;
  const name = (opp.name || "").toLowerCase();
  return keywords.some((k) => name.includes(k));
}

async function fetchOpportunities() {
  const url =
    `${GHL_BASE}/opportunities/search` +
    `?location_id=${encodeURIComponent(GHL_LOCATION_ID)}` +
    `&limit=100`;

  const resp = await fetch(url, { headers: ghlHeaders() });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    const err = new Error(`GHL API ${resp.status}: ${body.slice(0, 300)}`);
    err.status = resp.status;
    throw err;
  }
  const data = await resp.json();
  return data.opportunities || [];
}

// ---- Health check (Render pings this) ----
app.get("/", (req, res) => {
  res.json({ ok: true, service: "smart1-promos-proxy" });
});

// ---- Main feed the promotions page calls ----
app.get("/promotions", async (req, res) => {
  if (!GHL_PIT || !GHL_LOCATION_ID) {
    return res
      .status(500)
      .json({ error: "Server not configured: set GHL_PIT and GHL_LOCATION_ID." });
  }

  // Serve from cache when fresh
  if (cache.data && Date.now() - cache.at < CACHE_MS) {
    return res.json({ promotions: cache.data, cached: true });
  }

  try {
    const opps = await fetchOpportunities();
    const promotions = opps.filter(passesFilter).map(toPromotion);
    cache = { data: promotions, at: Date.now() };
    res.json({ promotions, cached: false });
  } catch (err) {
    console.error(err);
    res.status(err.status || 502).json({ error: err.message });
  }
});

// ---- Helper: list custom field definitions so you can grab the IDs ----
// Visit https://your-service.onrender.com/custom-fields once during setup,
// copy the IDs you need into the CF_* env vars, then you can ignore this.
app.get("/custom-fields", async (req, res) => {
  if (!GHL_PIT || !GHL_LOCATION_ID) {
    return res
      .status(500)
      .json({ error: "Server not configured: set GHL_PIT and GHL_LOCATION_ID." });
  }
  try {
    const url = `${GHL_BASE}/locations/${encodeURIComponent(
      GHL_LOCATION_ID
    )}/customFields?model=opportunity`;
    const resp = await fetch(url, { headers: ghlHeaders() });
    const data = await resp.json();
    const fields = (data.customFields || []).map((f) => ({
      id: f.id,
      name: f.name,
      dataType: f.dataType,
      fieldKey: f.fieldKey,
    }));
    res.json({ customFields: fields });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ---- Debug: see what GHL actually returns (names, pipelines, custom fields) ----
// Visit https://your-service.onrender.com/debug during setup, then remove/ignore.
app.get("/debug", async (req, res) => {
  if (!GHL_PIT || !GHL_LOCATION_ID) {
    return res
      .status(500)
      .json({ error: "Server not configured: set GHL_PIT and GHL_LOCATION_ID." });
  }
  try {
    const opps = await fetchOpportunities();
    res.json({
      totalOpportunities: opps.length,
      activeFilter: PROMO_PIPELINE_ID
        ? `pipelineId === ${PROMO_PIPELINE_ID}`
        : `name contains one of: ${PROMO_KEYWORDS}`,
      matchedAsPromotions: opps.filter(passesFilter).length,
      opportunities: opps.map((o) => ({
        id: o.id,
        name: o.name,
        status: o.status,
        pipelineId: o.pipelineId,
        pipelineStageId: o.pipelineStageId,
        contact: o.contact
          ? { name: o.contact.name, email: o.contact.email }
          : null,
        customFields: (o.customFields || []).map((f) => ({
          id: f.id || f.customFieldId || f.key,
          value:
            f.fieldValue ??
            f.value ??
            f.field_value ??
            f.fieldValueString ??
            f.selectedOptions ??
            "",
        })),
      })),
    });
  } catch (err) {
    res.status(err.status || 502).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Smart 1 promos proxy listening on ${PORT}`);
});
