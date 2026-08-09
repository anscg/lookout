use crate::{CaptureResult, CaptureSource};
use image::codecs::jpeg::JpegEncoder;
use image::DynamicImage;
#[cfg(target_os = "macos")]
use std::ffi::c_void;
use std::io::Cursor;
use xcap::Monitor;
#[cfg(not(target_os = "macos"))]
use xcap::Window;

#[cfg(target_os = "macos")]
use objc2_core_foundation::{CFDictionary, CFNumber, CFNumberType, CFRetained, CFString, CGRect};
#[cfg(target_os = "macos")]
use objc2_core_graphics::{
    CGDataProvider, CGImage, CGRectMakeWithDictionaryRepresentation, CGWindowImageOption,
    CGWindowListCopyWindowInfo, CGWindowListCreateImage, CGWindowListOption,
};

/// Black out regions of a monitor capture that belong to blacklisted apps,
/// but preserve regions where a non-blacklisted window is above (in front).
///
/// `list_onscreen_window_rects()` returns windows in front-to-back z-order.
/// We track non-blacklisted window rects as we go; for each blacklisted
/// window, we skip pixels already covered by a non-blacklisted window above.
fn redact_blacklisted_regions(
    img: &mut image::RgbaImage,
    monitor_bounds: (f64, f64, f64, f64), // (x, y, w, h) in logical screen coords
    blacklisted_apps: &[String],
    capture_w: u32,
    capture_h: u32,
) {
    if blacklisted_apps.is_empty() {
        return;
    }

    let on_screen = crate::list_onscreen_window_rects();
    let (mon_x, mon_y, mon_w, mon_h) = monitor_bounds;
    let scale_x = capture_w as f64 / mon_w;
    let scale_y = capture_h as f64 / mon_h;
    let black = image::Rgba([0, 0, 0, 255]);

    // Non-blacklisted window pixel rects above (in front of) the current window.
    let mut above_pixel_rects: Vec<(u32, u32, u32, u32)> = Vec::new();

    for win in &on_screen {
        let app_lower = win.app_name.to_ascii_lowercase();
        let is_blacklisted = blacklisted_apps
            .iter()
            .any(|b| b.to_ascii_lowercase() == app_lower);

        // Compute intersection of window with monitor in screen coords
        let ix1 = f64::max(win.x, mon_x);
        let iy1 = f64::max(win.y, mon_y);
        let ix2 = f64::min(win.x + win.width, mon_x + mon_w);
        let iy2 = f64::min(win.y + win.height, mon_y + mon_h);

        if ix2 <= ix1 || iy2 <= iy1 {
            continue;
        }

        // Convert to pixel coords
        let px1 = ((ix1 - mon_x) * scale_x).round() as u32;
        let py1 = ((iy1 - mon_y) * scale_y).round() as u32;
        let px2 = (((ix2 - mon_x) * scale_x).round() as u32).min(capture_w);
        let py2 = (((iy2 - mon_y) * scale_y).round() as u32).min(capture_h);

        if px2 <= px1 || py2 <= py1 {
            continue;
        }

        if !is_blacklisted {
            above_pixel_rects.push((px1, py1, px2, py2));
            continue;
        }

        // Blacklisted window — paint black, skipping pixels under above rects
        if above_pixel_rects.is_empty() {
            for y in py1..py2 {
                for x in px1..px2 {
                    img.put_pixel(x, y, black);
                }
            }
        } else {
            for y in py1..py2 {
                for x in px1..px2 {
                    let covered = above_pixel_rects
                        .iter()
                        .any(|(ax1, ay1, ax2, ay2)| x >= *ax1 && x < *ax2 && y >= *ay1 && y < *ay2);
                    if !covered {
                        img.put_pixel(x, y, black);
                    }
                }
            }
        }
    }
}

