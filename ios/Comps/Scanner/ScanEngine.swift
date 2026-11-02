import Vision
import CoreImage
import CoreImage.CIFilterBuiltins
import UIKit

/// A card outline in normalized image coordinates, top-left origin.
struct Quad: Equatable {
    var topLeft: CGPoint
    var topRight: CGPoint
    var bottomRight: CGPoint
    var bottomLeft: CGPoint

    var points: [CGPoint] { [topLeft, topRight, bottomRight, bottomLeft] }

    var area: CGFloat {
        let p = points
        var s: CGFloat = 0
        for i in 0..<4 { let j = (i + 1) % 4; s += p[i].x * p[j].y - p[j].x * p[i].y }
        return abs(s) / 2
    }

    func lerp(to o: Quad, _ t: CGFloat) -> Quad {
        func m(_ a: CGPoint, _ b: CGPoint) -> CGPoint { CGPoint(x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t) }
        return Quad(topLeft: m(topLeft, o.topLeft), topRight: m(topRight, o.topRight), bottomRight: m(bottomRight, o.bottomRight), bottomLeft: m(bottomLeft, o.bottomLeft))
    }

    func distance(to other: Quad) -> CGFloat {
        zip(points, other.points).map { hypot($0.x - $1.x, $0.y - $1.y) }.max() ?? 1
    }
}

/// What the engine hands back after reading a card.
struct CapturedCard {
    var image: UIImage
    var lines: [OCRLine]
    var hash: UInt64
}

/// Frame pipeline: find the card → wait until it's steady → flatten it →
/// fingerprint it (to skip the card that's still sitting there) → read the text.
/// Everything runs on the camera's frame queue.
final class ScanEngine {
    enum Event {
        case quad(Quad?, CGSize)
        case steady
        case reading
        case captured(CapturedCard)
        case skippedDuplicate
    }

    var onEvent: (@Sendable (Event) -> Void)?
    /// Toggled from the main thread.
    var isPaused = false
    var continuous = true
    /// Single mode: set to request one capture of the current card.
    var captureRequested = false

    private let context = CIContext(options: [.useSoftwareRenderer: false, .cacheIntermediates: false])
    private var recent: [Quad] = []
    private var framesWithoutCard = 0
    private var frameCount = 0
    private var busy = false
    private var lastHash: UInt64?
    private var cardLeftSinceCapture = true
    private var lastCapture = Date.distantPast

    private lazy var rectangles: VNDetectRectanglesRequest = {
        let r = VNDetectRectanglesRequest()
        r.minimumAspectRatio = 0.55   // slabs are ~0.6, raw cards 0.716
        r.maximumAspectRatio = 0.86
        r.minimumSize = 0.3
        r.maximumObservations = 1
        r.quadratureTolerance = 22
        r.minimumConfidence = 0.55
        return r
    }()

    func reset() {
        recent.removeAll()
        lastHash = nil
        cardLeftSinceCapture = true
        framesWithoutCard = 0
    }

    func process(_ buffer: CVPixelBuffer) {
        frameCount += 1
        // Rectangle detection at ~20 fps is plenty and keeps the phone cool.
        guard frameCount % 3 != 0 else { return }

        let width = CVPixelBufferGetWidth(buffer)
        let height = CVPixelBufferGetHeight(buffer)
        // Frames arrive portrait. If the rotation didn't apply, orient them ourselves.
        let orientation: CGImagePropertyOrientation = width > height ? .right : .up
        let size = orientation == .right ? CGSize(width: height, height: width) : CGSize(width: width, height: height)

        let handler = VNImageRequestHandler(cvPixelBuffer: buffer, orientation: orientation, options: [:])
        try? handler.perform([rectangles])
        guard let obs = rectangles.results?.first else {
            framesWithoutCard += 1
            if framesWithoutCard >= 5 {
                recent.removeAll()
                cardLeftSinceCapture = true
            }
            onEvent?(.quad(nil, size))
            return
        }
        framesWithoutCard = 0
        // Vision: normalized, bottom-left origin → top-left origin.
        let flip = { (p: CGPoint) in CGPoint(x: p.x, y: 1 - p.y) }
        let quad = Quad(topLeft: flip(obs.topLeft), topRight: flip(obs.topRight), bottomRight: flip(obs.bottomRight), bottomLeft: flip(obs.bottomLeft))
        onEvent?(.quad(quad, size))

        recent.append(quad)
        if recent.count > 6 { recent.removeFirst(recent.count - 6) }
        guard !busy, !isPaused, quad.area > 0.1 else { return }
        let steady = recent.count >= 5 && recent.allSatisfy { $0.distance(to: quad) < 0.014 }
        guard steady else { return }
        if !continuous && !captureRequested {
            onEvent?(.steady)
            return
        }
        // Give the person a beat between cards.
        guard Date().timeIntervalSince(lastCapture) > 0.6 else { return }

        let upright = CIImage(cvPixelBuffer: buffer).oriented(orientation)
        let origin = upright.extent.origin
        let image = upright.transformed(by: CGAffineTransform(translationX: -origin.x, y: -origin.y))
        guard let flat = flatten(image, quad: quad, size: size) else { return }
        let hash = dHash(flat)

        if continuous, let last = lastHash, !cardLeftSinceCapture, hamming(hash, last) <= 10 {
            return // same card still in frame
        }
        busy = true
        captureRequested = false
        lastCapture = Date()
        onEvent?(.reading)

        guard let cg = context.createCGImage(flat, from: flat.extent) else { busy = false; return }
        let lines = recognize(cg)
        let thumb = UIImage(cgImage: cg)
        lastHash = hash
        cardLeftSinceCapture = false
        busy = false
        onEvent?(.captured(CapturedCard(image: thumb, lines: lines, hash: hash)))
    }

