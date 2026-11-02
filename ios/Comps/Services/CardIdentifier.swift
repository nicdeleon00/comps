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
    static let yugiohCode = #"\b([A-Z0-9]{2,5})-([A-Z]{2})?(\d{3})\b"#
    static let mtgSet = #"\b([A-Z0-9]{3,5})\s*[•·*.\-]\s*(EN|JA|DE|FR|IT|ES|PT|KO|RU|ZHS|ZHT|PH)\b"#
    static let mtgNumber = #"(?:^|\s)(?:[CURMSLTP]\s+)?(\d{3,4})(?:\s|$)"#
    static let hp = #"(?i)\bHP\s?\d{2,3}\b|\b\d{2,3}\s?HP\b"#
    static let slabGrade = #"(?i)\b(GEM\s*MT|GEM\s*MINT|PRISTINE|MINT|NM-MT|NM|EX-MT|EX|VG-EX|VG)\s*(10|9\.5|9|8\.5|8|7\.5|7|6|5|4|3|2|1)\b"#
    static let grader = #"\b(PSA|BGS|BECKETT|CGC|SGC)\b"#

    private static let noise = try! NSRegularExpression(
        pattern: #"(?i)\b(basic|stage\s*[12]|evolves\s+from.*|trainer|item|supporter|stadium|tool|energy\s+card|pok[eé]mon|hp\s?\d+|\d+\s?hp|lv\.?\s?\d+|illus\.?.*|ability|tera)\b"#)

    static func extract(_ lines: [OCRLine], hint: Game?) -> CardFeatures {
        var f = CardFeatures()
        let bottomFirst = lines.sorted { $0.box.minY > $1.box.minY }

        for l in bottomFirst {
            if let m = firstMatch(yugiohCode, in: l.text) {
                f.setCode = "\(m[1])-\(m[2])\(m[3])"
                f.game = .yugioh
                break
            }
        }
        if f.game == nil {
            for l in bottomFirst {
                if let m = firstMatch(pokemonNumber, in: l.text) { f.number = m[1]; f.total = m[2]; break }
            }
            let hasHP = lines.contains { firstMatch(hp, in: $0.text) != nil }
            for l in bottomFirst {
                if let m = firstMatch(mtgSet, in: l.text) { f.setCode = m[1]; break }
            }
            if f.setCode != nil && !hasHP {
                f.game = .mtg
                if f.number == nil {
                    for l in bottomFirst where l.box.minY > 0.85 {
                        if let m = firstMatch(mtgNumber, in: l.text) { f.number = m[1]; break }
                    }
                }
            } else if f.number != nil || hasHP {
                f.game = .pokemon
            }
        }
        if let hint { f.game = hint }

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

/// Turns OCR lines into ranked card candidates — via the server when one is
/// connected (it has the whole catalog locally), otherwise straight from the public APIs.
enum CardResolver {
    static func resolve(lines: [OCRLine], hint: Game?) async -> (features: CardFeatures, candidates: [ScanCandidate]) {
        let f = FeatureExtractor.extract(lines, hint: hint)
        if let api = APIClient.current, let list = (try? await api.identify(lines: lines, game: hint)), !list.isEmpty {
            return (f, list)
        }
        return (f, await direct(f))
    }

    static func direct(_ f: CardFeatures) async -> [ScanCandidate] {
        var out: [ScanCandidate] = []
        do {
            switch f.game ?? .pokemon {
            case .yugioh:
                if let code = f.setCode { out = try await DirectProviders.yugioh(setCode: code) }
                if out.isEmpty, let name = f.name { out = try await DirectProviders.yugioh(name: name) }
            case .mtg:
                if let set = f.setCode, let n = f.number { out = [try await DirectProviders.scryfall(set: set, number: n)] }
                if out.isEmpty, let name = f.name { out = try await DirectProviders.scryfall(name: name) }
            default:
                var parts: [String] = []
                if let n = f.number {
                    let trimmed = n.replacingOccurrences(of: #"^([A-Z]*)0+(?=\d)"#, with: "$1", options: .regularExpression)
                    parts.append("number:\(trimmed)")
                }
                if let total = f.total, let t = Int(total) { parts.append("set.printedTotal:\(t)") }
                if !parts.isEmpty { out = try await DirectProviders.pokemon(query: parts.joined(separator: " ")) }
                if out.isEmpty, let name = f.name {
                    out = try await DirectProviders.pokemon(query: DirectProviders.pokemonNameQuery(name))
                }
            }
        } catch {
            return []
        }
        return rank(out, f)
    }

    static func rank(_ list: [ScanCandidate], _ f: CardFeatures) -> [ScanCandidate] {
        let names = [f.name].compactMap { $0 } + f.nameCandidates
        return list.map { c in
            var c = c
            var s = c.score
            if !names.isEmpty {
                let best = names.map { Similarity.score($0, c.card.name) }.max() ?? 0
                s = 0.25 + 0.75 * best
            }
            if let total = f.total, let t = Int(total), c.card.total == String(t) { s += 0.1 }
            if f.game == .mtg && f.setCode != nil && f.number != nil { s = max(s, c.score) }
            c.score = min(1, s)
            return c
        }
        .sorted { $0.score > $1.score }
    }
}
