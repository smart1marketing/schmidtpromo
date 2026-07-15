/**
 * Smart 1 Suite — Promotions Proxy
 * --------------------------------------------------------------
 * The GoHighLevel Private Integration Token lives ONLY here (as an
 * environment variable). The public promotions page calls this service;
 * this service calls GoHighLevel. The token never reaches the browser.
 *
 * DATA_SOURCE controls where promotions come from:
 *   "form"        (default) reads submissions from a specific form.
 *                 Simplest: no workflow / opportunity setup needed.
 *   "opportunity" reads Opportunities (needs a form->opportunity workflow
 *                 in Suite; use this if you want pipeline/stage logic).
 *
 * Environment variables (set these in the Render dashboard):
 *   GHL_PIT          (required)  Private Integration Token: pit-xxxx...
 *   GHL_LOCATION_ID  (required)  The sub-account / location ID
 *   DATA_SOURCE      (optional)  "form" (default) or "opportunity"
 *   FORM_ID          (required for form mode) e.g. HiSs6ID0Yw8nu5ISjech
 *   ALLOWED_ORIGIN   (optional)  Default "*" (this feed is public promo info)
 *
 * PIT scopes needed:
 *   form mode        -> forms.readonly
 *   opportunity mode -> opportunities.readonly (+ locations/customFields.readonly)
 *
 * Field mapping (form mode auto-detects by label; override if needed):
 *   FIELD_NAME_KEY, FIELD_AUDIENCE_KEY, FIELD_START_KEY,
 *   FIELD_DETAILS_KEY, FIELD_END_KEY, FIELD_CONTACT_KEY
 *
 * Field mapping (opportunity mode, custom field IDs from /custom-fields):
 *   CF_AUDIENCE_ID, CF_START_ID, CF_END_ID, CF_DETAILS_ID
 */

import express from "express";

const app = express();

const GHL_BASE = "https://services.leadconnectorhq.com";
const GHL_VERSION = "2021-07-28";

const {
  GHL_PIT,
  GHL_LOCATION_ID,
  DATA_SOURCE = "form",
  FORM_ID = "",
  ALLOWED_ORIGIN = "*",

  // form-mode field key overrides (optional)
  FIELD_NAME_KEY = "",
  FIELD_AUDIENCE_KEY = "",
  FIELD_START_KEY = "",
  FIELD_DETAILS_KEY = "",
  FIELD_END_KEY = "",
  FIELD_CONTACT_KEY = "",

  // opportunity-mode custom field IDs (optional)
  CF_AUDIENCE_ID = "",
  CF_START_ID = "",
  CF_END_ID = "",
  CF_DETAILS_ID = "",
  PROMO_PIPELINE_ID = "",
  PROMO_KEYWORDS = "promo,sale,offer,discount,deal",

  PORT = 10000,
} = process.env;

// ---- tiny cache so we don't hammer the GHL API ----
let cache = { data: null, at: 0 };
const CACHE_MS = 60 * 1000;

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

/* ======================= FORM MODE ======================= */

function fetchSubmissions() {
  const path =
    `/forms/submissions` +
    `?locationId=${encodeURIComponent(GHL_LOCATION_ID)}` +
    `&formId=${encodeURIComponent(FORM_ID)}` +
    `&limit=100`;
  return ghlGet(path).then((d) => d.submissions || d.data || []);
}

// keys that are metadata, not form answers
const META_KEYS = new Set([
  "id", "formId", "form_id", "contactId", "contact_id", "locationId",
  "location_id", "createdAt", "created_at", "dateAdded", "updatedAt",
  "pageUrl", "page_url", "eventData", "source", "medium",
]);

function stringify(v) {
  if (v === null || v === undefined) return "";
  if (Array.isArray(v)) return v.map(stringify).filter(Boolean).join(", ");
  if (typeof v === "object") {
    // GHL sometimes nests { value: "...", label: "..." }
    if ("value" in v) return stringify(v.value);
    return Object.values(v).map(stringify).filter(Boolean).join(", ");
  }
  return String(v);
}

/** Flatten a submission into simple { key: "text value" } pairs. */
function flattenSubmission(sub) {
  const flat = {};
  for (const [k, v] of Object.entries(sub || {})) {
    if (META_KEYS.has(k)) continue;
    flat[k] = stringify(v);
  }
  // Some responses tuck answers under "others" or "customFields"
  if (sub && typeof sub.others === "object") {
    for (const [k, v] of Object.entries(sub.others)) flat[k] = stringify(v);
  }
  if (Array.isArray(sub && sub.customFields)) {
    for (const f of sub.customFields) {
      const key = f.name || f.label || f.id || f.key;
      if (key) flat[key] = stringify(f.value ?? f.fieldValue ?? f.field_value);
    }
  }
  return flat;
}

// find a value by explicit key, else by fuzzy label match
function pick(flat, explicitKey, patterns) {
  if (explicitKey && flat[explicitKey] !== undefined) return flat[explicitKey];
  for (const [k, v] of Object.entries(flat)) {
    if (!v) continue;
    if (patterns.some((re) => re.test(k))) return v;
  }
  return "";
}

