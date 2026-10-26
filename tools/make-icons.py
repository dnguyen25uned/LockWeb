"""Generate the LockWeb PNG icon set (run from the project root)."""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
ICON_DIR = ROOT / "icons"
CANVAS = 1024


def vertical_gradient(size: int, top: tuple[int, int, int], bottom: tuple[int, int, int]) -> Image.Image:
    image = Image.new("RGBA", (size, size))
    pixels = image.load()
    for y in range(size):
        ratio = y / max(1, size - 1)
        color = tuple(round(top[i] + (bottom[i] - top[i]) * ratio) for i in range(3))
        for x in range(size):
            pixels[x, y] = (*color, 255)
    return image


def make_master() -> Image.Image:
    scale = CANVAS / 128

    base = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    mask = Image.new("L", (CANVAS, CANVAS), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        (0, 0, CANVAS - 1, CANVAS - 1),
        radius=round(28 * scale),
        fill=255,
    )

    background = vertical_gradient(CANVAS, (16, 31, 53), (5, 11, 21)).convert("RGBA")
    base.alpha_composite(Image.composite(background, Image.new("RGBA", (CANVAS, CANVAS)), mask))

    draw = ImageDraw.Draw(base)

    # Soft top glow.
    glow = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    glow_draw = ImageDraw.Draw(glow)
    glow_draw.ellipse(
        (CANVAS * 0.10, -CANVAS * 0.38, CANVAS * 0.90, CANVAS * 0.62),
        fill=(63, 123, 220, 55),
    )
    glow = glow.filter(ImageFilter.GaussianBlur(round(70 * scale)))
    base.alpha_composite(Image.composite(glow, Image.new("RGBA", (CANVAS, CANVAS)), mask))

    # Rounded border.
    draw.rounded_rectangle(
        (round(2 * scale), round(2 * scale), CANVAS - round(2 * scale), CANVAS - round(2 * scale)),
        radius=round(26 * scale),
        outline=(148, 177, 215, 48),
        width=round(1.5 * scale),
    )

    gold = (251, 191, 36, 255)
    gold_light = (253, 224, 71, 255)

    # Padlock shackle.
    shackle_box = (
        round(35 * scale),
        round(20 * scale),
        round(93 * scale),
        round(78 * scale),
    )
    draw.arc(shackle_box, start=180, end=360, fill=gold, width=round(8.5 * scale))

    # Padlock body with a subtle highlight edge.
    body_box = (
        round(26 * scale),
        round(50 * scale),
        round(102 * scale),
        round(106 * scale),
    )
    draw.rounded_rectangle(
        body_box,
        radius=round(14 * scale),
        fill=gold,
        outline=gold_light,
        width=round(1.4 * scale),
    )

    # Inner body shading.
    shade = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    shade_draw = ImageDraw.Draw(shade)
    shade_draw.rounded_rectangle(
        (
            round(28 * scale),
            round(70 * scale),
            round(100 * scale),
            round(104 * scale),
        ),
        radius=round(12 * scale),
        fill=(180, 120, 10, 45),
    )
    body_mask = Image.new("L", (CANVAS, CANVAS), 0)
    ImageDraw.Draw(body_mask).rounded_rectangle(
        body_box,
        radius=round(14 * scale),
        fill=255,
    )
    base.alpha_composite(Image.composite(shade, Image.new("RGBA", (CANVAS, CANVAS)), body_mask))

    # Keyhole.
    keyhole = (9, 18, 31, 255)
    draw.ellipse(
        (
            round(57 * scale),
            round(64 * scale),
            round(71 * scale),
            round(78 * scale),
        ),
        fill=keyhole,
    )
    draw.rounded_rectangle(
        (
            round(61.5 * scale),
            round(75 * scale),
            round(66.5 * scale),
            round(91 * scale),
        ),
        radius=round(2.4 * scale),
        fill=keyhole,
    )

    return base


def main() -> None:
    ICON_DIR.mkdir(parents=True, exist_ok=True)
    master = make_master()

    for size in (16, 32, 48, 128):
        icon = master.resize((size, size), Image.Resampling.LANCZOS)
        icon.save(ICON_DIR / f"icon{size}.png", optimize=True)
        print(f"wrote icons/icon{size}.png")


if __name__ == "__main__":
    main()
