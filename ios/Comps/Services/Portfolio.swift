import Foundation
import SwiftData

/// Pricing and history snapshots for the collection. Prices come from the
/// on-phone catalog, so this is instant and works offline.
@MainActor
enum Portfolio {
    static func activeHoldings(_ context: ModelContext) -> [Holding] {
        let descriptor = FetchDescriptor<Holding>(predicate: #Predicate { $0.isTombstoned == false })
        return (try? context.fetch(descriptor)) ?? []
    }

    static func refreshPrices(context: ModelContext) async {
        await Catalog.shared.ensureLoaded()
        let holdings = activeHoldings(context)
        guard !holdings.isEmpty else { return }
        let queries = holdings.map { Catalog.PriceQuery(id: $0.cardID, variant: $0.variant, grader: $0.grader, grade: $0.grade, condition: $0.condition) }
        let answers = await Catalog.shared.prices(queries)
        for (h, a) in zip(holdings, answers) {
            guard let a else { continue }
            if let v = a.value { h.unitValue = v }
            h.rawPrice = a.raw ?? h.rawPrice
            h.change7d = a.change7d
            h.priceBasis = a.basis
            if h.variant == nil { h.variant = a.variant }
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

    static func remove(_ h: Holding, context: ModelContext) {
        context.delete(h)
        try? context.save()
        snapshot(context: context)
    }

    /// CSV the website can import (Collection → Import CSV).
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
