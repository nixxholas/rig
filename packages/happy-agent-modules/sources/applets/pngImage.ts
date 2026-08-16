import { inflateSync } from "node:zlib";

export const APPLET_ICON_SIZE = 512;
export const APPLET_THUMBNAIL_SIZE = 100;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_CHUNKS = 1_024;

/**
 * Decode one validated, non-interlaced PNG into straight-alpha RGBA pixels.
 *
 * The decoder deliberately supports every non-interlaced PNG colour model:
 * packed grayscale and palette images, 8/16-bit grayscale and RGB images,
 * and their alpha-bearing forms. Adam7 interlacing is rejected explicitly
 * because silently treating its passes as scanlines would produce garbage.
 */
export function decodePngToRgba(source: Uint8Array): Buffer {
    const bytes = Buffer.from(source);
    if (
        bytes.byteLength < PNG_SIGNATURE.byteLength ||
        !bytes.subarray(0, 8).equals(PNG_SIGNATURE)
    ) {
        throw new Error("PNG signature is invalid.");
    }

    let offset = PNG_SIGNATURE.byteLength;
    let chunkCount = 0;
    let sawHeader = false;
    let sawImageData = false;
    let sawEnd = false;
    let width = 0;
    let height = 0;
    let bitDepth = 0;
    let colorType = 0;
    let palette: Buffer | undefined;
    let transparency: Buffer | undefined;
    const imageData: Buffer[] = [];

    while (offset < bytes.byteLength) {
        if (++chunkCount > MAX_CHUNKS || offset + 12 > bytes.byteLength) {
            throw new Error("PNG chunk structure is invalid.");
        }
        const chunkLength = bytes.readUInt32BE(offset);
        const typeStart = offset + 4;
        const dataStart = typeStart + 4;
        const dataEnd = dataStart + chunkLength;
        const chunkEnd = dataEnd + 4;
        if (chunkEnd > bytes.byteLength) throw new Error("PNG chunk exceeds the input.");

        const type = bytes.subarray(typeStart, dataStart);
        const data = bytes.subarray(dataStart, dataEnd);
        const expectedCrc = bytes.readUInt32BE(dataEnd);
        if (pngCrc32(type, data) !== expectedCrc) {
            throw new Error(`PNG ${type.toString("ascii")} chunk has an invalid checksum.`);
        }

        const typeName = type.toString("ascii");
        if (typeName === "IHDR") {
            if (sawHeader || chunkLength !== 13 || offset !== PNG_SIGNATURE.byteLength) {
                throw new Error("PNG header is invalid.");
            }
            sawHeader = true;
            width = data.readUInt32BE(0);
            height = data.readUInt32BE(4);
            bitDepth = data[8]!;
            colorType = data[9]!;
            if (width !== APPLET_ICON_SIZE || height !== APPLET_ICON_SIZE) {
                throw new Error(
                    `PNG image must be exactly ${APPLET_ICON_SIZE} by ${APPLET_ICON_SIZE} pixels.`,
                );
            }
            if (data[10] !== 0 || data[11] !== 0 || data[12] !== 0) {
                throw new Error("PNG uses an unsupported compression, filter, or interlace mode.");
            }
            assertColorModel(colorType, bitDepth);
        } else {
            if (!sawHeader) throw new Error("PNG data appeared before the header.");
            if (typeName === "PLTE") {
                if (
                    palette !== undefined ||
                    sawImageData ||
                    chunkLength === 0 ||
                    chunkLength % 3 !== 0
                ) {
                    throw new Error("PNG palette is invalid.");
                }
                palette = Buffer.from(data);
                if (palette.byteLength / 3 > 256) throw new Error("PNG palette is too large.");
            } else if (typeName === "tRNS") {
                if (transparency !== undefined || sawImageData) {
                    throw new Error("PNG transparency is duplicated or appeared too late.");
                }
                transparency = Buffer.from(data);
            } else if (typeName === "IDAT") {
                sawImageData = true;
                imageData.push(Buffer.from(data));
            } else if (typeName === "IEND") {
                if (chunkLength !== 0 || !sawImageData)
                    throw new Error("PNG end marker is invalid.");
                sawEnd = true;
                offset = chunkEnd;
                break;
            } else if ((type[0]! & 0x20) === 0) {
                throw new Error(`PNG critical chunk ${typeName} is unsupported.`);
            }
        }
        offset = chunkEnd;
    }

    if (!sawHeader || !sawImageData || !sawEnd || offset !== bytes.byteLength) {
        throw new Error("PNG is truncated or missing required chunks.");
    }
    assertPaletteAndTransparency(colorType, bitDepth, palette, transparency);

    const channels = channelCount(colorType);
    const rowBytes = Math.ceil((APPLET_ICON_SIZE * channels * bitDepth) / 8);
    const bytesPerPixel = Math.max(1, Math.ceil((channels * bitDepth) / 8));
    const filteredLength = APPLET_ICON_SIZE * (rowBytes + 1);
    let filtered: Buffer;
    try {
        filtered = inflateSync(Buffer.concat(imageData), {
            maxOutputLength: filteredLength,
        });
    } catch {
        throw new Error("PNG image data could not be decompressed.");
    }
    if (filtered.byteLength !== filteredLength) {
        throw new Error("PNG image data has an invalid length.");
    }
    const scanlines = unfilterScanlines(filtered, rowBytes, bytesPerPixel);
    return decodeScanlines(scanlines, rowBytes, colorType, bitDepth, palette, transparency);
}

