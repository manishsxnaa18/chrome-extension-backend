# Backend Agent Instructions

This folder is a Node.js + Express backend for OCR, HTML reconstruction, and structured field extraction.

## Key Files

- `src/server.js`: routes and request handling.
- `src/extractWithVisionModel.js`: Gemini/Qwen/GLM-style vision model reconstruction.
- `src/extractWithOllama.js`: local Ollama OCR and HTML reconstruction.
- `src/extractWithPaddle.js`: PaddleOCR integration.
- `src/paddle_ocr.py`: Python PaddleOCR runner.
- `.env.example`: documented environment variables.

## Rules

- Never commit `.env` or real API keys.
- Use environment variables for model names, endpoints, and API keys.
- Keep response contracts stable for the frontend. Full-image reconstruction should return:

```json
{
  "html": "...",
  "fields": {},
  "rawText": "...",
  "htmlMode": "...",
  "model": "..."
}
```

- Keep error messages useful but do not leak secret values.
- For production, prefer hosted Gemini/OpenAI-style providers over local Ollama/Paddle unless the deployment has the right infrastructure.

## Checks

Run syntax checks after backend edits:

```bash
node --check src/server.js
node --check src/extractWithVisionModel.js
node --check src/extractWithOllama.js
node --check src/extractWithPaddle.js
```

If Python OCR code changes, also validate the Python script in the project virtual environment when available.
