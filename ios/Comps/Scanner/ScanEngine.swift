import Vision
import CoreImage
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

    var center: CGPoint {
        CGPoint(x: points.map(\.x).reduce(0, +) / 4, y: points.map(\.y).reduce(0, +) / 4)
    }

    var bounds: CGRect {
        let xs = points.map(\.x), ys = points.map(\.y)
        return CGRect(x: xs.min()!, y: ys.min()!, width: xs.max()! - xs.min()!, height: ys.max()! - ys.min()!)
    }

    init(topLeft: CGPoint, topRight: CGPoint, bottomRight: CGPoint, bottomLeft: CGPoint) {
        self.topLeft = topLeft
        self.topRight = topRight
        self.bottomRight = bottomRight
        self.bottomLeft = bottomLeft
    }

    init(rect r: CGRect) {
        self.init(topLeft: CGPoint(x: r.minX, y: r.minY), topRight: CGPoint(x: r.maxX, y: r.minY),
                  bottomRight: CGPoint(x: r.maxX, y: r.maxY), bottomLeft: CGPoint(x: r.minX, y: r.maxY))
    }

    func lerp(to o: Quad, _ t: CGFloat) -> Quad {
        func m(_ a: CGPoint, _ b: CGPoint) -> CGPoint { CGPoint(x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t) }
        return Quad(topLeft: m(topLeft, o.topLeft), topRight: m(topRight, o.topRight), bottomRight: m(bottomRight, o.bottomRight), bottomLeft: m(bottomLeft, o.bottomLeft))
    }

    func distance(to other: Quad) -> CGFloat {
        zip(points, other.points).map { hypot($0.x - $1.x, $0.y - $1.y) }.max() ?? 1
    }

    /// Maps a quad that's normalized inside `rect` back to the outer image.
    func placed(in rect: CGRect) -> Quad {
        func m(_ p: CGPoint) -> CGPoint { CGPoint(x: rect.minX + p.x * rect.width, y: rect.minY + p.y * rect.height) }
        return Quad(topLeft: m(topLeft), topRight: m(topRight), bottomRight: m(bottomRight), bottomLeft: m(bottomLeft))
    }
}

/// What the engine hands back after reading a card.
struct CapturedCard {
    var image: UIImage
    var cgImage: CGImage
    var lines: [OCRLine]
    var hash: UInt64
    /// Set when this is a second look at a card that's already in the tray.
    var retakeOf: UUID?
}

/// Frame pipeline: find the card → wait until it's steady → flatten it →
/// fingerprint it (to skip the card that's still sitting there) → read the text.
/// Everything runs on the camera's frame queue.
final class ScanEngine {
    enum Event {
        case quad(Quad?, CGSize)
        case quads([Quad], CGSize)
        case steady
        case reading
        case captured(CapturedCard)
    }

    var onEvent: (@Sendable (Event) -> Void)?
    /// Toggled from the main thread.
    var isPaused = false
    var continuous = true
    /// Binder mode: outline every card in view, never capture on its own.
    var binder = false
    /// Single mode: set to request one capture of the current card.
    var captureRequested = false

    private let lock = NSLock()
    private var _retake: (id: UUID, attempt: Int)?
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

    private lazy var pageRectangles: VNDetectRectanglesRequest = {
        let r = VNDetectRectanglesRequest()
        r.minimumAspectRatio = 0.6
        r.maximumAspectRatio = 0.85
        r.minimumSize = 0.12
        r.maximumObservations = 16
        r.quadratureTolerance = 20
        r.minimumConfidence = 0.45
        return r
    }()

    /// Ask for a second read of the card that's still under the camera.
    func requestRetake(_ id: UUID, attempt: Int) {
        lock.lock(); _retake = (id, attempt); lock.unlock()
    }

    private var retake: (id: UUID, attempt: Int)? {
        get { lock.lock(); defer { lock.unlock() }; return _retake }
        set { lock.lock(); _retake = newValue; lock.unlock() }
    }

    func reset() {
        recent.removeAll()
        lastHash = nil
        cardLeftSinceCapture = true
        framesWithoutCard = 0
        retake = nil
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

        if binder {
            guard frameCount % 2 == 0 else { return }
            try? handler.perform([pageRectangles])
            let quads = (pageRectangles.results ?? []).map(CardImaging.quad)
            onEvent?(.quads(quads, size))
            return
        }

        try? handler.perform([rectangles])
        guard let obs = rectangles.results?.first else {
            framesWithoutCard += 1
            if framesWithoutCard >= 5 {
                recent.removeAll()
                cardLeftSinceCapture = true
                retake = nil
            }
            onEvent?(.quad(nil, size))
            return
        }
        framesWithoutCard = 0
        let quad = CardImaging.quad(obs)
        onEvent?(.quad(quad, size))

        recent.append(quad)
        if recent.count > 6 { recent.removeFirst(recent.count - 6) }
        let pendingRetake = retake
        guard !busy, quad.area > 0.1 else { return }
        if isPaused && pendingRetake == nil { return }
        let steady = recent.count >= 5 && recent.allSatisfy { $0.distance(to: quad) < 0.014 }
        guard steady else { return }
        if pendingRetake == nil && !continuous && !captureRequested {
            onEvent?(.steady)
            return
        }
        // Give the person a beat between cards; a second look can come sooner.
        guard Date().timeIntervalSince(lastCapture) > (pendingRetake == nil ? 0.6 : 0.2) else { return }

        let upright = CIImage(cvPixelBuffer: buffer).oriented(orientation)
        let origin = upright.extent.origin
        let image = upright.transformed(by: CGAffineTransform(translationX: -origin.x, y: -origin.y))
        guard let flat = CardImaging.flatten(image, quad: quad, size: size) else { return }
        let hash = CardImaging.dHash(flat)

        if let pendingRetake {
            // Only re-read the same card; if it was swapped, drop the second look.
            guard let last = lastHash, CardImaging.hamming(hash, last) <= 14 else {
                retake = nil
                cardLeftSinceCapture = true
                recent.removeAll()
                return
            }
            retake = nil
            capture(flat, hash: hash, attempt: pendingRetake.attempt, retakeOf: pendingRetake.id)
            return
        }
        if continuous, let last = lastHash, !cardLeftSinceCapture, CardImaging.hamming(hash, last) <= 10 {
            return // same card still in frame
        }
        captureRequested = false
        onEvent?(.reading)
        capture(flat, hash: hash, attempt: 0, retakeOf: nil)
    }

    private func capture(_ flat: CIImage, hash: UInt64, attempt: Int, retakeOf: UUID?) {
        busy = true
        lastCapture = Date()
        guard let cg = CardImaging.cgImage(flat) else { busy = false; return }
        let lines = CardImaging.recognize(cg, attempt: attempt)
        lastHash = hash
        cardLeftSinceCapture = false
        busy = false
        onEvent?(.captured(CapturedCard(image: UIImage(cgImage: cg), cgImage: cg, lines: lines, hash: hash, retakeOf: retakeOf)))
    }
}
