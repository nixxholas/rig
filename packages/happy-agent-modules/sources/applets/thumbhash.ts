/**
 * The reference ThumbHash encoder (the MIT-licensed `thumbhash` algorithm),
 * adapted from https://github.com/evanw/thumbhash and kept local so the
 * applet module does not acquire a native image dependency. The input is a
 * small, straight-alpha RGBA image; callers bound its dimensions before
 * invoking this function.
 */
export function rgbaToThumbHash(width: number, height: number, rgba: Uint8Array): Uint8Array {
    if (width < 1 || height < 1 || width > 100 || height > 100) {
        throw new Error("ThumbHash input dimensions must be between 1 and 100 pixels.");
    }
    if (rgba.byteLength !== width * height * 4) {
        throw new Error("ThumbHash RGBA input has an invalid byte length.");
    }

    let averageRed = 0;
    let averageGreen = 0;
    let averageBlue = 0;
    let averageAlpha = 0;
    for (let index = 0, offset = 0; index < width * height; index += 1, offset += 4) {
        const alpha = rgba[offset + 3]! / 255;
        averageRed += (alpha / 255) * rgba[offset]!;
        averageGreen += (alpha / 255) * rgba[offset + 1]!;
        averageBlue += (alpha / 255) * rgba[offset + 2]!;
        averageAlpha += alpha;
    }
    if (averageAlpha > 0) {
        averageRed /= averageAlpha;
        averageGreen /= averageAlpha;
        averageBlue /= averageAlpha;
    }

    const hasAlpha = averageAlpha < width * height;
    const luminanceLimit = hasAlpha ? 5 : 7;
    const luminanceWidth = Math.max(
        1,
        Math.round((luminanceLimit * width) / Math.max(width, height)),
    );
    const luminanceHeight = Math.max(
        1,
        Math.round((luminanceLimit * height) / Math.max(width, height)),
    );
    const luminance: number[] = [];
    const yellowBlue: number[] = [];
    const redGreen: number[] = [];
    const alphaChannel: number[] = [];

    for (let index = 0, offset = 0; index < width * height; index += 1, offset += 4) {
        const alpha = rgba[offset + 3]! / 255;
        const red = averageRed * (1 - alpha) + (alpha / 255) * rgba[offset]!;
        const green = averageGreen * (1 - alpha) + (alpha / 255) * rgba[offset + 1]!;
        const blue = averageBlue * (1 - alpha) + (alpha / 255) * rgba[offset + 2]!;
        luminance[index] = (red + green + blue) / 3;
        yellowBlue[index] = (red + green) / 2 - blue;
        redGreen[index] = red - green;
        alphaChannel[index] = alpha;
    }

    const [luminanceDc, luminanceAc, luminanceScale] = encodeChannel(
        luminance,
        width,
        height,
        Math.max(3, luminanceWidth),
        Math.max(3, luminanceHeight),
    );
    const [yellowBlueDc, yellowBlueAc, yellowBlueScale] = encodeChannel(
        yellowBlue,
        width,
        height,
        3,
        3,
    );
    const [redGreenDc, redGreenAc, redGreenScale] = encodeChannel(redGreen, width, height, 3, 3);
    const [alphaDc, alphaAc, alphaScale] = hasAlpha
        ? encodeChannel(alphaChannel, width, height, 5, 5)
        : [0, [], 0];

    const landscape = width > height;
    const header24 =
        Math.round(63 * luminanceDc) |
        (Math.round(31.5 + 31.5 * yellowBlueDc) << 6) |
        (Math.round(31.5 + 31.5 * redGreenDc) << 12) |
        (Math.round(31 * luminanceScale) << 18) |
        ((hasAlpha ? 1 : 0) << 23);
    const header16 =
        (landscape ? luminanceHeight : luminanceWidth) |
        (Math.round(63 * yellowBlueScale) << 3) |
        (Math.round(63 * redGreenScale) << 9) |
        ((landscape ? 1 : 0) << 15);
    const hash = [
        header24 & 255,
        (header24 >> 8) & 255,
        (header24 >> 16) & 255,
        header16 & 255,
        (header16 >> 8) & 255,
    ];
    const acStart = hasAlpha ? 6 : 5;
    let acIndex = 0;
    if (hasAlpha) hash.push(Math.round(15 * alphaDc) | (Math.round(15 * alphaScale) << 4));

    for (const channel of hasAlpha
        ? [luminanceAc, yellowBlueAc, redGreenAc, alphaAc]
        : [luminanceAc, yellowBlueAc, redGreenAc]) {
        for (const value of channel) {
            const byteIndex = acStart + (acIndex >> 1);
            hash[byteIndex] =
                (hash[byteIndex] ?? 0) | (Math.round(15 * value) << ((acIndex++ & 1) << 2));
        }
    }
    return Uint8Array.from(hash);
}

function encodeChannel(
    channel: readonly number[],
    width: number,
    height: number,
    componentWidth: number,
    componentHeight: number,
): [dc: number, ac: number[], scale: number] {
    let dc = 0;
    const ac: number[] = [];
    let scale = 0;
    const horizontalFactors: number[] = [];
    for (let componentY = 0; componentY < componentHeight; componentY += 1) {
        for (
            let componentX = 0;
            componentX * componentHeight < componentWidth * (componentHeight - componentY);
            componentX += 1
        ) {
            let factor = 0;
            for (let x = 0; x < width; x += 1) {
                horizontalFactors[x] = Math.cos((Math.PI / width) * componentX * (x + 0.5));
            }
            for (let y = 0; y < height; y += 1) {
                const verticalFactor = Math.cos((Math.PI / height) * componentY * (y + 0.5));
                for (let x = 0; x < width; x += 1) {
                    factor += channel[x + y * width]! * horizontalFactors[x]! * verticalFactor;
                }
            }
            factor /= width * height;
            if (componentX === 0 && componentY === 0) {
                dc = factor;
            } else {
                ac.push(factor);
                scale = Math.max(scale, Math.abs(factor));
            }
        }
    }
    if (scale > 0) {
        for (let index = 0; index < ac.length; index += 1) {
            ac[index] = 0.5 + (0.5 / scale) * ac[index]!;
        }
    }
    return [dc, ac, scale];
}
