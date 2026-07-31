const HTML_RECONSTRUCTION_PROMPT = [
  "You are converting a scanned school admission form image into clean HTML.",
  "Recreate the visible form layout as closely as possible using HTML and CSS.",
  "Use a root <div class=\"ai-form-page\"> and include a <style> tag scoped to .ai-form-page.",
  "Preserve headings, sections, rows, columns, tables, checkboxes, blank answer lines, boxed digit fields, and photo placeholders.",
  "Use real HTML tables where the form has tables.",
  "Use CSS borders for boxes and lines. Do not use external images, scripts, remote fonts, or JavaScript.",
  "Use readable text and professional spacing. If text is unclear, include the best visible guess.",
  "The output must be selectable/copyable HTML that visually resembles the original form.",
  "Also extract visible filled values into a flat JSON object named fields.",
  "Use snake_case keys such as student_name, date_of_birth, father_name, mother_name, phone, email, address, class, school_name.",
  "Return only valid JSON, not markdown, not explanations, and no code fences.",
  "Use exactly this shape: {\"html\":\"<div class=\\\"ai-form-page\\\">...</div>\",\"fields\":{\"student_name\":\"...\"}}.",
  "If no filled values are visible, return an empty fields object."
].join(" ");

const VISION_PROVIDERS = {
  qwen: {
    label: "Qwen2.5-VL",
    urlEnv: "QWEN_VL_URL",
    modelEnv: "QWEN_VL_MODEL",
    apiKeyEnv: "QWEN_VL_API_KEY",
    defaultUrl: "http://127.0.0.1:11434/v1/chat/completions",
    defaultModel: "qwen2.5vl:7b"
  },
  glm: {
    label: "GLM-OCR",
    urlEnv: "GLM_VL_URL",
    modelEnv: "GLM_VL_MODEL",
    apiKeyEnv: "GLM_VL_API_KEY",
    defaultUrl: "http://127.0.0.1:11434/v1/chat/completions",
    defaultModel: "glm-ocr:latest"
  },
  gemini: {
    label: "Gemini",
    urlEnv: "GEMINI_URL",
    modelEnv: "GEMINI_MODEL",
    apiKeyEnv: "GEMINI_API_KEY",
    defaultUrl: "https://generativelanguage.googleapis.com/v1beta/interactions",
    defaultModel: process.env.GEMINI_MODEL,
    format: "gemini-interactions"
  },
  openrouter: {
    label: "OpenRouter",
    urlEnv: "OPENROUTER_URL",
    modelEnv: "OPENROUTER_MODEL",
    apiKeyEnv: "OPENROUTER_API_KEY",
    defaultUrl: "https://openrouter.ai/api/v1/chat/completions",
    defaultModel: "google/gemma-4-31b-it:free,google/gemma-4-26b-a4b-it:free,nvidia/nemotron-nano-12b-v2-vl:free,nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free"
  }
};

export async function reconstructFormHtmlWithConfiguredAi(file) {
  const primaryProvider = getConfiguredAiProviderName("AI_VISION_PROVIDER", "gemini");
  const fallbackProvider = getConfiguredAiProviderName("AI_VISION_FALLBACK_PROVIDER", "");

  try {
    return await reconstructFormHtmlWithVisionModel(file, primaryProvider);
  } catch (err) {
    if (!fallbackProvider || fallbackProvider === primaryProvider || !shouldTryFallback(err)) {
      throw err;
    }

    console.warn(`${primaryProvider} vision provider failed. Trying ${fallbackProvider} fallback.`);

    try {
      const extraction = await reconstructFormHtmlWithVisionModel(file, fallbackProvider);
      return {
        ...extraction,
        primaryProvider,
        fallbackProvider,
        fallbackReason: err.publicMessage || err.message || ""
      };
    } catch (fallbackErr) {
      throw createFallbackVisionError(primaryProvider, fallbackProvider, err, fallbackErr);
    }
  }
}

export async function reconstructFormHtmlWithVisionModel(file, providerName) {
  const provider = getVisionProvider(providerName);
  const endpoint = process.env[provider.urlEnv] || provider.defaultUrl;
  const model = process.env[provider.modelEnv] || provider.defaultModel;
  const apiKey = process.env[provider.apiKeyEnv];
  const imageBase64 = file.buffer.toString("base64");
  const mimeType = file.mimetype || "image/png";

  if (provider.format === "gemini-interactions") {
    return reconstructFormHtmlWithGemini({ provider, providerName, endpoint, model, apiKey, imageBase64, mimeType });
  }

  return reconstructFormHtmlWithOpenRouterCompatible({ provider, providerName, endpoint, model, apiKey, imageBase64, mimeType });
}

