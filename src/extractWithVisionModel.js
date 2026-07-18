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
    defaultModel: "gemini-3.5-flash",
    format: "gemini-interactions"
  }
};

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

  const headers = {
    "Content-Type": "application/json"
  };

  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

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
    throw createVisionError(provider, `${endpoint} returned ${response.status}. ${details}`);
  }

  const data = await response.json();
  const reconstruction = parseReconstructionResponse(readChatCompletionText(data));
  const html = reconstruction.html;
  const rawText = htmlToText(html) || fieldsToText(reconstruction.fields);

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
    throw createVisionError(provider, `${endpoint} returned ${response.status}. ${details}`);
  }

  const data = await response.json();
  const reconstruction = parseReconstructionResponse(readGeminiInteractionText(data));
  const html = reconstruction.html;
  const rawText = htmlToText(html) || fieldsToText(reconstruction.fields);

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

function createVisionError(provider, message) {
  const error = new Error(`${provider.label} HTML OCR failed: ${message}`);
  error.statusCode = 503;
  return error;
}
