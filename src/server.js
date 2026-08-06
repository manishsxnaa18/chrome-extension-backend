import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import ExcelJS from "exceljs";
import multer from "multer";
import { createClient } from "@supabase/supabase-js";
import { extractFieldsWithOllama, reconstructFormHtmlWithOllama } from "./extractWithOllama.js";
import { extractFieldsWithPaddle } from "./extractWithPaddle.js";
import { getConfiguredAiVisionStatus, reconstructFormHtmlWithConfiguredAi, reconstructFormHtmlWithVisionModel } from "./extractWithVisionModel.js";
import { mapAiFillFields } from "./mapAiFillFields.js";

dotenv.config();

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024
  }
});

const port = process.env.PORT || 3000;
const host = process.env.HOST || (process.env.RENDER ? "0.0.0.0" : "127.0.0.1");
const freeDailyAiCalls = parsePositiveInt(process.env.FREE_DAILY_AI_CALLS ?? process.env.FREE_DAILY_GEMINI_CALLS, 10);
const aiUsageTimeZone = String(process.env.AI_USAGE_TIME_ZONE || "Asia/Kolkata").trim() || "Asia/Kolkata";
const adminApiKey = String(process.env.ADMIN_API_KEY || "").trim();
const supabase = createSupabaseClient();
const aiUsageByClient = new Map();
const memoryAiQuotaOverrides = [];
let nextMemoryQuotaOverrideId = 1;

app.set("trust proxy", 1);
app.use(cors({
  exposedHeaders: ["X-AI-Daily-Limit", "X-AI-Daily-Remaining", "X-Gemini-Daily-Limit", "X-Gemini-Daily-Remaining"]
}));
app.use(express.json());

app.get("/health", (req, res) => {
  res.json({ ok: true, service: "school-form-autofill-backend" });
});

app.get("/ai-usage", handleAiUsageRequest);
app.get("/gemini-usage", handleAiUsageRequest);

async function handleAiUsageRequest(req, res) {
  const deviceId = normalizeDeviceId(req.get("x-device-id"));

  if (!deviceId) {
    return res.status(400).json({
      error: "Anonymous device ID is required to check AI usage."
    });
  }

  try {
    const today = getUsageDateKey();
    const ip = getClientIp(req);
    const provider = normalizeAiProvider(req.query.provider) || getConfiguredAiQuotaProvider();
    const quota = await getAiQuota({ provider, deviceId, ip, usageDate: today });
    const used = supabase
      ? await getSupabaseAiUsageCount({ provider, deviceId, usageDate: today })
      : getMemoryAiUsageCount({ provider, deviceId, usageDate: today });
    const remaining = quota.blocked ? 0 : Math.max(0, quota.limit - used);

    setAiUsageHeaders(res, { provider, limit: quota.limit, remaining });
    res.json({
      limit: quota.limit,
      used,
      remaining,
      blocked: quota.blocked,
      date: today
    });
  } catch (err) {
    handleRouteError(err, res);
  }
}

app.get("/ocr-status", async (req, res) => {
  try {
    res.json({
      ok: true,
      provider: "ocr",
      htmlModels: {
        ai: getPublicAiVisionStatus()
      }
    });
  } catch (err) {
    handleRouteError(err, res);
  }
});

app.get("/admin/ai-quota", requireAdminApiKey, handleAdminAiQuotaRequest);
app.get("/admin/gemini-quota", requireAdminApiKey, handleAdminAiQuotaRequest);

async function handleAdminAiQuotaRequest(req, res) {
  try {
    const deviceId = normalizeDeviceId(req.query.deviceId);
    if (!deviceId) {
      return res.status(400).json({ error: "deviceId is required." });
    }

    const usageDate = normalizeUsageDate(req.query.usageDate) || getUsageDateKey();
    const ip = String(req.query.ipAddress || "").trim();
    const provider = normalizeAiProvider(req.query.provider) || getConfiguredAiQuotaProvider();
    const quota = await getAiQuota({ provider, deviceId, ip, usageDate });
    const used = supabase
      ? await getSupabaseAiUsageCount({ provider, deviceId, usageDate })
      : getMemoryAiUsageCount({ provider, deviceId, usageDate });

    res.json({
      provider,
      deviceId,
      ipAddress: ip || null,
      usageDate,
      used,
      limit: quota.limit,
      remaining: quota.blocked ? 0 : Math.max(0, quota.limit - used),
      blocked: quota.blocked,
      rules: quota.rules
    });
  } catch (err) {
    handleRouteError(err, res);
  }
}