/** Resize an RGBA image using a bounded Lanczos-3 kernel. */
export function resizeRgbaLanczos(
    source: Uint8Array,
    sourceWidth: number,
    sourceHeight: number,
    targetWidth: number,
    targetHeight: number,
): Buffer {
    if (
        sourceWidth < 1 ||
        sourceHeight < 1 ||
        targetWidth < 1 ||
        targetHeight < 1 ||
        source.byteLength !== sourceWidth * sourceHeight * 4
    ) {
        throw new Error("RGBA resize input is invalid.");
    }
    const horizontal = Array.from({ length: targetWidth }, (_, index) =>
        resizeWeights(sourceWidth, targetWidth, index),
    );
    const vertical = Array.from({ length: targetHeight }, (_, index) =>
        resizeWeights(sourceHeight, targetHeight, index),
    );
    const output = Buffer.alloc(targetWidth * targetHeight * 4);
    for (let targetY = 0; targetY < targetHeight; targetY += 1) {
        const verticalWeights = vertical[targetY]!;
        for (let targetX = 0; targetX < targetWidth; targetX += 1) {
            const horizontalWeights = horizontal[targetX]!;
            const outputOffset = (targetY * targetWidth + targetX) * 4;
            for (let channel = 0; channel < 4; channel += 1) {
                let value = 0;
                for (const verticalWeight of verticalWeights) {
                    for (const horizontalWeight of horizontalWeights) {
                        const sourceOffset =
                            (verticalWeight.index * sourceWidth + horizontalWeight.index) * 4 +
                            channel;
                        value +=
                            source[sourceOffset]! * verticalWeight.weight * horizontalWeight.weight;
                    }
                }
                output[outputOffset + channel] = clampByte(Math.round(value));
            }
        }
    }
    return output;
}

interface ResizeWeight {
    readonly index: number;
    readonly weight: number;
}

function resizeWeights(
    sourceSize: number,
    targetSize: number,
    targetIndex: number,
): ResizeWeight[] {
    const center = ((targetIndex + 0.5) * sourceSize) / targetSize - 0.5;
    const radius = 3;
    const first = Math.max(0, Math.ceil(center - radius));
    const last = Math.min(sourceSize - 1, Math.floor(center + radius));
    const weights: ResizeWeight[] = [];
    let sum = 0;
    for (let index = first; index <= last; index += 1) {
        const weight = lanczos(center - index, radius);
        if (weight === 0) continue;
        weights.push({ index, weight });
        sum += weight;
    }
    if (sum === 0)
        return [{ index: Math.min(sourceSize - 1, Math.max(0, Math.round(center))), weight: 1 }];
    return weights.map(({ index, weight }) => ({ index, weight: weight / sum }));
}

function lanczos(distance: number, radius: number): number {
    const absolute = Math.abs(distance);
    if (absolute >= radius) return 0;
    if (absolute < Number.EPSILON) return 1;
    const piDistance = Math.PI * distance;
    return (
        (Math.sin(piDistance) / piDistance) *
        (Math.sin(piDistance / radius) / (piDistance / radius))
    );
}

function assertColorModel(colorType: number, bitDepth: number): void {
    const valid =
        (colorType === 0 && [1, 2, 4, 8, 16].includes(bitDepth)) ||
        (colorType === 2 && [8, 16].includes(bitDepth)) ||
        (colorType === 3 && [1, 2, 4, 8].includes(bitDepth)) ||
        (colorType === 4 && [8, 16].includes(bitDepth)) ||
        (colorType === 6 && [8, 16].includes(bitDepth));
    if (!valid) throw new Error("PNG color type and bit depth are unsupported.");
}

