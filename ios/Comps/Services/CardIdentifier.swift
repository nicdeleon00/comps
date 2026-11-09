import Foundation
import CoreGraphics

/// One line of OCR text on a flattened card image. `box` is normalized with a top-left origin.
struct OCRLine: Hashable {
    var text: String
    var box: CGRect
    var confidence: Float
}

/// One way of reading the collector number. A scan can produce several
/// (OCR confusions, regulation marks, repeated frames); the catalog decides
/// which of them exist.
struct NumberRead: Hashable {
    var number: String
    var total: String?
    var weight: Double
}

/// Identifiers printed on the card face.
struct CardFeatures {
    var name: String?
    var nameCandidates: [String] = []
    var numbers: [NumberRead] = []
    /// Printed set code on Scarlet & Violet-era and later cards ("PAL EN 123/193").
    var setCode: String?
    /// All OCR text, normalized; used to spot stamps like "Prerelease" or "Staff".
    var text = ""
    var grader: String?
    var grade: String?
    /// Japanese writing on the card (kana, with or without kanji).
    var japanese = false
    /// Chinese writing on the card (hanzi without any kana).
    var chinese = false

    var number: String? { numbers.first?.number }
    var total: String? { numbers.first?.total }

    /// Identifies "this kind of read" so a correction can be remembered.
    var memoryKey: String? {
        if let n = numbers.first {
            return "n:" + Catalog.numberKey(n.number) + "/" + Catalog.numberKey(n.total ?? "") + (setCode.map { "@" + $0 } ?? "")
        }
        if let name { return "t:" + Similarity.normalize(name) }
        return nil
    }
}

enum FeatureExtractor {
    private static func regex(_ p: String) -> NSRegularExpression { try! NSRegularExpression(pattern: p) }