app.post("/admin/ai-quota", requireAdminApiKey, handleCreateAiQuotaOverride);
app.post("/admin/gemini-quota", requireAdminApiKey, handleCreateAiQuotaOverride);

async function handleCreateAiQuotaOverride(req, res) {
  try {
    const rule = await createAiQuotaOverride(req.body || {});
    res.status(201).json({ ok: true, rule });
  } catch (err) {
    handleRouteError(err, res);
  }
}

app.post("/admin/ai-quota/extra-uses", requireAdminApiKey, handleCreateAiExtraUses);
app.post("/admin/gemini-quota/extra-uses", requireAdminApiKey, handleCreateAiExtraUses);

async function handleCreateAiExtraUses(req, res) {
  try {
    const body = req.body || {};
    const rule = await createAiQuotaOverride({
      ...body,
      extraUses: body.extraUses ?? body.uses,
      status: "active",
      note: body.note || "Manual extra uses"
    });
    res.status(201).json({ ok: true, rule });
  } catch (err) {
    handleRouteError(err, res);
  }
}

app.post("/admin/ai-quota/block", requireAdminApiKey, handleCreateAiBlock);
app.post("/admin/gemini-quota/block", requireAdminApiKey, handleCreateAiBlock);

async function handleCreateAiBlock(req, res) {
  try {
    const rule = await createAiQuotaOverride({
      ...(req.body || {}),
      isBlocked: true,
      status: "active",
      note: req.body?.note || "Blocked by admin"
    });
    res.status(201).json({ ok: true, rule });
  } catch (err) {
    handleRouteError(err, res);
  }
}

app.post("/admin/ai-quota/:id/deactivate", requireAdminApiKey, handleDeactivateAiQuotaOverride);
app.post("/admin/gemini-quota/:id/deactivate", requireAdminApiKey, handleDeactivateAiQuotaOverride);

async function handleDeactivateAiQuotaOverride(req, res) {
  try {
    const rule = await deactivateAiQuotaOverride(req.params.id);
    res.json({ ok: true, rule });
  } catch (err) {
    handleRouteError(err, res);
  }
}

app.post("/ai-fill-map", enforceAiJsonDailyLimit, async (req, res) => {
  try {
    const result = await mapAiFillFields({
      fields: req.body?.fields || {},
      controls: req.body?.controls || []
    });
    const usage = await consumeAiUsage(req, res);

    if (!usage.allowed) {
      return sendAiLimitResponse(res);
    }

    res.json({ ok: true, mappings: result.mappings, aiUsage: toPublicAiUsage(usage) });
  } catch (err) {
    handlePublicAiRouteError(err, res);
  }
});

app.post("/extract", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "File is required." });
    }

    const extraction = await extractFields(req.file);

    res.json({
      sourceFile: {
        name: req.file.originalname,
        type: req.file.mimetype,
        size: req.file.size
      },
      ...extraction
    });
  } catch (err) {
    handleRouteError(err, res);
  }
});

app.post("/reconstruct-html", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "File is required." });
    }

    const extraction = await reconstructFormHtmlWithOllama(req.file);

    res.json({
      sourceFile: {
        name: req.file.originalname,
        type: req.file.mimetype,
        size: req.file.size
      },
      ...extraction
    });
  } catch (err) {
    handleRouteError(err, res);
  }
});

app.post("/reconstruct-html/qwen", upload.single("file"), (req, res) => {
  reconstructHtmlWithProvider(req, res, "qwen");
});

app.post("/reconstruct-html/glm", upload.single("file"), (req, res) => {
  reconstructHtmlWithProvider(req, res, "glm");
});