async function reconstructFormHtmlWithOpenRouterCompatible({ provider, providerName, endpoint, model, apiKey, imageBase64, mimeType }) {
  if (providerName === "openrouter" && !apiKey) {
    throw createVisionError(provider, `${provider.apiKeyEnv} is required.`);
  }

  const headers = {
    "Content-Type": "application/json"
  };

  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  if (providerName === "openrouter") {
    const referer = String(process.env.OPENROUTER_HTTP_REFERER || "").trim();
    const title = String(process.env.OPENROUTER_APP_TITLE || "Image2HTML AI").trim();

    if (referer) {
      headers["HTTP-Referer"] = referer;
    }

    if (title) {
      headers["X-Title"] = title;
    }
  }

  const modelCandidates = providerName === "openrouter" ? getOpenRouterModelCandidates(model) : [model];
  let lastError = null;

  for (const modelCandidate of modelCandidates) {
    try {
      return await requestOpenRouterCompatibleReconstruction({
        provider,
        providerName,
        endpoint,
        model: modelCandidate,
        headers,
        imageBase64,
        mimeType
      });
    } catch (err) {
      lastError = err;

      if (providerName !== "openrouter" || !shouldTryNextOpenRouterModel(err)) {
        throw err;
      }

      console.warn(`OpenRouter model ${modelCandidate} failed. Trying next free vision model.`);
    }
  }

  throw lastError || createVisionError(provider, "No OpenRouter vision models were available.");
}

async function requestOpenRouterCompatibleReconstruction({ provider, providerName, endpoint, model, headers, imageBase64, mimeType }) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      temperature: 0.1,
      max_tokens: 6000,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: HTML_RECONSTRUCTION_PROMPT
            },
            {
              type: "image_url",
              image_url: {
                url: `data:${mimeType};base64,${imageBase64}`
              }
            }
          ]
        }
      ]
    })
  }).catch((err) => {
    throw createVisionError(provider, `Could not connect to ${endpoint}. ${err.message}`);
  });

  if (!response.ok) {
    const details = await response.text().catch(() => "");
    const providerMessage = readProviderErrorMessage(details);
    throw createVisionError(provider, `${endpoint} returned ${response.status}. ${providerMessage || details}`, {
      providerMessage,
      status: response.status
    });
  }

  const data = await response.json();
  const reconstruction = parseReconstructionResponse(readChatCompletionText(data));
  const html = reconstruction.html;
  const rawText = htmlToText(html) || fieldsToText(reconstruction.fields);
  const actualModel = data?.model || model;
  assertVisionReconstruction(provider, providerName, {
    html,
    fields: reconstruction.fields,
    rawText,
    model: actualModel
  });

  return {
    fields: addRawTextField(reconstruction.fields, rawText),
    rawText,
    html,
    htmlMode: `${providerName}-ai-reconstruction`,
    unmatched: [],
    model: `${providerName}-vision-html:${actualModel}`,
    endpoint
  };
}

async function reconstructFormHtmlWithGemini({ provider, providerName, endpoint, model, apiKey, imageBase64, mimeType }) {
  if (!apiKey) {
    throw createVisionError(provider, `${provider.apiKeyEnv} is required.`);
  }

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey
    },
    body: JSON.stringify({
      model,
      input: [
        {
          type: "text",
          text: HTML_RECONSTRUCTION_PROMPT
        },
        {
          type: "image",
          data: imageBase64,
          mime_type: mimeType
        }
      ]
    })
  }).catch((err) => {
    throw createVisionError(provider, `Could not connect to ${endpoint}. ${err.message}`);
  });

  if (!response.ok) {
    const details = await response.text().catch(() => "");
    const providerMessage = readProviderErrorMessage(details);
    throw createVisionError(provider, `${endpoint} returned ${response.status}. ${providerMessage || details}`, {
      providerMessage,
      status: response.status
    });
  }

  const data = await response.json();
  const reconstruction = parseReconstructionResponse(readGeminiInteractionText(data));
  const html = reconstruction.html;
  const rawText = htmlToText(html) || fieldsToText(reconstruction.fields);
  assertVisionReconstruction(provider, providerName, {
    html,
    fields: reconstruction.fields,
    rawText,
    model
  });

  return {
    fields: addRawTextField(reconstruction.fields, rawText),
    rawText,
    html,
    htmlMode: `${providerName}-ai-reconstruction`,
    unmatched: [],
    model: `${providerName}-vision-html:${model}`,
    endpoint
  };
}

