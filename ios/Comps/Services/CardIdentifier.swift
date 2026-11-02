import Foundation
import CoreGraphics

/// One line of OCR text on a flattened card image. `box` is normalized with a top-left origin.
struct OCRLine: Hashable {
    var text: String
    var box: CGRect
    var confidence: Float
}

/// Identifiers printed on the card face.
struct CardFeatures {
    var game: Game?
    var name: String?
    var nameCandidates: [String] = []
    var number: String?
    var total: String?
    var setCode: String?
    var grader: String?
    var grade: String?
}

enum FeatureExtractor {
    private static func firstMatch(_ pattern: String, in text: String) -> [String]? {
        guard let re = try? NSRegularExpression(pattern: pattern, options: []) else { return nil }
        let range = NSRange(text.startIndex..., in: text)
        guard let m = re.firstMatch(in: text, options: [], range: range) else { return nil }
        return (0..<m.numberOfRanges).map { i in
            let r = m.range(at: i)
            guard r.location != NSNotFound, let rr = Range(r, in: text) else { return "" }
            return String(text[rr])
        }
    }

    // Same patterns as server/src/engine/identify.js
    static let pokemonNumber = #"(?:^|[^\w/])([A-Z]{0,3}\d{1,3}[a-z]?)\s?/\s?([A-Z]{0,3}\d{2,3})(?!\d)"#
    static let promoNumber = #"(?i)\b(SWSH|SVP|SV|SM|XY|BW|HGSS|DP|MEP)\s?(\d{2,3})\b"#
    static let slabGrade = #"(?i)\b(GEM\s*MT|GEM\s*MINT|PRISTINE|MINT|NM-MT|NM|EX-MT|EX|VG-EX|VG)\s*(10|9\.5|9|8\.5|8|7\.5|7|6|5|4|3|2|1)\b"#
    static let grader = #"\b(PSA|BGS|BECKETT|CGC|SGC)\b"#

    private static let noise = try! NSRegularExpression(
        pattern: #"(?i)\b(basic|stage\s*[12]|evolves\s+from.*|trainer|item|supporter|stadium|tool|energy\s+card|pok[eé]mon|hp\s?\d+|\d+\s?hp|lv\.?\s?\d+|illus\.?.*|ability|tera)\b"#)

    static func extract(_ lines: [OCRLine], hint: Game?) -> CardFeatures {
        var f = CardFeatures()
        let bottomFirst = lines.sorted { $0.box.minY > $1.box.minY }

        for l in bottomFirst {
            if let m = firstMatch(pokemonNumber, in: l.text) { f.number = m[1]; f.total = m[2]; break }
        }
        if f.number == nil {
            for l in bottomFirst {
                if let m = firstMatch(promoNumber, in: l.text) { f.number = m[1].uppercased() + m[2]; break }
            }
        }
        f.game = .pokemon

        // Slab labels: "GEM MT 10", "PSA".
        let all = lines.map(\.text).joined(separator: " ")
        if let g = firstMatch(slabGrade, in: all) { f.grade = g[2] }
        if let g = firstMatch(grader, in: all) { f.grader = g[1].uppercased() == "BECKETT" ? "BGS" : g[1].uppercased() }
        if f.grade != nil && f.grader == nil { f.grader = "PSA" }

        let top = lines.filter { $0.box.minY < 0.22 }.sorted { $0.box.height > $1.box.height }
        for l in top {
            let ns = l.text as NSString
            var cleaned = noise.stringByReplacingMatches(in: l.text, range: NSRange(location: 0, length: ns.length), withTemplate: " ")
            cleaned = cleaned.components(separatedBy: CharacterSet.letters.union(.decimalDigits).union(CharacterSet(charactersIn: "'’&.:,- ")).inverted).joined(separator: " ")
            cleaned = cleaned.split(separator: " ").joined(separator: " ")
            if cleaned.count >= 3, cleaned.rangeOfCharacter(from: .letters) != nil { f.nameCandidates.append(cleaned) }
        }
        f.name = f.nameCandidates.first
        return f
    }
}

/// String similarity tolerant of OCR noise.
enum Similarity {
    static func normalize(_ s: String) -> String {
        s.folding(options: [.diacriticInsensitive, .caseInsensitive], locale: .current)
            .components(separatedBy: CharacterSet.alphanumerics.inverted).filter { !$0.isEmpty }.joined(separator: " ")
    }

    static func levenshtein(_ a: [Character], _ b: [Character]) -> Int {
        if a.isEmpty { return b.count }
        if b.isEmpty { return a.count }
        var prev = Array(0...b.count)
        var cur = Array(repeating: 0, count: b.count + 1)
        for i in 1...a.count {
            cur[0] = i
            for j in 1...b.count {
                cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] == b[j - 1] ? 0 : 1))
            }
            swap(&prev, &cur)
        }
        return prev[b.count]
    }

    static func score(_ a: String, _ b: String) -> Double {
        let na = normalize(a), nb = normalize(b)
        guard !na.isEmpty, !nb.isEmpty else { return 0 }
        if na == nb { return 1 }
        let lev = 1 - Double(levenshtein(Array(na), Array(nb))) / Double(max(na.count, nb.count))
        let ta = Set(na.split(separator: " ")), tb = Set(nb.split(separator: " "))
        let jac = Double(ta.intersection(tb).count) / Double(ta.union(tb).count)
        let prefix = (nb.hasPrefix(na) || na.hasPrefix(nb)) ? 0.9 : 0
        return max(lev, jac, prefix)
    }
}

/// Turns OCR lines into ranked card candidates using the on-phone catalog.
enum CardResolver {
    static func resolve(lines: [OCRLine], hint: Game?) async -> (features: CardFeatures, candidates: [ScanCandidate]) {
        let f = FeatureExtractor.extract(lines, hint: .pokemon)
        await Catalog.shared.ensureLoaded()
        return (f, await Catalog.shared.match(f))
    }
}