function submissionToPromotion(sub) {
  const flat = flattenSubmission(sub);
  const name = pick(flat, FIELD_NAME_KEY, [/promotion.*name/i, /^name$/i, /title/i]);
  return {
    id: sub.id || "",
    name: name || "",
    audience: pick(flat, FIELD_AUDIENCE_KEY, [/\bfor\b/i, /audience/i, /who/i]),
    start: pick(flat, FIELD_START_KEY, [/start/i, /begin/i]),
    end: pick(flat, FIELD_END_KEY, [/\bend/i, /expire/i, /finish/i]),
    details: pick(flat, FIELD_DETAILS_KEY, [/detail/i, /descrip/i, /message/i]),
    contact: pick(flat, FIELD_CONTACT_KEY, [/contact/i, /email/i]) ||
             stringify(sub.email) || "",
    createdAt: sub.createdAt || sub.dateAdded || "",
  };
}

/* =================== OPPORTUNITY MODE ==================== */

function getCustomField(opp, fieldId) {
  if (!fieldId || !Array.isArray(opp.customFields)) return "";
  const m = opp.customFields.find(
    (f) => f.id === fieldId || f.customFieldId === fieldId || f.key === fieldId
  );
  if (!m) return "";
  const v = m.fieldValue ?? m.value ?? m.field_value ?? m.fieldValueString ?? m.selectedOptions ?? "";
  return Array.isArray(v) ? v.join(", ") : String(v ?? "");
}

function opportunityToPromotion(opp) {
  const c = opp.contact || {};
  return {
    id: opp.id,
    name: opp.name || "",
    audience: getCustomField(opp, CF_AUDIENCE_ID),
    start: getCustomField(opp, CF_START_ID),
    end: getCustomField(opp, CF_END_ID),
    details: getCustomField(opp, CF_DETAILS_ID),
    contact: c.email || c.name || [c.firstName, c.lastName].filter(Boolean).join(" ") || "",
  };
}

function opportunityPasses(opp) {
  if (PROMO_PIPELINE_ID) return opp.pipelineId === PROMO_PIPELINE_ID;
  const kws = PROMO_KEYWORDS.split(",").map((k) => k.trim().toLowerCase()).filter(Boolean);
  if (!kws.length) return true;
  return kws.some((k) => (opp.name || "").toLowerCase().includes(k));
}

function fetchOpportunities() {
  const path =
    `/opportunities/search?location_id=${encodeURIComponent(GHL_LOCATION_ID)}&limit=100`;
  return ghlGet(path).then((d) => d.opportunities || []);
}

/* ======================= ROUTES ========================= */

function configOK(res) {
  if (!GHL_PIT || !GHL_LOCATION_ID) {
    res.status(500).json({ error: "Server not configured: set GHL_PIT and GHL_LOCATION_ID." });
    return false;
  }
  if (DATA_SOURCE === "form" && !FORM_ID) {
    res.status(500).json({ error: "Form mode needs FORM_ID set." });
    return false;
  }
  return true;
}

app.get("/", (req, res) => {
  res.json({ ok: true, service: "smart1-promos-proxy", dataSource: DATA_SOURCE });
});

async function buildPromotions() {
  if (DATA_SOURCE === "opportunity") {
    const opps = await fetchOpportunities();
    return opps.filter(opportunityPasses).map(opportunityToPromotion);
  }
  const subs = await fetchSubmissions();
  return subs.map(submissionToPromotion).filter((p) => p.name); // must have a name
}

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

// Raw diagnostics — shows exactly what GHL returns so we can map fields.
app.get("/debug", async (req, res) => {
  if (!configOK(res)) return;
  try {
    if (DATA_SOURCE === "opportunity") {
      const opps = await fetchOpportunities();
      return res.json({
        dataSource: "opportunity",
        totalOpportunities: opps.length,
        matched: opps.filter(opportunityPasses).length,
        sample: opps.slice(0, 3),
      });
    }
    const subs = await fetchSubmissions();
    res.json({
      dataSource: "form",
      formId: FORM_ID,
      totalSubmissions: subs.length,
      // raw first few, plus how we'd flatten + map them
      rawSample: subs.slice(0, 3),
      flattenedSample: subs.slice(0, 3).map(flattenSubmission),
      mappedSample: subs.slice(0, 3).map(submissionToPromotion),
    });
  } catch (err) {
    res.status(err.status || 502).json({ error: err.message });
  }
});

// Helper for opportunity mode: list custom field IDs
app.get("/custom-fields", async (req, res) => {
  if (!GHL_PIT || !GHL_LOCATION_ID) {
    return res.status(500).json({ error: "Set GHL_PIT and GHL_LOCATION_ID." });
  }
  try {
    const data = await ghlGet(
      `/locations/${encodeURIComponent(GHL_LOCATION_ID)}/customFields?model=opportunity`
    );
    res.json({
      customFields: (data.customFields || []).map((f) => ({
        id: f.id, name: f.name, dataType: f.dataType, fieldKey: f.fieldKey,
      })),
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Smart 1 promos proxy (${DATA_SOURCE} mode) listening on ${PORT}`);
});
