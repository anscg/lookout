use image::{DynamicImage, RgbaImage};

fn auto_crop_black_borders(img: DynamicImage) -> DynamicImage {
    let rgba = img.to_rgba8();
    let (width, height) = rgba.dimensions();

    let mut min_x = width;
    let mut min_y = height;
    let mut max_x = 0;
    let mut max_y = 0;

    let threshold = 5;

    for y in 0..height {
        for x in 0..width {
            let pixel = rgba.get_pixel(x, y);
            if pixel[0] > threshold || pixel[1] > threshold || pixel[2] > threshold {
                if x < min_x { min_x = x; }
                if x > max_x { max_x = x; }
                if y < min_y { min_y = y; }
                if y > max_y { max_y = y; }
            }
        }
    }

    if min_x > max_x || min_y > max_y {
        return img;
    }

    let crop_width = max_x - min_x + 1;
    let crop_height = max_y - min_y + 1;

    if crop_width == width && crop_height == height {
        return img;
    }

    let mut img_mut = img;
    img_mut.crop(min_x, min_y, crop_width, crop_height)
}

fn main() {
    let mut img = RgbaImage::new(100, 100);
    img.put_pixel(50, 50, image::Rgba([255, 255, 255, 255]));
    let dyn_img = DynamicImage::ImageRgba8(img);
    let cropped = auto_crop_black_borders(dyn_img);
    println!("Cropped size: {}x{}", cropped.width(), cropped.height());
}
