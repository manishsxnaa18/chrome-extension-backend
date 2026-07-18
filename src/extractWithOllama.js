export async function extractFieldsWithOllama(file) {
  const model = process.env.OLLAMA_MODEL || "qwen2.5vl:7b";
  const endpoint = process.env.OLLAMA_URL || "http://127.0.0.1:11434/api/generate";
  const imageBase64 = file.buffer.toString("base64");

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      stream: false,
      images: [imageBase64],
      prompt: [
        "Extract only the visible text from this selected form image.",
        "Return plain text only.",
        "Preserve line breaks where possible.",
        "Do not describe the image."
      ].join(" ")
    })
  }).catch((err) => {
    throw createOllamaError(`Could not connect to Ollama at ${endpoint}. ${err.message}`);
  });

  if (!response.ok) {
    const details = await response.text().catch(() => "");
    throw createOllamaError(`Ollama returned ${response.status}. ${details}`);
  }

  const data = await response.json();
  const rawText = String(data.response || "").trim();
  const lines = rawText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);

  return {
    fields: rawText ? { raw_text: rawText } : {},
    rawText,
    html: linesToHtml(lines),
    unmatched: [],
    model: `ollama:${model}`
  };
}

export async function reconstructFormHtmlWithOllama(file) {
  const model = process.env.OLLAMA_HTML_MODEL || process.env.OLLAMA_MODEL || "qwen2.5vl:7b";
  const endpoint = process.env.OLLAMA_URL || "http://127.0.0.1:11434/api/generate";
  const imageBase64 = file.buffer.toString("base64");

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      stream: false,
      images: [imageBase64],
      prompt: [
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
      ].join(" ")
    })
  }).catch((err) => {
    throw createOllamaError(`Could not connect to Ollama at ${endpoint}. ${err.message}`);
  });

  if (!response.ok) {
    const details = await response.text().catch(() => "");
    throw createOllamaError(`Ollama returned ${response.status}. ${details}`);
  }

  const data = await response.json();
  const reconstruction = parseReconstructionResponse(data.response || "");
  const html = reconstruction.html;
  const rawText = htmlToText(html) || fieldsToText(reconstruction.fields);

  return {
    fields: rawText ? { ...reconstruction.fields, raw_text: rawText } : reconstruction.fields,
    rawText,
    html,
    htmlMode: "ai-reconstruction",
    unmatched: [],
    model: `ollama-html:${model}`
  };
}

export async function getOllamaStatus() {
  const endpoint = process.env.OLLAMA_URL || "http://127.0.0.1:11434/api/generate";
  const model = process.env.OLLAMA_MODEL || "qwen2.5vl:7b";
  return {
    endpoint,
    model
  };
}

function linesToHtml(lines) {
  return lines.map((line) => `<p>${escapeHtml(line)}</p>`).join("");
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
    return {
      html: normalizeHtmlResponse(parsed.html || parsed.form_html || parsed.markup || ""),
      fields: normalizeFields(parsed.fields || parsed.data || parsed.values || {})
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

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function createOllamaError(message) {
  const error = new Error(`Ollama OCR failed: ${message}`);
  error.statusCode = 503;
  return error;
}
