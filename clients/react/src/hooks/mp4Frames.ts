/** Still frames out of an MP4, decoded with WebCodecs instead of read back
 *  out of a `<video>`.
 *
 * The editor's filmstrip needs pixels, and the obvious way to get them —
 * seek a hidden `<video>`, `drawImage` it into a canvas — is broken on
 * Linux. WebKitGTK hands decoded frames to the compositor as GPU surfaces
 * that script cannot sample: with accelerated compositing on, `drawImage`,
 * `createImageBitmap` and even `new VideoFrame(el).copyTo()` all come back
 * empty (measured: every byte zero), and on some drivers they come back as
 * whatever was in that memory instead — the "colourful static" filmstrip.
 * Playback itself is fine, which is why the stage looks right while the
 * bar underneath it doesn't.
 *
 * `VideoDecoder` bypasses the compositor entirely: it owns its output
 * frames, so they read back correctly with acceleration left on. That
 * matters — disabling it fixes the filmstrip but puts video playback back
 * on the software path this app deliberately got off (see the
 * WEBKIT_DISABLE_COMPOSITING_MODE note in the desktop client's lib.rs).
 *
 * The cost is that WebCodecs takes encoded samples, not a URL, so the
 * container has to be taken apart here. Only what the worker actually
 * produces is supported: a plain (non-fragmented) MP4 holding one H.264
 * track. See packages/worker/src/segments.ts for the encode.
 */

/** One coded sample: where it lives in the file and when it is shown. */
export interface Mp4Sample {
  offset: number;
  size: number;
  /** Composition (presentation) time, seconds. */
  time: number;
  /** A sync sample — decoding can start here. */
  sync: boolean;
}

export interface Mp4VideoTrack {
  /** Codec string for `VideoDecoder.configure`, e.g. `avc1.640028`. */
  codec: string;
  /** The avcC record, which H.264 decoders need as `description`. */
  description: Uint8Array;
  width: number;
  height: number;
  durationSec: number;
  /** Samples in DECODE order, as stored — which is the order they must be
   *  fed to the decoder, and NOT the order they are shown in. */
  samples: Mp4Sample[];
  /** Sample indices sorted by presentation time. B-frames mean `samples`
   *  is not sorted by `time` (measured on the worker's own output: three
   *  distinct reorder offsets at the preview tier), so any search by time
   *  has to go through this. */
  byTime: Int32Array;
}

/** Bound on samples fed to decode one tile. A GOP here is a second of
 *  video (the worker pins `-g` to the frame rate), so this is only a
 *  backstop against a file whose keyframes are far apart. */
const MAX_GOP_SAMPLES = 120;

const fourcc = (v: DataView, at: number) =>
  String.fromCharCode(
    v.getUint8(at),
    v.getUint8(at + 1),
    v.getUint8(at + 2),
    v.getUint8(at + 3),
  );

interface Box {
  type: string;
  /** Payload bounds — past the size/type header. */
  start: number;
  end: number;
}

/** Walk the boxes directly inside [start, end). Stops rather than throwing
 *  on a truncated or nonsensical header, so a partial file degrades to
 *  "no track found". */
function* boxes(v: DataView, start: number, end: number): Generator<Box> {
  let p = start;
  while (p + 8 <= end) {
    let size = v.getUint32(p);
    const type = fourcc(v, p + 4);
    let header = 8;
    if (size === 1) {
      // 64-bit size. Read as two 32s: a >4GiB box can't be indexed by a
      // JS number safely anyway, and the high word is a sanity check.
      if (p + 16 > end) return;
      const hi = v.getUint32(p + 8);
      if (hi > 0x001fffff) return;
      size = hi * 2 ** 32 + v.getUint32(p + 12);
      header = 16;
    } else if (size === 0) {
      size = end - p; // runs to the end of its parent
    }
    if (size < header || p + size > end) return;
    yield { type, start: p + header, end: p + size };
    p += size;
  }
}

