import Foundation
import SwiftData

/// Email + password accounts (Supabase), shared with the website. The project
/// URL and public key come from the website (config.json), so accounts switch on
/// without an app update. The session is kept in the Keychain.
@MainActor
@Observable
final class Account {
    static let shared = Account()

    struct Session: Codable {
        var accessToken: String
        var refreshToken: String
        var expiresAt: Double
        var userID: String
        var email: String
    }

    enum Failure: LocalizedError {
        case notEnabled, notSignedIn, server(Int, String), network

        var errorDescription: String? {
            switch self {
            case .notEnabled: "Accounts aren't switched on for this site yet."
            case .notSignedIn: "Sign in first."
            case .server(_, let message): message
            case .network: "Couldn't reach the account server. Check your connection."
            }
        }
    }

    private(set) var session: Session? = Account.loadSession()
    private(set) var baseURL: String? = UserDefaults.standard.string(forKey: "account.url")
    private(set) var anonKey: String? = UserDefaults.standard.string(forKey: "account.anon")
    @ObservationIgnored private var refreshing: Task<String, Error>?

    var isEnabled: Bool { baseURL != nil && anonKey != nil }
    var isSignedIn: Bool { session != nil && isEnabled }
    var email: String? { session?.email }
    var userID: String? { session?.userID }

