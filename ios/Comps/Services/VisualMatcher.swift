import Foundation
import Vision
import ImageIO

/// Compares a scanned card with the official images of its candidate matches.
/// Vision's image feature prints shrug off glare, sleeves and white balance well
/// enough to tell different artworks apart, which text alone often can't
/// (same name and number in another set, alt arts, misread numbers).
actor VisualMatcher {
    static let shared = VisualMatcher()

    private var prints: [String: VNFeaturePrintObservation] = [:]
    private var order: [String] = []
    private let session: URLSession

    init() {
        let config = URLSessionConfiguration.default
        let dir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("card-art", isDirectory: true)
        config.urlCache = URLCache(memoryCapacity: 16 << 20, diskCapacity: 250 << 20, directory: dir)
        config.requestCachePolicy = .returnCacheDataElseLoad
        config.timeoutIntervalForRequest = 6
        config.httpMaximumConnectionsPerHost = 6
        session = URLSession(configuration: config)
    }

    static func featurePrint(_ image: CGImage) -> VNFeaturePrintObservation? {
        let request = VNGenerateImageFeaturePrintRequest()
        request.imageCropAndScaleOption = .scaleFill
        let handler = VNImageRequestHandler(cgImage: image, options: [:])
        do { try handler.perform([request]) } catch { return nil }
        return request.results?.first
    }

    /// Distance from the scan to each candidate's official image (smaller is closer).
    /// Candidates whose image can't be loaded (offline) are left out.
    func distances(scan: CGImage, candidates: [(id: String, url: URL)]) async -> [String: Float] {
        guard !candidates.isEmpty, let probe = Self.featurePrint(scan) else { return [:] }
        let missing = candidates.filter { prints[$0.id] == nil }
        if !missing.isEmpty {
            let session = self.session
            let downloads = await withTaskGroup(of: (String, Data?).self, returning: [(String, Data)].self) { group in
                for c in missing {
                    group.addTask { (c.id, await Self.download(c.url, session: session)) }
                }
                var got: [(String, Data)] = []
                for await (id, data) in group {
                    if let data { got.append((id, data)) }
                }
                return got
            }
            for (id, data) in downloads {
                guard let source = CGImageSourceCreateWithData(data as CFData, nil),
                      let image = CGImageSourceCreateImageAtIndex(source, 0, nil),
                      let p = Self.featurePrint(image) else { continue }
                remember(id, p)
            }
        }
        var out: [String: Float] = [:]
        for c in candidates {
            guard let p = prints[c.id] else { continue }
            var d: Float = 0
            do {
                try probe.computeDistance(&d, to: p)
                out[c.id] = d
            } catch {}
        }
        return out
    }

    private func remember(_ id: String, _ p: VNFeaturePrintObservation) {
        if prints[id] == nil { order.append(id) }
        prints[id] = p
        if order.count > 1000 { prints[order.removeFirst()] = nil }
    }

    private static func download(_ url: URL, session: URLSession) async -> Data? {
        guard let loaded = (try? await session.data(from: url)),
              ((loaded.1 as? HTTPURLResponse)?.statusCode ?? 200) < 300 else { return nil }
        return loaded.0
    }
}