function childBox(v: DataView, parent: Box, type: string): Box | null {
  for (const b of boxes(v, parent.start, parent.end)) if (b.type === type) return b;
  return null;
}

/** Descend a chain of box types, e.g. `mdia/minf/stbl`. */
function descend(v: DataView, from: Box, path: string[]): Box | null {
  let cur: Box | null = from;
  for (const type of path) {
    if (!cur) return null;
    cur = childBox(v, cur, type);
  }
  return cur;
}

/** version byte + 3 flag bytes, then an entry count. */
function fullBoxEntries(v: DataView, box: Box): { version: number; count: number; at: number } {
  return {
    version: v.getUint8(box.start),
    count: v.getUint32(box.start + 4),
    at: box.start + 8,
  };
}

/** Run-length table of (count, value) pairs — stts and ctts share it. */
function expandRuns(
  v: DataView,
  box: Box,
  signed: boolean,
  total: number,
): Int32Array {
  const out = new Int32Array(total);
  const { count, at } = fullBoxEntries(v, box);
  let i = 0;
  for (let e = 0; e < count && i < total; e++) {
    const p = at + e * 8;
    if (p + 8 > box.end) break;
    const run = v.getUint32(p);
    const value = signed ? v.getInt32(p + 4) : v.getUint32(p + 4);
    for (let k = 0; k < run && i < total; k++) out[i++] = value;
  }
  // A table shorter than the sample count is malformed; carry the last
  // value rather than leaving a run of zero-length samples behind.
  for (let k = i; k < total; k++) out[k] = i > 0 ? out[i - 1] : 0;
  return out;
}

/** Per-sample file offsets, from the chunk tables. */
function sampleOffsets(
  v: DataView,
  stsc: Box,
  chunkOffsets: number[],
  sizes: Int32Array,
): Float64Array {
  const offsets = new Float64Array(sizes.length);
  const { count: runCount, at } = fullBoxEntries(v, stsc);
  let sample = 0;
  for (let e = 0; e < runCount && sample < sizes.length; e++) {
    const p = at + e * 12;
    if (p + 12 > stsc.end) break;
    const firstChunk = v.getUint32(p); // 1-based
    const perChunk = v.getUint32(p + 4);
    const nextFirst =
      e + 1 < runCount && p + 16 <= stsc.end
        ? v.getUint32(p + 12)
        : chunkOffsets.length + 1;
    for (let c = firstChunk; c < nextFirst && sample < sizes.length; c++) {
      const base = chunkOffsets[c - 1];
      if (base === undefined) return offsets.slice(0, sample);
      let within = base;
      for (let k = 0; k < perChunk && sample < sizes.length; k++) {
        offsets[sample] = within;
        within += sizes[sample];
        sample++;
      }
    }
  }
  return sample === sizes.length ? offsets : offsets.slice(0, sample);
}

/**
 * Seconds to add to every composition time, from the track's edit list.
 *
 * Two conventions, both of which ffmpeg emits: an "empty" leading edit
 * (media_time -1) holds a blank stretch whose duration delays the track,
 * and a normal edit's media_time names the media instant that plays first,
 * so it comes off the front. Anything more elaborate than one of each is
 * left alone — nothing in this pipeline produces it.
 */
function editListShift(
  v: DataView,
  trak: Box,
  mediaTimescale: number,
  movieTimescale: number,
): number {
  const elst = descend(v, trak, ["edts", "elst"]);
  if (!elst) return 0;
  const { version, count, at } = fullBoxEntries(v, elst);
  const stride = version === 1 ? 20 : 12;
  let shift = 0;
  for (let e = 0; e < count; e++) {
    const p = at + e * stride;
    if (p + stride > elst.end) break;
    const duration =
      version === 1
        ? v.getUint32(p) * 2 ** 32 + v.getUint32(p + 4)
        : v.getUint32(p);
    const mediaTime =
      version === 1 ? Number(v.getBigInt64(p + 8)) : v.getInt32(p + 4);
    if (mediaTime < 0) {
      shift += movieTimescale ? duration / movieTimescale : 0;
      continue;
    }
    shift -= mediaTime / mediaTimescale;
    break; // only the first real edit sets the start
  }
  return shift;
}