function assertPaletteAndTransparency(
    colorType: number,
    bitDepth: number,
    palette: Buffer | undefined,
    transparency: Buffer | undefined,
): void {
    if (colorType === 3) {
        if (palette === undefined) throw new Error("Indexed PNG is missing its palette.");
        if (palette.byteLength / 3 > 1 << bitDepth) {
            throw new Error("Indexed PNG palette has too many entries.");
        }
        if (transparency !== undefined && transparency.byteLength > palette.byteLength / 3) {
            throw new Error("Indexed PNG transparency has too many entries.");
        }
    } else if (colorType === 0) {
        if (transparency !== undefined && transparency.byteLength !== 2) {
            throw new Error("Grayscale PNG transparency is invalid.");
        }
    } else if (colorType === 2) {
        if (transparency !== undefined && transparency.byteLength !== 6) {
            throw new Error("RGB PNG transparency is invalid.");
        }
    } else if (transparency !== undefined) {
        throw new Error("This PNG color type cannot carry transparency.");
    }
}

function channelCount(colorType: number): number {
    switch (colorType) {
        case 0:
            return 1;
        case 2:
            return 3;
        case 3:
            return 1;
        case 4:
            return 2;
        case 6:
            return 4;
        default:
            throw new Error("PNG color type is unsupported.");
    }
}

function unfilterScanlines(filtered: Buffer, rowBytes: number, bytesPerPixel: number): Buffer {
    const scanlines = Buffer.alloc(rowBytes * APPLET_ICON_SIZE);
    for (let y = 0; y < APPLET_ICON_SIZE; y += 1) {
        const filteredOffset = y * (rowBytes + 1);
        const outputOffset = y * rowBytes;
        const filter = filtered[filteredOffset]!;
        if (filter > 4) throw new Error("PNG scanline filter is unsupported.");
        for (let x = 0; x < rowBytes; x += 1) {
            const left = x >= bytesPerPixel ? scanlines[outputOffset + x - bytesPerPixel]! : 0;
            const above = y > 0 ? scanlines[outputOffset - rowBytes + x]! : 0;
            const upperLeft =
                y > 0 && x >= bytesPerPixel
                    ? scanlines[outputOffset - rowBytes + x - bytesPerPixel]!
                    : 0;
            const encoded = filtered[filteredOffset + 1 + x]!;
            let value: number;
            switch (filter) {
                case 0:
                    value = encoded;
                    break;
                case 1:
                    value = encoded + left;
                    break;
                case 2:
                    value = encoded + above;
                    break;
                case 3:
                    value = encoded + Math.floor((left + above) / 2);
                    break;
                case 4:
                    value = encoded + paeth(left, above, upperLeft);
                    break;
                default:
                    throw new Error("PNG scanline filter is unsupported.");
            }
            scanlines[outputOffset + x] = value & 255;
        }
    }
    return scanlines;
}

