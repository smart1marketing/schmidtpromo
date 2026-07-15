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
  PROMO_PIPELINE_NAME = "Schmidt Marketing Projects", // pipeline to match by name
  PROMO_STAGE_ID = "",
  PROMO_STAGE_NAME = "Upcoming Events", // stage within that pipeline to show
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

let promoScope = null; // { pipelineId, stageId } resolved once

async function getPipelines() {
  const data = await ghlGet(
    `/opportunities/pipelines?locationId=${encodeURIComponent(GHL_LOCATION_ID)}`
  );
  return data.pipelines || [];
}

// Resolve the pipeline + stage that hold promotions (explicit id wins, else by name).
async function resolvePromoScope() {
  if (promoScope) return promoScope;
  const pipelines = await getPipelines();

  let pipeline = null;
  if (PROMO_PIPELINE_ID) {
    pipeline = pipelines.find((p) => p.id === PROMO_PIPELINE_ID) || { id: PROMO_PIPELINE_ID, stages: [] };
  } else {
    const needle = PROMO_PIPELINE_NAME.toLowerCase();
    pipeline = pipelines.find((p) => (p.name || "").toLowerCase().includes(needle)) || null;
  }

  let stageId = "";
  if (pipeline) {
    if (PROMO_STAGE_ID) {
      stageId = PROMO_STAGE_ID;
    } else if (PROMO_STAGE_NAME) {
      const sNeedle = PROMO_STAGE_NAME.toLowerCase();
      const stage = (pipeline.stages || []).find((s) =>
        (s.name || "").toLowerCase().includes(sNeedle)
      );
      stageId = stage ? stage.id : "";
    }
  }

  promoScope = { pipelineId: pipeline ? pipeline.id : "", stageId };
  return promoScope;
}

async function fetchOpportunities(pipelineId) {
  let path =
    `/opportunities/search?location_id=${encodeURIComponent(GHL_LOCATION_ID)}&limit=100`;
  if (pipelineId) path += `&pipeline_id=${encodeURIComponent(pipelineId)}`;
  const data = await ghlGet(path);
  return data.opportunities || [];
}

// Some search results omit customFields; fetch the full opportunity if needed.
async function enrichIfNeeded(opp) {
  if (Array.isArray(opp.customFields) && opp.customFields.length) return opp;
  try {
    const data = await ghlGet(`/opportunities/${encodeURIComponent(opp.id)}`);
    const full = data.opportunity || data;
    if (Array.isArray(full.customFields)) opp.customFields = full.customFields;
  } catch {
    /* leave as-is if the detail call fails */
  }
  return opp;
}

function isPromotion(opp, idMap, scope) {
  if (scope.pipelineId) {
    if (opp.pipelineId !== scope.pipelineId) return false;
    if (scope.stageId && opp.pipelineStageId !== scope.stageId) return false;
    return true;
  }
  // No promo pipeline found: fall back to "promo_name is filled"
  return !!valueById(opp, idMap.promo_name);
}

async function buildPromotions() {
  const idMap = await resolveFieldIds();
  const scope = await resolvePromoScope();
  const opps = await fetchOpportunities(scope.pipelineId);
  const inScope = opps.filter((o) => isPromotion(o, idMap, scope));
  const enriched = await Promise.all(inScope.map(enrichIfNeeded));
  // Only real promotions: must have a Promo Name filled in.
  // (Hides event bookings in the same stage that have no promo fields.)
  return enriched
    .filter((o) => valueById(o, idMap.promo_name))
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

// List pipelines + their stages (name + id) so we can confirm the promo scope.
app.get("/pipelines", async (req, res) => {
  if (!configOK(res)) return;
  try {
    const pipelines = await getPipelines();
    res.json({
      chosenScope: await resolvePromoScope(),
      lookingFor: { pipelineName: PROMO_PIPELINE_NAME, stageName: PROMO_STAGE_NAME },
      pipelines: pipelines.map((p) => ({
        id: p.id,
        name: p.name,
        stages: (p.stages || []).map((s) => ({ id: s.id, name: s.name })),
      })),
    });
  } catch (err) {
    res.status(err.status || 502).json({ error: err.message });
  }
});

// Raw diagnostics: field-id resolution + what GHL returns for opportunities.
app.get("/debug", async (req, res) => {
  if (!configOK(res)) return;
  try {
    const idMap = await resolveFieldIds();
    const scope = await resolvePromoScope();

    // id -> field name, so we can label the raw values
    const defs = await ghlGet(
      `/locations/${encodeURIComponent(GHL_LOCATION_ID)}/customFields?model=opportunity`
    );
    const nameById = {};
    for (const f of defs.customFields || []) nameById[f.id] = f.name;

    const opps = await fetchOpportunities(scope.pipelineId);
    const matched = opps.filter((o) => isPromotion(o, idMap, scope));
    const enriched = await Promise.all(matched.slice(0, 3).map(enrichIfNeeded));

    const rawValue = (f) =>
      f.fieldValue ?? f.value ?? f.field_value ?? f.fieldValueString ??
      f.fieldValueArray ?? f.selectedOptions ?? "";

    res.json({
      chosenScope: scope,
      lookingFor: { pipelineName: PROMO_PIPELINE_NAME, stageName: PROMO_STAGE_NAME },
      opportunitiesInPipeline: opps.length,
      matchedAsPromotions: matched.length,
      mappedSample: enriched.map((o) => toPromotion(o, idMap)),
      // What each matched opportunity ACTUALLY has filled in:
      matchedFieldsSample: enriched.map((o) => ({
        id: o.id,
        title: o.name,
        customFieldsFilled: (o.customFields || []).map((f) => ({
          field: nameById[f.id || f.customFieldId] || f.id,
          value: rawValue(f),
        })),
      })),
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
