// Step 2 of the migration test: the current card model opens the old store the way the app does.
import Foundation
import SwiftData

enum Game { case pokemon, other; init(id: String) { self = id == "pokemon" ? .pokemon : .other } }
enum Fmt { static func date(fromDay s: String) -> Date? { nil } }
func check(_ ok: Bool, _ m: String) { if !ok { print("FAIL: \(m)"); exit(1) }; print("ok - \(m)") }

let schema = Schema([Holding.self, ValueSnapshot.self])
let config = ModelConfiguration(schema: schema, isStoredInMemoryOnly: false, cloudKitDatabase: .none)
do {
    let container = try ModelContainer(for: schema, configurations: config)
    let context = ModelContext(container)
    let all = try context.fetch(FetchDescriptor<Holding>(sortBy: [SortDescriptor(\.createdAt)]))
    check(all.count == 300, "all 300 cards open with the new model (\(all.count))")
    check(all.allSatisfy { $0.language == nil && $0.customValue == nil }, "new fields start empty")
    check(all[7].name == "Card 7" && all[7].unitValue == 7 && all[7].quantity == 2, "existing fields unchanged")
    check(try context.fetchCount(FetchDescriptor<ValueSnapshot>()) == 1, "value history kept")
    all[3].language = "zh"
    all[3].customValue = 12.5
    try context.save()
}
do {
    let container = try ModelContainer(for: schema, configurations: config)
    let all = try ModelContext(container).fetch(FetchDescriptor<Holding>(sortBy: [SortDescriptor(\.createdAt)]))
    check(all[3].language == "zh" && all[3].customValue == 12.5, "a Chinese mark and your value save and reopen")
    check(Holding.value(market: 9, language: "zh", custom: nil) == nil && Holding.value(market: 9, language: nil, custom: 4) == 4, "value rule")
}
print("ALL PASSED")