function decodeScanlines(
    scanlines: Buffer,
    rowBytes: number,
    colorType: number,
    bitDepth: number,
    palette: Buffer | undefined,
    transparency: Buffer | undefined,
): Buffer {
    const rgba = Buffer.alloc(APPLET_ICON_SIZE * APPLET_ICON_SIZE * 4);
    const channels = channelCount(colorType);
    for (let y = 0; y < APPLET_ICON_SIZE; y += 1) {
        const row = scanlines.subarray(y * rowBytes, (y + 1) * rowBytes);
        for (let x = 0; x < APPLET_ICON_SIZE; x += 1) {
            const pixelOffset = (y * APPLET_ICON_SIZE + x) * 4;
            if (colorType === 0) {
                const sample = readSample(row, x, 0, bitDepth, channels);
                const value = sampleToByte(sample, (1 << bitDepth) - 1, bitDepth);
                const transparent =
                    transparency !== undefined && sample === transparency.readUInt16BE(0);
                rgba[pixelOffset] = value;
                rgba[pixelOffset + 1] = value;
                rgba[pixelOffset + 2] = value;
                rgba[pixelOffset + 3] = transparent ? 0 : 255;
            } else if (colorType === 2) {
                const red = readSample(row, x, 0, bitDepth, channels);
                const green = readSample(row, x, 1, bitDepth, channels);
                const blue = readSample(row, x, 2, bitDepth, channels);
                const transparent =
                    transparency !== undefined &&
                    red === transparency.readUInt16BE(0) &&
                    green === transparency.readUInt16BE(2) &&
                    blue === transparency.readUInt16BE(4);
                rgba[pixelOffset] = sampleToByte(red, (1 << bitDepth) - 1, bitDepth);
                rgba[pixelOffset + 1] = sampleToByte(green, (1 << bitDepth) - 1, bitDepth);
                rgba[pixelOffset + 2] = sampleToByte(blue, (1 << bitDepth) - 1, bitDepth);
                rgba[pixelOffset + 3] = transparent ? 0 : 255;
            } else if (colorType === 3) {
                const index = readSample(row, x, 0, bitDepth, channels);
                const paletteOffset = index * 3;
                if (palette === undefined || paletteOffset + 3 > palette.byteLength) {
                    throw new Error("Indexed PNG refers to a missing palette entry.");
                }
                rgba[pixelOffset] = palette[paletteOffset]!;
                rgba[pixelOffset + 1] = palette[paletteOffset + 1]!;
                rgba[pixelOffset + 2] = palette[paletteOffset + 2]!;
                rgba[pixelOffset + 3] =
                    transparency !== undefined && index < transparency.byteLength
                        ? transparency[index]!
                        : 255;
            } else if (colorType === 4) {
                const sample = readSample(row, x, 0, bitDepth, channels);
                const alpha = readSample(row, x, 1, bitDepth, channels);
                const value = sampleToByte(sample, (1 << bitDepth) - 1, bitDepth);
                rgba[pixelOffset] = value;
                rgba[pixelOffset + 1] = value;
                rgba[pixelOffset + 2] = value;
                rgba[pixelOffset + 3] = sampleToByte(alpha, (1 << bitDepth) - 1, bitDepth);
            } else {
                const red = readSample(row, x, 0, bitDepth, channels);
                const green = readSample(row, x, 1, bitDepth, channels);
                const blue = readSample(row, x, 2, bitDepth, channels);
                const alpha = readSample(row, x, 3, bitDepth, channels);
                rgba[pixelOffset] = sampleToByte(red, (1 << bitDepth) - 1, bitDepth);
                rgba[pixelOffset + 1] = sampleToByte(green, (1 << bitDepth) - 1, bitDepth);
                rgba[pixelOffset + 2] = sampleToByte(blue, (1 << bitDepth) - 1, bitDepth);
                rgba[pixelOffset + 3] = sampleToByte(alpha, (1 << bitDepth) - 1, bitDepth);
            }
        }
    }
    return rgba;
}

function readSample(
    row: Buffer,
    pixel: number,
    channel: number,
    bitDepth: number,
    channels: number,
): number {
    if (bitDepth < 8) {
        const packed = row[Math.floor((pixel * 1 * bitDepth) / 8)]!;
        const shift = 8 - bitDepth - ((pixel * bitDepth) % 8);
        return (packed >> shift) & ((1 << bitDepth) - 1);
    }
    const bytesPerSample = bitDepth / 8;
    const offset = pixel * channels * bytesPerSample + channel * bytesPerSample;
    return bitDepth === 8 ? row[offset]! : row.readUInt16BE(offset);
}

function sampleToByte(sample: number, maximum: number, bitDepth: number): number {
    if (bitDepth === 16) return Math.round((sample * 255) / 65_535);
    return Math.round((sample * 255) / maximum);
}

function paeth(left: number, above: number, upperLeft: number): number {
    const estimate = left + above - upperLeft;
    const leftDistance = Math.abs(estimate - left);
    const aboveDistance = Math.abs(estimate - above);
    const upperLeftDistance = Math.abs(estimate - upperLeft);
    if (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance) return left;
    if (aboveDistance <= upperLeftDistance) return above;
    return upperLeft;
}

function pngCrc32(type: Buffer, data: Buffer): number {
    let crc = 0xffffffff;
    for (const byte of type) crc = crc32Step(crc, byte);
    for (const byte of data) crc = crc32Step(crc, byte);
    return (crc ^ 0xffffffff) >>> 0;
}

function crc32Step(crc: number, byte: number): number {
    let value = (crc ^ byte) & 0xff;
    for (let bit = 0; bit < 8; bit += 1) {
        value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    return ((crc >>> 8) ^ value) >>> 0;
}

function clampByte(value: number): number {
    return Math.min(255, Math.max(0, value));
}
