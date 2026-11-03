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

struct SyncFile: Codable {
    var v: Int
    var updatedAt: Double
    var items: [SyncItem]

    init(items: [SyncItem]) {
        v = 1
        updatedAt = Date().millis.rounded()
        self.items = items
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        v = (try? c.decodeIfPresent(Int.self, forKey: .v)) ?? 1
        updatedAt = (try? c.decodeIfPresent(Double.self, forKey: .updatedAt)) ?? 0
        // Skip any item that can't be read rather than failing the sync.
        items = ((try? c.decodeIfPresent([Lenient].self, forKey: .items)) ?? []).compactMap(\.item)
    }

    /// Always decodes (consuming the element), keeping the item only if it's readable.
    private struct Lenient: Decodable {
        let item: SyncItem?
        init(from decoder: Decoder) throws { item = try? SyncItem(from: decoder) }
    }
}

/// Newest change wins per card; deletions travel as tombstones for 90 days.
enum SyncMerge {
    static let keepTombstones: Double = 90 * 86_400_000

    static func key(_ i: SyncItem) -> String {
        [i.cardId, i.variant ?? "", i.grader ?? "", i.grade ?? "", i.condition.isEmpty ? "NM" : i.condition].joined(separator: "|")
    }

    /// On a device's first sync, the same card that exists on both sides under
    /// different ids (an earlier CSV import) is kept once.
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

/// Keeps the phone's collection and the website's in step through a secret gist
/// on the owner's GitHub account. Pull, merge, write back only what changed.
@MainActor
@Observable
final class CollectionSync {
    static let shared = CollectionSync()
    static let fileName = "comps-collection.json"

    private(set) var token: String? = Keychain.get("sync.token")
    private(set) var gist: String? = UserDefaults.standard.string(forKey: "sync.gist")
    private(set) var lastSync: Date? = UserDefaults.standard.object(forKey: "sync.last") as? Date
    private(set) var lastError: String?
    private(set) var syncing = false
    private(set) var count: Int?
    @ObservationIgnored private var pending: Task<Void, Never>?

    var isConnected: Bool { token != nil && gist != nil }

    enum Failure: LocalizedError {
        case auth, permission, missing, rateLimited, http(Int), notConnected

        var errorDescription: String? {
            switch self {
            case .auth: "The GitHub key was revoked or expired. Connect again with a new key."
            case .permission: "The GitHub key needs the “gist” permission."
            case .missing: "The sync file wasn't found on GitHub."
            case .rateLimited: "GitHub is rate limiting; trying again shortly."
            case .http(let code): "GitHub answered \(code)."
            case .notConnected: "Sync isn't set up."
            }
        }
    }

    /// comps://sync?token=…&gist=… from the website's Settings page.
    nonisolated static func parse(_ payload: String) -> (token: String, gist: String?)? {
        guard let comps = URLComponents(string: payload), comps.scheme == "comps", comps.host == "sync",
              let token = comps.queryItems?.first(where: { $0.name == "token" })?.value, !token.isEmpty else { return nil }
        let gist = comps.queryItems?.first(where: { $0.name == "gist" })?.value
        return (token, gist?.isEmpty == false ? gist : nil)
    }

    func connect(token raw: String, gist: String?, context: ModelContext) async throws {
        let token = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        let id: String
        if let gist {
            id = gist
        } else {
            do { id = try await findOrCreateGist(token: token) } catch Failure.missing { throw Failure.permission }
        }
        Keychain.set("sync.token", token)
        UserDefaults.standard.set(id, forKey: "sync.gist")
        UserDefaults.standard.set(false, forKey: "sync.done")
        self.token = token
        self.gist = id
        lastError = nil
        await sync(context)
        if let lastError { throw NSError(domain: "Sync", code: 1, userInfo: [NSLocalizedDescriptionKey: lastError]) }
    }

    func disconnect() {
        pending?.cancel()
        Keychain.set("sync.token", nil)
        UserDefaults.standard.removeObject(forKey: "sync.gist")
        UserDefaults.standard.removeObject(forKey: "sync.last")
        UserDefaults.standard.set(false, forKey: "sync.done")
        token = nil
        gist = nil
        lastSync = nil
        lastError = nil
        count = nil
    }

    /// After a local change: push shortly, batching quick edits.
    func syncSoon(_ context: ModelContext) {
        guard isConnected else { return }
        pending?.cancel()
        pending = Task {
            try? await Task.sleep(for: .seconds(1.5))
            guard !Task.isCancelled else { return }
            await sync(context)
        }
    }