app.post("/reconstruct-html/ai", upload.single("file"), enforceAiDailyLimit, (req, res) => {
  reconstructHtmlWithConfiguredAi(req, res);
});

app.post("/reconstruct-html/gemini", upload.single("file"), enforceAiDailyLimit, (req, res) => {
  reconstructHtmlWithConfiguredAi(req, res);
});

app.post("/reconstruct-html/openrouter", upload.single("file"), (req, res) => {
  reconstructHtmlWithProvider(req, res, "openrouter");
});

app.post("/reconstruct-excel/ai", upload.single("file"), enforceAiDailyLimit, reconstructExcelWithConfiguredAi);
app.post("/reconstruct-excel/gemini", upload.single("file"), enforceAiDailyLimit, reconstructExcelWithConfiguredAi);

async function reconstructExcelWithConfiguredAi(req, res) {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "File is required." });
    }

    const extraction = await reconstructFormHtmlWithConfiguredAi(req.file, { mode: "text" });
    const excel = await createExcelExport(extraction, req.file.originalname);
    const usage = await consumeAiUsage(req, res);

    if (!usage.allowed) {
      return sendAiLimitResponse(res);
    }

    res.json({
      sourceFile: {
        name: req.file.originalname,
        type: req.file.mimetype,
        size: req.file.size
      },
      fields: extraction.fields,
      rawText: extraction.rawText,
      model: "AI",
      excel,
      aiUsage: toPublicAiUsage(usage)
    });
  } catch (err) {
    handlePublicAiRouteError(err, res);
  }
}

async function reconstructHtmlWithConfiguredAi(req, res) {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "File is required." });
    }

    const extraction = await reconstructFormHtmlWithConfiguredAi(req.file, { mode: getAiGenerationMode(req) });
    const usage = await consumeAiUsage(req, res);

    if (!usage.allowed) {
      return sendAiLimitResponse(res);
    }

    res.json({
      sourceFile: {
        name: req.file.originalname,
        type: req.file.mimetype,
        size: req.file.size
      },
      ...sanitizePublicAiExtraction(extraction),
      aiUsage: toPublicAiUsage(usage)
    });
  } catch (err) {
    handlePublicAiRouteError(err, res);
  }
}

async function reconstructHtmlWithProvider(req, res, provider) {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "File is required." });
    }

    const extraction = await reconstructFormHtmlWithVisionModel(req.file, provider, { mode: getAiGenerationMode(req) });
    let usage = null;

    if (provider === "gemini") {
      usage = await consumeAiUsage(req, res);

      if (!usage.allowed) {
        return sendAiLimitResponse(res);
      }
    }

    res.json({
      sourceFile: {
        name: req.file.originalname,
        type: req.file.mimetype,
        size: req.file.size
      },
      ...extraction,
      ...(usage ? { aiUsage: toPublicAiUsage(usage) } : {})
    });
  } catch (err) {
    handleRouteError(err, res);
  }
}

async function createExcelExport(extraction, originalName = "document") {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Image2HTML AI";
  workbook.created = new Date();

  const fields = getExportableFields(extraction.fields || {});
  const fieldsSheet = workbook.addWorksheet("Fields");
  fieldsSheet.columns = [
    { header: "Field", key: "field", width: 34 },
    { header: "Value", key: "value", width: 56 }
  ];
  fieldsSheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  fieldsSheet.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F4E79" } };
  fieldsSheet.getRow(1).alignment = { vertical: "middle" };

  if (fields.length) {
    fields.forEach(([field, value]) => fieldsSheet.addRow({ field: labelFromKey(field), value }));
  } else {
    fieldsSheet.addRow({ field: "Extracted text", value: extraction.rawText || "" });
  }

  fieldsSheet.eachRow((row) => {
    row.eachCell((cell) => {
      cell.border = {
        top: { style: "thin", color: { argb: "FFD9E2EC" } },
        left: { style: "thin", color: { argb: "FFD9E2EC" } },
        bottom: { style: "thin", color: { argb: "FFD9E2EC" } },
        right: { style: "thin", color: { argb: "FFD9E2EC" } }
      };
      cell.alignment = { vertical: "top", wrapText: true };
    });
  });

  const rawText = extraction.rawText || fieldsToText(extraction.fields || {});
  if (rawText) {
    const textSheet = workbook.addWorksheet("Raw Text");
    textSheet.columns = [{ header: "Text", key: "text", width: 100 }];
    textSheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
    textSheet.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F4E79" } };
    rawText.split(/\r?\n/).forEach((line) => textSheet.addRow({ text: line }));
    textSheet.eachRow((row) => {
      row.eachCell((cell) => {
        cell.alignment = { vertical: "top", wrapText: true };
      });
    });
  }

  const buffer = await workbook.xlsx.writeBuffer();
  const baseName = String(originalName || "document").replace(/\.[^.]+$/, "").replace(/[^\w.-]+/g, "-") || "document";

  return {
    fileName: `${baseName}-extracted.xlsx`,
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    base64: Buffer.from(buffer).toString("base64"),
    sheetNames: workbook.worksheets.map((sheet) => sheet.name),
    rowCount: fields.length || (rawText ? 1 : 0)
  };
}

