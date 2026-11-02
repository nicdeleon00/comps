import Foundation

struct CatalogPrice: Hashable {
    let variant: String
    let raw: Double?
    let g9: Double?
    let psa10: Double?
    let change7d: Double?
}

struct CatalogCard {
    let productId: Int
    let name: String
    let baseName: String
    let setId: String
    let number: String
    let total: String?
    let rarity: String?
    let prices: [CatalogPrice]
    var id: String { "tcg:\(productId)" }
}

struct CatalogSet {
    let name: String
    let code: String?
    let series: String
    let released: String?
}

/// Every English Pokémon card with today's prices, downloaded from the price
/// site and cached on the phone. Scanning, search and collection values all
/// run against it locally, so they're instant and work offline.
actor Catalog {
    static let shared = Catalog()

    private(set) var cards: [CatalogCard] = []
    private(set) var sets: [String: CatalogSet] = [:]
    private(set) var updatedAt: Date?
    private var byId: [String: Int] = [:]
    private var byNumber: [String: [Int]] = [:]
    private var imageBase = "https://tcgplayer-cdn.tcgplayer.com/product/"
    private var loading: Task<Void, Never>?

    private var cacheFile: URL {
        let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("catalog-index.json")
    }

    var isLoaded: Bool { !cards.isEmpty }
    var count: Int { cards.count }

    /// Loads the cached copy, then downloads a fresh one if it's older than 6 hours (or `force`).
    func ensureLoaded(force: Bool = false) async {
        if let loading { await loading.value; if !force { return } }
        let task = Task { await self.load(force: force) }
        loading = task
        await task.value
        loading = nil
    }

    private func load(force: Bool) async {
        if cards.isEmpty, let data = try? Data(contentsOf: cacheFile) { try? parse(data) }
        let stale = updatedAt.map { Date().timeIntervalSince($0) > 6 * 3600 } ?? true
        guard force || stale || cards.isEmpty else { return }
        do {
            let data = try await HostedData.current.data("data/index.json", fresh: true)
            try parse(data)
            try? data.write(to: cacheFile, options: .atomic)
        } catch {
            // Keep the cached catalog; it's still useful offline.
        }
    }

    static func numberKey(_ n: String) -> String {
        let up = n.uppercased().trimmingCharacters(in: .whitespaces)
        let letters = up.prefix { $0.isLetter }
        var digits = up.dropFirst(letters.count)
        while digits.count > 1, digits.first == "0", digits.dropFirst().first?.isNumber == true { digits = digits.dropFirst() }
        return String(letters) + String(digits)
    }

    static func baseName(_ name: String) -> String {
        name.replacingOccurrences(of: #"\s*\([^)]*\)\s*"#, with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespaces)
    }

    private func parse(_ data: Data) throws {
        guard let root = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let rows = root["cards"] as? [[Any]] else { return }
        if let base = root["imageBase"] as? String { imageBase = base }
        var newSets: [String: CatalogSet] = [:]
        for (gid, value) in root["sets"] as? [String: [Any]] ?? [:] {
            newSets[gid] = CatalogSet(name: value[safe: 0] as? String ?? "", code: value[safe: 1] as? String,
                                      series: value[safe: 2] as? String ?? "", released: value[safe: 3] as? String)
        }
        var list: [CatalogCard] = []
        list.reserveCapacity(rows.count)
        for r in rows {
            guard let pid = (r[safe: 0] as? NSNumber)?.intValue, let name = r[safe: 1] as? String else { continue }
            let prices = (r[safe: 6] as? [[Any]] ?? []).compactMap { p -> CatalogPrice? in
                guard let v = p[safe: 0] as? String else { return nil }
                func num(_ i: Int) -> Double? { (p[safe: i] as? NSNumber)?.doubleValue }
                return CatalogPrice(variant: v, raw: num(1), g9: num(2), psa10: num(3), change7d: num(4))
            }
            list.append(CatalogCard(productId: pid, name: name, baseName: Self.baseName(name), setId: r[safe: 2] as? String ?? "",
                                    number: r[safe: 3] as? String ?? "", total: r[safe: 4] as? String, rarity: r[safe: 5] as? String, prices: prices))
        }
        guard !list.isEmpty else { return }
        cards = list
        sets = newSets
        byId = [:]
        byNumber = [:]
        for (i, c) in list.enumerated() {
            byId[c.id] = i
            byNumber[Self.numberKey(c.number), default: []].append(i)
        }
        let ms = (root["updatedAt"] as? NSNumber)?.doubleValue
        updatedAt = ms.map { Date(millis: $0) } ?? Date()
    }

    // MARK: Lookups

    func summary(_ c: CatalogCard, variant: String? = nil) -> CardSummary {
        let set = sets[c.setId]
        let p = c.prices.first { $0.variant == variant } ?? c.prices.first
        let grades = (p?.g9 != nil || p?.psa10 != nil) ? Grades(g9: p?.g9, psa10: p?.psa10) : nil
        return CardSummary(id: c.id, game: "pokemon", name: c.name, setName: set?.name, setCode: set?.code, number: c.number, total: c.total,
                           rarity: c.rarity, year: set?.released.flatMap { Int($0.prefix(4)) },
                           image: "\(imageBase)\(c.productId)_200w.jpg", imageLarge: "\(imageBase)\(c.productId)_400w.jpg",
                           variant: p?.variant, price: p?.raw, change7d: p?.change7d, grades: grades)
    }

    func card(id: String) -> CardSummary? {
        byId[id].map { summary(cards[$0]) }
    }

    func variants(id: String) -> [VariantPrice] {
        guard let i = byId[id] else { return [] }
        return cards[i].prices.map { p in
            VariantPrice(variant: p.variant, label: VariantName.label(p.variant), price: p.raw,
                         grades: (p.g9 != nil || p.psa10 != nil) ? Grades(g9: p.g9, psa10: p.psa10) : nil)
        }
    }

    struct PriceQuery { var id: String; var variant: String?; var grader: String?; var grade: String?; var condition: String }
    struct PriceAnswer { var value: Double?; var raw: Double?; var change7d: Double?; var variant: String?; var basis: String }

    func prices(_ queries: [PriceQuery]) -> [PriceAnswer?] {
        queries.map { q in
            guard let i = byId[q.id] else { return nil }
            let c = cards[i]
            guard let p = c.prices.first(where: { $0.variant == q.variant }) ?? c.prices.first else { return nil }
            let g = q.grade.flatMap(Double.init)
            if q.grader != nil, let g {
                if g >= 10, let v = p.psa10 { return PriceAnswer(value: v, raw: p.raw, change7d: p.change7d, variant: p.variant, basis: "psa10") }
                if g >= 9, g < 10, let v = p.g9 { return PriceAnswer(value: v, raw: p.raw, change7d: p.change7d, variant: p.variant, basis: "g9") }
                return PriceAnswer(value: p.raw, raw: p.raw, change7d: p.change7d, variant: p.variant, basis: "raw")
            }
            let factor = CardCondition(rawValue: q.condition)?.factor ?? 1
            return PriceAnswer(value: p.raw.map { ($0 * factor * 100).rounded() / 100 }, raw: p.raw, change7d: p.change7d, variant: p.variant, basis: "raw")
        }
    }

    /// Name / set / number search, ranked by match quality then value.
    func search(_ q: String, limit: Int = 40) -> [CardSummary] {
        let numberPattern = #"([A-Za-z]*\d+[a-z]?)\s*/\s*([A-Za-z]*\d+)"#
        var number: String?
        var text = q
        if let r = q.range(of: numberPattern, options: .regularExpression) {
            number = String(q[r]).components(separatedBy: "/").first.map { Self.numberKey($0) }
            text.removeSubrange(r)
        }
        let words = Similarity.normalize(text).split(separator: " ").map(String.init)
        guard !words.isEmpty || number != nil else { return [] }
        let candidates: [Int] = number.map { byNumber[$0] ?? [] } ?? Array(cards.indices)
        var scored: [(Int, Double)] = []
        for i in candidates {
            let c = cards[i]
            let name = Similarity.normalize(c.name).split(separator: " ")
            let set = Similarity.normalize(sets[c.setId]?.name ?? "")
            var s = 0.0
            var ok = true
            for w in words {
                if name.contains(where: { $0.hasPrefix(w) }) { s += 2 }
                else if set.contains(w) { s += 1 }
                else if w.allSatisfy(\.isNumber), Self.numberKey(c.number) == Self.numberKey(w) { s += 1.5 }
                else { ok = false; break }
            }
            guard ok else { continue }
            s += min(1.5, log10((c.prices.first?.raw ?? 0) + 1) / 2)
            scored.append((i, s))
        }
        return scored.sorted { $0.1 > $1.1 }.prefix(limit).map { summary(cards[$0.0]) }
    }

    /// Scanner matching: collector number + set size, then name.
    func match(_ f: CardFeatures) -> [ScanCandidate] {
        let names = ([f.name].compactMap { $0 } + f.nameCandidates)
        func nameScore(_ c: CatalogCard) -> Double {
            guard !names.isEmpty else { return 0.5 }
            let best = names.map { max(Similarity.score($0, c.baseName), Similarity.score($0, c.name)) }.max() ?? 0
            return 0.25 + 0.75 * best
        }
        var results: [(Int, Double, String)] = []
        if let n = f.number {
            var ranked = (byNumber[Self.numberKey(n)] ?? []).map { ($0, nameScore(cards[$0]), "Number") }
            if let t = f.total {
                let exact = ranked.filter { Self.numberKey(cards[$0.0].total ?? "") == Self.numberKey(t) }
                if !exact.isEmpty { ranked = exact.map { ($0.0, min(1, $0.1 + 0.1), "Number and set size") } }
            }
            results += ranked
        }
        if results.count < 3, let name = f.name, name.count >= 3 {
            let target = Similarity.normalize(name)
            let first = String(target.prefix(2))
            var byName: [(Int, Double, String)] = []
            for (i, c) in cards.enumerated() where Similarity.normalize(c.baseName).hasPrefix(first) {
                let s = nameScore(c)
                if s >= 0.8 { byName.append((i, s * 0.85, "Name")) }
            }
            // Same name across many sets: prefer the valuable printings.
            byName.sort { $0.1 != $1.1 ? $0.1 > $1.1 : (cards[$0.0].prices.first?.raw ?? 0) > (cards[$1.0].prices.first?.raw ?? 0) }
            results += byName.prefix(20)
        }
        var seen = Set<Int>()
        return results
            .filter { seen.insert($0.0).inserted }
            .sorted { $0.1 > $1.1 }
            .prefix(10)
            .map { i, score, reason in
                ScanCandidate(card: summary(cards[i]), variants: variants(id: cards[i].id), score: score, reason: reason)
            }
    }
}

enum VariantName {
    static let labels = ["normal": "Normal", "holofoil": "Holo", "reverseHolofoil": "Reverse Holo", "1stEditionHolofoil": "1st Edition Holo",
                         "1stEditionNormal": "1st Edition", "unlimitedHolofoil": "Unlimited Holo", "default": ""]
    static func label(_ v: String) -> String { labels[v] ?? v }
}

extension Array {
    subscript(safe i: Int) -> Element? { indices.contains(i) ? self[i] : nil }
}
