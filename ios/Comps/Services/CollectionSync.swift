import Foundation
import SwiftData
import Security

/// One card in the shared collection file. Same shape and merge rules as the
/// website (web/src/lib/syncMerge.ts), so either side can read what the other wrote.
struct SyncItem: Codable, Equatable {
    var id: String
    var cardId: String
    var name: String
    var set: String?
    var number: String?
    var image: String?
    var variant: String?
    var grader: String?
    var grade: String?
    var condition: String
    var quantity: Int
    var cost: Double?
    var acquiredAt: String?
    var notes: String?
    var createdAt: Double?
    var updatedAt: Double
    var deleted: Bool?

    init(id: String, cardId: String, name: String, set: String?, number: String?, image: String?, variant: String?, grader: String?,
         grade: String?, condition: String, quantity: Int, cost: Double?, acquiredAt: String?, notes: String?, createdAt: Double?,
         updatedAt: Double, deleted: Bool?) {
        self.id = id; self.cardId = cardId; self.name = name; self.set = set; self.number = number; self.image = image
        self.variant = variant; self.grader = grader; self.grade = grade; self.condition = condition; self.quantity = quantity
        self.cost = cost; self.acquiredAt = acquiredAt; self.notes = notes; self.createdAt = createdAt; self.updatedAt = updatedAt
        self.deleted = deleted
    }

    /// Lenient: a field the other side left out shouldn't sink the whole file.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        cardId = try c.decode(String.self, forKey: .cardId)
        name = try c.decodeIfPresent(String.self, forKey: .name) ?? "Card"
        set = try c.decodeIfPresent(String.self, forKey: .set)
        number = try c.decodeIfPresent(String.self, forKey: .number)
        image = try c.decodeIfPresent(String.self, forKey: .image)
        variant = try c.decodeIfPresent(String.self, forKey: .variant)
        grader = try c.decodeIfPresent(String.self, forKey: .grader)
        grade = try c.decodeIfPresent(String.self, forKey: .grade)
        condition = (try? c.decodeIfPresent(String.self, forKey: .condition)) ?? "NM"
        quantity = max(1, (try? c.decodeIfPresent(Int.self, forKey: .quantity)) ?? 1)
        cost = try? c.decodeIfPresent(Double.self, forKey: .cost)
        acquiredAt = try? c.decodeIfPresent(String.self, forKey: .acquiredAt)
        notes = try? c.decodeIfPresent(String.self, forKey: .notes)
        createdAt = try? c.decodeIfPresent(Double.self, forKey: .createdAt)
        updatedAt = (try? c.decodeIfPresent(Double.self, forKey: .updatedAt)) ?? 0
        deleted = try? c.decodeIfPresent(Bool.self, forKey: .deleted)
    }

    var isDeleted: Bool { deleted ?? false }
}

/// Newest change wins per card; deletions travel as tombstones for 90 days.
enum SyncMerge {
    static let keepTombstones: Double = 90 * 86_400_000

    static func key(_ i: SyncItem) -> String {
        [i.cardId, i.variant ?? "", i.grader ?? "", i.grade ?? "", i.condition.isEmpty ? "NM" : i.condition].joined(separator: "|")
    }

