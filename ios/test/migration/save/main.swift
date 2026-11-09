// Step 1 of the migration test: saves 300 cards with the card model as it was before (HoldingV1.swift).
import Foundation
import SwiftData

enum Game { case pokemon, other; init(id: String) { self = id == "pokemon" ? .pokemon : .other } }
enum Fmt { static func date(fromDay s: String) -> Date? { nil } }

let support = URL.applicationSupportDirectory
try? FileManager.default.createDirectory(at: support, withIntermediateDirectories: true)
for suffix in ["", "-wal", "-shm"] { try? FileManager.default.removeItem(atPath: support.appending(path: "default.store").path + suffix) }
let schema = Schema([Holding.self, ValueSnapshot.self])
let container = try ModelContainer(for: schema, configurations: ModelConfiguration(schema: schema, isStoredInMemoryOnly: false, cloudKitDatabase: .none))
let context = ModelContext(container)
for i in 0..<300 {
    let h = Holding(cardID: "tcg:\(1000 + i)", game: "pokemon", name: "Card \(i)", setName: "Set", number: "\(i)", quantity: 1 + i % 2, unitValue: Double(i))
    h.createdAt = Date(timeIntervalSinceReferenceDate: 800_000_000 + Double(i))
    context.insert(h)
}
context.insert(ValueSnapshot(day: "2026-11-01", value: 123, cost: 4))
try context.save()
print("saved 300 cards with the old model")
