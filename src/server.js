import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import multer from "multer";
import { extractFieldsWithOllama, getOllamaStatus, reconstructFormHtmlWithOllama } from "./extractWithOllama.js";
import { extractFieldsWithPaddle, getPaddleStatus } from "./extractWithPaddle.js";
import { getVisionModelStatus, reconstructFormHtmlWithVisionModel } from "./extractWithVisionModel.js";

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

app.use(cors());
app.use(express.json());

app.get("/health", (req, res) => {
  res.json({ ok: true, service: "school-form-autofill-backend" });
});

app.get("/ocr-status", async (req, res) => {
  try {
    const provider = getOcrProvider();
    const paddle = provider === "paddle" ? await getPaddleStatus() : null;
    const ollama = provider === "ollama" ? await getOllamaStatus() : null;

    res.json({
      ok: true,
      provider,
      paddle,
      ollama,
      htmlModels: {
        ollama: await getOllamaStatus(),
        qwen: getVisionModelStatus("qwen"),
        glm: getVisionModelStatus("glm"),
        gemini: getVisionModelStatus("gemini")
      }
    });
  } catch (err) {
    handleRouteError(err, res);
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

app.post("/reconstruct-html/gemini", upload.single("file"), (req, res) => {
  reconstructHtmlWithProvider(req, res, "gemini");
});

async function reconstructHtmlWithProvider(req, res, provider) {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "File is required." });
    }

    const extraction = await reconstructFormHtmlWithVisionModel(req.file, provider);

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
}

function handleRouteError(err, res) {
  console.error(err);
  res.status(err.statusCode || err.status || 500).json({
    error: err.message || "Something went wrong."
  });
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
