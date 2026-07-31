import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

const args = parseArgs(process.argv.slice(2));

try {
  const supabase = createSupabaseClient();
  const rule = normalizeQuotaOverridePayload(args);
  const { data, error } = await supabase
    .from("ai_quota_overrides")
    .insert(rule)
    .select("*")
    .single();

  if (error) {
    throw new Error(`Could not create AI quota override: ${error.message}`);
  }

  console.log(JSON.stringify({ ok: true, rule: data }, null, 2));
} catch (error) {
  console.error(error.message || error);
  process.exitCode = 1;
}

function parseArgs(rawArgs) {
  const parsed = {};

  for (const arg of rawArgs) {
    if (!arg.startsWith("--")) continue;

    const [rawKey, ...rawValue] = arg.slice(2).split("=");
    const key = toCamelCase(rawKey);
    const value = rawValue.length ? rawValue.join("=") : "true";
    parsed[key] = value;
  }

  if (parsed.help) {
    printUsage();
    process.exit(0);
  }

  return parsed;
}

function printUsage() {
  console.log(`Usage:
  npm run quota:override -- --device-id=<device-id> [--provider=gemini] [--usage-date=YYYY-MM-DD] [--ip-address=<ip>] [--daily-limit=20] [--extra-uses=5] [--blocked=true] [--note="reason"]

Examples:
  npm run quota:override -- --device-id=image2html.example-device-0001 --provider=gemini --extra-uses=5 --note="Manual top-up"
  npm run quota:override -- --device-id=image2html.example-device-0001 --provider=openai --daily-limit=25 --usage-date=2026-07-30
`);
}

function createSupabaseClient() {
  const url = String(process.env.SUPABASE_URL || "").trim();
  const serviceRoleKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();

  if (!url || !serviceRoleKey) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
  }

  return createClient(url, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    }
  });
}

function normalizeQuotaOverridePayload(payload = {}) {
  const deviceId = normalizeDeviceId(payload.deviceId || payload.device_id);
  if (!deviceId) {
    throw new Error("A valid --device-id value is required. Use the extension's anonymous device ID.");
  }

  return {
    provider: normalizeAiProvider(payload.provider || process.env.AI_VISION_PROVIDER) || "gemini",
    device_id: deviceId,
    ip_address: normalizeNullableText(payload.ipAddress || payload.ip_address),
    usage_date: normalizeUsageDate(payload.usageDate || payload.usage_date),
    daily_limit: parseNullableNonNegativeInt(payload.dailyLimit ?? payload.daily_limit, "daily-limit"),
    extra_uses: parseNonNegativeInt(payload.extraUses ?? payload.extra_uses, 0, "extra-uses"),
    is_blocked: parseBoolean(payload.blocked ?? payload.isBlocked ?? payload.is_blocked, false),
    status: normalizeQuotaStatus(payload.status),
    note: normalizeNullableText(payload.note)
  };
}

function normalizeDeviceId(deviceId) {
  const cleanId = String(deviceId || "").trim();
  return /^[a-zA-Z0-9._:-]{16,120}$/.test(cleanId) ? cleanId : "";
}

function normalizeAiProvider(value) {
  const provider = String(value || "").trim().toLowerCase();
  return /^[a-z0-9._:-]{2,64}$/.test(provider) ? provider : "";
}

function normalizeUsageDate(value) {
  const date = String(value || "").trim();
  if (!date) return null;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error("usage-date must be YYYY-MM-DD.");
  }

  return date;
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

  throw new Error("status must be active or deactive.");
}

function parseNullableNonNegativeInt(value, label) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  return parseNonNegativeInt(value, null, label);
}

function parseNonNegativeInt(value, fallback, label) {
  if (value === null || value === undefined || value === "") {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative number.`);
  }

  return parsed;
}

function parseBoolean(value, fallback) {
  if (value === null || value === undefined || value === "") {
    return fallback;
  }

  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

function toCamelCase(value) {
  return String(value || "").replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}
