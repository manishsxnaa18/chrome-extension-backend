import json
import numbers
import os
import sys


def main():
    if len(sys.argv) < 2:
        raise SystemExit("Usage: paddle_ocr.py <image-or-pdf-path>")

    file_path = sys.argv[1]
    result = run_paddleocr(file_path)
    print(json.dumps(result, ensure_ascii=False))


def run_paddleocr(file_path):
    os.environ.setdefault("PADDLE_PDX_CACHE_HOME", ".paddle-cache")

    try:
        from paddleocr import PaddleOCR
    except ModuleNotFoundError as exc:
        missing_name = getattr(exc, "name", "unknown")
        raise SystemExit(
            f"Missing Python module '{missing_name}'. "
            "Run: .venv/bin/python -m pip install -r requirements.txt"
        ) from exc
    except Exception as exc:
        raise SystemExit(f"PaddleOCR import failed: {exc}") from exc

    ocr = create_ocr(PaddleOCR)

    if hasattr(ocr, "predict"):
        parsed = parse_predict_result(ocr.predict(input=file_path))
        parsed["image"] = get_image_size(file_path)
        return parsed

    if hasattr(ocr, "ocr"):
        parsed = parse_legacy_result(ocr.ocr(file_path, cls=True))
        parsed["image"] = get_image_size(file_path)
        return parsed

    raise SystemExit("Unsupported PaddleOCR API version.")


def create_ocr(PaddleOCR):
    try:
        return PaddleOCR(lang="en")
    except TypeError:
        return PaddleOCR(use_angle_cls=True, lang="en")


def parse_predict_result(result):
    lines = []
    boxes = []

    for item in result or []:
        if isinstance(item, dict):
            payload = item.get("res") if isinstance(item.get("res"), dict) else item
            rec_texts = first_present(payload, ["rec_texts", "text"], [])
            rec_boxes = first_present(payload, ["rec_boxes", "dt_polys", "rec_polys"], [])
            if isinstance(rec_texts, str):
                lines.append(rec_texts)
            else:
                lines.extend(str(text) for text in rec_texts if text)
            boxes.extend(to_box_items(rec_texts, rec_boxes))
            continue

        json_data = getattr(item, "json", None)
        if isinstance(json_data, dict):
            payload = json_data.get("res") if isinstance(json_data.get("res"), dict) else json_data
            rec_texts = first_present(payload, ["rec_texts", "text"], [])
            rec_boxes = first_present(payload, ["rec_boxes", "dt_polys", "rec_polys"], [])
            if isinstance(rec_texts, str):
                lines.append(rec_texts)
            else:
                lines.extend(str(text) for text in rec_texts if text)
            boxes.extend(to_box_items(rec_texts, rec_boxes))

    return {
        "lines": clean_lines(lines),
        "boxes": clean_boxes(boxes),
    }


def parse_legacy_result(result):
    lines = []
    boxes = []

    def visit(value):
        if isinstance(value, (list, tuple)):
            if len(value) >= 2 and isinstance(value[1], (list, tuple)) and value[1]:
                text = value[1][0]
                if isinstance(text, str):
                    lines.append(text)
                    box = normalize_box(value[0])
                    if box:
                        boxes.append({"text": text.strip(), **box})
                    return

            for child in value:
                visit(child)

    visit(result)
    return {
        "lines": clean_lines(lines),
        "boxes": clean_boxes(boxes),
    }


def to_box_items(texts, raw_boxes):
    if isinstance(texts, str):
        text_list = [texts]
    else:
        text_list = [str(text) for text in as_list(texts) if text]

    box_list = as_list(raw_boxes)
    items = []

    for index, text in enumerate(text_list):
        box = normalize_box(box_list[index]) if index < len(box_list) else None
        if box and text.strip():
            items.append({"text": text.strip(), **box})

    return items


def first_present(mapping, keys, fallback):
    for key in keys:
        value = mapping.get(key)
        if value is not None:
            return value
    return fallback


def as_list(value):
    if value is None:
        return []
    if hasattr(value, "tolist"):
        value = value.tolist()
    if isinstance(value, (list, tuple)):
        return list(value)
    return [value]


def normalize_box(raw_box):
    if raw_box is None:
        return None

    try:
        if hasattr(raw_box, "tolist"):
            raw_box = raw_box.tolist()

        if len(raw_box) == 4 and all(is_number(value) for value in raw_box):
            x1, y1, x2, y2 = [float(value) for value in raw_box]
            return rect_from_bounds(x1, y1, x2, y2)

        points = []
        for point in raw_box:
            if isinstance(point, (list, tuple)) and len(point) >= 2:
                points.append((float(point[0]), float(point[1])))

        if not points:
            return None

        xs = [point[0] for point in points]
        ys = [point[1] for point in points]
        return rect_from_bounds(min(xs), min(ys), max(xs), max(ys))
    except Exception:
        return None


def rect_from_bounds(x1, y1, x2, y2):
    left = min(x1, x2)
    top = min(y1, y2)
    width = abs(x2 - x1)
    height = abs(y2 - y1)

    if width <= 0 or height <= 0:
        return None

    return {
        "x": round(left, 2),
        "y": round(top, 2),
        "width": round(width, 2),
        "height": round(height, 2),
    }


def is_number(value):
    return isinstance(value, numbers.Number) and not isinstance(value, bool)


def clean_boxes(boxes):
    return [box for box in boxes if box.get("text") and box.get("width", 0) > 0 and box.get("height", 0) > 0]


def get_image_size(file_path):
    try:
        from PIL import Image

        with Image.open(file_path) as image:
            return {"width": image.width, "height": image.height}
    except Exception:
        return {"width": 0, "height": 0}


def clean_lines(lines):
    return [line.strip() for line in lines if isinstance(line, str) and line.strip()]


if __name__ == "__main__":
    main()
