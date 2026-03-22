use image::DynamicImage;

pub fn auto_crop_black_borders(mut img: DynamicImage) -> DynamicImage {
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
            // Ignore transparent padding, and check RGB against threshold
            if pixel[3] > threshold
                && (pixel[0] > threshold || pixel[1] > threshold || pixel[2] > threshold)
            {
                if x < min_x {
                    min_x = x;
                }
                if x > max_x {
                    max_x = x;
                }
                if y < min_y {
                    min_y = y;
                }
                if y > max_y {
                    max_y = y;
                }
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

    img.crop(min_x, min_y, crop_width, crop_height)
}
