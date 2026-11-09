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
    /// Normalized base name, for fast fuzzy matching.
    let key: String
    /// Words in brackets that mark a special printing ("poke ball pattern", "cosmos holo").
    let variantTag: String?
    let setId: String
    let number: String
    let total: String?
    let rarity: String?
    let prices: [CatalogPrice]
    /// From the Japanese catalog (index-ja.json).
    var japanese = false
    var id: String { "tcg:\(productId)" }
}

struct CatalogSet {
    let name: String
    let code: String?
    let series: String
    let released: String?
    /// Reprint products (Prize Pack, Jumbo, World Championship decks…) that share
    /// numbers with the original set. The scanner prefers the original.
    let alt: Bool
    /// A Japanese set (its name ends "(Japanese)").
    var japanese = false
}

struct SetOption: Identifiable, Hashable {
    let id: String
    let name: String
    let series: String
    let released: String?
    let count: Int
}

/// Every English Pokémon card with today's prices, plus Japanese cards, downloaded from the
/// price site and cached on the phone. Scanning, search and collection values all
/// run against it locally, so they're instant and work offline.
actor Catalog {
    static let shared = Catalog()

    private(set) var cards: [CatalogCard] = []
    private(set) var sets: [String: CatalogSet] = [:]
    private(set) var updatedAt: Date?
    private var byId: [String: Int] = [:]
    private var byNumber: [String: [Int]] = [:]
    private var byKey: [String: [Int]] = [:]
    private(set) var imageBase = "https://tcgplayer-cdn.tcgplayer.com/product/"
    /// Master sets built from the current catalog (see MasterSets.swift).
    var masterSetCache: [MSSetInfo]?
    private var loading: Task<Void, Never>?

    private var cacheFile: URL {
        let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("catalog-index.json")
    }
    private var japaneseCacheFile: URL { cacheFile.deletingLastPathComponent().appendingPathComponent("catalog-index-ja.json") }
    /// The Japanese catalog, kept so it's added back whenever the English one is reloaded.
    private var japaneseData: Data?

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
        if cards.isEmpty, let data = try? Data(contentsOf: cacheFile) {
            japaneseData = try? Data(contentsOf: japaneseCacheFile)
            try? parse(data)
        }
        let stale = updatedAt.map { Date().timeIntervalSince($0) > 6 * 3600 } ?? true
        guard force || stale || cards.isEmpty else { return }
        do {
            let data = try await HostedData.current.data("data/index.json", fresh: true)
            // Japanese cards are extra: without the file (or offline) the last copy is kept.
            if let ja = try? await HostedData.current.data("data/index-ja.json", fresh: true) {
                japaneseData = ja
                try? ja.write(to: japaneseCacheFile, options: .atomic)
            }
            try parse(data)
            try? data.write(to: cacheFile, options: .atomic)
        } catch {
            // Keep the cached catalog; it's still useful offline.
        }
    }

    /// The regular printing comes first: it's what a scanned or added card defaults to.
    /// Reverse holo is only used when picked, and 1st Edition always sorts last (after any
    /// printing not listed here), so it's never the default while another printing exists.
    static let printingRank = ["normal": 0, "holofoil": 1, "unlimitedHolofoil": 2, "reverseHolofoil": 3, "1stEditionNormal": 50, "1stEditionHolofoil": 51]

    static func regularFirst(_ a: CatalogPrice, _ b: CatalogPrice) -> Bool {
        let ra = rank(a.variant), rb = rank(b.variant)
        return ra != rb ? ra < rb : (a.raw ?? 0) > (b.raw ?? 0)
    }

    private static func rank(_ v: String) -> Int { printingRank[v] ?? (isFirstEdition(v) ? 52 : 9) }

    static func isFirstEdition(_ v: String) -> Bool { v.lowercased().hasPrefix("1stedition") }

    /// The printing a scanned or added card starts on: the regular one. 1st Edition only when
    /// it's the card's only printing; otherwise it has to be picked by hand.
    static func defaultPrinting(_ variants: [VariantPrice], card: String?) -> String? {
        if let regular = variants.first(where: { !isFirstEdition($0.variant) }) { return regular.variant }
        if let card, !isFirstEdition(card) { return card }
        return variants.first?.variant ?? card
    }

    static func defaultPrinting(_ c: ScanCandidate) -> String? { defaultPrinting(c.variants, card: c.card.variant) }

    static func numberKey(_ n: String) -> String {
        let up = n.uppercased().trimmingCharacters(in: .whitespaces)
        let letters = up.prefix { $0.isLetter }
        var digits = up.dropFirst(letters.count)
        while digits.count > 1, digits.first == "0", digits.dropFirst().first?.isNumber == true { digits = digits.dropFirst() }
        return String(letters) + String(digits)
    }

    /// "Pikachu - 025/165 (Pokemon Together)" → "Pikachu"
    static func baseName(_ name: String) -> String {
        var s = name.replacingOccurrences(of: #"\s*[\(\[][^\)\]]*[\)\]]"#, with: " ", options: .regularExpression)
        if let r = s.range(of: #"\s+-\s+.*$"#, options: .regularExpression) { s.removeSubrange(r) }
        return s.split(separator: " ").joined(separator: " ")
    }

    private static let bracketed = try! NSRegularExpression(pattern: #"[\(\[]([^\)\]]*)[\)\]]"#)

    /// Bracketed words that mark a special printing; plain numbers ("Raichu (25)") don't count.
    static func variantTag(_ name: String) -> String? {
        let ns = name as NSString
        let tags = bracketed.matches(in: name, range: NSRange(location: 0, length: ns.length))
            .map { ns.substring(with: $0.range(at: 1)) }
            .filter { $0.rangeOfCharacter(from: .letters) != nil && $0.count > 1 }
        return tags.isEmpty ? nil : Similarity.normalize(tags.joined(separator: " "))
    }

    private func parse(_ data: Data) throws {
        guard let root = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let rows = root["cards"] as? [[Any]] else { return }
        if let base = root["imageBase"] as? String { imageBase = base }
        var newSets: [String: CatalogSet] = [:]
        var list: [CatalogCard] = []
        Self.decode(root, rows: rows, japanese: false, sets: &newSets, cards: &list)
        if let japaneseData, let ja = try? JSONSerialization.jsonObject(with: japaneseData) as? [String: Any], let jaRows = ja["cards"] as? [[Any]] {
            Self.decode(ja, rows: jaRows, japanese: true, sets: &newSets, cards: &list)
        }
        guard !list.isEmpty else { return }
        cards = list
        masterSetCache = nil
        sets = newSets
        byId = [:]
        byNumber = [:]
        byKey = [:]
        for (i, c) in list.enumerated() {
            byId[c.id] = i
            byNumber[Self.numberKey(c.number), default: []].append(i)
            byKey[c.key, default: []].append(i)
        }
        let ms = (root["updatedAt"] as? NSNumber)?.doubleValue
        updatedAt = ms.map { Date(millis: $0) } ?? Date()
    }

    /// One catalog file's sets and cards. Japanese sets are named "… (Japanese)".
    private static func decode(_ root: [String: Any], rows: [[Any]], japanese: Bool, sets newSets: inout [String: CatalogSet], cards list: inout [CatalogCard]) {
        for (gid, value) in root["sets"] as? [String: [Any]] ?? [:] {
            let name = value[safe: 0] as? String ?? ""
            newSets[gid] = CatalogSet(name: japanese ? "\(name) (Japanese)" : name, code: value[safe: 1] as? String,
                                      series: value[safe: 2] as? String ?? "", released: value[safe: 3] as? String,
                                      alt: (value[safe: 4] as? NSNumber)?.boolValue ?? false, japanese: japanese)
        }
        list.reserveCapacity(list.count + rows.count)
        for r in rows {
            guard let pid = (r[safe: 0] as? NSNumber)?.intValue, let name = r[safe: 1] as? String else { continue }
            let prices = (r[safe: 6] as? [[Any]] ?? []).compactMap { p -> CatalogPrice? in
                guard let v = p[safe: 0] as? String else { return nil }
                func num(_ i: Int) -> Double? { (p[safe: i] as? NSNumber)?.doubleValue }
                return CatalogPrice(variant: v, raw: num(1), g9: num(2), psa10: num(3), change7d: num(4))
            }
            .sorted(by: Self.regularFirst)
            let base = Self.baseName(name)
            list.append(CatalogCard(productId: pid, name: name, baseName: base, key: Similarity.normalize(base), variantTag: Self.variantTag(name),
                                    setId: r[safe: 2] as? String ?? "", number: r[safe: 3] as? String ?? "", total: r[safe: 4] as? String,
                                    rarity: r[safe: 5] as? String, prices: prices, japanese: japanese))
        }
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
        searchIndices(q, setId: nil, limit: limit).map { summary(cards[$0]) }
    }

    /// Scan review lookups: search (optionally inside one set), or with only a set,
    /// every card in it in collector-number order.
    func lookup(_ q: String, setId: String?, limit: Int) -> [ScanCandidate] {
        let trimmed = q.trimmingCharacters(in: .whitespaces)
        let found: [Int]
        if trimmed.isEmpty, let setId {
            found = cards.indices.filter { cards[$0].setId == setId }.sorted { numberOrder(cards[$0], cards[$1]) }
        } else {
            found = searchIndices(trimmed, setId: setId, limit: limit)
        }
        return found.prefix(limit).map { i in
            ScanCandidate(card: summary(cards[i]), variants: variants(id: cards[i].id), score: 0.5, reason: "Search")
        }
    }

    private func numberOrder(_ a: CatalogCard, _ b: CatalogCard) -> Bool {
        let ka = Self.numberKey(a.number), kb = Self.numberKey(b.number)
        let pa = String(ka.prefix { $0.isLetter }), pb = String(kb.prefix { $0.isLetter })
        if pa != pb { return pa < pb }
        let na = Int(ka.dropFirst(pa.count).prefix { $0.isNumber }) ?? 0
        let nb = Int(kb.dropFirst(pb.count).prefix { $0.isNumber }) ?? 0
        if na != nb { return na < nb }
        return a.name < b.name
    }

    private func searchIndices(_ q: String, setId: String?, limit: Int) -> [Int] {
        let numberPattern = #"([A-Za-z]*\d+[a-z]?)\s*/\s*([A-Za-z]*\d+)"#
        var number: String?
        var total: String?
        var text = q
        if let r = q.range(of: numberPattern, options: .regularExpression) {
            let parts = String(q[r]).components(separatedBy: "/")
            number = parts.first.map { Self.numberKey($0) }
            total = parts.count > 1 ? Self.numberKey(parts[1].trimmingCharacters(in: .whitespaces)) : nil
            text.removeSubrange(r)
        }
        var words = Similarity.normalize(text).split(separator: " ").map(String.init)
        let onlyJapanese = words.contains { $0 == "jp" || $0 == "japanese" || $0 == "jpn" }
        words.removeAll { $0 == "jp" || $0 == "japanese" || $0 == "jpn" }
        guard !words.isEmpty || number != nil || onlyJapanese else { return [] }
        var candidates: [Int] = number.map { byNumber[$0] ?? [] } ?? Array(cards.indices)
        if let setId { candidates = candidates.filter { cards[$0].setId == setId } }
        if onlyJapanese { candidates = candidates.filter { cards[$0].japanese } }
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
            // "001/165": the set size picks the set, so those cards come first.
            if let total, let ct = c.total, Self.numberKey(ct) == total { s += 3 }
            s += min(1.5, log10((c.prices.first?.raw ?? 0) + 1) / 2)
            if c.japanese && !onlyJapanese && setId == nil { s -= 2.5 }
            scored.append((i, s))
        }
        return scored.sorted { $0.1 > $1.1 }.prefix(limit).map(\.0)
    }

    /// Sets that have priced cards, newest first (for the scanner's set lock).
    func setOptions() -> [SetOption] {
        var counts: [String: Int] = [:]
        for c in cards { counts[c.setId, default: 0] += 1 }
        return sets.compactMap { id, s in
            guard let n = counts[id], n > 0 else { return nil }
            return SetOption(id: id, name: s.name, series: s.series, released: s.released, count: n)
        }
        .sorted { ($0.released ?? "") != ($1.released ?? "") ? ($0.released ?? "") > ($1.released ?? "") : $0.name < $1.name }
    }

    /// Scanner matching. Every candidate is scored on the evidence printed on the
    /// card — name, collector number, set size, set code — then nudged by what
    /// we know about printings (reprint products and pattern variants share the
    /// original's number) and by the session (set lock, recent sets, past corrections).
    func match(_ f: CardFeatures, context: MatchContext = MatchContext()) -> [ScanCandidate] {
        let names = Array(([f.name].compactMap { $0 } + f.nameCandidates).map(Similarity.normalize).filter { $0.count >= 3 }.prefix(5))
        var nameCache: [String: Double] = [:]
        func nameSim(_ c: CatalogCard) -> Double {
            if let s = nameCache[c.key] { return s }
            let s = names.map { Similarity.normalizedScore($0, c.key) }.max() ?? 0
            nameCache[c.key] = s
            return s
        }

        // Candidate pool: every card with a plausible number, plus every card with a plausible name.
        var numberEvidence: [Int: Double] = [:]
        for r in f.numbers.prefix(8) {
            for i in byNumber[Self.numberKey(r.number)] ?? [] {
                let c = cards[i]
                let total: Double
                if let t = r.total {
                    if let ct = c.total { total = Self.numberKey(ct) == Self.numberKey(t) ? 1 : 0 } else { total = 0.3 }
                } else {
                    total = c.total == nil ? 0.8 : 0.5
                }
                let e = r.weight * 0.35 + total * 0.15
                numberEvidence[i] = max(numberEvidence[i] ?? 0, e)
            }
        }
        var pool = Set(numberEvidence.keys)
        if !names.isEmpty {
            // Only fall back to name search when the number didn't produce a convincing name match.
            let bestNumbered = pool.map { nameSim(cards[$0]) }.max() ?? 0
            if bestNumbered < 0.85 || pool.count < 2 {
                var nameHits: [(Int, Double)] = []
                for (key, idx) in byKey {
                    let s = names.map { Similarity.normalizedScore($0, key) }.max() ?? 0
                    guard s >= 0.72 else { continue }
                    nameCache[key] = s
                    for i in idx { nameHits.append((i, s)) }
                }
                // Same name in dozens of sets (Pikachu): keep the best name matches, originals first, newest first.
                nameHits.sort { a, b in
                    if a.1 != b.1 { return a.1 > b.1 }
                    let sa = sets[cards[a.0].setId], sb = sets[cards[b.0].setId]
                    if (sa?.alt ?? false) != (sb?.alt ?? false) { return !(sa?.alt ?? false) }
                    return (sa?.released ?? "") > (sb?.released ?? "")
                }
                for (i, _) in nameHits.prefix(context.lockedSet == nil ? 60 : 400) { pool.insert(i) }
            }
        }

        // Japanese text on the card means a Japanese card; otherwise English (when the catalog has any of that kind).
        // A name that reads clearly as an English card keeps it English (a few misread characters don't count).
        // Chinese cards follow the Japanese sets' numbering, so they're matched to Japanese cards first.
        var japanese = f.japanese || f.chinese
        if japanese, pool.contains(where: { !cards[$0].japanese && nameSim(cards[$0]) >= 0.85 }) { japanese = false }
        let sameLanguage = pool.filter { cards[$0].japanese == japanese }
        if !sameLanguage.isEmpty { pool = sameLanguage }

        let recentTotal = context.recentSets.values.reduce(0, +)
        var scored: [(Int, Double, String)] = []
        for i in pool {
            let c = cards[i]
            let set = sets[c.setId]
            let sim = names.isEmpty ? 0.5 : nameSim(c)
            var s = 0.40 * sim * sim
            let numbered = numberEvidence[i]
            if let numbered {
                s += numbered
            } else {
                // A digit off ("126" for "125") still counts for something; the art check settles it.
                let cn = Self.numberKey(c.number)
                if let near = f.numbers.prefix(3).first(where: { r in
                    let rn = Self.numberKey(r.number)
                    return rn.count == cn.count && Similarity.levenshtein(Array(rn), Array(cn)) == 1
                }) {
                    s += 0.2 * near.weight
                }
                if let t = f.total, let ct = c.total, Self.numberKey(ct) == Self.numberKey(t) {
                    s += 0.15 * 0.8   // misread number, right set size
                }
            }
            if let code = f.setCode {
                if let sc = set?.code?.uppercased(), sc == code { s += 0.10 }
            } else {
                s += 0.05
            }
            if set?.alt == true { s -= 0.12 }
            if let tag = c.variantTag {
                // Pattern/stamp variants share the plain card's number: prefer the plain card
                // unless the stamp's words were actually read off the card.
                let words = tag.split(separator: " ").filter { $0.count >= 4 }
                s += !words.isEmpty && words.allSatisfy({ f.text.contains($0) }) ? 0.03 : -0.10
            }
            if let locked = context.lockedSet { s += c.setId == locked ? 0.15 : -0.05 }
            if recentTotal > 0, let name = set?.name, let n = context.recentSets[name] {
                s += min(0.06, 0.02 * Double(n))
            }
            if context.learned == c.id { s += 0.25 }

            var why: [String] = []
            if numbered != nil { why.append(f.total != nil ? "Number and set size" : "Number") }
            if sim >= 0.8 && !names.isEmpty { why.append("name") }
            if f.setCode != nil, set?.code?.uppercased() == f.setCode { why.append("set code") }
            if context.learned == c.id { why.append("your earlier pick") }
            scored.append((i, s, why.isEmpty ? "Name" : why.joined(separator: ", ").capitalizedFirst))
        }

        scored.sort { a, b in
            if abs(a.1 - b.1) > 0.0001 { return a.1 > b.1 }
            return (sets[cards[a.0].setId]?.released ?? "") > (sets[cards[b.0].setId]?.released ?? "")
        }
        return scored.prefix(12).map { i, score, reason in
            ScanCandidate(card: summary(cards[i]), variants: variants(id: cards[i].id), score: max(0, min(1, score)), reason: reason)
        }
    }
}

extension String {
    var capitalizedFirst: String { self.prefix(1).uppercased() + String(self.dropFirst()) }
}

enum VariantName {
    static let labels = ["normal": "Normal", "holofoil": "Holo", "reverseHolofoil": "Reverse Holo", "1stEditionHolofoil": "1st Edition Holo",
                         "1stEditionNormal": "1st Edition", "unlimitedHolofoil": "Unlimited Holo", "default": ""]
    static func label(_ v: String) -> String { labels[v] ?? v }
}

extension Array {
    subscript(safe i: Int) -> Element? { indices.contains(i) ? self[i] : nil }
}