function getExportableFields(fields) {
  return Object.entries(fields || {}).filter(([key, value]) => key !== "raw_text" && value !== null && value !== undefined && String(value).trim());
}

function labelFromKey(key) {
  return String(key || "")
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function fieldsToText(fields) {
  return getExportableFields(fields)
    .map(([key, value]) => `${labelFromKey(key)}: ${value}`)
    .join("\n");
}

async function getAiQuota({ provider, deviceId, ip, usageDate }) {
  const rules = supabase
    ? await getSupabaseQuotaRules({ provider, deviceId, ip, usageDate })
    : getMemoryQuotaRules({ provider, deviceId, ip, usageDate });
  const activeRules = rules.filter((rule) => rule.status === "active");
  const blocked = activeRules.some((rule) => Boolean(rule.is_blocked));
  const limitOverrides = activeRules
    .map((rule) => parseNullablePositiveInt(rule.daily_limit))
    .filter((value) => value !== null);
  const extraUses = activeRules.reduce((total, rule) => total + Math.max(0, Number(rule.extra_uses || 0)), 0);
  const baseLimit = limitOverrides.length ? Math.max(...limitOverrides) : freeDailyAiCalls;

  return {
    blocked,
    limit: Math.max(0, baseLimit + extraUses),
    rules
  };
}

async function getSupabaseQuotaRules({ provider, deviceId, ip, usageDate }) {
  const { data, error } = await supabase
    .from("ai_quota_overrides")
    .select("*")
    .eq("provider", provider)
    .eq("device_id", deviceId)
    .eq("status", "active")
    .order("created_at", { ascending: false });

  if (error) {
    throw new Error(`Could not check AI quota overrides: ${error.message}`);
  }

  return (data || []).filter((rule) => quotaRuleMatches(rule, { ip, usageDate }));
}

function getMemoryQuotaRules({ provider, deviceId, ip, usageDate }) {
  return memoryAiQuotaOverrides.filter((rule) => {
    return rule.provider === provider && rule.device_id === deviceId && rule.status === "active" && quotaRuleMatches(rule, { ip, usageDate });
  });
}

function quotaRuleMatches(rule, { ip, usageDate }) {
  const ruleDate = rule.usage_date ? String(rule.usage_date).slice(0, 10) : "";
  const ruleIp = String(rule.ip_address || "").trim();

  return (!ruleDate || ruleDate === usageDate) && (!ruleIp || ruleIp === ip);
}

async function createAiQuotaOverride(payload) {
  const rule = normalizeQuotaOverridePayload(payload);

  if (supabase) {
    const { data, error } = await supabase
      .from("ai_quota_overrides")
      .insert(rule)
      .select("*")
      .single();

    if (error) {
      throw createHttpError(`Could not create AI quota override: ${error.message}`, 400);
    }

    return data;
  }

  const now = new Date().toISOString();
  const memoryRule = {
    id: nextMemoryQuotaOverrideId,
    ...rule,
    created_at: now,
    updated_at: now
  };

  nextMemoryQuotaOverrideId += 1;
  memoryAiQuotaOverrides.push(memoryRule);
  return memoryRule;
}

async function deactivateAiQuotaOverride(id) {
  const ruleId = Number.parseInt(id, 10);
  if (!Number.isFinite(ruleId) || ruleId <= 0) {
    throw createHttpError("Valid quota rule id is required.", 400);
  }

  if (supabase) {
    const { data, error } = await supabase
      .from("ai_quota_overrides")
      .update({ status: "deactive", updated_at: new Date().toISOString() })
      .eq("id", ruleId)
      .select("*")
      .single();

    if (error) {
      throw createHttpError(`Could not deactivate AI quota override: ${error.message}`, 400);
    }

    return data;
  }

  const rule = memoryAiQuotaOverrides.find((item) => item.id === ruleId);
  if (!rule) {
    throw createHttpError("Quota rule not found.", 404);
  }

  rule.status = "deactive";
  rule.updated_at = new Date().toISOString();
  return rule;
}

function normalizeQuotaOverridePayload(payload = {}) {
  const deviceId = normalizeDeviceId(payload.deviceId || payload.device_id);
  if (!deviceId) {
    throw createHttpError("deviceId is required.", 400);
  }

  const usageDate = normalizeUsageDate(payload.usageDate || payload.usage_date);
  const dailyLimit = parseNullablePositiveInt(payload.dailyLimit ?? payload.daily_limit);
  const extraUses = parseNonNegativeInt(payload.extraUses ?? payload.extra_uses, 0);
  const status = normalizeQuotaStatus(payload.status);

  return {
    provider: normalizeAiProvider(payload.provider) || getConfiguredAiQuotaProvider(),
    device_id: deviceId,
    ip_address: normalizeNullableText(payload.ipAddress || payload.ip_address),
    usage_date: usageDate,
    daily_limit: dailyLimit,
    extra_uses: extraUses,
    is_blocked: Boolean(payload.isBlocked ?? payload.is_blocked ?? false),
    status,
    note: normalizeNullableText(payload.note)
  };
}

async function enforceAiDailyLimit(req, res, next) {
  return enforceAiRequestLimit(req, res, next, { requireFile: true });
}

async function enforceAiJsonDailyLimit(req, res, next) {
  return enforceAiRequestLimit(req, res, next, { requireFile: false });
}

async function enforceAiRequestLimit(req, res, next, { requireFile }) {
  if (!req.file) {
    if (requireFile) {
      return res.status(400).json({ error: "File is required." });
    }
  }

  const deviceId = normalizeDeviceId(req.get("x-device-id"));

  if (!deviceId) {
    return res.status(400).json({
      error: "Anonymous device ID is required to use AI generation."
    });
  }

  const today = getUsageDateKey();
  const ip = getClientIp(req);
  const endpoint = req.path;
  const provider = getConfiguredAiQuotaProvider();

  try {
    const quota = await getAiQuota({ provider, deviceId, ip, usageDate: today });

    if (quota.blocked) {
      return sendAiBlockedResponse(res, { provider, limit: quota.limit });
    }

    const used = supabase
      ? await getSupabaseAiUsageCount({ provider, deviceId, usageDate: today })
      : getMemoryAiUsageCount({ provider, deviceId, usageDate: today });

    if (used >= quota.limit) {
      return sendAiLimitResponse(res, { provider, limit: quota.limit });
    }

    setAiUsageHeaders(res, { provider, limit: quota.limit, remaining: Math.max(0, quota.limit - used) });
    req.aiUsageContext = {
      provider,
      deviceId,
      ip,
      usageDate: today,
      endpoint,
      limit: quota.limit,
      remaining: Math.max(0, quota.limit - used)
    };
    next();
  } catch (err) {
    handleRouteError(err, res);
  }
}

async function consumeAiUsage(req, res) {
  const context = req.aiUsageContext;

  if (!context) {
    return { allowed: true, remaining: null };
  }

  const usage = supabase
    ? await recordSupabaseAiUsage({
        provider: context.provider,
        deviceId: context.deviceId,
        ip: context.ip,
        usageDate: context.usageDate,
        endpoint: context.endpoint,
        dailyLimit: context.limit
      })
    : recordMemoryAiUsage({
        provider: context.provider,
        deviceId: context.deviceId,
        ip: context.ip,
        usageDate: context.usageDate,
        dailyLimit: context.limit
      });

  setAiUsageHeaders(res, {
    provider: context.provider || getConfiguredAiQuotaProvider(),
    limit: context.limit || freeDailyAiCalls,
    remaining: usage.remaining
  });
  return {
    ...usage,
    limit: context.limit || freeDailyAiCalls
  };
}

function toPublicAiUsage(usage = {}) {
  const limit = Number(usage.limit || freeDailyAiCalls);
  const remaining = Math.max(0, Number(usage.remaining || 0));

  return {
    limit,
    used: Math.max(0, limit - remaining),
    remaining,
    date: usage.usageDate || getUsageDateKey()
  };
}

function sendAiLimitResponse(res, { provider = getConfiguredAiQuotaProvider(), limit = freeDailyAiCalls } = {}) {
  setAiUsageHeaders(res, { provider, limit, remaining: 0 });
  return res.status(429).json({
    error: `Daily AI uses are finished (${limit}/${limit}). Please come back tomorrow.`,
    code: "DAILY_AI_LIMIT_REACHED",
    limit,
    remaining: 0
  });
}

function sendAiBlockedResponse(res, { provider = getConfiguredAiQuotaProvider(), limit = freeDailyAiCalls } = {}) {
  setAiUsageHeaders(res, { provider, limit, remaining: 0 });
  return res.status(403).json({
    error: "AI access is currently deactivated for this user.",
    code: "AI_ACCESS_DEACTIVATED",
    limit,
    remaining: 0
  });
}

async function getSupabaseAiUsageCount({ provider, deviceId, usageDate }) {
  const { data, error } = await supabase.rpc("get_ai_usage_count", {
    p_usage_date: usageDate,
    p_provider: provider,
    p_device_id: deviceId
  });

  if (error) {
    if (isMissingSupabaseFunctionError(error)) {
      return getSupabaseAiUsageCountByQuery({ provider, deviceId, usageDate });
    }

    throw new Error(`Could not check AI usage: ${error.message}`);
  }

  return Math.max(0, Number(data || 0));
}

async function getSupabaseAiUsageCountByQuery({ provider, deviceId, usageDate }) {
  const { count, error } = await supabase
    .from("ai_usages")
    .select("id", { count: "exact", head: true })
    .eq("usage_date", usageDate)
    .eq("provider", provider)
    .eq("device_id", deviceId);

  if (error) {
    throw new Error(`Could not check AI usage: ${error.message}`);
  }

  return Math.max(0, Number(count || 0));
}

async function recordSupabaseAiUsage({ provider, deviceId, ip, usageDate, endpoint, dailyLimit = freeDailyAiCalls }) {
  const { data, error } = await supabase.rpc("record_ai_usage", {
    p_usage_date: usageDate,
    p_provider: provider,
    p_ip_address: ip,
    p_device_id: deviceId,
    p_endpoint: endpoint,
    p_daily_limit: dailyLimit
  });

  if (error) {
    if (isMissingSupabaseFunctionError(error)) {
      return recordSupabaseAiUsageByQuery({ provider, deviceId, ip, usageDate, endpoint, dailyLimit });
    }

    throw new Error(`Could not record AI usage: ${error.message}`);
  }

  const usage = Array.isArray(data) ? data[0] : data;
  return {
    allowed: Boolean(usage?.allowed),
    remaining: Math.max(0, Number(usage?.remaining || 0))
  };
}

async function recordSupabaseAiUsageByQuery({ provider, deviceId, ip, usageDate, endpoint, dailyLimit = freeDailyAiCalls }) {
  const currentCount = await getSupabaseAiUsageCountByQuery({ provider, deviceId, usageDate });

  if (currentCount >= dailyLimit) {
    return { allowed: false, remaining: 0 };
  }

  const { error } = await supabase
    .from("ai_usages")
    .insert({
      usage_date: usageDate,
      provider,
      ip_address: ip,
      device_id: deviceId,
      endpoint
    });

  if (error) {
    throw new Error(`Could not record AI usage: ${error.message}`);
  }

  return {
    allowed: true,
    remaining: Math.max(0, dailyLimit - currentCount - 1)
  };
}

function isMissingSupabaseFunctionError(error) {
  return String(error?.message || "").toLowerCase().includes("could not find the function");
}

function getMemoryAiUsageCount({ provider, deviceId, usageDate }) {
  pruneOldUsage(usageDate);

  const suffix = `:${deviceId}`;
  let total = 0;

  for (const [key, count] of aiUsageByClient.entries()) {
    if (key.startsWith(`${usageDate}:${provider}:`) && key.endsWith(suffix)) {
      total += count;
    }
  }

  return total;
}

function recordMemoryAiUsage({ provider, deviceId, ip, usageDate, dailyLimit = freeDailyAiCalls }) {
  pruneOldUsage(usageDate);

  const key = `${usageDate}:${provider}:${ip}:${deviceId}`;
  const currentCount = getMemoryAiUsageCount({ provider, deviceId, usageDate });
  if (currentCount >= dailyLimit) {
    return { allowed: false, remaining: 0 };
  }

  aiUsageByClient.set(key, (aiUsageByClient.get(key) || 0) + 1);
  return {
    allowed: true,
    remaining: Math.max(0, dailyLimit - currentCount - 1)
  };
}

function normalizeDeviceId(deviceId) {
  const cleanId = String(deviceId || "").trim();
  return /^[a-zA-Z0-9._:-]{16,120}$/.test(cleanId) ? cleanId : "";
}

function requireAdminApiKey(req, res, next) {
  if (!adminApiKey) {
    return res.status(503).json({
      error: "Admin APIs are not configured."
    });
  }

  const authHeader = String(req.get("authorization") || "").trim();
  const bearerToken = authHeader.toLowerCase().startsWith("bearer ") ? authHeader.slice(7).trim() : "";
  const providedKey = bearerToken || String(req.get("x-admin-api-key") || req.query.adminKey || "").trim();

  if (providedKey !== adminApiKey) {
    return res.status(401).json({
      error: "Admin API key is required."
    });
  }

  next();
}

function normalizeUsageDate(value) {
  const date = String(value || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null;
}

function normalizeNullableText(value) {
  const text = String(value || "").trim();
  return text || null;
}

function normalizeQuotaStatus(value) {
  const status = String(value || "active").trim().toLowerCase();
  if (status === "active" || status === "deactive") {
    return status;
  }

  throw createHttpError("status must be active or deactive.", 400);
}

function parseNullablePositiveInt(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw createHttpError("dailyLimit must be a non-negative number.", 400);
  }

  return parsed;
}

function parseNonNegativeInt(value, fallback) {
  if (value === null || value === undefined || value === "") {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw createHttpError("extraUses must be a non-negative number.", 400);
  }

  return parsed;
}

function createHttpError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function getClientIp(req) {
  const forwardedFor = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return forwardedFor || req.ip || req.socket?.remoteAddress || "unknown";
}

function getUsageDateKey(date = new Date()) {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: aiUsageTimeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).formatToParts(date);
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

function pruneOldUsage(today) {
  for (const key of aiUsageByClient.keys()) {
    if (!key.startsWith(`${today}:`)) {
      aiUsageByClient.delete(key);
    }
  }
}

function setAiUsageHeaders(res, { provider, limit, remaining }) {
  res.set("X-AI-Daily-Limit", String(limit));
  res.set("X-AI-Daily-Remaining", String(remaining));
  res.set("X-Gemini-Daily-Limit", String(limit));
  res.set("X-Gemini-Daily-Remaining", String(remaining));
}

function sanitizePublicAiExtraction(extraction = {}) {
  return {
    ...extraction,
    htmlMode: String(extraction.htmlMode || "").includes("text-extraction") ? "ai-text-extraction" : "ai-reconstruction",
    model: "AI",
    endpoint: undefined,
    primaryProvider: undefined,
    fallbackProvider: undefined,
    fallbackReason: undefined
  };
}

function getAiGenerationMode(req) {
  const mode = String(req.body?.generationMode || req.body?.mode || "").trim().toLowerCase();
  return mode === "html" ? "html" : "text";
}

function handlePublicAiRouteError(err, res) {
  console.error(err);
  const status = err.statusCode || err.status || 500;
  const payload = {
    error: status >= 500
      ? "AI generation failed. Please try again."
      : sanitizePublicAiErrorMessage(err.publicMessage || err.message || "AI generation failed. Please try again.")
  };

  if (err.code) {
    payload.code = err.code;
  }

  res.status(status).json(payload);
}

function sanitizePublicAiErrorMessage(message) {
  return String(message || "")
    .replace(/\bGemini\b/gi, "AI")
    .replace(/\bOpenRouter\b/gi, "AI")
    .replace(/\bOpenAI\b/gi, "AI")
    .replace(/\bClaude\b/gi, "AI")
    .replace(/\bQwen(?:2\.5-VL)?\b/gi, "AI")
    .replace(/\bGLM(?:-OCR)?\b/gi, "AI");
}

function getPublicAiVisionStatus() {
  const status = getConfiguredAiVisionStatus();

  return {
    provider: "ai",
    label: "AI",
    configured: Boolean(status?.primary),
    fallbackConfigured: Boolean(status?.fallback)
  };
}

function getConfiguredAiQuotaProvider() {
  return normalizeAiProvider(process.env.AI_VISION_PROVIDER) || "gemini";
}

function normalizeAiProvider(value) {
  const provider = String(value || "").trim().toLowerCase();
  return /^[a-z0-9._:-]{2,64}$/.test(provider) ? provider : "";
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function createSupabaseClient() {
  const url = String(process.env.SUPABASE_URL || "").trim();
  const serviceRoleKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();

  if (!url || !serviceRoleKey) {
    return null;
  }

  if (isPlaceholderEnvValue(url) || isPlaceholderEnvValue(serviceRoleKey) || !isValidUrl(url)) {
    console.warn("Supabase usage tracking is disabled because SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is not configured correctly.");
    return null;
  }

  try {
    return createClient(url, serviceRoleKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false
      }
    });
  } catch {
    console.warn("Supabase usage tracking is disabled because the Supabase client could not be created.");
    return null;
  }
}

function isValidUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function isPlaceholderEnvValue(value) {
  return ["your_supabase_project_url", "your_service_role_key"].includes(String(value || "").trim().toLowerCase());
}

function handleRouteError(err, res) {
  console.error(err);
  const payload = {
    error: err.publicMessage || err.message || "Something went wrong."
  };

  if (err.code) {
    payload.code = err.code;
  }

  res.status(err.statusCode || err.status || 500).json(payload);
}

function extractFields(file) {
  const provider = getOcrProvider();

  if (process.env.USE_MOCK_OCR === "true" || provider === "mock") {
    return createMockExtraction();
  }

  if (provider === "ollama") {
    return extractFieldsWithOllama(file);
  }

  return extractFieldsWithPaddle(file);
}

function getOcrProvider() {
  const provider = (process.env.OCR_PROVIDER || "paddle").toLowerCase();
  return ["mock", "paddle", "ollama"].includes(provider) ? provider : "paddle";
}

function createMockExtraction() {
  const rawText = [
    "Student Name: Sample Name",
    "Date: 2016-08-12",
    "Contact Number: 9876543210",
    "Address: Sample address"
  ].join("\n");

  return {
    fields: {
      extracted_name: "Sample Name",
      extracted_date: "2016-08-12",
      contact_number: "9876543210",
      address_line: "Sample address"
    },
    rawText,
    html: rawText.split("\n").map((line) => `<p>${line}</p>`).join(""),
    unmatched: [],
    model: "mock"
  };
}

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: err.message });
  }

  console.error(err);
  res.status(err.statusCode || 500).json({ error: err.message || "Something went wrong." });
});

app.listen(port, host, () => {
  console.log(`Backend running on http://${host}:${port}`);
});
