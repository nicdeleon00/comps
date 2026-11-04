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

    /// Syncs with the website (when set up), then reprices everything.
    static func refreshPrices(context: ModelContext) async {
        await CollectionSync.shared.sync(context, reprice: false)
        await reprice(context: context)
    }

    static func reprice(context: ModelContext) async {
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

    /// One-time fix: early builds defaulted scanned cards to their priciest printing
    /// (usually reverse holo). Cards that still carry that automatic pick and were
    /// never edited move to the regular printing.
    static func migrateDefaultPrintings(context: ModelContext) async {
        let key = "migrated.regularPrinting.v1"
        guard !UserDefaults.standard.bool(forKey: key) else { return }
        await Catalog.shared.ensureLoaded()
        guard await Catalog.shared.isLoaded else { return } // try again next launch
        var changed = false
        for h in activeHoldings(context) {
            guard let current = h.variant, abs(h.updatedAt.timeIntervalSince(h.createdAt)) < 2 else { continue }
            let options = await Catalog.shared.variants(id: h.cardID)
            guard let regular = options.first?.variant, regular != current,
                  let priciest = options.max(by: { ($0.price ?? 0) < ($1.price ?? 0) })?.variant, priciest == current else { continue }
            h.variant = regular
            h.unitValue = nil
            h.touch()
            changed = true
        }
        if changed { try? context.save() }
        UserDefaults.standard.set(true, forKey: key)
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
        if CollectionSync.shared.isConnected {
            // Kept as a deletion so it also disappears from the website.
            h.isTombstoned = true
            h.touch()
        } else {
            context.delete(h)
        }
        try? context.save()
        snapshot(context: context)
        CollectionSync.shared.syncSoon(context)
    }
}
