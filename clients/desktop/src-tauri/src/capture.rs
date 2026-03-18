use crate::CaptureResult;
use image::codecs::jpeg::JpegEncoder;
use image::DynamicImage;
use std::io::Cursor;
use xcap::Monitor;

/// Capture the primary monitor, scale to fit within max dimensions, encode as JPEG.
pub fn take_screenshot(
    max_width: u32,
    max_height: u32,
    jpeg_quality: u8,
) -> Result<CaptureResult, String> {
    // Get primary monitor
    let monitors = Monitor::all().map_err(|e| format!("Failed to enumerate monitors: {e}"))?;
    let monitor = monitors
        .into_iter()
        .find(|m| m.is_primary().unwrap_or(false))
        .or_else(|| {
            // Fallback: first monitor
            Monitor::all().ok().and_then(|m| m.into_iter().next())
        })
        .ok_or("No monitors found")?;

    // Capture screen
    let img = monitor
        .capture_image()
        .map_err(|e| format!("Screen capture failed: {e}"))?;

    let mut dynamic = DynamicImage::ImageRgba8(img);

    // Scale down if needed (preserving aspect ratio)
    let (w, h) = (dynamic.width(), dynamic.height());
    if w > max_width || h > max_height {
        let scale = f64::min(
            max_width as f64 / w as f64,
            max_height as f64 / h as f64,
        );
        let new_w = (w as f64 * scale).round() as u32;
        let new_h = (h as f64 * scale).round() as u32;
        dynamic = dynamic.resize_exact(new_w, new_h, image::imageops::FilterType::Lanczos3);
    }

    let (final_w, final_h) = (dynamic.width(), dynamic.height());

    // Encode as JPEG
    let rgb = dynamic.to_rgb8();
    let mut jpeg_buf = Cursor::new(Vec::new());
    let mut encoder = JpegEncoder::new_with_quality(&mut jpeg_buf, jpeg_quality);
    encoder
        .encode_image(&rgb)
        .map_err(|e| format!("JPEG encoding failed: {e}"))?;

    let jpeg_bytes = jpeg_buf.into_inner();
    let size_bytes = jpeg_bytes.len();

    // Base64 encode for transfer to frontend
    use base64::Engine;
    let base64 = base64::engine::general_purpose::STANDARD.encode(&jpeg_bytes);

    Ok(CaptureResult {
        base64,
        width: final_w,
        height: final_h,
        size_bytes,
    })
}
