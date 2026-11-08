import Foundation
import SQLite3
import SwiftData

/// Gets the collection back when its saved file won't open, without ever changing that file.
///
/// 1. The file (and its -wal/-shm journal files) is copied twice into "Store backups":
///    one copy is kept exactly as it was, the other is read.
/// 2. The cards and value history are read straight out of that copy's database with
///    SQLite, so nothing depends on the step that failed.
/// 3. They go into a fresh file, which the app uses from then on.
enum StoreRescue {
    /// The file the app should open: the original one, or the rescued one once there is one.
    static var currentURL: URL {
        if let name = UserDefaults.standard.string(forKey: fileKey) { return support.appending(path: name) }
        return defaultURL
    }
    static var isMoved: Bool { UserDefaults.standard.string(forKey: fileKey) != nil }

    private static let fileKey = "store.file"
    private static let support = URL.applicationSupportDirectory
    private static let defaultURL = URL.applicationSupportDirectory.appending(path: "default.store")

    enum Value {
        case int(Int64), real(Double), text(String), blob(Data), null

        var string: String? {
            switch self {
            case .text(let s): return s
            case .int(let i): return String(i)
            case .real(let d): return String(d)
            default: return nil
            }
        }
        var double: Double? {
            switch self {
            case .real(let d): return d
            case .int(let i): return Double(i)
            case .text(let s): return Double(s)
            default: return nil
            }
        }
        var int: Int? { double.map { Int($0) } }
        var bool: Bool { (double ?? 0) != 0 }
        /// Core Data keeps dates as seconds since 2001.
        var date: Date? { double.map { Date(timeIntervalSinceReferenceDate: $0) } }
        var uuid: UUID? {
            switch self {
            case .blob(let d) where d.count == 16:
                let b = [UInt8](d)
                return UUID(uuid: (b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7], b[8], b[9], b[10], b[11], b[12], b[13], b[14], b[15]))
            case .text(let s): return UUID(uuidString: s)
            default: return nil
            }
        }
    }

    struct Result {
        let container: ModelContainer
        let cards: Int
    }

    /// Rescues the collection from the file the app couldn't open. Nil when there's nothing to
    /// rescue or it didn't work (the file is left as it was either way).
    static func recover(schema: Schema) -> Result? {
        let source = currentURL
        guard FileManager.default.fileExists(atPath: source.path) else { return nil }
        guard let work = try? backup(source) else { return nil }
        let holdings = rows(work, entity: "Holding")
        let snapshots = rows(work, entity: "ValueSnapshot")
        guard let holdings, !holdings.isEmpty else { return nil }

        let name = "collection-\(Int(Date().timeIntervalSince1970)).store"
        let target = support.appending(path: name)
        let config = ModelConfiguration(schema: schema, url: target, cloudKitDatabase: .none)
        guard let container = try? ModelContainer(for: schema, configurations: config) else { return nil }
        let context = ModelContext(container)
        var cards = 0
        for r in holdings {
            guard let h = holding(r) else { continue }
            context.insert(h)
            if !h.isTombstoned { cards += h.quantity }
        }
        var days = Set<String>()
        for r in snapshots ?? [] {
            guard let day = r["day"]?.string, days.insert(day).inserted else { continue }
            context.insert(ValueSnapshot(day: day, value: r["value"]?.double ?? 0, cost: r["cost"]?.double ?? 0))
        }
        do { try context.save() } catch { return nil }
        UserDefaults.standard.set(name, forKey: fileKey)
        // The new file starts its account sync from scratch, so it gets everything from the account too.
        for key in UserDefaults.standard.dictionaryRepresentation().keys where key.hasPrefix("account.sync.") {
            UserDefaults.standard.removeObject(forKey: key)
        }
        return Result(container: container, cards: cards)
    }

    /// Before this version first opens the collection, a copy of the file is put aside, once.
    static func backupOnce() {
        let key = "store.backedUp.1"
        guard !UserDefaults.standard.bool(forKey: key), FileManager.default.fileExists(atPath: currentURL.path) else { return }
        if (try? backup(currentURL)) != nil { UserDefaults.standard.set(true, forKey: key) }
    }

    /// Copies the store and its journal files twice: "original" (never opened) and "read".
    /// Returns the copy to read.
    private static func backup(_ source: URL) throws -> URL {
        let stamp = ISO8601DateFormatter().string(from: .now).replacingOccurrences(of: ":", with: "-")
        let dir = support.appending(path: "Store backups/\(stamp)", directoryHint: .isDirectory)
        let fm = FileManager.default
        for sub in ["original", "read"] {
            let to = dir.appending(path: sub, directoryHint: .isDirectory)
            try fm.createDirectory(at: to, withIntermediateDirectories: true)
            for suffix in ["", "-wal", "-shm"] {
                let file = URL(fileURLWithPath: source.path + suffix)
                guard fm.fileExists(atPath: file.path) else { continue }
                try fm.copyItem(at: file, to: to.appending(path: file.lastPathComponent))
            }
        }
        return dir.appending(path: "read/\(source.lastPathComponent)")
    }

    /// Every row of an entity's table, keyed by attribute name in lower case ("ZCARDID" → "cardid").
    static func rows(_ store: URL, entity: String) -> [[String: Value]]? {
        var db: OpaquePointer?
        guard sqlite3_open_v2(store.path, &db, SQLITE_OPEN_READWRITE, nil) == SQLITE_OK, let db else {
            sqlite3_close(db)
            return nil
        }
        defer { sqlite3_close(db) }
        let table = "Z" + entity.uppercased()
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, "SELECT * FROM \(table)", -1, &stmt, nil) == SQLITE_OK, let stmt else { return nil }
        defer { sqlite3_finalize(stmt) }
        let columns = (0..<sqlite3_column_count(stmt)).map { i -> String in
            let name = sqlite3_column_name(stmt, i).map { String(cString: $0) }?.lowercased() ?? ""
            return name.hasPrefix("z") ? String(name.dropFirst()) : name
        }
        var out: [[String: Value]] = []
        while sqlite3_step(stmt) == SQLITE_ROW {
            var row: [String: Value] = [:]
            for (i, name) in columns.enumerated() {
                let c = Int32(i)
                switch sqlite3_column_type(stmt, c) {
                case SQLITE_INTEGER: row[name] = .int(sqlite3_column_int64(stmt, c))
                case SQLITE_FLOAT: row[name] = .real(sqlite3_column_double(stmt, c))
                case SQLITE_TEXT: row[name] = sqlite3_column_text(stmt, c).map { .text(String(cString: $0)) } ?? .null
                case SQLITE_BLOB:
                    let n = Int(sqlite3_column_bytes(stmt, c))
                    if n > 0, let bytes = sqlite3_column_blob(stmt, c) { row[name] = .blob(Data(bytes: bytes, count: n)) } else { row[name] = .null }
                default: row[name] = .null
                }
            }
            out.append(row)
        }
        return out
    }

    static func holding(_ r: [String: Value]) -> Holding? {
        guard let cardID = r["cardid"]?.string else { return nil }
        let h = Holding(id: r["id"]?.uuid ?? UUID(), cardID: cardID, game: r["game"]?.string ?? "pokemon", name: r["name"]?.string ?? "Card",
                        setName: r["setname"]?.string, number: r["number"]?.string, imageURL: r["imageurl"]?.string,
                        variant: r["variant"]?.string, grader: r["grader"]?.string, grade: r["grade"]?.string,
                        condition: r["condition"]?.string ?? "NM", quantity: max(1, r["quantity"]?.int ?? 1),
                        costBasis: r["costbasis"]?.double, acquiredAt: r["acquiredat"]?.date, notes: r["notes"]?.string,
                        unitValue: r["unitvalue"]?.double)
        if let d = r["createdat"]?.date { h.createdAt = d }
        if let d = r["updatedat"]?.date { h.updatedAt = d }
        h.isTombstoned = r["istombstoned"]?.bool ?? false
        h.rawPrice = r["rawprice"]?.double
        h.change7d = r["change7d"]?.double
        h.priceBasis = r["pricebasis"]?.string
        h.priceUpdatedAt = r["priceupdatedat"]?.date
        return h
    }
}