    // "025/198", "TG05/TG30", "GG35/GG70", "SV94/SV94", "H1/H32"
    private static let numberWithTotal = regex(#"(?:^|[^A-Za-z0-9/])([A-Z]{0,3}\d{1,3}[a-z]?)\s?/\s?([A-Z]{0,3}\d{2,3})(?!\d)"#)
    // "SVP EN 050", "MEP EN 012" (promos and energies that print a set code instead of a total)
    private static let codedPromo = regex(#"\b(SVP|MEP|SVE|MEE)\s?(?:EN)?\s?(\d{1,3})\b"#)
    // "SWSH050", "SM210", "XY124", "BW45", "HGSS12", "DP45"
    private static let prefixedPromo = regex(#"\b(SWSH|SM|XY|BW|HGSS|DP)\s?(\d{1,3})\b"#)
    // "PAL EN", "SVI EN"
    private static let setCodePattern = regex(#"\b([A-Z]{3})\s?EN\b"#)
    // Japanese set codes: "SV2a", "S12a", "SM12a", "M1L"
    private static let japaneseSetCode = regex(#"\b((?:SV|SM|S|M)\d{1,2}[a-zA-Z]?)\b"#)

    /// Kana (Japanese only) and han characters (Japanese kanji or Chinese) in a piece of text.
    static func scripts(_ s: String) -> (kana: Int, han: Int) {
        var kana = 0, han = 0
        for u in s.unicodeScalars {
            if (0x3040...0x30FF).contains(u.value) { kana += 1 } else if (0x4E00...0x9FFF).contains(u.value) { han += 1 }
        }
        return (kana, han)
    }
    private static let slabGrade = regex(#"(?i)\b(GEM\s*MT|GEM\s*MINT|PRISTINE|MINT|NM-MT|NM|EX-MT|EX|VG-EX|VG)\s*(10|9\.5|9|8\.5|8|7\.5|7|6|5|4|3|2|1)\b"#)
    private static let graderPattern = regex(#"\b(PSA|BGS|BECKETT|CGC|SGC)\b"#)
    private static let noise = regex(#"(?i)\b(basic|stage\s*[12]|evolves\s+from.*|trainer|item|supporter|stadium|tool|energy\s+card|pok[eé]mon|hp\s?\d+|\d+\s?hp|lv\.?\s?\d+|illus\.?.*|ability|tera)\b"#)

    /// Letters OCR commonly reads in place of digits. Only swapped when they sit
    /// next to a digit or slash, so prefixes like "TG", "SV" and "SWSH" survive.
    private static let confusions: [Character: Character] = ["O": "0", "o": "0", "Q": "0", "I": "1", "l": "1", "|": "1", "i": "1", "!": "1", "Z": "2", "z": "2", "S": "5", "s": "5"]

    static func digitize(_ s: String) -> String {
        var chars = Array(s)
        for _ in 0..<2 {
            var changed = false
            for i in chars.indices {
                guard let d = confusions[chars[i]] else { continue }
                let prev = i > 0 ? chars[i - 1] : " "
                let next = i + 1 < chars.count ? chars[i + 1] : " "
                if prev.isNumber || prev == "/" || next.isNumber || next == "/" { chars[i] = d; changed = true }
            }
            if !changed { break }
        }
        return String(chars)
    }

    private static func matches(_ re: NSRegularExpression, in text: String) -> [[String]] {
        let ns = text as NSString
        return re.matches(in: text, range: NSRange(location: 0, length: ns.length)).map { m in
            (0..<m.numberOfRanges).map { i in
                let r = m.range(at: i)
                return r.location == NSNotFound ? "" : ns.substring(with: r)
            }
        }
    }

    static func extract(_ lines: [OCRLine]) -> CardFeatures {
        var f = CardFeatures()
        var reads: [String: NumberRead] = [:]
        var votes: [String: Int] = [:]

        func add(_ number: String, _ total: String?, _ weight: Double) {
            let key = Catalog.numberKey(number) + "/" + Catalog.numberKey(total ?? "")
            votes[key, default: 0] += 1
            if let r = reads[key], r.weight >= weight { return }
            reads[key] = NumberRead(number: number, total: total, weight: weight)
        }

        for l in lines {
            // The collector number lives in the bottom quarter; trust reads there more.
            let place = l.box.midY > 0.72 ? 1.0 : 0.75
            var variants: [(String, Double)] = [(l.text, 1.0)]
            let digits = digitize(l.text)
            if digits != l.text { variants.append((digits, 0.9)) }
            for (variant, trust) in variants {
                for m in matches(numberWithTotal, in: variant) {
                    let number = m[1], total = m[2]
                    add(number, total, place * trust)
                    // "G025/198": a regulation mark glued to the number. The total has no prefix, so try without it.
                    if let first = number.first, first.isLetter, number.dropFirst().first?.isNumber == true,
                       total.first?.isNumber == true {
                        add(String(number.dropFirst()), total, place * trust * 0.95)
                    }
                }
                for m in matches(codedPromo, in: variant) {
                    add(m[2], nil, place * trust * 0.95)
                    if f.setCode == nil { f.setCode = m[1].uppercased() }
                }
                for m in matches(prefixedPromo, in: variant) {
                    add(m[1].uppercased() + m[2], nil, place * trust * 0.9)
                }
                if variant == l.text {
                    for m in matches(setCodePattern, in: variant) where f.setCode == nil {
                        f.setCode = m[1].uppercased()
                    }
                }
            }
        }
        // Japanese writing in the name band means a Japanese card. Its set code ("SV2a") sits by the number.
        // Pokémon names are in katakana on Japanese cards and in hanzi on Chinese ones.
        let band = lines.filter { $0.box.minY < 0.25 }.map { scripts($0.text) }
        let kana = band.reduce(0) { $0 + $1.kana }, han = band.reduce(0) { $0 + $1.han }
        f.japanese = kana >= 2 || (kana >= 1 && kana + han >= 3)
        f.chinese = !f.japanese && han >= 2
        if f.japanese || f.chinese {
            f.setCode = nil
            for l in lines where l.box.midY > 0.72 {
                if let m = matches(japaneseSetCode, in: l.text).first { f.setCode = m[1].uppercased(); break }
            }
        }
        // Readings seen in several passes or frames are more likely right.
        f.numbers = reads.map { key, r in
            NumberRead(number: r.number, total: r.total, weight: min(1, r.weight + 0.08 * Double((votes[key] ?? 1) - 1)))
        }
        .sorted { $0.weight > $1.weight }

        let all = lines.map(\.text).joined(separator: " ")
        f.text = Similarity.normalize(all)
        if let g = matches(slabGrade, in: all).first { f.grade = g[2] }
        if let g = matches(graderPattern, in: all).first { f.grader = g[1].uppercased() == "BECKETT" ? "BGS" : g[1].uppercased() }
        if f.grade != nil && f.grader == nil { f.grader = "PSA" }

        // The name is the biggest text in the top band.
        let top = lines.filter { $0.box.minY < 0.22 }.sorted { $0.box.height > $1.box.height }
        var seen = Set<String>()
        for l in top {
            let ns = l.text as NSString
            var cleaned = noise.stringByReplacingMatches(in: l.text, range: NSRange(location: 0, length: ns.length), withTemplate: " ")
            cleaned = cleaned.components(separatedBy: CharacterSet.letters.union(.decimalDigits).union(CharacterSet(charactersIn: "'’&.:,- ")).inverted).joined(separator: " ")
            cleaned = cleaned.split(separator: " ").joined(separator: " ")
            let letters = cleaned.unicodeScalars.filter { CharacterSet.letters.contains($0) }.count
            guard cleaned.count >= 3, letters >= 3, seen.insert(cleaned.lowercased()).inserted else { continue }
            f.nameCandidates.append(cleaned)
            if f.nameCandidates.count == 5 { break }
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
        normalizedScore(normalize(a), normalize(b))
    }

    /// Same as `score` for strings that are already normalized.
    static func normalizedScore(_ na: String, _ nb: String) -> Double {
        guard !na.isEmpty, !nb.isEmpty else { return 0 }
        if na == nb { return 1 }
        // Cheap reject: lengths far apart can't be close.
        let longer = max(na.count, nb.count), shorter = min(na.count, nb.count)
        let prefix = (nb.hasPrefix(na) || na.hasPrefix(nb)) && shorter >= 4 ? 0.9 : 0
        if Double(shorter) / Double(longer) < 0.45 { return prefix }
        let lev = 1 - Double(levenshtein(Array(na), Array(nb))) / Double(longer)
        let ta = Set(na.split(separator: " ")), tb = Set(nb.split(separator: " "))
        let jac = Double(ta.intersection(tb).count) / Double(ta.union(tb).count)
        return max(lev, jac, prefix)
    }
}

/// Context that sharpens matching beyond what's printed on the card.
struct MatchContext {
    /// Only this set (group id) gets the benefit of the doubt.
    var lockedSet: String?
    /// Sets of cards already scanned this session (set name → count).
    var recentSets: [String: Int] = [:]
    /// The card the user picked last time for an identical read.
    var learned: String?
}

/// Remembers the user's corrections so the same read resolves right next time.
enum ScanMemory {
    private static let key = "scan.corrections"

    static func learned(for k: String) -> String? {
        (UserDefaults.standard.dictionary(forKey: key) as? [String: String])?[k]
    }

    static func remember(_ k: String, cardID: String) {
        var d = (UserDefaults.standard.dictionary(forKey: key) as? [String: String]) ?? [:]
        d[k] = cardID
        if d.count > 800, let drop = d.keys.first(where: { $0 != k }) { d.removeValue(forKey: drop) }
        UserDefaults.standard.set(d, forKey: key)
    }
}

/// Turns OCR lines (and the card photo) into ranked candidates using the on-phone catalog.
enum CardResolver {
    struct Result {
        var features: CardFeatures
        var candidates: [ScanCandidate]
    }

    static func resolve(lines: [OCRLine], image: CGImage?, context: MatchContext) async -> Result {
        let f = FeatureExtractor.extract(lines)
        await Catalog.shared.ensureLoaded()
        var ctx = context
        if let key = f.memoryKey, let learned = ScanMemory.learned(for: key) { ctx.learned = learned }
        var candidates = await Catalog.shared.match(f, context: ctx)
        if let image, candidates.count >= 2 {
            candidates = await compareArt(candidates, scan: image, wide: f.numbers.isEmpty)
        }
        return Result(features: f, candidates: candidates)
    }

    /// Re-ranks close candidates by how much their official image looks like the scan.
    /// Identical reprints come out even; different artwork separates clearly.
    static func compareArt(_ candidates: [ScanCandidate], scan: CGImage, wide: Bool) async -> [ScanCandidate] {
        guard let top = candidates.first?.score else { return candidates }
        let pool = candidates.prefix(wide ? 16 : 10).filter { top - $0.score < 0.35 }
        guard pool.count >= 2 else { return candidates }
        let targets = pool.compactMap { c in c.card.imageURL.map { (id: c.id, url: $0) } }
        let distances = await VisualMatcher.shared.distances(scan: scan, candidates: targets)
        guard distances.count >= 2, let best = distances.values.min() else { return candidates }
        var out = candidates
        for i in out.indices {
            guard let d = distances[out[i].id] else { continue }
            let rel = Double(d - best) / Double(max(best, 0.05))
            let likeness = exp(-3 * rel)
            out[i].score += 0.18 * (likeness - 1) + (d == best ? 0.04 : 0)
            if d == best, rel == 0 { out[i].reason += " · art matches" }
        }
        return out.sorted { $0.score > $1.score }
    }
}
