import Foundation
import SwiftData

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
