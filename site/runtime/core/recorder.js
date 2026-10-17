// Records the game canvas as a 9:16 portrait video for short-video apps, with the game's sound
// and a fun.dev watermark. The host copies each rendered frame into a 2D canvas right after
// rendering, so the canvas needs no preserved drawing buffer. Platform DOM (menu, stop button) is never
// part of the canvas and stays out of the video.
const WIDTH = 720;
const HEIGHT = 1280;
const FPS = 30;
// The frame takes the canvas's full width (at most a 3:4 slice of wider, desktop canvases) and
// centres the game's focus point vertically (default: the middle below the top safe area).
// Where the frame reaches above or below the canvas, the edge rows are stretched outwards, so a
// plain background or a cut-off body simply continues. Sides are never stretched: hands and
// arms reaching past them would smear.
const MAX_ASPECT = 3 / 4;
const types = [
  "video/mp4;codecs=avc1.42E01F,mp4a.40.2",
  "video/mp4;codecs=avc1,mp4a",
  "video/mp4",
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm",
];

export const recordingLimit = 60;

function videoType() {
  if (typeof MediaRecorder === "undefined" || typeof HTMLCanvasElement === "undefined" || !HTMLCanvasElement.prototype.captureStream) return null;
  return types.find((type) => MediaRecorder.isTypeSupported(type)) ?? null;
}

export function recordingSupported() {
  return videoType() !== null;
}

// source: the game canvas. audio: { context, node } to tap, optional. topInset(): the top safe
// area and focus(): null or { x, y }, both as fractions of the canvas size. badge(): null or an
// image shown in a small frame at the top left, such as the photo a game is using.
// watermark: { title, url }. onLimit: called once the limit is reached.
export function createRecorder({ source, audio, topInset = () => 0, focus = () => null, badge = () => null, watermark, onLimit = () => {} }) {
  const type = videoType();
  if (!type) throw new Error("Video recording is not supported in this browser.");
  const canvas = document.createElement("canvas");
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  const context = canvas.getContext("2d");
  const stream = canvas.captureStream(FPS);
  let tap = null;
  if (audio) {
    try {
      tap = audio.context.createMediaStreamDestination();
      audio.node.connect(tap);
      for (const track of tap.stream.getAudioTracks()) stream.addTrack(track);
    } catch { tap = null; }
  }
  const recorder = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 6_000_000, audioBitsPerSecond: 128_000 });
  const chunks = [];
  recorder.addEventListener("dataavailable", (event) => { if (event.data.size) chunks.push(event.data); });
  let lastDraw = -Infinity;
  let elapsed = 0;
  let since = null;
  let finished = null;
  let limited = false;
  let encoding = false;

  function draw() {
    const width = source.width, height = source.height;
    if (!width || !height) return;
    const top = Math.min(0.5, Math.max(0, topInset())) * height;
    const point = focus();
    const fx = (point ? point.x : 0.5) * width;
    const fy = point ? point.y * height : (top + height) / 2;
    // Crop rectangle in canvas pixels, 9:16 and centred on the focus; it may reach past the top or bottom.
    const cw = Math.min(width, height * MAX_ASPECT);
    const ch = cw * HEIGHT / WIDTH;
    const cx = Math.min(width - cw, Math.max(0, fx - cw / 2));
    const cy = fy - ch / 2;
    const k = WIDTH / cw;
    // The canvas in the middle, its first and last rows stretched above and below.
    const rows = [[cy, 0, 0, 1], [Math.max(0, cy), Math.min(height, cy + ch), null], [height, cy + ch, height - 1, 1]];
    for (const [y0, y1, sampleY, sampleH] of rows) {
      if (y1 - y0 > 0) context.drawImage(source, cx, sampleY ?? y0, cw, sampleH ?? y1 - y0, 0, (y0 - cy) * k, WIDTH, (y1 - y0) * k);
    }
    const x = drawBadge();
    drawWatermark(x);
  }

  // The badge image is scaled once into a small canvas and redrawn from there every frame.
  const BADGE = 168, MARGIN = 28, BORDER = 4;
  let badgeSource = null, badgeCanvas = null;
  function drawBadge() {
    const image = badge();
    const width = image?.width, height = image?.height;
    if (!width || !height) return 32;
    if (image !== badgeSource) {
      badgeSource = image;
      const scale = BADGE / Math.max(width, height);
      badgeCanvas = Object.assign(document.createElement("canvas"), { width: Math.round(width * scale), height: Math.round(height * scale) });
      const badgeContext = badgeCanvas.getContext("2d");
      badgeContext.imageSmoothingQuality = "high";
      badgeContext.drawImage(image, 0, 0, badgeCanvas.width, badgeCanvas.height);
    }
    context.fillStyle = "#211f17";
    context.fillRect(MARGIN - BORDER, MARGIN - BORDER, badgeCanvas.width + BORDER * 2, badgeCanvas.height + BORDER * 2);
    context.drawImage(badgeCanvas, MARGIN, MARGIN);
    return MARGIN + badgeCanvas.width + BORDER + 20;
  }

  // Bold monospace like the site wordmark, ink with a cream outline so it reads on any game.
  function drawWatermark(x) {
    context.save();
    context.textBaseline = "alphabetic";
    context.lineJoin = "round";
    context.strokeStyle = "#fff7d6";
    context.fillStyle = "#211f17";
    const lines = [
      [watermark.title, "800 34px system-ui, sans-serif", 72],
      [watermark.url, "700 22px ui-monospace, Menlo, Consolas, monospace", 106],
    ];
    for (const [text, font, y] of lines) {
      if (!text) continue;
      context.font = font;
      context.lineWidth = 6;
      context.strokeText(text, x, y);
      context.fillText(text, x, y);
    }
    context.restore();
  }

  function seconds() {
    return elapsed + (since === null ? 0 : (performance.now() - since) / 1000);
  }

  return {
    // Game canvases are only readable right after rendering, so encoding starts with the first
    // captured frame; the clip never opens on a blank one.
    start() {
      since = performance.now();
    },
    // Called by the host after every rendered frame; draws at most FPS times per second.
    capture(time) {
      if (finished || since === null) return;
      if (seconds() >= recordingLimit) {
        if (!limited) { limited = true; onLimit(); }
        return;
      }
      if (time - lastDraw < 1000 / FPS - 2) return;
      lastDraw = time;
      draw();
      if (!encoding) { encoding = true; recorder.start(1000); }
    },
    pause() {
      if (finished || since === null) return;
      elapsed = seconds();
      since = null;
      if (recorder.state === "recording") recorder.pause?.();
    },
    resume() {
      if (finished || since !== null) return;
      since = performance.now();
      lastDraw = -Infinity;
      if (recorder.state === "paused") recorder.resume?.();
    },
    get seconds() { return Math.min(recordingLimit, seconds()); },
    // Resolves { blob, type, seconds }; calling it again returns the same promise.
    stop() {
      if (finished) return finished;
      const duration = this.seconds;
      since = null;
      finished = new Promise((resolve, reject) => {
        recorder.addEventListener("stop", () => {
          if (tap) { try { audio.node.disconnect(tap); } catch { /* Already disconnected at teardown. */ } }
          for (const track of stream.getTracks()) track.stop();
          const blob = new Blob(chunks, { type: type.split(";")[0] });
          if (blob.size) resolve({ blob, type: blob.type, seconds: duration });
          else reject(new Error("The recording is empty."));
        }, { once: true });
        if (recorder.state === "inactive") recorder.dispatchEvent(new Event("stop"));
        else recorder.stop();
      });
      return finished;
    },
  };
}
