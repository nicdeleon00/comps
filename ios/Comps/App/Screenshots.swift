import Foundation
import SwiftData
import UIKit

/// Screenshot mode, used only by the screenshot workflow: the simulator launches the
/// app with `-screenshots`. It runs on a throwaway in-memory store filled with sample
/// cards, so it never reads or changes a real collection. Normal launches can't turn it on.
enum Screenshots {
    static let on = ProcessInfo.processInfo.arguments.contains("-screenshots")

    /// The value after a launch flag ("-tab deals" → "deals").
    static func value(_ flag: String) -> String? {
        let args = ProcessInfo.processInfo.arguments
        guard on, let i = args.firstIndex(of: flag), i + 1 < args.count else { return nil }
        return args[i + 1]
    }

    static func flag(_ name: String) -> Bool { on && ProcessInfo.processInfo.arguments.contains(name) }

    /// A scanned card with two copies, as the check-before-adding screen shows it ("-review <search>").
    @MainActor
    static func sampleScan() async -> ScanItem? {
        let found = await Catalog.shared.lookup(value("-review") ?? "Bulbasaur 001/165", setId: nil, limit: 6)
        guard let first = found.first else { return nil }
        let item = ScanItem(photo: UIImage(), condition: "NM")
        item.candidates = found
        item.selected = 0
        item.variant = Catalog.defaultPrinting(first)
        item.status = .matched
        item.quantity = 2
        return item
    }

    /// A sample of the Stock screen: three stores, one product low, one just sold out.
    static func sampleStock() -> StockDoc {
        let now = Date().timeIntervalSince1970 * 1000
        let hour = 3_600_000.0
        func store(_ n: String, _ name: String, _ city: String, _ miles: Double) -> StockDoc.Store {
            .init(id: "bestbuy:\(n)", chain: "bestbuy", number: n, name: name, address: nil, city: city, state: "TX", zip: nil, distance: miles, url: nil)
        }
        func product(_ sku: String, _ name: String, _ price: Double) -> StockDoc.Product {
            .init(id: "bestbuy:\(sku)", chain: "bestbuy", name: name, price: price, image: nil, url: nil)
        }
        func entry(_ s: String, _ p: String, isIn: Bool = true, low: Bool = false, since: Double, log: [[Double]]) -> StockDoc.Entry {
            .init(s: "bestbuy:\(s)", p: "bestbuy:\(p)", isIn: isIn, low: low, qty: nil, since: now - since * hour, log: log.map { [now - $0[0] * hour, $0[1]] })
        }
        return StockDoc(
            updatedAt: now - 11 * 60_000, radius: 50,
            chains: ["bestbuy": .init(name: "Best Buy", checkedAt: now - 11 * 60_000, ok: true, error: nil, exact: false)],
            stores: [store("176", "Main Street", "Springfield", 5.2), store("665", "Oak Avenue", "Oak Avenue", 5.3), store("202", "Lakeside", "Shelbyville", 13.8), store("1067", "Alliance", "Springfield", 24.1)],
            products: [product("1", "Mega Evolution - Delta Reign Booster Bundle", 26.94), product("2", "30th Celebration Mini Tin", 9.99),
                       product("3", "Mega Evolution - Pitch Black Elite Trainer Box", 54.99), product("4", "30th Celebration Booster Bundle", 29.99)],
            stock: [entry("176", "1", low: true, since: 25, log: [[72, 1], [47, 0], [25, 1]]), entry("176", "2", isIn: false, since: 2, log: [[28, 1], [2, 0]]),
                    entry("665", "1", since: 11, log: [[11, 1]]), entry("665", "3", since: 1, log: [[1, 1]]), entry("1067", "4", since: 6, log: [[6, 1]])])
    }

    /// Sample cards (and a value history for the chart) for the pictures.
    @MainActor
    static func seed(_ context: ModelContext) async {
        UserDefaults.standard.set(flag("-grid") ? "grid" : "list", forKey: "collection.layout")
        await Catalog.shared.ensureLoaded()
        let picks: [(String, Int, String?, String?)] = [
            ("Charizard ex 199/165", 1, nil, nil), ("Umbreon VMAX 215/203", 1, "PSA", "10"), ("Umbreon ex 161/131", 1, nil, nil),
            ("Pikachu 025/165", 3, nil, nil), ("Eevee 074/131", 2, nil, nil), ("Mew ex 232/091", 1, nil, nil),
            ("Giratina V 186/196", 1, "PSA", "9"), ("Lugia V 186/195", 1, nil, nil), ("Gengar VMAX 271/264", 1, nil, nil),
            ("Rayquaza VMAX 218/203", 1, nil, nil), ("Snorlax 143/165", 2, nil, nil), ("Bulbasaur 001/165", 4, nil, nil),
            ("Charmander 004/165", 2, nil, nil), ("Squirtle 007/165", 3, nil, nil), ("Espeon VMAX 270/264", 1, nil, nil),
            ("Dragonite V 192/203", 1, nil, nil), ("Sylveon ex 156/131", 1, nil, nil), ("Leafeon 005/131", 1, nil, nil),
        ]
        // Spread over a few adds for History: a scan this afternoon, one yesterday, two by hand.
        let adds: [TimeInterval] = [-2.2 * 3600, -26 * 3600, -26 * 3600 - 1800, -75 * 3600]
        for (i, (query, quantity, grader, grade)) in picks.enumerated() {
            guard let c = await Catalog.shared.search(query, limit: 1).first else { continue }
            let h = Holding(cardID: c.id, game: c.game, name: c.name, setName: c.setName, number: c.number, imageURL: c.image,
                            variant: c.variant, grader: grader, grade: grade, quantity: quantity, costBasis: c.price.map { ($0 * 0.8).rounded() })
            let add = i < 10 ? adds[0] : i < 16 ? adds[1] : i == 16 ? adds[2] : adds[3]
            h.createdAt = Date().addingTimeInterval(add + Double(i) * 0.05)
            if query.hasPrefix("Mew ex") {
                // A Chinese copy, valued by hand.
                h.language = "zh"
                h.customValue = 35
            }
            context.insert(h)
        }
        try? context.save()
        await Portfolio.reprice(context: context)
        // A gently rising value history for the chart.
        let total = Portfolio.activeHoldings(context).reduce(0) { $0 + ($1.totalValue ?? 0) }
        for back in stride(from: 120, through: 1, by: -1) {
            guard let date = Calendar.current.date(byAdding: .day, value: -back, to: .now) else { continue }
            let wobble = sin(Double(back) / 6) * 0.025
            context.insert(ValueSnapshot(day: Fmt.day(date), value: total * (0.78 + 0.22 * Double(120 - back) / 120 + wobble), cost: 0))
        }
        try? context.save()
    }
}