/// Get monitor bounds in the same coordinate space as window positions.
///
/// - **macOS**: Both monitor and window coords are in logical (point) space.
///   xcap's `width()`/`height()` return logical dimensions. No adjustment needed.
/// - **Windows**: Both monitor and window coords are in physical pixel space.
///   xcap's `width()`/`height()` return `dmPelsWidth`/`dmPelsHeight` (physical).
///   No adjustment needed.
/// - **Linux**: xcap's monitor `width()`/`height()` are divided by scale_factor
///   (logical), but window x/y from `TranslateCoordinates` are physical.
///   We multiply back by scale_factor to get physical coords.
fn get_monitor_screen_bounds(monitor_id: u32) -> Option<(f64, f64, f64, f64)> {
    let monitors = Monitor::all().ok()?;
    for m in monitors {
        if m.id().ok() == Some(monitor_id) {
            let x = m.x().unwrap_or(0) as f64;
            let y = m.y().unwrap_or(0) as f64;
            let w = m.width().ok()? as f64;
            let h = m.height().ok()? as f64;

            #[cfg(target_os = "linux")]
            {
                // xcap divides by scale_factor on Linux, but window coords
                // (from TranslateCoordinates) are in physical pixels.
                // Multiply back to get physical-pixel monitor bounds.
                let scale = m.scale_factor().unwrap_or(1.0) as f64;
                return Some((x * scale, y * scale, w * scale, h * scale));
            }

            #[cfg(not(target_os = "linux"))]
            return Some((x, y, w, h));
        }
    }
    None
}

fn capture_to_dynamic_image(
    source: &CaptureSource,
    #[allow(unused_variables)] pipewire_fds: &std::collections::HashMap<u32, i32>,
) -> Result<DynamicImage, String> {
    let img = match source {
        CaptureSource::Monitor { id } => {
            let monitor = Monitor::all()
                .map_err(|e| format!("Failed to enumerate monitors: {e}"))?
                .into_iter()
                .find(|m| m.id().ok() == Some(*id))
                .ok_or_else(|| format!("Monitor with id {id} not found"))?;
            monitor
                .capture_image()
                .map_err(|e| format!("Screen capture failed: {e}"))?
        }
        CaptureSource::Window { id } => {
            #[cfg(target_os = "macos")]
            {
                return capture_window_macos_to_dynamic_image(*id);
            }

            #[cfg(not(target_os = "macos"))]
            {
                let window = Window::all()
                    .map_err(|e| format!("Failed to enumerate windows: {e}"))?
                    .into_iter()
                    .find(|w| w.id().ok() == Some(*id))
                    .ok_or_else(|| format!("Window with id {id} not found"))?;
                window
                    .capture_image()
                    .map_err(|e| format!("Window capture failed: {e}"))?
            }
        }
        CaptureSource::PipeWire { id } => {
            #[cfg(target_os = "linux")]
            {
                let fd = pipewire_fds.get(id).copied().ok_or_else(|| {
                    format!(
                        "PipeWire fd not found for node {}. Did you request screencast first?",
                        id
                    )
                })?;
                let img = crate::pipewire::capture_pipewire_node(*id, fd)?;
                return Ok(crate::crop::auto_crop_black_borders(img));
            }
            #[cfg(not(target_os = "linux"))]
            {
                return Err(format!(
                    "PipeWire capture not supported on this OS (node: {})",
                    id
                ));
            }
        }
    };

    Ok(DynamicImage::ImageRgba8(img))
}

/// Capture a source and apply blacklist redaction for monitor captures.
fn capture_to_dynamic_image_with_blacklist(
    source: &CaptureSource,
    pipewire_fds: &std::collections::HashMap<u32, i32>,
    blacklisted_apps: &[String],
) -> Result<DynamicImage, String> {
    let mut dynamic = capture_to_dynamic_image(source, pipewire_fds)?;

    // Only apply redaction for monitor captures with a non-empty blacklist
    if let CaptureSource::Monitor { id } = source {
        if !blacklisted_apps.is_empty() {
            if let Some(bounds) = get_monitor_screen_bounds(*id) {
                // into_rgba8 is a move (captures are always RGBA8) — avoids
                // cloning a full-resolution frame just to draw on it.
                let mut rgba = dynamic.into_rgba8();
                let w = rgba.width();
                let h = rgba.height();
                redact_blacklisted_regions(&mut rgba, bounds, blacklisted_apps, w, h);
                dynamic = DynamicImage::ImageRgba8(rgba);
            }
        }
    }

    Ok(dynamic)
}

#[cfg(target_os = "macos")]
fn capture_window_macos_to_dynamic_image(id: u32) -> Result<DynamicImage, String> {
    let window = get_window_cf_dictionary_any_space(id)?;
    let bounds = get_window_cg_rect(window.as_ref())?;

    let cg_image = CGWindowListCreateImage(
        bounds,
        CGWindowListOption::OptionIncludingWindow,
        id,
        CGWindowImageOption::Default,
    );

    let rgba =
        cgimage_to_rgba8(cg_image).ok_or_else(|| "Window capture decode failed".to_string())?;
    Ok(DynamicImage::ImageRgba8(rgba))
}

