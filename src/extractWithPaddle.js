import { spawn } from "child_process";
import { randomUUID } from "crypto";
import { mkdir, rm, writeFile } from "fs/promises";
import { dirname, isAbsolute, join, resolve } from "path";
import { tmpdir } from "os";
import { fileURLToPath } from "url";

const backendDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export async function extractFieldsWithPaddle(file) {
  const workDir = join(tmpdir(), "school-form-autofill", randomUUID());
  await mkdir(workDir, { recursive: true });

  const inputPath = join(workDir, sanitizeFileName(file.originalname || "upload"));

  try {
    await writeFile(inputPath, file.buffer);

    const result = await runPaddleScript(inputPath);
    const lines = result.lines || [];
    const layout = normalizeLayout(result.image, result.boxes || []);

    return {
      fields: extractFieldsFromLines(lines),
      rawText: lines.join("\n"),
      html: layout.boxes.length ? layoutToHtml(layout) : linesToHtml(lines),
      htmlMode: layout.boxes.length ? "layout" : "paragraphs",
      layout,
      unmatched: [],
      model: "paddleocr"
    };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

export async function getPaddleStatus() {
  return runPaddleHealthCheck();
}

function runPaddleHealthCheck() {
  return new Promise((resolve, reject) => {
    const pythonCommand = resolvePythonCommand();
    const cacheDir = resolveBackendPath(process.env.PADDLE_PDX_CACHE_HOME || ".paddle-cache");

    const child = spawn(
      pythonCommand,
      [
        "-c",
        "import sys, json; import paddleocr; import paddle; print(json.dumps({'python': sys.executable, 'paddleocr': True, 'paddle_version': paddle.__version__}))"
      ],
      {
        cwd: backendDir,
        env: {
          ...process.env,
          PADDLE_PDX_CACHE_HOME: cacheDir
        },
        stdio: ["ignore", "pipe", "pipe"]
      }
    );

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (err) => {
      reject(createPaddleError(`${err.message}. Python command: ${pythonCommand}`));
    });

    child.on("close", (code) => {
      if (code !== 0) {
        reject(createPaddleError(`${stderr || `Paddle health check exited with code ${code}.`} Python command: ${pythonCommand}`));
        return;
      }

      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(createPaddleError(`Paddle health check returned invalid JSON. ${stdout}`));
      }
    });
  });
}

function runPaddleScript(inputPath) {
  return new Promise((resolve, reject) => {
    const pythonCommand = resolvePythonCommand();
    const cacheDir = resolveBackendPath(process.env.PADDLE_PDX_CACHE_HOME || ".paddle-cache");
    const scriptPath = join(backendDir, "src", "paddle_ocr.py");

    const child = spawn(pythonCommand, [scriptPath, inputPath], {
      cwd: backendDir,
      env: {
        ...process.env,
        PADDLE_PDX_CACHE_HOME: cacheDir
      },
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (err) => {
      reject(createPaddleError(`${err.message}. Python command: ${pythonCommand}`));
    });

    child.on("close", (code) => {
      if (code !== 0) {
        reject(createPaddleError(`${stderr || `PaddleOCR exited with code ${code}.`} Python command: ${pythonCommand}`));
        return;
      }

      try {
        resolve(parsePaddleJson(stdout));
      } catch {
        reject(createPaddleError(`PaddleOCR returned invalid JSON. Output: ${stdout || stderr}`));
      }
    });
  });
}

function parsePaddleJson(stdout) {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (!lines[index].startsWith("{")) continue;
    return JSON.parse(lines[index]);
  }

  return JSON.parse(stdout);
}

function resolvePythonCommand() {
  const command = process.env.PADDLE_PYTHON || ".venv/bin/python";
  return isAbsolute(command) ? command : join(backendDir, command);
}

function resolveBackendPath(pathValue) {
  return isAbsolute(pathValue) ? pathValue : join(backendDir, pathValue);
}

function extractFieldsFromLines(lines) {
  const fields = {};

  for (let index = 0; index < lines.length; index += 1) {
    const line = normalizeLine(lines[index]);
    if (!line) continue;

    const inlinePair = parseInlinePair(line);
    if (inlinePair) {
      fields[inlinePair.key] = inlinePair.value;
      continue;
    }

    const nextLine = normalizeLine(lines[index + 1]);
    if (looksLikeLabel(line) && nextLine && !looksLikeLabel(nextLine)) {
      fields[normalizeKey(line)] = nextLine;
      index += 1;
    }
  }

  if (!Object.keys(fields).length && lines.length) {
    fields.raw_text = lines.join("\n");
  }

  return fields;
}

function parseInlinePair(line) {
  const match = line.match(/^(.{2,80}?)(?:\s*[:=\-]\s+|\s{2,})(.{1,200})$/);
  if (!match) return null;

  const key = normalizeKey(match[1]);
  const value = match[2].trim();

  if (!key || !value) return null;
  return { key, value };
}

function looksLikeLabel(line) {
  if (line.length > 80) return false;
  if (/\d{3,}/.test(line)) return false;
  return /name|date|dob|birth|phone|mobile|email|address|class|grade|gender|father|mother|guardian|school|city|state|pin|zip|blood|category|religion|nationality/i.test(line);
}

function normalizeLine(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeKey(key) {
  return String(key)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function sanitizeFileName(name) {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function linesToHtml(lines) {
  return lines.map((line) => `<p>${escapeHtml(line)}</p>`).join("");
}

function normalizeLayout(image, boxes) {
  const width = Number(image?.width) || 0;
  const height = Number(image?.height) || 0;

  return {
    width,
    height,
    boxes: boxes
      .map((box) => ({
        text: String(box.text || "").trim(),
        x: Number(box.x) || 0,
        y: Number(box.y) || 0,
        width: Number(box.width) || 0,
        height: Number(box.height) || 0
      }))
      .filter((box) => box.text && box.width > 0 && box.height > 0)
  };
}

function layoutToHtml(layout) {
  const width = Math.max(1, layout.width || 1);
  const height = Math.max(1, layout.height || 1);
  const boxesHtml = layout.boxes.map((box) => {
    const left = (box.x / width) * 100;
    const top = (box.y / height) * 100;
    const boxWidth = (box.width / width) * 100;
    const boxHeight = (box.height / height) * 100;
    const fontSize = Math.max(8, Math.min(20, box.height * 0.82));

    return [
      `<span class="ocrTextBox" style="`,
      `left:${left.toFixed(4)}%;`,
      `top:${top.toFixed(4)}%;`,
      `width:${boxWidth.toFixed(4)}%;`,
      `min-height:${boxHeight.toFixed(4)}%;`,
      `font-size:${fontSize.toFixed(2)}px;`,
      `">`,
      escapeHtml(box.text),
      `</span>`
    ].join("");
  }).join("");

  return `<div class="ocrDocument" style="aspect-ratio:${width}/${height};">${boxesHtml}</div>`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function createPaddleError(message) {
  const error = new Error(`PaddleOCR failed: ${message}`);
  error.statusCode = 500;
  return error;
}
