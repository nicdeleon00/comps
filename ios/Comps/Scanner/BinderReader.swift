import Vision
import CoreImage
import UIKit

/// Binder page sizes. Pockets are about 66 × 92 mm.
enum BinderLayout: String, CaseIterable, Identifiable {
    case four, nine, twelve

    var id: String { rawValue }
    var columns: Int { self == .four ? 2 : 3 }
    var rows: Int {
        switch self {
        case .four: 2
        case .nine: 3
        case .twelve: 4
        }
    }
    var count: Int { columns * rows }
    /// Page width ÷ height.
    var aspect: CGFloat { CGFloat(columns) * 66 / (CGFloat(rows) * 92) }

    /// Where the page guide sits, normalized to the camera frame.
    func guide(frame: CGSize) -> CGRect {
        guard frame.width > 0, frame.height > 0 else { return CGRect(x: 0.04, y: 0.04, width: 0.92, height: 0.92) }
        let frameAspect = frame.width / frame.height
        var w: CGFloat = 0.94, h: CGFloat = 0.94
        if aspect < frameAspect { w = h * aspect / frameAspect } else { h = w * frameAspect / aspect }
        return CGRect(x: (1 - w) / 2, y: (1 - h) / 2, width: w, height: h)
    }
}

/// One pocket of a binder page.
struct BinderCell {
    var row: Int
    var column: Int
    /// The card's outline in the page photo, normalized, top-left origin.
    var quad: Quad
    var image: CGImage?
    var lines: [OCRLine]
    /// True when the card's edges were found; false when the spot was inferred from the grid.
    var found: Bool

    /// An empty pocket reads as little or no text.
    var isEmpty: Bool {
        image == nil || lines.reduce(0) { $0 + $1.text.filter(\.isLetter).count } < 6
    }
}

/// Reads every card on a binder page from one photo: find the cards' edges,
/// fit the page grid to them (so a missed card still gets its pocket), then
/// flatten and read each pocket in parallel.
enum BinderReader {
    static func read(_ page: CGImage, layout: BinderLayout, guide: CGRect) -> [BinderCell] {
        let size = CGSize(width: page.width, height: page.height)
        let image = CIImage(cgImage: page)
        let found = detectCards(page, layout: layout, guide: guide)
        let grid = fitGrid(found, layout: layout, guide: guide)
        var cells = [BinderCell?](repeating: nil, count: grid.count)
        let lock = NSLock()
        DispatchQueue.concurrentPerform(iterations: grid.count) { i in
            let spot = grid[i]
            let cell = readCell(image, size: size, spot: spot)
            lock.lock()
            cells[i] = cell
            lock.unlock()
        }
        return cells.compactMap { $0 }
    }

    // MARK: Finding the cards

    private static func detectCards(_ page: CGImage, layout: BinderLayout, guide: CGRect) -> [Quad] {
        let request = VNDetectRectanglesRequest()
        request.minimumAspectRatio = 0.55
        request.maximumAspectRatio = 0.9
        request.minimumSize = Float(0.45 / CGFloat(layout.columns))
        request.maximumObservations = 30
        request.quadratureTolerance = 20
        request.minimumConfidence = 0.4
        let handler = VNImageRequestHandler(cgImage: page, options: [:])
        try? handler.perform([request])

        let W = CGFloat(page.width), H = CGFloat(page.height)
        let pocket = (guide.width / CGFloat(layout.columns)) * (guide.height / CGFloat(layout.rows))
        let candidates = (request.results ?? []).map(CardImaging.quad).filter { q in
            let b = q.bounds
            let w = b.width * W, h = b.height * H
            // Cards stand upright in a binder.
            guard h > w else { return false }
            let ratio = w / h
            return ratio > 0.6 && ratio < 0.82 && q.area > pocket * 0.3 && q.area < pocket * 1.4
        }
        // A pocket and the card inside it both look like rectangles: keep one per spot, the card.
        var kept: [Quad] = []
        for q in candidates.sorted(by: { $0.area < $1.area })
        where !kept.contains(where: { $0.bounds.contains(q.center) || q.bounds.contains($0.center) }) {
            kept.append(q)
        }
        return kept
    }

    private struct Spot {
        var row: Int
        var column: Int
        var quad: Quad
        var found: Bool
    }