pub struct RawCaptureResult {
    pub data: Vec<u8>,
    pub width: u32,
    pub height: u32,
}

/// SIMD resize (fast_image_resize: SSE4/AVX2/NEON) — ~4x faster than the
/// `image` crate's scalar filters at screen sizes (measured 29ms → 7ms for
/// a 5K→1080p downscale). Box for downscales (area average: the correct
/// filter for heavy downscaling AND the cheapest), bilinear when upscaling
/// (box upscales look blocky). Falls back to the scalar Triangle path if
/// the SIMD buffers can't be built — unreachable in practice, but capture
/// must never die on a resize.
pub fn fast_resize_rgba(dynamic: DynamicImage, new_w: u32, new_h: u32) -> DynamicImage {
    // Captures are always RGBA8 — into_rgba8 is a move, not a copy.
    let rgba = dynamic.into_rgba8();
    match fast_resize_buffer(&rgba, new_w, new_h) {
        Some(out) => DynamicImage::ImageRgba8(out),
        // Unreachable in practice; the scalar path keeps capture alive.
        None => DynamicImage::ImageRgba8(rgba).resize_exact(
            new_w,
            new_h,
            image::imageops::FilterType::Triangle,
        ),
    }
}

/// Borrowing core of {@link fast_resize_rgba} — resizes without consuming
/// the source, for callers that still need the original frame (e.g. the
/// preview downscale next to the clip encoder).
pub fn fast_resize_buffer(
    rgba: &image::RgbaImage,
    new_w: u32,
    new_h: u32,
) -> Option<image::RgbaImage> {
    use fast_image_resize as fir;

    let (w, h) = (rgba.width(), rgba.height());
    let alg = if new_w <= w && new_h <= h {
        fir::ResizeAlg::Convolution(fir::FilterType::Box)
    } else {
        fir::ResizeAlg::Convolution(fir::FilterType::Bilinear)
    };
    let src = fir::images::ImageRef::new(w, h, rgba.as_raw(), fir::PixelType::U8x4).ok()?;
    let mut dst = fir::images::Image::new(new_w, new_h, fir::PixelType::U8x4);
    let opts = fir::ResizeOptions::new().resize_alg(alg);
    fir::Resizer::new().resize(&src, &mut dst, &opts).ok()?;
    image::RgbaImage::from_raw(new_w, new_h, dst.into_vec())
}

/// Encode a captured (already redacted + scaled) frame as JPEG.
pub fn encode_frame_jpeg(
    dynamic: &DynamicImage,
    jpeg_quality: u8,
) -> Result<RawCaptureResult, String> {
    let rgb = dynamic.to_rgb8();
    let mut jpeg_buf = Cursor::new(Vec::new());
    let mut encoder = JpegEncoder::new_with_quality(&mut jpeg_buf, jpeg_quality);
    encoder
        .encode_image(&rgb)
        .map_err(|e| format!("JPEG encoding failed: {e}"))?;
    Ok(RawCaptureResult {
        data: jpeg_buf.into_inner(),
        width: dynamic.width(),
        height: dynamic.height(),
    })
}

/// Capture a single source, redact, and scale to fit — returning the raw
/// RGBA frame (no JPEG encode). Base primitive shared by the JPEG upload
/// path, the live preview, and the clip encoder.
pub fn take_screenshot_image_with_blacklist(
    source: CaptureSource,
    max_width: u32,
    max_height: u32,
    pipewire_fds: &std::collections::HashMap<u32, i32>,
    blacklisted_apps: &[String],
) -> Result<DynamicImage, String> {
    let mut dynamic =
        capture_to_dynamic_image_with_blacklist(&source, pipewire_fds, blacklisted_apps)?;

    if dynamic.width() <= 2 || dynamic.height() <= 2 {
        return Err("Source is minimized or invisible".to_string());
    }

    // Scale down if needed (preserving aspect ratio)
    let (w, h) = (dynamic.width(), dynamic.height());
    if w > max_width || h > max_height {
        let scale = f64::min(max_width as f64 / w as f64, max_height as f64 / h as f64);
        let new_w = (w as f64 * scale).round() as u32;
        let new_h = (h as f64 * scale).round() as u32;
        dynamic = fast_resize_rgba(dynamic, new_w, new_h);
    }

    Ok(dynamic)
}