export function getVisionModelStatus(providerName) {
  const provider = getVisionProvider(providerName);
  return {
    provider: providerName,
    label: provider.label,
    endpoint: process.env[provider.urlEnv] || provider.defaultUrl,
    model: process.env[provider.modelEnv] || provider.defaultModel,
    hasApiKey: Boolean(process.env[provider.apiKeyEnv])
  };
}

export function getConfiguredAiVisionStatus() {
  const primaryProvider = getConfiguredAiProviderName("AI_VISION_PROVIDER", "gemini");
  const fallbackProvider = getConfiguredAiProviderName("AI_VISION_FALLBACK_PROVIDER", "");

  return {
    primaryProvider,
    fallbackProvider: fallbackProvider || null,
    primary: getVisionModelStatus(primaryProvider),
    fallback: fallbackProvider ? getVisionModelStatus(fallbackProvider) : null
  };
}

function getConfiguredAiProviderName(envName, fallback) {
  const providerName = String(process.env[envName] || fallback || "").trim().toLowerCase();
  return providerName || "";
}

function shouldTryFallback(err) {
  return err?.statusCode >= 500 || err?.status >= 500 || err?.providerStatusCode === 429 || ["VISION_PROVIDER_UNAVAILABLE", "VISION_PROVIDER_ERROR"].includes(err?.code);
}

function getOpenRouterModelCandidates(model) {
  const configuredModels = String(process.env.OPENROUTER_MODELS || model || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  return [...new Set(configuredModels)];
}

function shouldTryNextOpenRouterModel(err) {
  const message = String(err?.message || err?.publicMessage || "").toLowerCase();
  return (
    err?.providerStatusCode === 404 ||
    err?.providerStatusCode === 429 ||
    err?.statusCode === 404 ||
    err?.status === 404 ||
    err?.statusCode === 429 ||
    err?.status === 429 ||
    message.includes("returned 404") ||
    message.includes("returned 429") ||
    message.includes("rate limit") ||
    message.includes("provider returned error") ||
    message.includes("model is unavailable") ||
    message.includes("non-vision safety model") ||
    message.includes("did not return usable form html") ||
    message.includes("empty html reconstruction")
  );
}

function getVisionProvider(providerName) {
  const provider = VISION_PROVIDERS[providerName];

  if (!provider) {
    const error = new Error(`Unsupported vision provider: ${providerName}`);
    error.statusCode = 400;
    throw error;
  }

  return provider;
}

function readChatCompletionText(data) {
  const content = data?.choices?.[0]?.message?.content;

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }

        return part?.text || "";
      })
      .join("")
      .trim();
  }

  return String(content || data?.response || "").trim();
}

function readGeminiInteractionText(data) {
  if (typeof data?.output_text === "string") {
    return data.output_text.trim();
  }

  const output = data?.output;

  if (Array.isArray(output)) {
    const text = readGeminiParts(output);
    if (text) return text;
  }

  const steps = data?.steps;

  if (Array.isArray(steps)) {
    const modelOutput = steps.filter((step) => step?.type === "model_output");
    const text = readGeminiParts(modelOutput);
    if (text) return text;
  }

  return readChatCompletionText(data);
}

function readGeminiParts(items) {
  return items
    .flatMap((item) => item?.content || item?.parts || [])
    .map((part) => {
      if (typeof part === "string") {
        return part;
      }

      return part?.text || part?.output_text || "";
    })
    .join("")
    .trim();
}

function normalizeHtmlResponse(value) {
  return String(value || "")
    .trim()
    .replace(/^```(?:html)?\s*/i, "")
    .replace(/```$/i, "")
    .trim();
}

function parseReconstructionResponse(value) {
  const text = String(value || "").trim();
  const parsed = parseJsonObject(text);

  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const html = normalizeHtmlResponse(parsed.html || parsed.form_html || parsed.markup || "");
    const fields = normalizeFields(parsed.fields || parsed.data || parsed.values || {});

    return {
      html,
      fields
    };
  }

  return {
    html: normalizeHtmlResponse(text),
    fields: {}
  };
}

