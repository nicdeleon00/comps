import Vision
import CoreImage
import CoreImage.CIFilterBuiltins
import UIKit

/// Image steps shared by the live scanner and the binder-page reader:
/// flatten a card, fingerprint it, read its text. Safe to call from any thread.
enum CardImaging {
    static let context = CIContext(options: [.useSoftwareRenderer: false, .cacheIntermediates: false])

    /// Perspective-correct the card inside `quad` (normalized, top-left origin) to an upright image.
    static func flatten(_ image: CIImage, quad: Quad, size: CGSize, maxHeight: CGFloat = 1600) -> CIImage? {
        // Core Image uses a bottom-left origin in pixels.
        func px(_ p: CGPoint) -> CGPoint { CGPoint(x: p.x * size.width, y: (1 - p.y) * size.height) }
        let f = CIFilter.perspectiveCorrection()
        f.inputImage = image
        f.topLeft = px(quad.topLeft)
        f.topRight = px(quad.topRight)
        f.bottomLeft = px(quad.bottomLeft)
        f.bottomRight = px(quad.bottomRight)
        guard var out = f.outputImage else { return nil }
        out = out.transformed(by: CGAffineTransform(translationX: -out.extent.origin.x, y: -out.extent.origin.y))
        // A landscape result means the card is lying sideways; rotate it upright.
        if out.extent.width > out.extent.height {
            out = out.oriented(.right)
            out = out.transformed(by: CGAffineTransform(translationX: -out.extent.origin.x, y: -out.extent.origin.y))
        }
        let scale = min(1, maxHeight / out.extent.height)
        if scale < 1 { out = out.transformed(by: CGAffineTransform(scaleX: scale, y: scale)) }
        return out
    }

    static func cgImage(_ image: CIImage) -> CGImage? {
        context.createCGImage(image, from: image.extent)
    }

    /// 64-bit difference hash: robust to lighting, sensitive to which card it is.
    static func dHash(_ image: CIImage) -> UInt64 {
        let sx = 9 / image.extent.width
        let sy = 8 / image.extent.height
        let small = image.transformed(by: CGAffineTransform(scaleX: sx, y: sy))
        var pixels = [UInt8](repeating: 0, count: 9 * 8 * 4)
        context.render(small, toBitmap: &pixels, rowBytes: 9 * 4, bounds: CGRect(x: 0, y: 0, width: 9, height: 8),
                       format: .RGBA8, colorSpace: CGColorSpaceCreateDeviceRGB())
        func lum(_ x: Int, _ y: Int) -> Int {
            let i = (y * 9 + x) * 4
            return Int(pixels[i]) * 299 + Int(pixels[i + 1]) * 587 + Int(pixels[i + 2]) * 114
        }
        var hash: UInt64 = 0
        var bit: UInt64 = 0
        for y in 0..<8 {
            for x in 0..<8 {
                if lum(x, y) > lum(x + 1, y) { hash |= (1 << bit) }
                bit += 1
            }
        }
        return hash
    }

    static func hamming(_ a: UInt64, _ b: UInt64) -> Int { (a ^ b).nonzeroBitCount }

    /// Reads the card: the whole face, then the bands where the name and the tiny
    /// collector number live, enlarged. Later attempts crop differently so a second
    /// look isn't a repeat of the first. `small` is for low-resolution crops (binder pages).
    static func recognize(_ image: CGImage, attempt: Int = 0, small: Bool = false) -> [OCRLine] {
        let boost: CGFloat = small ? 1.5 : 1
        var lines = ocr(image, region: CGRect(x: 0, y: 0, width: 1, height: 1), upscale: small ? 1.5 : 1)
        if attempt == 0 {
            lines += ocr(image, region: CGRect(x: 0, y: 0.84, width: 1, height: 0.16), upscale: 2 * boost)
            lines += ocr(image, region: CGRect(x: 0, y: 0, width: 1, height: 0.18), upscale: 1.5 * boost)
        } else {
            // Halves of the bottom band, larger: modern cards print the number bottom-left, older ones bottom-right.
            lines += ocr(image, region: CGRect(x: 0, y: 0.8, width: 0.6, height: 0.2), upscale: 3 * boost)
            lines += ocr(image, region: CGRect(x: 0.4, y: 0.8, width: 0.6, height: 0.2), upscale: 3 * boost)
            lines += ocr(image, region: CGRect(x: 0, y: 0, width: 0.8, height: 0.15), upscale: 2 * boost)
        }
        // Drop duplicates that the band passes re-read.
        var seen = Set<String>()
        return lines.filter { seen.insert($0.text.lowercased() + "\(Int($0.box.minY * 40))").inserted }
    }

    static func ocr(_ image: CGImage, region: CGRect, upscale: CGFloat) -> [OCRLine] {
        let w = CGFloat(image.width), h = CGFloat(image.height)
        let crop = CGRect(x: region.minX * w, y: region.minY * h, width: region.width * w, height: region.height * h).integral
        guard var input = image.cropping(to: crop) else { return [] }
        if upscale > 1, let scaled = scale(input, by: upscale) { input = scaled }

        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = false
        request.recognitionLanguages = ["en-US"]
        request.minimumTextHeight = 0.01
        let handler = VNImageRequestHandler(cgImage: input, options: [:])
        try? handler.perform([request])
        let results = request.results ?? []
        return results.compactMap { obs in
            guard let top = obs.topCandidates(1).first else { return nil }
            let b = obs.boundingBox
            // Map band coordinates (bottom-left origin) back to the full card (top-left origin).
            let x = region.minX + b.minX * region.width
            let y = region.minY + (1 - b.maxY) * region.height
            return OCRLine(text: top.string, box: CGRect(x: x, y: y, width: b.width * region.width, height: b.height * region.height), confidence: top.confidence)
        }
    }

    private static func scale(_ image: CGImage, by factor: CGFloat) -> CGImage? {
        let ci = CIImage(cgImage: image).applyingFilter("CILanczosScaleTransform", parameters: [kCIInputScaleKey: factor, kCIInputAspectRatioKey: 1])
        return context.createCGImage(ci, from: ci.extent.integral)
    }

    /// Converts a Vision rectangle (normalized, bottom-left origin) to a top-left-origin quad.
    static func quad(_ obs: VNRectangleObservation) -> Quad {
        let flip = { (p: CGPoint) in CGPoint(x: p.x, y: 1 - p.y) }
        return Quad(topLeft: flip(obs.topLeft), topRight: flip(obs.topRight), bottomRight: flip(obs.bottomRight), bottomLeft: flip(obs.bottomLeft))
    }
}