    /// Pull, merge, apply locally, push if needed. `reprice` prices any cards that arrived.
    func sync(_ context: ModelContext, reprice: Bool = true) async {
        guard isConnected, !syncing, let token else { return }
        syncing = true
        defer { syncing = false }
        do {
            var remote: SyncFile
            do {
                remote = try await read(token: token)
            } catch Failure.missing {
                // The gist was deleted on GitHub: start a new one from the phone's copy.
                let id = try await findOrCreateGist(token: token)
                gist = id
                UserDefaults.standard.set(id, forKey: "sync.gist")
                remote = try await read(token: token)
            }
            let all = (try? context.fetch(FetchDescriptor<Holding>())) ?? []
            let firstSync = !UserDefaults.standard.bool(forKey: "sync.done")
            let merged = SyncMerge.merge(local: all.map(\.syncItem), remote: remote.items, firstSync: firstSync, preferLocal: true,
                                         now: Date().millis.rounded())

            var byId: [String: Holding] = [:]
            for h in all { byId[h.id.uuidString.lowercased()] = h }
            var changed = false
            var arrived = false
            for m in merged {
                if let h = byId[m.id] {
                    if m.updatedAt != h.updatedAt.millis.rounded() || m.isDeleted != h.isTombstoned {
                        h.apply(m)
                        changed = true
                    }
                } else if !m.isDeleted, let uuid = UUID(uuidString: m.id) {
                    let h = Holding(id: uuid, cardID: m.cardId, game: "pokemon", name: m.name)
                    h.apply(m)
                    context.insert(h)
                    changed = true
                    arrived = true
                }
            }
            let kept = Set(merged.map(\.id))
            for h in all where h.isTombstoned && !kept.contains(h.id.uuidString.lowercased()) {
                context.delete(h)
                changed = true
            }
            if changed { try? context.save() }
            if SyncMerge.differs(merged, remote.items) { try await write(merged, token: token) }

            UserDefaults.standard.set(true, forKey: "sync.done")
            let now = Date()
            lastSync = now
            UserDefaults.standard.set(now, forKey: "sync.last")
            count = merged.filter { !$0.isDeleted }.count
            lastError = nil
            if arrived && reprice { await Portfolio.reprice(context: context) } else if changed { Portfolio.snapshot(context: context) }
        } catch {
            lastError = error.localizedDescription
        }
    }

    // MARK: Shared files (Drops)

    /// Raw contents of every file in the sync gist, by name.
    func gistFiles() async throws -> [String: Data] {
        guard let token, let gist else { throw Failure.notConnected }
        let data = try await request("GET", "/gists/\(gist)", token: token)
        let g = try JSONDecoder().decode(Gist.self, from: data)
        var out: [String: Data] = [:]
        for (name, f) in g.files {
            if f.truncated == true, let raw = f.raw_url.flatMap(URL.init(string:)) {
                var r = URLRequest(url: raw)
                r.cachePolicy = .reloadIgnoringLocalCacheData
                out[name] = try await URLSession.shared.data(for: r).0
            } else {
                out[name] = Data((f.content ?? "").utf8)
            }
        }
        return out
    }

    /// Replaces one file in the sync gist; the other files are untouched.
    func writeGistFile(_ name: String, data: Data) async throws {
        guard let token, let gist else { throw Failure.notConnected }
        let content = String(data: data, encoding: .utf8) ?? "{}"
        _ = try await request("PATCH", "/gists/\(gist)", token: token, json: ["files": [name: ["content": content]]])
    }

    // MARK: GitHub

    private struct GistFile: Decodable {
        var content: String?
        var truncated: Bool?
        var raw_url: String?
    }

    private struct Gist: Decodable {
        var id: String
        var files: [String: GistFile]
    }

    private func request(_ method: String, _ path: String, token: String, json: Any? = nil) async throws -> Data {
        var r = URLRequest(url: URL(string: "https://api.github.com" + path)!)
        r.httpMethod = method
        r.cachePolicy = .reloadIgnoringLocalCacheData
        r.timeoutInterval = 20
        r.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        r.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        r.setValue("2022-11-28", forHTTPHeaderField: "X-GitHub-Api-Version")
        if let json {
            r.httpBody = try JSONSerialization.data(withJSONObject: json)
            r.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let (data, response) = try await URLSession.shared.data(for: r)
        let http = response as? HTTPURLResponse
        switch http?.statusCode ?? 0 {
        case 200..<300: return data
        case 401: throw Failure.auth
        case 403: throw http?.value(forHTTPHeaderField: "x-ratelimit-remaining") == "0" ? Failure.rateLimited : Failure.permission
        case 404: throw Failure.missing
        case let code: throw Failure.http(code)
        }
    }

    private func findOrCreateGist(token: String) async throws -> String {
        for page in 1...5 {
            let data = try await request("GET", "/gists?per_page=100&page=\(page)", token: token)
            let list = (try? JSONDecoder().decode([Gist].self, from: data)) ?? []
            if let hit = list.first(where: { $0.files[Self.fileName] != nil }) { return hit.id }
            if list.count < 100 { break }
        }
        let empty = String(data: try JSONEncoder().encode(SyncFile(items: [])), encoding: .utf8) ?? "{}"
        let body: [String: Any] = [
            "description": "Comps collection — synced by the Comps app and website",
            "public": false,
            "files": [Self.fileName: ["content": empty]],
        ]
        let data = try await request("POST", "/gists", token: token, json: body)
        return try JSONDecoder().decode(Gist.self, from: data).id
    }

    private func read(token: String) async throws -> SyncFile {
        guard let gist else { throw Failure.notConnected }
        let data = try await request("GET", "/gists/\(gist)", token: token)
        let g = try JSONDecoder().decode(Gist.self, from: data)
        guard let f = g.files[Self.fileName] else { return SyncFile(items: []) }
        var text = Data((f.content ?? "").utf8)
        if f.truncated == true, let raw = f.raw_url.flatMap(URL.init(string:)) {
            var r = URLRequest(url: raw)
            r.cachePolicy = .reloadIgnoringLocalCacheData
            text = try await URLSession.shared.data(for: r).0
        }
        return (try? JSONDecoder().decode(SyncFile.self, from: text)) ?? SyncFile(items: [])
    }

    private func write(_ items: [SyncItem], token: String) async throws {
        guard let gist else { throw Failure.notConnected }
        let content = String(data: try JSONEncoder().encode(SyncFile(items: items)), encoding: .utf8) ?? "{}"
        _ = try await request("PATCH", "/gists/\(gist)", token: token, json: ["files": [Self.fileName: ["content": content]]])
    }
}