    /// Places the page grid over the detected cards. Starts from the on-screen guide,
    /// then fits scale and offset (per axis) so a page that's framed a little off still lines up.
    private static func fitGrid(_ found: [Quad], layout: BinderLayout, guide: CGRect) -> [Spot] {
        let cols = layout.columns, rows = layout.rows
        let pitchX = guide.width / CGFloat(cols), pitchY = guide.height / CGFloat(rows)
        func guideCenter(_ r: Int, _ c: Int) -> CGPoint {
            CGPoint(x: guide.minX + (CGFloat(c) + 0.5) * pitchX, y: guide.minY + (CGFloat(r) + 0.5) * pitchY)
        }
        var sx: CGFloat = 1, tx: CGFloat = 0, sy: CGFloat = 1, ty: CGFloat = 0
        func predicted(_ r: Int, _ c: Int) -> CGPoint {
            let g = guideCenter(r, c)
            return CGPoint(x: sx * g.x + tx, y: sy * g.y + ty)
        }

        for _ in 0..<3 {
            var xs: [(CGFloat, CGFloat)] = [], ys: [(CGFloat, CGFloat)] = []
            for q in found {
                let c = q.center
                var best: (r: Int, c: Int, d: CGFloat)?
                for r in 0..<rows {
                    for k in 0..<cols {
                        let p = predicted(r, k)
                        let d = hypot((p.x - c.x) / (pitchX * sx), (p.y - c.y) / (pitchY * sy))
                        if d < (best?.d ?? .infinity) { best = (r, k, d) }
                    }
                }
                guard let b = best, b.d < 0.75 else { continue }
                let g = guideCenter(b.r, b.c)
                xs.append((g.x, c.x))
                ys.append((g.y, c.y))
            }
            (sx, tx) = fit(xs)
            (sy, ty) = fit(ys)
        }

        func median(_ v: [CGFloat]) -> CGFloat? {
            guard !v.isEmpty else { return nil }
            return v.sorted()[v.count / 2]
        }
        let w = median(found.map { $0.bounds.width }) ?? pitchX * sx * 0.9
        let h = median(found.map { $0.bounds.height }) ?? pitchY * sy * 0.93
        let unit = CGRect(x: 0, y: 0, width: 1, height: 1)

        var used = Set<Int>()
        var spots: [Spot] = []
        for r in 0..<rows {
            for k in 0..<cols {
                let p = predicted(r, k)
                var match: Int?
                var bestD = CGFloat.infinity
                for (i, q) in found.enumerated() where !used.contains(i) {
                    let d = hypot((q.center.x - p.x) / (pitchX * sx), (q.center.y - p.y) / (pitchY * sy))
                    if d < 0.4 && d < bestD { bestD = d; match = i }
                }
                if let m = match {
                    used.insert(m)
                    spots.append(Spot(row: r, column: k, quad: found[m], found: true))
                } else {
                    let rect = CGRect(x: p.x - w / 2, y: p.y - h / 2, width: w, height: h).intersection(unit)
                    guard !rect.isNull, rect.width > w * 0.5, rect.height > h * 0.5 else { continue }
                    spots.append(Spot(row: r, column: k, quad: Quad(rect: rect), found: false))
                }
            }
        }
        return spots
    }

    /// Least-squares line through (guide, detected) pairs; scale clamped to sane values.
    private static func fit(_ pairs: [(CGFloat, CGFloat)]) -> (CGFloat, CGFloat) {
        guard !pairs.isEmpty else { return (1, 0) }
        let n = CGFloat(pairs.count)
        let mg = pairs.map(\.0).reduce(0, +) / n
        let md = pairs.map(\.1).reduce(0, +) / n
        let variance = pairs.map { ($0.0 - mg) * ($0.0 - mg) }.reduce(0, +)
        var s: CGFloat = 1
        if variance > 1e-4 {
            s = pairs.map { ($0.0 - mg) * ($0.1 - md) }.reduce(0, +) / variance
            s = min(1.35, max(0.7, s))
        }
        return (s, md - s * mg)
    }

    // MARK: Reading a pocket

    private static func readCell(_ page: CIImage, size: CGSize, spot: Spot) -> BinderCell {
        var quad = spot.quad
        var found = spot.found
        if !found, let refined = refine(page, size: size, rect: quad.bounds) {
            quad = refined
            found = true
        }
        var cell = BinderCell(row: spot.row, column: spot.column, quad: quad, image: nil, lines: [], found: found)
        guard let flat = CardImaging.flatten(page, quad: quad, size: size, maxHeight: 1400),
              let cg = CardImaging.cgImage(flat) else { return cell }
        cell.image = cg
        cell.lines = CardImaging.recognize(cg, small: flat.extent.height < 1100)
        return cell
    }

    /// Looks for the card's edges inside an inferred pocket.
    private static func refine(_ page: CIImage, size: CGSize, rect: CGRect) -> Quad? {
        let r = rect.insetBy(dx: -rect.width * 0.06, dy: -rect.height * 0.06).intersection(CGRect(x: 0, y: 0, width: 1, height: 1))
        guard !r.isNull else { return nil }
        let px = CGRect(x: r.minX * size.width, y: (1 - r.maxY) * size.height, width: r.width * size.width, height: r.height * size.height).integral
        guard let crop = CardImaging.context.createCGImage(page, from: px) else { return nil }
        let request = VNDetectRectanglesRequest()
        request.minimumAspectRatio = 0.6
        request.maximumAspectRatio = 0.85
        request.minimumSize = 0.6
        request.maximumObservations = 1
        request.quadratureTolerance = 20
        request.minimumConfidence = 0.5
        let handler = VNImageRequestHandler(cgImage: crop, options: [:])
        try? handler.perform([request])
        guard let obs = request.results?.first else { return nil }
        return CardImaging.quad(obs).placed(in: r)
    }
}
