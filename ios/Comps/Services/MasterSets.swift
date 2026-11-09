import Foundation

// Master sets: every card in a set in every printing it comes in (normal,
// reverse holo, Poké Ball / Master Ball / Energy Symbol patterns, …), what you
// have, and what's left. The same rules as the website's Master Sets page.
//
// TCGplayer lists pattern printings as their own products named with a tag:
// "Eevee (Poke Ball Pattern)" #074 sits next to "Eevee" #074. Products with the
// same number and the same name (tags removed) are one card.

/// One printing of a card: normal, reverse holo, a Poké Ball pattern…
struct MSPrinting: Identifiable, Hashable, Sendable {
    let cardID: String
    let variant: String
    /// The product's full name ("Eevee (Poke Ball Pattern)"), as it's saved in the collection.
    let productName: String
    let image: String
    let label: String
    let short: String
    let price: Double?
    /// The product's regular printing: copies saved without a printing count as this one.
    let isRegular: Bool
    var id: String { "\(cardID)|\(variant)" }
}

/// One card number in a set, with all its printings.
struct MSSlot: Identifiable, Hashable, Sendable {
    let key: String
    let number: String
    let name: String
    let rarity: String?
    let cardID: String
    let image: URL?
    let imageLarge: URL?
    let printings: [MSPrinting]
    var id: String { key }
}

struct MSSetInfo: Identifiable, Hashable, Sendable {
    let id: String
    let name: String
    let code: String?
    let series: String
    let released: String?
    let art: URL?
    let slots: [MSSlot]
    var printingCount: Int { slots.reduce(0) { $0 + $1.printings.count } }

    static func == (a: MSSetInfo, b: MSSetInfo) -> Bool { a.id == b.id }
    func hash(into h: inout Hasher) { h.combine(id) }
}

enum MSMode: String, CaseIterable, Identifiable {
    case master = "Master set"
    case base = "One of each"
    var id: String { rawValue }
}

struct MSProgress {
    var total = 0
    var owned = 0
    /// What you have, at raw market prices (one of each).
    var value = 0.0
    /// Buying everything still missing, at raw market prices.
    var toComplete = 0.0
    /// The whole set at raw market prices.
    var full = 0.0
    /// Missing printings with no price yet (left out of the cost).
    var unpriced = 0
    var fraction: Double { total > 0 ? Double(owned) / Double(total) : 0 }
    var isComplete: Bool { total > 0 && owned >= total }
    var percentText: String {
        let f = fraction
        return f > 0 && f < 0.01 ? "<1%" : "\(Int((f * 100).rounded(.down)))%"
    }
}

enum MasterSet {
    static let variantLabels: [String: (String, String)] = [
        "normal": ("Normal", "N"), "holofoil": ("Holo", "H"), "reverseHolofoil": ("Reverse Holo", "RH"),
        "unlimitedHolofoil": ("Unlimited Holo", "UH"), "unlimited": ("Unlimited", "U"),
        "1stEditionNormal": ("1st Edition", "1st"), "1stEditionHolofoil": ("1st Edition Holo", "1st H"),
    ]
    static let variantRank: [String: Int] = ["normal": 0, "holofoil": 1, "unlimitedHolofoil": 2, "unlimited": 3, "reverseHolofoil": 4, "1stEditionNormal": 5, "1stEditionHolofoil": 6]
    /// Pattern printings in the order collectors list them.
    static let patternRank = ["poké ball", "master ball", "energy symbol", "friend ball", "love ball", "quick ball", "dusk ball"]

