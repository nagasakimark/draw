/**
 * The shared drawing surface. Everything on the canvas is derived from an ordered list
 * of strokes, so undo, "clear" and late joiners are all just "replay the list".
 *
 * Stroke:  { id, k: "s", c: "#rrggbb", w, p: [x1, y1, x2, y2, ...] }
 * Fill:    { id, k: "f", c: "#rrggbb", x, y }
 */

export const BOARD_W = 1280;
export const BOARD_H = 720;
export const FILL_TOLERANCE = 48;

function hexToRgb(hex) {
  const n = Number.parseInt(String(hex).replace("#", "").padEnd(6, "0").slice(0, 6), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export class Board {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d", { willReadFrequently: true });
    this.strokes = [];
    this.byId = new Map();
    this._paintBackground();
  }

  _paintBackground() {
    this.ctx.fillStyle = "#ffffff";
    this.ctx.fillRect(0, 0, BOARD_W, BOARD_H);
  }

  reset() {
    this.strokes = [];
    this.byId.clear();
    this._paintBackground();
  }

  /** Replace everything with an authoritative list (join, reconnect, resync). */
  setStrokes(list) {
    this.strokes = Array.isArray(list) ? list.map((s) => ({ ...s, p: s.p ? [...s.p] : undefined })) : [];
    this.byId = new Map(this.strokes.map((s) => [s.id, s]));
    this.redraw();
  }

  redraw() {
    this._paintBackground();
    for (const stroke of this.strokes) {
      this._render(stroke);
    }
  }

  /** Apply one wire message ("sb" | "sp" | "fill" | "clear" | "undo"). */
  apply(op) {
    switch (op.t) {
      case "sb": {
        const stroke = { id: op.id, k: "s", c: op.c, w: op.w, p: [op.x, op.y] };
        this.strokes.push(stroke);
        this.byId.set(stroke.id, stroke);
        this._dot(stroke);
        break;
      }
      case "sp": {
        const stroke = this.byId.get(op.id);
        if (!stroke || !stroke.p) {
          break;
        }
        this._segments(stroke, op.p);
        stroke.p.push(...op.p);
        break;
      }
      case "fill": {
        const stroke = { id: op.id, k: "f", c: op.c, x: op.x, y: op.y };
        this.strokes.push(stroke);
        this.byId.set(stroke.id, stroke);
        this._fill(stroke);
        break;
      }
      case "clear":
        this.reset();
        break;
      case "undo": {
        const removed = this.strokes.pop();
        if (removed) {
          this.byId.delete(removed.id);
          this.redraw();
        }
        break;
      }
      default:
        break;
    }
  }

  _render(stroke) {
    if (stroke.k === "f") {
      this._fill(stroke);
    } else if (stroke.p.length <= 2) {
      this._dot(stroke);
    } else {
      this._line(stroke.c, stroke.w, stroke.p, 0);
    }
  }

  _dot(stroke) {
    const ctx = this.ctx;
    ctx.fillStyle = stroke.c;
    ctx.beginPath();
    ctx.arc(stroke.p[0], stroke.p[1], stroke.w / 2, 0, Math.PI * 2);
    ctx.fill();
  }

  _line(color, width, points, from) {
    const ctx = this.ctx;
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(points[from], points[from + 1]);
    for (let i = from + 2; i < points.length; i += 2) {
      ctx.lineTo(points[i], points[i + 1]);
    }
    ctx.stroke();
  }

  /** Draw only the new part of a stroke, continuing from its previous last point. */
  _segments(stroke, newPoints) {
    const last = stroke.p.length - 2;
    this._line(stroke.c, stroke.w, [stroke.p[last], stroke.p[last + 1], ...newPoints], 0);
  }

  _fill(stroke) {
    floodFill(this.ctx, stroke.x, stroke.y, stroke.c, FILL_TOLERANCE);
  }
}

/**
 * Scanline flood fill. Pixels within `tolerance` (per channel) of the clicked colour
 * are filled, which keeps the anti-aliased fringe next to a line from showing up as
 * a white halo. A visited mask guarantees termination.
 */
export function floodFill(ctx, startX, startY, colorHex, tolerance = FILL_TOLERANCE) {
  const image = ctx.getImageData(0, 0, BOARD_W, BOARD_H);
  const data = image.data;
  const x0 = Math.max(0, Math.min(BOARD_W - 1, Math.round(startX)));
  const y0 = Math.max(0, Math.min(BOARD_H - 1, Math.round(startY)));
  const [fr, fg, fb] = hexToRgb(colorHex);

  const seed = (y0 * BOARD_W + x0) * 4;
  const tr = data[seed];
  const tg = data[seed + 1];
  const tb = data[seed + 2];

  if (tr === fr && tg === fg && tb === fb) {
    return;
  }

  const seen = new Uint8Array(BOARD_W * BOARD_H);
  const matches = (pixel) => {
    const i = pixel * 4;
    return (
      !seen[pixel] &&
      Math.abs(data[i] - tr) <= tolerance &&
      Math.abs(data[i + 1] - tg) <= tolerance &&
      Math.abs(data[i + 2] - tb) <= tolerance
    );
  };

  const stack = [x0, y0];
  while (stack.length > 0) {
    const y = stack.pop();
    const x = stack.pop();
    const row = y * BOARD_W;
    if (!matches(row + x)) {
      continue;
    }

    let left = x;
    while (left > 0 && matches(row + left - 1)) {
      left -= 1;
    }
    let right = x;
    while (right < BOARD_W - 1 && matches(row + right + 1)) {
      right += 1;
    }

    for (let px = left; px <= right; px += 1) {
      const pixel = row + px;
      seen[pixel] = 1;
      const i = pixel * 4;
      data[i] = fr;
      data[i + 1] = fg;
      data[i + 2] = fb;
      data[i + 3] = 255;
    }

    for (const ny of [y - 1, y + 1]) {
      if (ny < 0 || ny >= BOARD_H) {
        continue;
      }
      let inRun = false;
      for (let px = left; px <= right; px += 1) {
        const ok = matches(ny * BOARD_W + px);
        if (ok && !inRun) {
          stack.push(px, ny);
          inRun = true;
        } else if (!ok) {
          inRun = false;
        }
      }
    }
  }

  ctx.putImageData(image, 0, 0);
}