pub fn take_screenshot_raw_with_blacklist(
    source: CaptureSource,
    max_width: u32,
    max_height: u32,
    jpeg_quality: u8,
    pipewire_fds: &std::collections::HashMap<u32, i32>,
    blacklisted_apps: &[String],
) -> Result<RawCaptureResult, String> {
    let dynamic = take_screenshot_image_with_blacklist(
        source,
        max_width,
        max_height,
        pipewire_fds,
        blacklisted_apps,
    )?;
    encode_frame_jpeg(&dynamic, jpeg_quality)
}

/// Capture a specific source (monitor or window), scale to fit, encode as JPEG.
pub fn take_screenshot(
    source: CaptureSource,
    max_width: u32,
    max_height: u32,
    jpeg_quality: u8,
    pipewire_fds: &std::collections::HashMap<u32, i32>,
) -> Result<CaptureResult, String> {
    let raw = take_screenshot_raw_with_blacklist(
        source,
        max_width,
        max_height,
        jpeg_quality,
        pipewire_fds,
        &[],
    )?;
    let size_bytes = raw.data.len();

    use base64::Engine;
    let base64 = base64::engine::general_purpose::STANDARD.encode(&raw.data);

    Ok(CaptureResult {
        base64,
        width: raw.width,
        height: raw.height,
        size_bytes,
    })
}

/// Capture one or more sources side-by-side, redact, and scale to fit —
/// returning the composed raw RGBA frame (no JPEG encode). Base primitive
/// shared by the JPEG upload path, the live preview, and the clip encoder.
pub fn take_stitched_screenshots_image_with_blacklist(
    sources: &[CaptureSource],
    max_width: u32,
    max_height: u32,
    pipewire_fds: &std::collections::HashMap<u32, i32>,
    blacklisted_apps: &[String],
) -> Result<DynamicImage, String> {
    if sources.is_empty() {
        return Err("No sources provided".to_string());
    }

    if sources.len() == 1 {
        return take_screenshot_image_with_blacklist(
            sources[0].clone(),
            max_width,
            max_height,
            pipewire_fds,
            blacklisted_apps,
        );
    }

    let mut images = Vec::new();
    for source in sources {
        if let Ok(img) =
            capture_to_dynamic_image_with_blacklist(source, pipewire_fds, blacklisted_apps)
        {
            // Drop ghost artifacts from closed/minimized windows (OS sometimes returns 1x1 buffers)
            if img.width() > 2 && img.height() > 2 {
                images.push(img);
            }
        }
    }

    if images.is_empty() {
        return Err(
            "All selected windows or screens are currently closed or minimized".to_string(),
        );
    }

    let target_h = images.iter().map(|img| img.height()).max().unwrap_or(0);

    // Scale images to match target_h
    let mut scaled_images = Vec::new();
    let mut total_w = 0;

    for img in images {
        let (w, h) = (img.width(), img.height());
        if h != target_h && h > 0 {
            let scale = target_h as f64 / h as f64;
            let new_w = (w as f64 * scale).round() as u32;
            let scaled = fast_resize_rgba(img, new_w, target_h);
            total_w += scaled.width();
            scaled_images.push(scaled);
        } else {
            total_w += w;
            scaled_images.push(img);
        }
    }

    let mut stitched = image::RgbaImage::new(total_w, target_h);
    let mut current_x: i64 = 0;
    for img in scaled_images {
        let w = img.width() as i64;
        // into_rgba8 is a move for RGBA8 frames — no full-frame clone.
        let rgba = img.into_rgba8();
        image::imageops::overlay(&mut stitched, &rgba, current_x, 0);
        current_x += w;
    }

    let mut dynamic = DynamicImage::ImageRgba8(stitched);

    // Scale down if needed (preserving aspect ratio)
    // We only enforce that the HEIGHT does not exceed max_height,
    // and that NO SINGLE INDIVIDUAL SCREEN exceeds max_width (we check total_w against max_width * num_sources)
    let (w, h) = (dynamic.width(), dynamic.height());
    let effective_max_width = max_width * (sources.len() as u32);

    if w > effective_max_width || h > max_height {
        let scale = f64::min(
            effective_max_width as f64 / w as f64,
            max_height as f64 / h as f64,
        );
        let new_w = (w as f64 * scale).round() as u32;
        let new_h = (h as f64 * scale).round() as u32;
        dynamic = fast_resize_rgba(dynamic, new_w, new_h);
    }

    Ok(dynamic)
}