/**
 * Pull the video track's sample table out of an MP4.
 *
 * Returns null for anything this doesn't handle — a fragmented file, no
 * H.264 track, a table that doesn't add up — and the caller falls back to
 * reading the `<video>` instead.
 *
 * The track's edit list is applied, because ffmpeg always writes one: a
 * `media_time` absorbing the encoder's B-frame reorder delay, which is a
 * third of a second at the preview tier. Ignoring it would slide every
 * thumbnail the same way, so the strip would still look right — but the
 * times would silently disagree with every other tool's reading of the
 * same file.
 */
export function demuxMp4Video(bytes: ArrayBuffer): Mp4VideoTrack | null {
  const v = new DataView(bytes);
  const moov = (() => {
    for (const b of boxes(v, 0, bytes.byteLength)) if (b.type === "moov") return b;
    return null;
  })();
  if (!moov) return null;
  const mvhd = childBox(v, moov, "mvhd");
  const movieTimescale = mvhd
    ? v.getUint8(mvhd.start) === 1
      ? v.getUint32(mvhd.start + 20)
      : v.getUint32(mvhd.start + 12)
    : 0;

  for (const trak of boxes(v, moov.start, moov.end)) {
    if (trak.type !== "trak") continue;
    const mdia = childBox(v, trak, "mdia");
    if (!mdia) continue;
    const hdlr = childBox(v, mdia, "hdlr");
    if (!hdlr || fourcc(v, hdlr.start + 8) !== "vide") continue;

    const mdhd = childBox(v, mdia, "mdhd");
    const stbl = descend(v, mdia, ["minf", "stbl"]);
    if (!mdhd || !stbl) continue;
    const timescale =
      v.getUint8(mdhd.start) === 1
        ? v.getUint32(mdhd.start + 20)
        : v.getUint32(mdhd.start + 12);
    if (!timescale) continue;

    // ── the coded description (avcC) and the frame size ──
    const stsd = childBox(v, stbl, "stsd");
    if (!stsd) continue;
    const entry = (() => {
      for (const e of boxes(v, stsd.start + 8, stsd.end)) return e;
      return null;
    })();
    if (!entry || (entry.type !== "avc1" && entry.type !== "avc3")) continue;
    // VisualSampleEntry: 78 bytes of fixed fields before its child boxes,
    // with the frame size 24 in.
    const width = v.getUint16(entry.start + 24);
    const height = v.getUint16(entry.start + 26);
    const avcC = (() => {
      for (const b of boxes(v, entry.start + 78, entry.end)) {
        if (b.type === "avcC") return b;
      }
      return null;
    })();
    if (!avcC || avcC.end - avcC.start < 4) continue;
    const description = new Uint8Array(bytes.slice(avcC.start, avcC.end));
    const hex = (n: number) => n.toString(16).padStart(2, "0");
    const codec = `avc1.${hex(description[1])}${hex(description[2])}${hex(description[3])}`;

    // ── the sample tables ──
    const stts = childBox(v, stbl, "stts");
    const stsz = childBox(v, stbl, "stsz");
    const stsc = childBox(v, stbl, "stsc");
    const stco = childBox(v, stbl, "stco") ?? childBox(v, stbl, "co64");
    if (!stts || !stsz || !stsc || !stco) continue;

    const uniformSize = v.getUint32(stsz.start + 4);
    const sampleCount = v.getUint32(stsz.start + 8);
    if (!sampleCount) continue;
    const sizes = new Int32Array(sampleCount);
    for (let i = 0; i < sampleCount; i++) {
      const p = stsz.start + 12 + i * 4;
      sizes[i] = uniformSize || (p + 4 <= stsz.end ? v.getUint32(p) : 0);
    }

    const wide = stco.type === "co64";
    const { count: chunkCount, at: chunkAt } = fullBoxEntries(v, stco);
    const chunkOffsets: number[] = [];
    for (let c = 0; c < chunkCount; c++) {
      const p = chunkAt + c * (wide ? 8 : 4);
      if (p + (wide ? 8 : 4) > stco.end) break;
      chunkOffsets.push(
        wide ? v.getUint32(p) * 2 ** 32 + v.getUint32(p + 4) : v.getUint32(p),
      );
    }
    if (!chunkOffsets.length) continue;

    const offsets = sampleOffsets(v, stsc, chunkOffsets, sizes);
    if (offsets.length !== sampleCount) continue;

    const deltas = expandRuns(v, stts, false, sampleCount);
    const ctts = childBox(v, stbl, "ctts");
    // ctts is unsigned in version 0 and signed in version 1; x264's
    // reordering delay makes those offsets matter for which frame is which.
    const shifts = ctts
      ? expandRuns(v, ctts, v.getUint8(ctts.start) === 1, sampleCount)
      : null;

    const sync = new Uint8Array(sampleCount);
    const stss = childBox(v, stbl, "stss");
    if (stss) {
      const { count, at } = fullBoxEntries(v, stss);
      for (let e = 0; e < count; e++) {
        const p = at + e * 4;
        if (p + 4 > stss.end) break;
        const n = v.getUint32(p) - 1; // stss is 1-based
        if (n >= 0 && n < sampleCount) sync[n] = 1;
      }
    } else {
      sync.fill(1); // no stss = every sample is a sync sample
    }
    if (!sync[0]) sync[0] = 1; // the first sample always is, whatever stss says

    const shift = editListShift(v, trak, timescale, movieTimescale);
    const samples: Mp4Sample[] = new Array(sampleCount);
    let dts = 0;
    let lastEnd = 0;
    for (let i = 0; i < sampleCount; i++) {
      const cts = dts + (shifts ? shifts[i] : 0);
      samples[i] = {
        offset: offsets[i],
        size: sizes[i],
        time: Math.max(0, cts / timescale + shift),
        sync: sync[i] === 1,
      };
      dts += deltas[i];
      lastEnd = Math.max(lastEnd, cts + deltas[i]);
    }

    const byTime = Int32Array.from(samples.keys()).sort(
      (a, b) => samples[a].time - samples[b].time,
    );

    return {
      codec,
      description,
      width,
      height,
      durationSec: Math.max(0, lastEnd / timescale + shift),
      samples,
      byTime,
    };
  }
  return null;
}