    /// On a device's first sync, the same card that exists on both sides under
    /// different ids (added on each before signing in) is kept once.
    static func merge(local: [SyncItem], remote: [SyncItem], firstSync: Bool, preferLocal: Bool, now: Double) -> [SyncItem] {
        func norm(_ i: SyncItem) -> SyncItem { var x = i; x.id = i.id.lowercased(); return x }
        let L = local.map(norm), R = remote.map(norm)
        var byId: [String: SyncItem] = [:]
        var order: [String] = []
        for r in R {
            if byId[r.id] == nil { order.append(r.id) }
            byId[r.id] = r
        }
        for l in L {
            if let r = byId[l.id] {
                if l.updatedAt > r.updatedAt || (l.updatedAt == r.updatedAt && l.isDeleted && !r.isDeleted) { byId[l.id] = l }
            } else {
                order.append(l.id)
                byId[l.id] = l
            }
        }
        if firstSync {
            let localIds = Set(L.map(\.id)), remoteIds = Set(R.map(\.id))
            let live = order.compactMap { byId[$0] }.filter { !$0.isDeleted }
            var pool: [String: [SyncItem]] = [:]
            for r in live where remoteIds.contains(r.id) && !localIds.contains(r.id) { pool[key(r), default: []].append(r) }
            for l in live where localIds.contains(l.id) && !remoteIds.contains(l.id) {
                guard var twins = pool[key(l)], !twins.isEmpty else { continue }
                let twin = twins.removeFirst()
                pool[key(l)] = twins
                var drop = preferLocal ? twin : l
                drop.deleted = true
                drop.updatedAt = now
                byId[drop.id] = drop
            }
        }
        return order.compactMap { byId[$0] }.filter { !$0.isDeleted || now - $0.updatedAt < keepTombstones }
    }

    /// True when `other` is missing changes that `merged` has.
    static func differs(_ merged: [SyncItem], _ other: [SyncItem]) -> Bool {
        guard merged.count == other.count else { return true }
        var byId: [String: SyncItem] = [:]
        for o in other { byId[o.id.lowercased()] = o }
        return merged.contains { m in
            guard let o = byId[m.id] else { return true }
            return o.updatedAt != m.updatedAt || o.isDeleted != m.isDeleted
        }
    }
}

private enum SyncDates {
    static let day: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withFullDate]
        return f
    }()
    static let full = ISO8601DateFormatter()

    static func string(_ d: Date) -> String { day.string(from: d) }
    static func date(_ s: String) -> Date? { day.date(from: String(s.prefix(10))) ?? full.date(from: s) }
}

extension Holding {
    var syncItem: SyncItem {
        SyncItem(id: id.uuidString.lowercased(), cardId: cardID, name: name, set: setName, number: number, image: imageURL, variant: variant,
                 grader: grader, grade: grade, condition: condition, quantity: quantity, cost: costBasis, acquiredAt: acquiredAt.map(SyncDates.string),
                 notes: notes, createdAt: createdAt.millis.rounded(), updatedAt: updatedAt.millis.rounded(), deleted: isTombstoned ? true : nil)
    }

    func apply(_ i: SyncItem) {
        cardID = i.cardId
        name = i.name
        setName = i.set
        number = i.number
        imageURL = i.image
        variant = i.variant
        grader = i.grader
        grade = i.grade
        condition = i.condition
        quantity = i.quantity
        costBasis = i.cost
        acquiredAt = i.acquiredAt.flatMap(SyncDates.date)
        notes = i.notes
        if let c = i.createdAt { createdAt = Date(millis: c) }
        updatedAt = Date(millis: i.updatedAt)
        isTombstoned = i.isDeleted
    }
}

/// Small Keychain wrapper for the sync key (falls back to app storage if the Keychain refuses).
enum Keychain {
    private static let service = "com.comps.scanner"

    private static func base(_ account: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
    }

    static func get(_ account: String) -> String? {
        var q = base(account)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        if SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let d = out as? Data, let s = String(data: d, encoding: .utf8) { return s }
        return UserDefaults.standard.string(forKey: "keychain.\(account)")
    }

    static func set(_ account: String, _ value: String?) {
        SecItemDelete(base(account) as CFDictionary)
        UserDefaults.standard.removeObject(forKey: "keychain.\(account)")
        guard let value else { return }
        var add = base(account)
        add[kSecValueData as String] = Data(value.utf8)
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        if SecItemAdd(add as CFDictionary, nil) != errSecSuccess {
            UserDefaults.standard.set(value, forKey: "keychain.\(account)")
        }
    }
}