    /// Reads the site's public account settings.
    func loadConfig() async {
        guard let data = try? await HostedData.current.data("config.json", fresh: true),
              let j = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return }
        var url = (j["supabaseUrl"] as? String)?.trimmingCharacters(in: .whitespaces)
        if url?.hasSuffix("/") == true { url = String(url!.dropLast()) }
        let key = (j["supabaseAnonKey"] as? String)?.trimmingCharacters(in: .whitespaces)
        baseURL = url?.isEmpty == false ? url : nil
        anonKey = key?.isEmpty == false ? key : nil
        UserDefaults.standard.set(baseURL, forKey: "account.url")
        UserDefaults.standard.set(anonKey, forKey: "account.anon")
    }

    // MARK: Sign in

    func signUp(email: String, password: String) async throws {
        let d = try await call("/auth/v1/signup", method: "POST", json: ["email": email.trimmingCharacters(in: .whitespaces), "password": password])
        try store(d)
    }

    func signIn(email: String, password: String) async throws {
        let d = try await call("/auth/v1/token?grant_type=password", method: "POST", json: ["email": email.trimmingCharacters(in: .whitespaces), "password": password])
        try store(d)
    }

    func signOut() async {
        let token = session?.accessToken
        save(nil)
        if let token { _ = try? await call("/auth/v1/logout", method: "POST", token: token) }
    }

    func changePassword(_ password: String) async throws {
        _ = try await call("/auth/v1/user", method: "PUT", token: try await accessToken(), json: ["password": password])
    }

    /// A valid access token, refreshed shortly before it expires.
    func accessToken() async throws -> String {
        guard let s = session else { throw Failure.notSignedIn }
        if s.expiresAt - Date().timeIntervalSince1970 > 60 { return s.accessToken }
        if let refreshing { return try await refreshing.value }
        let task = Task { () throws -> String in
            do {
                let d = try await self.call("/auth/v1/token?grant_type=refresh_token", method: "POST", json: ["refresh_token": s.refreshToken])
                try self.store(d)
                return self.session?.accessToken ?? ""
            } catch Failure.server(let code, _) where (400..<500).contains(code) {
                // The refresh token no longer works: sign in again.
                self.save(nil)
                throw Failure.notSignedIn
            }
        }
        refreshing = task
        defer { refreshing = nil }
        return try await task.value
    }

    /// Data API call as the signed-in person (row-level security applies).
    func rest(_ path: String, method: String = "GET", json: Any? = nil, prefer: String? = nil) async throws -> Data {
        try await call("/rest/v1/\(path)", method: method, token: try await accessToken(), json: json, prefer: prefer)
    }

    // MARK: Plumbing

    private func call(_ path: String, method: String = "GET", token: String? = nil, json: Any? = nil, prefer: String? = nil) async throws -> Data {
        guard let baseURL, let anonKey, let url = URL(string: baseURL + path) else { throw Failure.notEnabled }
        var r = URLRequest(url: url)
        r.httpMethod = method
        r.cachePolicy = .reloadIgnoringLocalCacheData
        r.timeoutInterval = 20
        r.setValue(anonKey, forHTTPHeaderField: "apikey")
        r.setValue("Bearer \(token ?? anonKey)", forHTTPHeaderField: "Authorization")
        if let prefer { r.setValue(prefer, forHTTPHeaderField: "Prefer") }
        if let json {
            r.httpBody = try JSONSerialization.data(withJSONObject: json)
            r.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let result: (Data, URLResponse)
        do { result = try await URLSession.shared.data(for: r) } catch { throw Failure.network }
        let status = (result.1 as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else { throw Failure.server(status, Self.message(status, result.0)) }
        return result.0
    }

    static func message(_ status: Int, _ data: Data) -> String {
        let j = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        let raw = ((j?["error_description"] ?? j?["msg"] ?? j?["message"] ?? j?["error"]) as? String ?? "").trimmingCharacters(in: .whitespaces)
        let l = raw.lowercased()
        if l.contains("invalid login credentials") { return "That email and password don't match an account." }
        if l.contains("already registered") || l.contains("already exists") { return "There's already an account with that email. Sign in instead." }
        if l.contains("password should be at least") { return "Use a password with at least 6 characters." }
        if l.contains("email not confirmed") { return "Confirm your email first (check your inbox)." }
        if l.contains("rate limit") || l.contains("too many") { return "Too many tries — wait a minute and try again." }
        if let r = raw.range(of: "Limit reached:") { return String(raw[r.lowerBound...]) }
        if status == 409 { return "That's already saved." }
        return raw.isEmpty ? "Something went wrong (\(status))." : raw
    }

    private func store(_ data: Data) throws {
        guard let j = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let access = j["access_token"] as? String, let refresh = j["refresh_token"] as? String,
              let user = j["user"] as? [String: Any], let id = user["id"] as? String else {
            throw Failure.server(200, "Account created — confirm your email, then sign in.")
        }
        let expires = (j["expires_at"] as? Double) ?? Date().timeIntervalSince1970 + ((j["expires_in"] as? Double) ?? 3600)
        save(Session(accessToken: access, refreshToken: refresh, expiresAt: expires, userID: id, email: user["email"] as? String ?? ""))
    }

    private func save(_ s: Session?) {
        session = s
        Keychain.set("account.session", s.flatMap { try? JSONEncoder().encode($0) }.flatMap { String(data: $0, encoding: .utf8) })
    }

    private static func loadSession() -> Session? {
        Keychain.get("account.session").flatMap { $0.data(using: .utf8) }.flatMap { try? JSONDecoder().decode(Session.self, from: $0) }
    }
}

/// Keeps the phone's collection in step with the account (and so the website).
/// Each sync downloads only what changed on the server, merges (newest change wins
/// per card; deletions travel), and saves the phone's own changes back.
@MainActor
@Observable
final class CollectionSync {
    static let shared = CollectionSync()

    private(set) var lastSync: Date?
    private(set) var lastError: String?
    private(set) var syncing = false
    private(set) var count: Int?
    @ObservationIgnored private var pending: Task<Void, Never>?

    var isConnected: Bool { Account.shared.isSignedIn }

    private struct State: Codable {
        var cursor: Double = 0
        var synced = false
        var pushedAt: Double = 0
    }

    private func loadState(_ user: String) -> State {
        UserDefaults.standard.data(forKey: "account.sync.\(user)").flatMap { try? JSONDecoder().decode(State.self, from: $0) } ?? State()
    }
    private func saveState(_ s: State, _ user: String) {
        UserDefaults.standard.set(try? JSONEncoder().encode(s), forKey: "account.sync.\(user)")
    }

    private struct Row: Decodable {
        var id: String
        var cardId: String
        var name: String?
        var setName: String?
        var number: String?
        var image: String?
        var variant: String?
        var grader: String?
        var grade: String?
        var condition: String?
        var quantity: Int?
        var cost: Double?
        var acquiredAt: String?
        var notes: String?
        var createdAt: Double?
        var updatedAt: Double
        var deleted: Bool?
        var syncedAt: Double

        var item: SyncItem {
            SyncItem(id: id.lowercased(), cardId: cardId, name: name ?? "Card", set: setName, number: number, image: image, variant: variant,
                     grader: grader, grade: grade, condition: condition ?? "NM", quantity: max(1, quantity ?? 1), cost: cost, acquiredAt: acquiredAt,
                     notes: notes, createdAt: createdAt, updatedAt: updatedAt, deleted: deleted == true ? true : nil)
        }
    }

    private static func row(_ i: SyncItem) -> [String: Any] {
        func v(_ x: Any?) -> Any { x ?? NSNull() }
        return ["id": i.id, "card_id": i.cardId, "name": i.name, "set_name": v(i.set), "number": v(i.number), "image": v(i.image),
                "variant": v(i.variant), "grader": v(i.grader), "grade": v(i.grade), "condition": i.condition, "quantity": i.quantity,
                "cost": v(i.cost), "acquired_at": v(i.acquiredAt), "notes": v(i.notes), "created_at": v(i.createdAt.map { Int64($0) }),
                "updated_at": Int64(i.updatedAt), "deleted": i.isDeleted]
    }

    /// After a local change: save shortly, batching quick edits.
    func syncSoon(_ context: ModelContext) {
        guard isConnected else { return }
        pending?.cancel()
        pending = Task {
            try? await Task.sleep(for: .seconds(1.5))
            guard !Task.isCancelled else { return }
            await sync(context)
        }
    }

    /// Pull, merge, apply locally, push. `reprice` prices any cards that arrived.
    func sync(_ context: ModelContext, reprice: Bool = true) async {
        guard Account.shared.isSignedIn, !syncing, let user = Account.shared.userID else { return }
        syncing = true
        defer { syncing = false }
        do {
            var state = loadState(user)
            let decoder = JSONDecoder()
            decoder.keyDecodingStrategy = .convertFromSnakeCase

            // 1. What changed on the server (a 5 s overlap guards against slow commits).
            var rows: [Row] = []
            var after = max(0, state.cursor - 5000)
            while true {
                let data = try await Account.shared.rest("holdings?select=*&synced_at=gt.\(Int64(after))&order=synced_at.asc&limit=1000")
                let page = try decoder.decode([Row].self, from: data)
                rows += page
                guard page.count == 1000, let last = page.last else { break }
                after = last.syncedAt
            }
            let remote = rows.map(\.item)

            // 2. Merge with the phone's cards (on the first sync, copies made earlier by CSV are kept once).
            let all = (try? context.fetch(FetchDescriptor<Holding>())) ?? []
            let now = Date().millis.rounded()
            let merged = SyncMerge.merge(local: all.map(\.syncItem), remote: remote, firstSync: !state.synced, preferLocal: true, now: now)
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

            // 3. Save the phone's changes.
            var remoteById: [String: SyncItem] = [:]
            for r in remote { remoteById[r.id] = r }
            let pushStarted = now
            let toPush = merged.filter { m in
                if let r = remoteById[m.id] { return m.updatedAt > r.updatedAt || (m.isDeleted && !r.isDeleted) }
                return !state.synced || m.updatedAt > state.pushedAt
            }
            var start = 0
            while start < toPush.count {
                let chunk = toPush[start..<min(start + 500, toPush.count)].map(Self.row)
                _ = try await Account.shared.rest("rpc/upsert_holdings", method: "POST", json: ["items": chunk])
                start += 500
            }

            state.cursor = rows.reduce(state.cursor) { max($0, $1.syncedAt) }
            state.synced = true
            state.pushedAt = pushStarted
            saveState(state, user)
            lastSync = Date()
            count = merged.filter { !$0.isDeleted }.count
            lastError = nil
            if arrived && reprice { await Portfolio.reprice(context: context) } else if changed { Portfolio.snapshot(context: context) }
        } catch {
            lastError = error.localizedDescription
        }
    }

    /// Sign out: the cards are safe in the account, so the phone forgets them.
    func signOut(_ context: ModelContext) async {
        await sync(context, reprice: false)
        if let user = Account.shared.userID { UserDefaults.standard.removeObject(forKey: "account.sync.\(user)") }
        await Account.shared.signOut()
        for h in (try? context.fetch(FetchDescriptor<Holding>())) ?? [] { context.delete(h) }
        for s in (try? context.fetch(FetchDescriptor<ValueSnapshot>())) ?? [] { context.delete(s) }
        try? context.save()
        lastSync = nil
        lastError = nil
        count = nil
    }
}
