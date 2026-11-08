// Checks StoreRescue against a real SwiftData store, on a Mac (see .github/workflows/store-test.yml).
// Not part of the app: it compiles Holding.swift and StoreRescue.swift with the stubs below.
import Foundation
import SwiftData
import CryptoKit

enum Game { case pokemon, other; init(id: String) { self = id == "pokemon" ? .pokemon : .other } }
enum Fmt { static func date(fromDay s: String) -> Date? { nil } }

func fail(_ m: String) -> Never { print("FAIL: \(m)"); exit(1) }
func check(_ ok: Bool, _ m: String) { if !ok { fail(m) }; print("ok - \(m)") }
func sha(_ url: URL) -> String { (try? Data(contentsOf: url)).map { SHA256.hash(data: $0).map { String(format: "%02x", $0) }.joined() } ?? "missing" }

struct Expected {
    var id: UUID, cardID: String, name: String, setName: String?, number: String?, imageURL: String?, variant: String?
    var grader: String?, grade: String?, condition: String, quantity: Int, costBasis: Double?, acquiredAt: Date?, notes: String?
    var createdAt: Date, updatedAt: Date, isTombstoned: Bool, unitValue: Double?, rawPrice: Double?, change7d: Double?, priceBasis: String?
}

let fm = FileManager.default
let schema = Schema([Holding.self, ValueSnapshot.self])
let support = URL.applicationSupportDirectory
try? fm.createDirectory(at: support, withIntermediateDirectories: true)
let store = support.appending(path: "default.store")
for suffix in ["", "-wal", "-shm"] { try? fm.removeItem(atPath: store.path + suffix) }
try? fm.removeItem(at: support.appending(path: "Store backups"))
UserDefaults.standard.removeObject(forKey: "store.file")
UserDefaults.standard.removeObject(forKey: "store.backedUp.1")
UserDefaults.standard.set(Data([1]), forKey: "account.sync.someone")

// 1. A 700-card collection saved the way the app saves it.
var expected: [UUID: Expected] = [:]
let base = Date(timeIntervalSinceReferenceDate: 800_000_000.125)
do {
    let container = try ModelContainer(for: schema, configurations: ModelConfiguration(schema: schema, url: store, cloudKitDatabase: .none))
    let context = ModelContext(container)
    for i in 0..<700 {
        let graded = i % 7 == 0
        let e = Expected(id: UUID(), cardID: "tcg:\(500_000 + i)", name: i % 50 == 0 ? "Pokémon Flabébé “\(i)”, ex" : "Card \(i)",
                         setName: i % 9 == 0 ? nil : "Set \(i % 40)", number: String(format: "%03d", i % 200), imageURL: i % 11 == 0 ? nil : "https://img/\(i).jpg",
                         variant: i % 3 == 0 ? nil : "holofoil", grader: graded ? "PSA" : nil, grade: graded ? "10" : nil,
                         condition: ["NM", "LP", "MP"][i % 3], quantity: 1 + i % 3, costBasis: i % 5 == 0 ? Double(i) / 4 : nil,
                         acquiredAt: i % 4 == 0 ? nil : base.addingTimeInterval(Double(i) * 3600), notes: i % 13 == 0 ? "cert #\(i)\nline 2" : nil,
                         createdAt: base.addingTimeInterval(Double(i) * 0.01), updatedAt: base.addingTimeInterval(Double(i) * 10 + 0.5),
                         isTombstoned: i % 100 == 99, unitValue: i % 6 == 0 ? nil : Double(i) * 1.37, rawPrice: Double(i) * 1.5, change7d: i % 2 == 0 ? -0.042 : nil,
                         priceBasis: i % 2 == 0 ? "raw" : nil)
        expected[e.id] = e
        let h = Holding(id: e.id, cardID: e.cardID, game: "pokemon", name: e.name, setName: e.setName, number: e.number, imageURL: e.imageURL,
                        variant: e.variant, grader: e.grader, grade: e.grade, condition: e.condition, quantity: e.quantity, costBasis: e.costBasis,
                        acquiredAt: e.acquiredAt, notes: e.notes, unitValue: e.unitValue)
        h.createdAt = e.createdAt
        h.updatedAt = e.updatedAt
        h.isTombstoned = e.isTombstoned
        h.rawPrice = e.rawPrice
        h.change7d = e.change7d
        h.priceBasis = e.priceBasis
        context.insert(h)
    }
    for d in 0..<30 { context.insert(ValueSnapshot(day: "2026-10-\(String(format: "%02d", d + 1))", value: Double(d) * 100, cost: Double(d))) }
    try context.save()
}
let before = ["", "-wal", "-shm"].map { sha(URL(fileURLWithPath: store.path + $0)) }
print("saved store: \(before)")