    /// Perspective-correct the card to a flat, upright image (~1000px tall).
    private func flatten(_ image: CIImage, quad: Quad, size: CGSize) -> CIImage? {
        // CI uses a bottom-left origin in pixels.
        func px(_ p: CGPoint) -> CGPoint { CGPoint(x: p.x * size.width, y: (1 - p.y) * size.height) }
        let f = CIFilter.perspectiveCorrection()
        f.inputImage = image
        f.topLeft = px(quad.topLeft)
        f.topRight = px(quad.topRight)
        f.bottomLeft = px(quad.bottomLeft)
        f.bottomRight = px(quad.bottomRight)
        guard var out = f.outputImage else { return nil }
        out = out.transformed(by: CGAffineTransform(translationX: -out.extent.origin.x, y: -out.extent.origin.y))
        // Landscape result means the card is lying sideways; rotate upright.
        if out.extent.width > out.extent.height {
            out = out.oriented(.right)
            out = out.transformed(by: CGAffineTransform(translationX: -out.extent.origin.x, y: -out.extent.origin.y))
        }
        let scale = min(1, 1400 / out.extent.height)
        if scale < 1 { out = out.transformed(by: CGAffineTransform(scaleX: scale, y: scale)) }
        return out
    }

    /// 64-bit difference hash: robust to lighting, sensitive to which card it is.
    private func dHash(_ image: CIImage) -> UInt64 {
        let sx = 9 / image.extent.width
        let sy = 8 / image.extent.height
        let small = image.transformed(by: CGAffineTransform(scaleX: sx, y: sy))
        var pixels = [UInt8](repeating: 0, count: 9 * 8 * 4)
        context.render(small, toBitmap: &pixels, rowBytes: 9 * 4, bounds: CGRect(x: 0, y: 0, width: 9, height: 8),
                       format: .RGBA8, colorSpace: CGColorSpaceCreateDeviceRGB())
        var hash: UInt64 = 0
        var bit: UInt64 = 0
        for y in 0..<8 {
            for x in 0..<8 {
                let a = luminance(pixels, x, y)
                let b = luminance(pixels, x + 1, y)
                if a > b { hash |= (1 << bit) }
                bit += 1
            }
        }
        return hash
    }

    private func luminance(_ p: [UInt8], _ x: Int, _ y: Int) -> Int {
        let i = (y * 9 + x) * 4
        return Int(p[i]) * 299 + Int(p[i + 1]) * 587 + Int(p[i + 2]) * 114
    }

    private func hamming(_ a: UInt64, _ b: UInt64) -> Int { (a ^ b).nonzeroBitCount }

    /// OCR the whole card, then the top and bottom bands at 2× where the
    /// name and the tiny collector number live.
    private func recognize(_ image: CGImage) -> [OCRLine] {
        var lines = ocr(image, region: CGRect(x: 0, y: 0, width: 1, height: 1), upscale: 1)
        lines += ocr(image, region: CGRect(x: 0, y: 0.84, width: 1, height: 0.16), upscale: 2)
        lines += ocr(image, region: CGRect(x: 0, y: 0, width: 1, height: 0.18), upscale: 1.5)
        // Drop duplicates the band passes re-read.
        var seen = Set<String>()
        return lines.filter { seen.insert($0.text.lowercased() + "\(Int($0.box.minY * 40))").inserted }
    }

    private func ocr(_ image: CGImage, region: CGRect, upscale: CGFloat) -> [OCRLine] {
        let w = CGFloat(image.width), h = CGFloat(image.height)
        let crop = CGRect(x: region.minX * w, y: region.minY * h, width: region.width * w, height: region.height * h).integral
        guard var input = image.cropping(to: crop) else { return [] }
        if upscale > 1, let scaled = scale(input, by: upscale) { input = scaled }

        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = false
        request.recognitionLanguages = ["en-US"]
        request.minimumTextHeight = 0.012
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

    private func scale(_ image: CGImage, by factor: CGFloat) -> CGImage? {
        let ci = CIImage(cgImage: image).transformed(by: CGAffineTransform(scaleX: factor, y: factor))
        return context.createCGImage(ci, from: ci.extent)
    }
}
