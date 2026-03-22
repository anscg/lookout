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

fn capture_to_dynamic_image(
    source: &CaptureSource,
    #[allow(unused_variables)] pipewire_fd: Option<i32>,
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
                let fd = pipewire_fd.ok_or_else(|| {
                    "PipeWire fd not provided. Did you request screencast first?".to_string()
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

pub fn take_screenshot_raw(
    source: CaptureSource,
    max_width: u32,
    max_height: u32,
    jpeg_quality: u8,
    pipewire_fd: Option<i32>,
) -> Result<RawCaptureResult, String> {
    let mut dynamic = capture_to_dynamic_image(&source, pipewire_fd)?;

    if dynamic.width() <= 2 || dynamic.height() <= 2 {
        return Err("Source is minimized or invisible".to_string());
    }

    // Scale down if needed (preserving aspect ratio)
    let (w, h) = (dynamic.width(), dynamic.height());
    if w > max_width || h > max_height {
        let scale = f64::min(max_width as f64 / w as f64, max_height as f64 / h as f64);
        let new_w = (w as f64 * scale).round() as u32;
        let new_h = (h as f64 * scale).round() as u32;
        dynamic = dynamic.resize_exact(new_w, new_h, image::imageops::FilterType::Triangle);
    }

    let (final_w, final_h) = (dynamic.width(), dynamic.height());

    // Encode as JPEG
    let rgb = dynamic.to_rgb8();
    let mut jpeg_buf = Cursor::new(Vec::new());
    let mut encoder = JpegEncoder::new_with_quality(&mut jpeg_buf, jpeg_quality);
    encoder
        .encode_image(&rgb)
        .map_err(|e| format!("JPEG encoding failed: {e}"))?;

    Ok(RawCaptureResult {
        data: jpeg_buf.into_inner(),
        width: final_w,
        height: final_h,
    })
}

/// Capture a specific source (monitor or window), scale to fit, encode as JPEG.
pub fn take_screenshot(
    source: CaptureSource,
    max_width: u32,
    max_height: u32,
    jpeg_quality: u8,
    pipewire_fd: Option<i32>,
) -> Result<CaptureResult, String> {
    let raw = take_screenshot_raw(source, max_width, max_height, jpeg_quality, pipewire_fd)?;
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

pub fn take_stitched_screenshots(
    sources: &[CaptureSource],
    max_width: u32,
    max_height: u32,
    jpeg_quality: u8,
    pipewire_fd: Option<i32>,
) -> Result<CaptureResult, String> {
    if sources.is_empty() {
        return Err("No sources provided".to_string());
    }

    if sources.len() == 1 {
        return take_screenshot(
            sources[0].clone(),
            max_width,
            max_height,
            jpeg_quality,
            pipewire_fd,
        );
    }

    let mut images = Vec::new();
    for source in sources {
        if let Ok(img) = capture_to_dynamic_image(source, pipewire_fd) {
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
            let scaled = img.resize_exact(new_w, target_h, image::imageops::FilterType::Lanczos3);
            total_w += scaled.width();
            scaled_images.push(scaled);
        } else {
            total_w += w;
            scaled_images.push(img);
        }
    }

    let mut stitched = image::RgbaImage::new(total_w, target_h);
    let mut current_x = 0;
    for img in scaled_images {
        let rgba = img.to_rgba8();
        image::imageops::overlay(&mut stitched, &rgba, current_x as i64, 0);
        current_x += img.width() as i64;
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

    use base64::Engine;
    let base64 = base64::engine::general_purpose::STANDARD.encode(&jpeg_bytes);

    Ok(CaptureResult {
        base64,
        width: final_w,
        height: final_h,
        size_bytes,
    })
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
