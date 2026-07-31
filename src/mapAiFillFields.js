const AI_FILL_MAPPING_PROMPT = [
  "You map extracted form data to target web page controls.",
  "Return only valid JSON, no markdown and no explanations.",
  "Use this exact shape: {\"mappings\":[{\"controlId\":\"c1\",\"fieldKey\":\"student_name\",\"value\":\"Rahul\",\"confidence\":0.95,\"reason\":\"label match\"}]}",
  "Only include mappings when confidence is at least 0.62.",
  "Never invent values. Use only values from extractedFields.",
  "You may transform values for target controls, such as splitting full names into first/middle/last names, converting dates to requested formats, and matching select/radio options.",
  "If a target control has options, choose the closest option text or value.",
  "Do not map the same controlId more than once.",
  "Prefer specific labels over generic labels."
].join(" ");

export async function mapAiFillFields({ fields, controls }) {
  const cleanFields = normalizeFields(fields);
  const cleanControls = normalizeControls(controls);

  if (!Object.keys(cleanFields).length || !cleanControls.length) {
    return { mappings: [] };
  }

  const endpoint = process.env.GEMINI_URL || "https://generativelanguage.googleapis.com/v1beta/interactions";
  const model = process.env.GEMINI_FILL_MODEL || process.env.GEMINI_MODEL || "gemini-2.5-flash-lite";
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    const error = new Error("AI fill mapping is not configured.");
    error.statusCode = 503;
    throw error;
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
          text: [
            AI_FILL_MAPPING_PROMPT,
            "",
            "extractedFields:",
            JSON.stringify(cleanFields),
            "",
            "targetControls:",
            JSON.stringify(cleanControls)
          ].join("\n")
        }
      ]
    })
  }).catch((err) => {
    const error = new Error(`Could not connect to AI fill mapping service. ${err.message}`);
    error.statusCode = 502;
    throw error;
  });

  if (!response.ok) {
    const details = await response.text().catch(() => "");
    const error = new Error(`AI fill mapping failed with ${response.status}. ${readProviderErrorMessage(details) || "Please try again."}`);
    error.statusCode = response.status >= 500 ? 502 : response.status;
    throw error;
  }

  const data = await response.json();
  return {
    mappings: normalizeMappings(parseJsonObject(readAiText(data))?.mappings, cleanFields, cleanControls)
  };
}

function normalizeFields(fields) {
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) {
    return {};
  }

  return Object.entries(fields).reduce((normalized, [key, value]) => {
    const cleanKey = String(key || "").trim();
    const cleanValue = String(value ?? "").trim();
    if (cleanKey && cleanValue && cleanKey !== "raw_text") {
      normalized[cleanKey] = cleanValue;
    }
    return normalized;
  }, {});
}

function normalizeControls(controls) {
  if (!Array.isArray(controls)) return [];

  return controls
    .map((control) => ({
      controlId: String(control?.controlId || "").trim(),
      tag: String(control?.tag || "").trim().slice(0, 20),
      type: String(control?.type || "").trim().slice(0, 40),
      name: String(control?.name || "").trim().slice(0, 120),
      id: String(control?.id || "").trim().slice(0, 120),
      label: String(control?.label || "").trim().slice(0, 300),
      placeholder: String(control?.placeholder || "").trim().slice(0, 160),
      value: String(control?.value || "").trim().slice(0, 160),
      options: Array.isArray(control?.options)
        ? control.options.map((option) => String(option || "").trim()).filter(Boolean).slice(0, 80)
        : []
    }))
    .filter((control) => control.controlId)
    .slice(0, 180);
}

function normalizeMappings(mappings, fields, controls) {
  if (!Array.isArray(mappings)) return [];

  const fieldKeys = new Set(Object.keys(fields));
  const controlIds = new Set(controls.map((control) => control.controlId));
  const usedControlIds = new Set();

  return mappings.reduce((normalized, mapping) => {
    const controlId = String(mapping?.controlId || "").trim();
    const fieldKey = String(mapping?.fieldKey || "").trim();
    const value = String(mapping?.value ?? "").trim();
    const confidence = Number(mapping?.confidence || 0);

    if (!controlIds.has(controlId) || !fieldKeys.has(fieldKey) || !value || usedControlIds.has(controlId) || confidence < 0.62) {
      return normalized;
    }

    usedControlIds.add(controlId);
    normalized.push({
      controlId,
      fieldKey,
      value,
      confidence: Math.min(1, Math.max(0, confidence)),
      reason: String(mapping?.reason || "").trim().slice(0, 160)
    });
    return normalized;
  }, []);
}

function readAiText(data) {
  if (typeof data?.output_text === "string") return data.output_text.trim();

  const output = Array.isArray(data?.output) ? readParts(data.output) : "";
  if (output) return output;

  const steps = Array.isArray(data?.steps) ? readParts(data.steps.filter((step) => step?.type === "model_output")) : "";
  if (steps) return steps;

  const content = data?.choices?.[0]?.message?.content;
  if (Array.isArray(content)) {
    return content.map((part) => typeof part === "string" ? part : part?.text || "").join("").trim();
  }

  return String(content || data?.response || "").trim();
}

function readParts(items) {
  return items
    .flatMap((item) => item?.content || item?.parts || [])
    .map((part) => typeof part === "string" ? part : part?.text || part?.output_text || "")
    .join("")
    .trim();
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
    if (start === -1 || end <= start) return null;

    try {
      return JSON.parse(cleaned.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

function readProviderErrorMessage(details) {
  const parsed = parseJsonObject(details);
  return parsed?.error?.message || parsed?.message || "";
}