/** Decode-order index of the sample shown closest to `timeSec`. Bisects
 *  `byTime`, never `samples` — reordering makes the latter unsorted. */
export function nearestSample(track: Mp4VideoTrack, timeSec: number): number {
  const { samples, byTime } = track;
  let lo = 0;
  let hi = byTime.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (samples[byTime[mid]].time < timeSec) lo = mid + 1;
    else hi = mid;
  }
  // Bisection lands on the first sample at or past the target; the one
  // before it can be nearer.
  const at = byTime[lo];
  if (lo > 0) {
    const prev = byTime[lo - 1];
    if (Math.abs(samples[prev].time - timeSec) < Math.abs(samples[at].time - timeSec)) {
      return prev;
    }
  }
  return at;
}

/**
 * A decode-on-demand still source over one MP4 held in memory.
 *
 * One `VideoDecoder` is kept configured for the whole strip and each
 * request feeds it a single closed GOP, so seeking backwards costs the
 * same as seeking forwards and no state carries between tiles.
 */
export class Mp4FrameSource {
  readonly track: Mp4VideoTrack;
  private readonly bytes: ArrayBuffer;
  private decoder: VideoDecoder | null = null;
  /** Where `output` puts frames while a request is in flight. */
  private sink: VideoFrame[] | null = null;
  private failure: string | null = null;