    private static let trailingTag = try! NSRegularExpression(pattern: #"\s*[\(\[]([^\(\)\[\]]*)[\)\]]\s*$"#)

    /// "Eevee (Poke Ball Pattern)" → ("Eevee", ["Poké Ball"])
    static func split(_ name: String) -> (base: String, tags: [String]) {
        var base = name.trimmingCharacters(in: .whitespaces)
        var tags: [String] = []
        while true {
            let ns = base as NSString
            guard let m = trailingTag.firstMatch(in: base, range: NSRange(location: 0, length: ns.length)), m.range.location > 0 else { break }
            var tag = ns.substring(with: m.range(at: 1))
            tag = tag.replacingOccurrences(of: #"\s+Pattern$"#, with: "", options: [.regularExpression, .caseInsensitive])
            tag = tag.replacingOccurrences(of: #"\bPoke\b"#, with: "Poké", options: .regularExpression)
            tags.insert(tag.trimmingCharacters(in: .whitespaces), at: 0)
            base = ns.substring(to: m.range.location).trimmingCharacters(in: .whitespaces)
        }
        return (base, tags.filter { !$0.isEmpty })
    }

    static func label(tags: [String], variant: String, single: Bool) -> (String, String) {
        let (vl, vs) = variantLabels[variant] ?? (variant, String(variant.prefix(2)).uppercased())
        guard let first = tags.first else { return (vl, vs) }
        let tag = tags.joined(separator: " · ")
        let initials = first.split(separator: " ").compactMap(\.first).map { String($0) }.joined().uppercased()
        return single ? (tag, initials) : ("\(tag) \(vl)", "\(initials) \(vs)")
    }

    static func rank(tags: [String], variant: String) -> Int {
        guard let first = tags.first else { return variantRank[variant] ?? 9 }
        return 10 + (patternRank.firstIndex(of: first.lowercased()) ?? patternRank.count)
    }

    /// Card number order: 1, 2, … 10, then lettered runs like TG01 or GG01.
    static func numberLess(_ a: String, _ b: String) -> Bool {
        func parts(_ s: String) -> (String, Int, String) {
            let letters = String(s.prefix { $0.isLetter })
            let rest = s.dropFirst(letters.count)
            let digits = String(rest.prefix { $0.isNumber })
            return (letters.uppercased(), Int(digits) ?? 0, String(rest.dropFirst(digits.count)))
        }
        let pa = parts(a), pb = parts(b)
        if pa.0 != pb.0 { return pa.0 < pb.0 }
        if pa.1 != pb.1 { return pa.1 < pb.1 }
        if pa.2 != pb.2 { return pa.2 < pb.2 }
        return a < b
    }

    /// Copies of each printing you have, keyed "cardID|variant" ("cardID|" when no printing was picked).
    static func ownedMap(_ holdings: [Holding]) -> [String: Int] {
        var m: [String: Int] = [:]
        for h in holdings where !h.isTombstoned {
            guard !h.isChinese else { continue }
            m["\(h.cardID)|\(h.variant ?? "")", default: 0] += max(1, h.quantity)
        }
        return m
    }

    static func have(_ p: MSPrinting, _ owned: [String: Int]) -> Int {
        (owned[p.id] ?? 0) + (p.isRegular ? owned["\(p.cardID)|"] ?? 0 : 0)
    }

    static func isDone(_ s: MSSlot, _ owned: [String: Int], _ mode: MSMode) -> Bool {
        mode == .master ? s.printings.allSatisfy { have($0, owned) > 0 } : s.printings.contains { have($0, owned) > 0 }
    }

    /// What's left to buy for one card.
    static func missingCost(_ s: MSSlot, _ owned: [String: Int], _ mode: MSMode) -> Double {
        let missing = s.printings.filter { have($0, owned) == 0 }.compactMap(\.price)
        guard !missing.isEmpty else { return 0 }
        if mode == .base { return s.printings.contains { have($0, owned) > 0 } ? 0 : missing.min() ?? 0 }
        return missing.reduce(0, +)
    }

    /// How far along a set is. "Master set" counts every printing; "one of each" needs any printing of each card.
    static func progress(_ slots: [MSSlot], _ owned: [String: Int], _ mode: MSMode) -> MSProgress {
        var p = MSProgress()
        for s in slots {
            switch mode {
            case .master:
                for x in s.printings {
                    p.total += 1
                    p.full += x.price ?? 0
                    if have(x, owned) > 0 { p.owned += 1; p.value += x.price ?? 0 }
                    else if let price = x.price { p.toComplete += price }
                    else { p.unpriced += 1 }
                }
            case .base:
                p.total += 1
                let cheapest = s.printings.compactMap(\.price).min()
                p.full += cheapest ?? 0
                let mine = s.printings.filter { have($0, owned) > 0 }
                if !mine.isEmpty { p.owned += 1; p.value += mine.map { $0.price ?? 0 }.max() ?? 0 }
                else if let cheapest { p.toComplete += cheapest }
                else { p.unpriced += 1 }
            }
        }
        return p
    }
}

extension Catalog {
    /// Every set as master-set slots, newest series first. Built once per catalog download.
    func masterSets() -> [MSSetInfo] {
        if let masterSetCache { return masterSetCache }
        struct Part { let tags: [String]; let variant: String; let p: MSPrinting }
        final class Builder {
            var number = ""
            var name = ""
            var rarity: String?
            var productId = 0
            var faceTagged = true
            var parts: [Part] = []
        }
        var bySet: [String: [String: Builder]] = [:]
        var order: [String: [String]] = [:]
        var art: [String: (Double, Int)] = [:]
        for c in cards where !c.number.isEmpty && !c.prices.isEmpty && !c.japanese {
            let (base, tags) = MasterSet.split(c.name)
            let key = "\(Self.numberKey(c.number))|\(Similarity.normalize(base))"
            let b: Builder
            if let existing = bySet[c.setId]?[key] {
                b = existing
            } else {
                b = Builder()
                b.number = c.number
                b.name = base
                b.rarity = c.rarity
                b.productId = c.productId
                b.faceTagged = !tags.isEmpty
                bySet[c.setId, default: [:]][key] = b
                order[c.setId, default: []].append(key)
            }
            // The untagged product is the face of the card.
            if tags.isEmpty && b.faceTagged {
                b.productId = c.productId
                b.rarity = c.rarity
                b.faceTagged = false
            }
            let image = "\(imageBase)\(c.productId)_200w.jpg"
            for (i, v) in c.prices.enumerated() {
                let (label, short) = MasterSet.label(tags: tags, variant: v.variant, single: c.prices.count == 1)
                b.parts.append(Part(tags: tags, variant: v.variant, p: MSPrinting(
                    cardID: c.id, variant: v.variant, productName: c.name, image: image, label: label, short: short, price: v.raw, isRegular: i == 0)))
            }
            let top = c.prices.compactMap(\.raw).max() ?? 0
            if top > (art[c.setId]?.0 ?? -1) { art[c.setId] = (top, c.productId) }
        }
        var out: [MSSetInfo] = []
        for (setId, builders) in bySet {
            guard let info = sets[setId] else { continue }
            let slots = (order[setId] ?? []).compactMap { key -> MSSlot? in
                guard let b = builders[key] else { return nil }
                let printings = b.parts.sorted {
                    let ra = MasterSet.rank(tags: $0.tags, variant: $0.variant), rb = MasterSet.rank(tags: $1.tags, variant: $1.variant)
                    return ra != rb ? ra < rb : $0.p.label < $1.p.label
                }.map(\.p)
                return MSSlot(key: key, number: b.number, name: b.name, rarity: b.rarity, cardID: "tcg:\(b.productId)",
                              image: URL(string: "\(imageBase)\(b.productId)_200w.jpg"), imageLarge: URL(string: "\(imageBase)\(b.productId)_400w.jpg"),
                              printings: printings)
            }
            .sorted { $0.number != $1.number ? MasterSet.numberLess($0.number, $1.number) : $0.name < $1.name }
            out.append(MSSetInfo(id: setId, name: info.name, code: info.code, series: info.series, released: info.released,
                                 art: art[setId].flatMap { URL(string: "\(imageBase)\($0.1)_200w.jpg") }, slots: slots))
        }
        // Series ordered by their newest set; sets newest first within a series.
        var newest: [String: String] = [:]
        for s in out { newest[s.series] = max(newest[s.series] ?? "", s.released ?? "") }
        out.sort {
            let na = newest[$0.series] ?? "", nb = newest[$1.series] ?? ""
            if $0.series != $1.series { return na != nb ? na > nb : $0.series < $1.series }
            return ($0.released ?? "") != ($1.released ?? "") ? ($0.released ?? "") > ($1.released ?? "") : $0.name < $1.name
        }
        masterSetCache = out
        return out
    }
}
