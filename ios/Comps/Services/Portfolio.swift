import Foundation
import SwiftData

/// Pricing, server sync and history snapshots for the collection.
@MainActor
enum Portfolio {
    static func activeHoldings(_ context: ModelContext) -> [Holding] {
        let descriptor = FetchDescriptor<Holding>(predicate: #Predicate { $0.isTombstoned == false })
        return (try? context.fetch(descriptor)) ?? []
    }

    /// Refreshes every holding's value. Uses the server (graded prices included)
    /// when connected, otherwise raw prices from the public APIs.
    static func refreshPrices(context: ModelContext) async {
        let holdings = activeHoldings(context)
        guard !holdings.isEmpty else { return }

        if let api = APIClient.current {
            let items = holdings.map { PriceRequestItem(cardId: $0.cardID, variant: $0.variant, grader: $0.grader, grade: $0.grade, condition: $0.condition) }
            if let prices = (try? await api.prices(items)), prices.count == holdings.count {
                for (h, p) in zip(holdings, prices) where p.cardId == h.cardID {
                    if let v = p.value { h.unitValue = v }
                    h.rawPrice = p.raw ?? h.rawPrice
                    h.change7d = p.change7d
                    h.priceBasis = p.basis
                    if h.variant == nil { h.variant = p.variant }
                    h.priceUpdatedAt = .now
                }
                try? context.save()
                snapshot(context: context)
                return
            }
        }

        let requests = holdings.enumerated().map { (index: $0.offset, cardID: $0.element.cardID, variant: $0.element.variant) }
        var results: [Int: (Double?, String?)] = [:]
        for batch in stride(from: 0, to: requests.count, by: 6).map({ Array(requests[$0..<min($0 + 6, requests.count)]) }) {
            await withTaskGroup(of: (Int, Double?, String?).self) { group in
                for r in batch {
                    group.addTask {
                        let p = await DirectProviders.price(cardID: r.cardID, variant: r.variant)
                        return (r.index, p.value, p.variant)
                    }
                }
                for await (i, value, variant) in group { results[i] = (value, variant) }
            }
        }
        for (i, h) in holdings.enumerated() {
            guard let result = results[i], let raw = result.0 else { continue }
            h.rawPrice = raw
            if h.variant == nil { h.variant = result.1 }
            // Keep a graded value the server gave us; raw is all we know offline.
            if !(h.isGraded && h.priceBasis != nil && h.priceBasis != "raw") {
                let factor = CardCondition(rawValue: h.condition)?.factor ?? 1
                h.unitValue = h.isGraded ? raw : raw * factor
                h.priceBasis = "raw"
            }
            h.priceUpdatedAt = .now
        }
        try? context.save()
        snapshot(context: context)
    }

    static func snapshot(context: ModelContext) {
        let holdings = activeHoldings(context)
        let value = holdings.reduce(0) { $0 + ($1.totalValue ?? 0) }
        let cost = holdings.reduce(0) { $0 + ($1.totalCost ?? 0) }
        let today = Fmt.day()
        let descriptor = FetchDescriptor<ValueSnapshot>(predicate: #Predicate { $0.day == today })
        if let existing = try? context.fetch(descriptor).first {
            existing.value = value
            existing.cost = cost
        } else {
            context.insert(ValueSnapshot(day: today, value: value, cost: cost))
        }
        try? context.save()
    }

    // MARK: Sync

    static func toServer(_ h: Holding) -> ServerHolding {
        ServerHolding(id: h.id.uuidString.lowercased(), cardId: h.cardID, game: h.game, name: h.name, setName: h.setName, number: h.number,
                      image: h.imageURL, variant: h.variant, grader: h.grader, grade: h.grade, condition: h.condition, quantity: h.quantity,
                      costBasis: h.costBasis, acquiredAt: h.acquiredAt.map { Fmt.day($0) }, notes: h.notes,
                      createdAt: h.createdAt.millis, updatedAt: h.updatedAt.millis, deleted: h.isTombstoned)
    }

    static func apply(_ s: ServerHolding, to h: Holding) {
        h.cardID = s.cardId
        h.game = s.game ?? h.game
        h.name = s.name ?? h.name
        h.setName = s.setName
        h.number = s.number
        h.imageURL = ImageURL.original(s.image) ?? h.imageURL
        h.variant = s.variant
        h.grader = s.grader
        h.grade = s.grade
        h.condition = s.condition ?? "NM"
        h.quantity = max(1, s.quantity)
        h.costBasis = s.costBasis
        h.acquiredAt = s.acquiredAt.flatMap { Fmt.date(fromDay: $0) }
        h.notes = s.notes
        h.updatedAt = Date(millis: s.updatedAt)
    }

    /// Two-way sync with the server, last write wins per holding.
    @discardableResult
    static func sync(context: ModelContext) async throws -> Int {
        guard let api = APIClient.current else { throw APIError.notConfigured }
        let since = UserDefaults.standard.double(forKey: Pref.lastSync)
        let all = (try? context.fetch(FetchDescriptor<Holding>())) ?? []
        let outgoing = all.filter { $0.updatedAt.millis > since || since == 0 }.map(toServer)
        let res = try await api.sync(outgoing, since: since)

        var byID: [String: Holding] = [:]
        for h in all { byID[h.id.uuidString.lowercased()] = h }
        var removed = Set<String>()
        var changes = 0
        for s in res.items {
            let key = s.id.lowercased()
            if let local = byID[key] {
                if s.deleted {
                    if !removed.contains(key) { context.delete(local); removed.insert(key); changes += 1 }
                } else if s.updatedAt > local.updatedAt.millis + 1 {
                    apply(s, to: local)
                    changes += 1
                }
            } else if !s.deleted, let uuid = UUID(uuidString: s.id) {
                let h = Holding(id: uuid, cardID: s.cardId, game: s.game ?? "other", name: s.name ?? "Card")
                apply(s, to: h)
                h.createdAt = s.createdAt.map { Date(millis: $0) } ?? .now
                context.insert(h)
                changes += 1
            }
        }
        for h in all where h.isTombstoned && !removed.contains(h.id.uuidString.lowercased()) {
            context.delete(h)
        }
        try context.save()
        UserDefaults.standard.set(res.serverTime, forKey: Pref.lastSync)
        return changes
    }

    /// Deletes locally, or leaves a tombstone so the server learns about it.
    static func remove(_ h: Holding, context: ModelContext) {
        if APIClient.current != nil {
            h.isTombstoned = true
            h.touch()
        } else {
            context.delete(h)
        }
        try? context.save()
        snapshot(context: context)
    }

    static func csv(_ holdings: [Holding]) -> URL? {
        func esc(_ v: String?) -> String {
            guard let v else { return "" }
            return v.contains(where: { $0 == "," || $0 == "\"" || $0 == "\n" }) ? "\"\(v.replacingOccurrences(of: "\"", with: "\"\""))\"" : v
        }
        var lines = ["name,set,number,game,variant,grader,grade,condition,quantity,cost_each,value_each,card_id"]
        for h in holdings {
            lines.append([esc(h.name), esc(h.setName), esc(h.number), h.game, esc(h.variant), esc(h.grader), esc(h.grade), h.condition,
                          String(h.quantity), h.costBasis.map { String(format: "%.2f", $0) } ?? "", h.unitValue.map { String(format: "%.2f", $0) } ?? "", esc(h.cardID)].joined(separator: ","))
        }
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("comps-collection-\(Fmt.day()).csv")
        do {
            try lines.joined(separator: "\n").write(to: url, atomically: true, encoding: .utf8)
            return url
        } catch {
            return nil
        }
    }
}