  private constructor(bytes: ArrayBuffer, track: Mp4VideoTrack) {
    this.bytes = bytes;
    this.track = track;
  }

  get width() {
    return this.track.width;
  }
  get height() {
    return this.track.height;
  }
  get durationSec() {
    return this.track.durationSec;
  }

  /** Null when the file isn't demuxable, WebCodecs is missing, or the
   *  decoder won't take the track. Never throws. */
  static async open(bytes: ArrayBuffer): Promise<Mp4FrameSource | null> {
    if (
      typeof VideoDecoder === "undefined" ||
      typeof EncodedVideoChunk === "undefined" ||
      typeof VideoDecoder.isConfigSupported !== "function"
    ) {
      return null;
    }
    let track: Mp4VideoTrack | null = null;
    try {
      track = demuxMp4Video(bytes);
    } catch (err) {
      console.warn("[frames] MP4 demux failed:", err);
      return null;
    }
    if (!track || !track.samples.length) return null;

    const config: VideoDecoderConfig = {
      codec: track.codec,
      description: track.description,
      codedWidth: track.width,
      codedHeight: track.height,
      optimizeForLatency: true,
    };
    try {
      const support = await VideoDecoder.isConfigSupported(config);
      if (!support.supported) return null;
    } catch {
      return null;
    }

    const src = new Mp4FrameSource(bytes, track);
    try {
      src.decoder = new VideoDecoder({
        output: (frame) => {
          if (src.sink) src.sink.push(frame);
          else frame.close();
        },
        error: (err) => {
          src.failure = String(err);
        },
      });
      src.decoder.configure(config);
    } catch (err) {
      console.warn("[frames] VideoDecoder setup failed:", err);
      src.close();
      return null;
    }
    return src;
  }

  /**
   * The frame shown nearest `timeSec`. The caller owns it and must
   * `close()` it. Null once the decoder has given up.
   */
  async frameAt(timeSec: number): Promise<VideoFrame | null> {
    const dec = this.decoder;
    if (!dec || this.failure) return null;
    const { samples } = this.track;

    const target = nearestSample(this.track, timeSec);
    let first = target;
    while (first > 0 && !samples[first].sync) first--;
    // Feed the whole GOP, not just up to the target: with reordering the
    // target frame can depend on a sample that comes after it.
    let last = target;
    while (
      last + 1 < samples.length &&
      !samples[last + 1].sync &&
      last - first < MAX_GOP_SAMPLES
    ) {
      last++;
    }

    const frames: VideoFrame[] = [];
    this.sink = frames;
    try {
      for (let i = first; i <= last; i++) {
        const s = samples[i];
        dec.decode(
          new EncodedVideoChunk({
            type: s.sync ? "key" : "delta",
            timestamp: Math.round(s.time * 1e6),
            data: new Uint8Array(this.bytes, s.offset, s.size),
          }),
        );
      }
      await dec.flush();
    } catch (err) {
      this.failure = String(err);
    } finally {
      this.sink = null;
    }

    let best: VideoFrame | null = null;
    let bestGap = Infinity;
    for (const f of frames) {
      const gap = Math.abs(f.timestamp / 1e6 - timeSec);
      if (gap < bestGap) {
        if (best) best.close();
        best = f;
        bestGap = gap;
      } else {
        f.close();
      }
    }
    if (this.failure) {
      best?.close();
      return null;
    }
    return best;
  }

  close(): void {
    for (const f of this.sink ?? []) f.close();
    this.sink = null;
    const dec = this.decoder;
    this.decoder = null;
    if (dec && dec.state !== "closed") {
      try {
        dec.close();
      } catch {
        // Already tearing down; nothing left to salvage.
      }
    }
  }
}
