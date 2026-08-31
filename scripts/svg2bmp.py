#!/usr/bin/env python3
"""Rasterize an SVG to a 24-bit BI_RGB BMP for the Tauri/NSIS installer.

librsvg + cairo are driven through ctypes because this box lacks the
PyGObject<->pycairo bridge (python3-gi-cairo), which is the only thing the
GI path needs that isn't already here.

Renders onto an opaque RGB24 surface at `ss`x the target, then LANCZOS-
downsamples. Supersampling beats a straight render at these sizes: librsvg
antialiases with per-pixel coverage, so a 1px stroke landing between pixel
centres goes muddy, and 4x + LANCZOS resolves it. RGB24 also sidesteps any
premultiplied-alpha round trip.
"""
import ctypes as C
import sys
from PIL import Image

cairo = C.CDLL("libcairo.so.2")
rsvg  = C.CDLL("librsvg-2.so.2")
gobj  = C.CDLL("libgobject-2.0.so.0")

CAIRO_FORMAT_RGB24 = 1


class RsvgRectangle(C.Structure):
    _fields_ = [("x", C.c_double), ("y", C.c_double),
                ("width", C.c_double), ("height", C.c_double)]


cairo.cairo_image_surface_create.restype = C.c_void_p
cairo.cairo_image_surface_create.argtypes = [C.c_int, C.c_int, C.c_int]
cairo.cairo_create.restype = C.c_void_p
cairo.cairo_create.argtypes = [C.c_void_p]
cairo.cairo_set_source_rgb.argtypes = [C.c_void_p, C.c_double, C.c_double, C.c_double]
cairo.cairo_paint.argtypes = [C.c_void_p]
cairo.cairo_surface_flush.argtypes = [C.c_void_p]
cairo.cairo_image_surface_get_data.restype = C.c_void_p
cairo.cairo_image_surface_get_data.argtypes = [C.c_void_p]
cairo.cairo_image_surface_get_stride.restype = C.c_int
cairo.cairo_image_surface_get_stride.argtypes = [C.c_void_p]
cairo.cairo_status.restype = C.c_int
cairo.cairo_status.argtypes = [C.c_void_p]
cairo.cairo_status_to_string.restype = C.c_char_p
cairo.cairo_destroy.argtypes = [C.c_void_p]
cairo.cairo_surface_destroy.argtypes = [C.c_void_p]

rsvg.rsvg_handle_new_from_file.restype = C.c_void_p
rsvg.rsvg_handle_new_from_file.argtypes = [C.c_char_p, C.POINTER(C.c_void_p)]
rsvg.rsvg_handle_render_document.restype = C.c_int
rsvg.rsvg_handle_render_document.argtypes = [
    C.c_void_p, C.c_void_p, C.POINTER(RsvgRectangle), C.POINTER(C.c_void_p)]
gobj.g_object_unref.argtypes = [C.c_void_p]


def render(svg_path, w, h, ss=1, bg=(255, 255, 255)):
    err = C.c_void_p()
    handle = rsvg.rsvg_handle_new_from_file(str(svg_path).encode(), C.byref(err))
    if not handle:
        raise RuntimeError(f"librsvg could not open {svg_path}")

    W, H = w * ss, h * ss
    surf = cairo.cairo_image_surface_create(CAIRO_FORMAT_RGB24, W, H)
    cr = cairo.cairo_create(surf)
    cairo.cairo_set_source_rgb(cr, *[c / 255 for c in bg])
    cairo.cairo_paint(cr)

    vp = RsvgRectangle(0.0, 0.0, float(W), float(H))
    if not rsvg.rsvg_handle_render_document(handle, cr, C.byref(vp), C.byref(err)):
        raise RuntimeError(f"librsvg failed to render {svg_path}")
    st = cairo.cairo_status(cr)
    if st != 0:
        raise RuntimeError(f"cairo: {cairo.cairo_status_to_string(st).decode()}")

    cairo.cairo_surface_flush(surf)
    stride = cairo.cairo_image_surface_get_stride(surf)
    data = C.string_at(cairo.cairo_image_surface_get_data(surf), stride * H)
    # cairo RGB24 is 32bpp BGRX in native (little-endian) byte order.
    img = Image.frombuffer("RGB", (W, H), data, "raw", "BGRX", stride, 1)

    cairo.cairo_destroy(cr)
    cairo.cairo_surface_destroy(surf)
    gobj.g_object_unref(handle)
    return img.resize((w, h), Image.LANCZOS) if ss > 1 else img.copy()


if __name__ == "__main__":
    src, dst, w, h = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
    ss = int(sys.argv[5]) if len(sys.argv) > 5 else 4
    render(src, w, h, ss).save(dst)      # PIL writes RGB as 24bpp BI_RGB
    print(f"  {dst}  {w}x{h}  ss={ss}")