function parseJsonObject(value) {
  const cleaned = String(value || "")
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```$/i, "")
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");

    if (start === -1 || end <= start) {
      return null;
    }

    try {
      return JSON.parse(cleaned.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

function normalizeFields(fields) {
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) {
    return {};
  }

  return Object.entries(fields).reduce((normalized, [key, value]) => {
    if (value === null || value === undefined) {
      return normalized;
    }

    const cleanKey = String(key || "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
    const cleanValue = Array.isArray(value) ? value.join(", ") : String(value).trim();

    if (cleanKey && cleanValue) {
      normalized[cleanKey] = cleanValue;
    }

    return normalized;
  }, {});
}

function addRawTextField(fields, rawText) {
  return rawText ? { ...fields, raw_text: rawText } : fields;
}

function fieldsToText(fields) {
  return Object.entries(fields || {})
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n");
}

function assertVisionReconstruction(provider, providerName, reconstruction) {
  const html = String(reconstruction.html || "").trim();
  const rawText = String(reconstruction.rawText || "").trim();
  const model = String(reconstruction.model || "").trim();
  const fieldKeys = Object.keys(reconstruction.fields || {}).filter((key) => key !== "raw_text");
  const combinedText = `${model}\n${html}\n${rawText}\n${fieldsToText(reconstruction.fields)}`.toLowerCase();

  if (providerName === "openrouter" && /content[-_\s]?safety|safety: safe|user safety/.test(combinedText)) {
    throw createVisionError(provider, `OpenRouter selected a non-vision safety model (${model || "unknown model"}). Set OPENROUTER_MODEL to a vision model.`, {
      status: 502
    });
  }

  if (!html) {
    throw createVisionError(provider, "The model returned an empty HTML reconstruction.", {
      status: 502
    });
  }

  if (!/<[a-z][\s\S]*>/i.test(html) && !fieldKeys.length && rawText.length < 40) {
    throw createVisionError(provider, "The model did not return usable form HTML.", {
      status: 502
    });
  }
}

function htmlToText(html) {
  return String(html || "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<\/(p|div|tr|table|section|header|h[1-6]|li)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

function readProviderErrorMessage(details) {
  const text = String(details || "").trim();

  if (!text) {
    return "";
  }

  try {
    const payload = JSON.parse(text);
    return String(payload?.error?.message || payload?.message || "").trim();
  } catch {
    return "";
  }
}

function createVisionError(provider, message, options = {}) {
  const error = new Error(`${provider.label} HTML OCR failed: ${message}`);
  error.statusCode = 503;
  error.providerStatusCode = options.status || null;
  error.code = options.status >= 500 ? "VISION_PROVIDER_UNAVAILABLE" : "VISION_PROVIDER_ERROR";
  error.publicMessage = createVisionPublicMessage(provider, options.providerMessage || message);
  return error;
}

function createVisionPublicMessage(provider, message) {
  const cleanMessage = String(message || "").replace(/\s+/g, " ").trim();
  const lowerMessage = cleanMessage.toLowerCase();

  if (lowerMessage.includes("high demand") || lowerMessage.includes("overloaded") || lowerMessage.includes("try again later")) {
    return `${provider.label} is currently experiencing high demand. Please try again later.`;
  }

  if (lowerMessage.includes("returned 429") || lowerMessage.includes("rate limit") || lowerMessage.includes("provider returned error")) {
    return `${provider.label} free model is rate limited right now. Please try again later.`;
  }

  if (lowerMessage.includes("api key") || lowerMessage.includes("required")) {
    return `${provider.label} is not configured. Add the API key in the backend settings.`;
  }

  if (lowerMessage.includes("could not connect")) {
    return `Could not connect to ${provider.label}. Check the backend provider settings and try again.`;
  }

  if (lowerMessage.includes("non-vision safety model") || lowerMessage.includes("did not return usable form html")) {
    return `${provider.label} did not return usable form HTML. Check the selected vision model and try again.`;
  }

  return `${provider.label} OCR failed. Please try again.`;
}

function createFallbackVisionError(primaryProvider, fallbackProvider, primaryError, fallbackError) {
  const primaryLabel = VISION_PROVIDERS[primaryProvider]?.label || primaryProvider;
  const fallbackLabel = VISION_PROVIDERS[fallbackProvider]?.label || fallbackProvider;
  const error = new Error(`${primaryLabel} failed and ${fallbackLabel} fallback also failed. ${fallbackError.message || primaryError.message || ""}`.trim());
  error.statusCode = fallbackError.statusCode || primaryError.statusCode || 503;
  error.code = fallbackError.code || primaryError.code || "VISION_PROVIDER_ERROR";
  error.publicMessage = `${primaryLabel} failed, then ${fallbackLabel} fallback also failed. ${fallbackError.publicMessage || fallbackError.message || "Please try again."}`;
  return error;
}