// 2. The one-time backup copies the file without opening it.
StoreRescue.backupOnce()
check(UserDefaults.standard.bool(forKey: "store.backedUp.1"), "backup made before opening")
StoreRescue.backupOnce()
let backups = (try? fm.contentsOfDirectory(atPath: support.appending(path: "Store backups").path)) ?? []
check(backups.count == 1, "backup made only once (\(backups))")

// 3. Rescue: read the rows straight out of a copy and move them into a fresh file.
guard let result = StoreRescue.recover(schema: schema) else { fail("recover returned nil") }
let live = expected.values.filter { !$0.isTombstoned }
check(result.cards == live.reduce(0) { $0 + $1.quantity }, "card count \(result.cards)")
let context = ModelContext(result.container)
let got = try context.fetch(FetchDescriptor<Holding>())
check(got.count == 700, "all 700 holdings rescued (\(got.count))")
var mismatches: [String] = []
func same(_ a: Date?, _ b: Date?) -> Bool { a == nil && b == nil || (a != nil && b != nil && abs(a!.timeIntervalSince(b!)) < 0.001) }
for h in got {
    guard let e = expected[h.id] else { mismatches.append("unknown id \(h.id)"); continue }
    let fields: [(String, Bool)] = [
        ("cardID", h.cardID == e.cardID), ("name", h.name == e.name), ("setName", h.setName == e.setName), ("number", h.number == e.number),
        ("imageURL", h.imageURL == e.imageURL), ("variant", h.variant == e.variant), ("grader", h.grader == e.grader), ("grade", h.grade == e.grade),
        ("condition", h.condition == e.condition), ("quantity", h.quantity == e.quantity), ("costBasis", h.costBasis == e.costBasis),
        ("acquiredAt", same(h.acquiredAt, e.acquiredAt)), ("notes", h.notes == e.notes), ("createdAt", same(h.createdAt, e.createdAt)),
        ("updatedAt", same(h.updatedAt, e.updatedAt)), ("isTombstoned", h.isTombstoned == e.isTombstoned), ("unitValue", h.unitValue == e.unitValue),
        ("rawPrice", h.rawPrice == e.rawPrice), ("change7d", h.change7d == e.change7d), ("priceBasis", h.priceBasis == e.priceBasis),
    ]
    for (f, ok) in fields where !ok { mismatches.append("\(e.name) \(f)") }
}
check(mismatches.isEmpty, "every field matches \(mismatches.prefix(10))")
let snaps = try context.fetch(FetchDescriptor<ValueSnapshot>())
check(snaps.count == 30 && snaps.contains { $0.day == "2026-10-05" && $0.value == 400 && $0.cost == 4 }, "value history rescued")

// 4. The original file is untouched, the backups are there, and the app now uses the new file.
let after = ["", "-wal", "-shm"].map { sha(URL(fileURLWithPath: store.path + $0)) }
check(before == after, "original file unchanged")
let allBackups = (try? fm.contentsOfDirectory(atPath: support.appending(path: "Store backups").path)) ?? []
check(allBackups.count == 2, "rescue kept its own backup too")
for b in allBackups {
    let original = support.appending(path: "Store backups/\(b)/original/default.store")
    check(fm.fileExists(atPath: original.path), "backup \(b) has the original")
}
check(StoreRescue.isMoved && StoreRescue.currentURL.lastPathComponent.hasPrefix("collection-"), "app now opens \(StoreRescue.currentURL.lastPathComponent)")
check(UserDefaults.standard.object(forKey: "account.sync.someone") == nil, "account sync starts over")

// 5. The new file opens again on the next launch.
do {
    let again = try ModelContainer(for: schema, configurations: ModelConfiguration(schema: schema, url: StoreRescue.currentURL, cloudKitDatabase: .none))
    check(try ModelContext(again).fetchCount(FetchDescriptor<Holding>()) == 700, "rescued file reopens with all 700")
}

// 6. The original opens with iCloud off (the first thing the app tries).
do {
    let original = try ModelContainer(for: schema, configurations: ModelConfiguration(schema: schema, isStoredInMemoryOnly: false, cloudKitDatabase: .none))
    check(try ModelContext(original).fetchCount(FetchDescriptor<Holding>()) == 700, "original opens with iCloud off")
}
print("ALL PASSED")