/// Capture one or more sources side-by-side and encode as a single JPEG.
/// Returns raw JPEG bytes — callers that need base64 (e.g. for the preview
/// event) encode it themselves, so the upload path never has to decode.
pub fn take_stitched_screenshots_raw_with_blacklist(
    sources: &[CaptureSource],
    max_width: u32,
    max_height: u32,
    jpeg_quality: u8,
    pipewire_fds: &std::collections::HashMap<u32, i32>,
    blacklisted_apps: &[String],
) -> Result<RawCaptureResult, String> {
    let dynamic = take_stitched_screenshots_image_with_blacklist(
        sources,
        max_width,
        max_height,
        pipewire_fds,
        blacklisted_apps,
    )?;
    encode_frame_jpeg(&dynamic, jpeg_quality)
}

#[cfg(target_os = "macos")]
fn get_cf_dictionary_get_value(
    cf_dictionary: &CFDictionary,
    key: &str,
) -> Result<*const c_void, String> {
    let key = CFString::from_str(key);
    let key_ref = key.as_ref() as *const CFString;
    let value = unsafe { cf_dictionary.value(key_ref.cast()) };
    if value.is_null() {
        return Err(format!("Missing {key} in window metadata"));
    }
    Ok(value)
}

#[cfg(target_os = "macos")]
fn get_cf_number_i32_value(cf_dictionary: &CFDictionary, key: &str) -> Result<i32, String> {
    let cf_number = get_cf_dictionary_get_value(cf_dictionary, key)? as *const CFNumber;
    let mut value: i32 = 0;
    let ok =
        unsafe { (*cf_number).value(CFNumberType::IntType, &mut value as *mut _ as *mut c_void) };
    if !ok {
        return Err(format!("Invalid CFNumber for {key}"));
    }
    Ok(value)
}

#[cfg(target_os = "macos")]
fn get_window_cf_dictionary_any_space(window_id: u32) -> Result<CFRetained<CFDictionary>, String> {
    let windows = CGWindowListCopyWindowInfo(
        CGWindowListOption::OptionAll | CGWindowListOption::ExcludeDesktopElements,
        0,
    )
    .ok_or_else(|| "Failed to enumerate macOS windows".to_string())?;

    for i in 0..windows.count() {
        let window_dict_ref = unsafe { windows.value_at_index(i) } as *const CFDictionary;
        if window_dict_ref.is_null() {
            continue;
        }
        let window_dict = unsafe { &*window_dict_ref };
        let current_id = match get_cf_number_i32_value(window_dict, "kCGWindowNumber") {
            Ok(v) => v as u32,
            Err(_) => continue,
        };
        if current_id == window_id {
            let copy = CFDictionary::new_copy(None, Some(window_dict))
                .ok_or_else(|| "Failed to copy window metadata".to_string())?;
            return Ok(copy);
        }
    }

    Err(format!("Window with id {window_id} not found"))
}

#[cfg(target_os = "macos")]
fn get_window_cg_rect(window_cf_dictionary: &CFDictionary) -> Result<CGRect, String> {
    let bounds = get_cf_dictionary_get_value(window_cf_dictionary, "kCGWindowBounds")?
        as *const CFDictionary;
    let mut rect = CGRect::default();
    let ok = unsafe { CGRectMakeWithDictionaryRepresentation(Some(&*bounds), &mut rect) };
    if !ok {
        return Err("Invalid window bounds".to_string());
    }
    Ok(rect)
}

#[cfg(target_os = "macos")]
fn cgimage_to_rgba8(
    cg_image: Option<objc2_core_foundation::CFRetained<CGImage>>,
) -> Option<image::RgbaImage> {
    let width = CGImage::width(cg_image.as_deref());
    let height = CGImage::height(cg_image.as_deref());
    let data_provider = CGImage::data_provider(cg_image.as_deref());
    let data = CGDataProvider::data(data_provider.as_deref())?.to_vec();
    let bytes_per_row = CGImage::bytes_per_row(cg_image.as_deref());

    if width == 0 || height == 0 || bytes_per_row < width * 4 {
        return None;
    }

    let mut buffer = Vec::with_capacity(width * height * 4);
    for row in data.chunks_exact(bytes_per_row).take(height) {
        buffer.extend_from_slice(&row[..width * 4]);
    }

    for bgra in buffer.chunks_exact_mut(4) {
        bgra.swap(0, 2);
    }

    image::RgbaImage::from_raw(width as u32, height as u32, buffer)
}
