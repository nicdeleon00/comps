import Foundation

/// Trading between people, through the same account server as the website (the "trading" part of
/// supabase/schema.sql). Collections stay private; a trader can share theirs read-only. Nothing here
/// writes to the collection on this phone.
struct Trader: Codable, Identifiable, Hashable {
    var userId: String
    var handle: String
    var name: String?
    var area: String?
    var bio: String?
    var shareCollection: Bool
    var createdAt: Double

    var id: String { userId }
    var displayName: String { (name?.isEmpty == false ? name : nil) ?? "@\(handle)" }
}

/// One card as trading sees it: on a trade list, in an offer, or in a shared collection.
struct TradeCard: Codable, Hashable, Identifiable {
    var id: String?
    var userId: String?
    var kind: String?
    var cardId: String
    var name: String
    var setName: String?
    var number: String?
    var image: String?
    var variant: String?
    var grader: String?
    var grade: String?
    var condition: String?
    var language: String?
    var quantity: Int
    var value: Double?
    var holdingId: String?

    /// Stable within a list even for cards without a row id (offers, shared collections).
    var key: String { id ?? "\(cardId)|\(variant ?? "")|\(grader ?? "")|\(grade ?? "")|\(holdingId ?? "")" }
    var imageURL: URL? { ImageURL.resolve(image) }
    var detail: String {
        [setName, number.map { "#\($0)" }, grader.map { "\($0) \(grade ?? "")" } ?? condition].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
    }

    func same(_ o: TradeCard) -> Bool {
        cardId == o.cardId && variant == o.variant && grader == o.grader && grade == o.grade && holdingId == o.holdingId
    }

    init(cardId: String, name: String, setName: String? = nil, number: String? = nil, image: String? = nil, variant: String? = nil,
         grader: String? = nil, grade: String? = nil, condition: String? = "NM", language: String? = nil, quantity: Int = 1,
         value: Double? = nil, holdingId: String? = nil) {
        self.cardId = cardId; self.name = name; self.setName = setName; self.number = number; self.image = image; self.variant = variant
        self.grader = grader; self.grade = grade; self.condition = condition; self.language = language; self.quantity = quantity
        self.value = value; self.holdingId = holdingId
    }

    init(_ c: CardSummary) {
        self.init(cardId: c.id, name: c.name, setName: c.setName, number: c.number, image: c.image, variant: c.variant, value: c.price)
    }

    @MainActor init(_ h: Holding) {
        self.init(cardId: h.cardID, name: h.name, setName: h.setName, number: h.number, image: h.imageURL, variant: h.variant,
                  grader: h.grader, grade: h.grade, condition: h.condition, language: h.language, quantity: h.quantity,
                  value: h.unitValue, holdingId: h.id.uuidString.lowercased())
    }

    /// What the server stores for a card in an offer or on a list.
    var json: [String: Any] {
        var d: [String: Any] = ["card_id": cardId, "name": name, "quantity": max(1, quantity), "condition": condition ?? "NM"]
        if let setName { d["set_name"] = setName }
        if let number { d["number"] = number }
        if let image { d["image"] = image }
        if let variant { d["variant"] = variant }
        if let grader { d["grader"] = grader }
        if let grade { d["grade"] = grade }
        if let language { d["language"] = language }
        if let value { d["value"] = value }
        return d
    }
}

struct TradeOffer: Codable, Identifiable, Hashable {
    enum Status: String, Codable { case open, accepted, declined, cancelled, countered }
    var id: String
    var fromUser: String
    var toUser: String
    var parentId: String?
    var status: Status
    var give: [TradeCard]
    var get: [TradeCard]
    var cash: Double
    var message: String?
    var createdAt: Double
    var updatedAt: Double

    /// The offer from one person's side.
    struct Perspective { var sent: Bool; var other: String; var youGive: [TradeCard]; var youGet: [TradeCard]; var cashOut: Double }
    func view(for me: String) -> Perspective {
        let sent = fromUser == me
        return Perspective(sent: sent, other: sent ? toUser : fromUser, youGive: sent ? give : get, youGet: sent ? get : give, cashOut: sent ? cash : -cash)
    }

    func statusLabel(for me: String) -> String {
        switch status {
        case .open: fromUser == me ? "Waiting on them" : "Waiting on you"
        case .accepted: "Accepted"
        case .declined: "Declined"
        case .cancelled: "Cancelled"
        case .countered: "Countered"
        }
    }
}

struct TradeMessage: Codable, Identifiable, Hashable {
    var id: String
    var offerId: String
    var fromUser: String
    var body: String
    var createdAt: Double
}

struct TradeMatch: Codable, Hashable {
    var userId: String
    var theyHave: Int
    var theyWant: Int
}

enum TradeError: LocalizedError {
    case message(String)
    var errorDescription: String? { if case .message(let m) = self { m } else { nil } }
}

@MainActor
enum TradeAPI {
    private static var account: Account { Account.shared }
    private static let decoder: JSONDecoder = {
        let d = JSONDecoder()
        d.keyDecodingStrategy = .convertFromSnakeCase
        return d
    }()

    /// Every row, however many: the account server hands back at most 1,000 rows per request, so
    /// ask again from where the last page ended until an empty page comes back.
    private static func all<T: Decodable>(_ path: String, method: String = "GET", json: Any? = nil) async throws -> [T] {
        var out: [T] = []
        let sep = path.contains("?") ? "&" : "?"
        for _ in 0..<100 {
            let page: [T] = try decoder.decode([T].self, from: try await account.rest("\(path)\(sep)limit=1000&offset=\(out.count)", method: method, json: json))
            if page.isEmpty { break }
            out += page
        }
        return out
    }

    private static func get<T: Decodable>(_ path: String) async throws -> T {
        try decoder.decode(T.self, from: try await account.rest(path))
    }

    private static func rpc<T: Decodable>(_ fn: String, _ args: [String: Any]) async throws -> T {
        try decoder.decode(T.self, from: try await account.rest("rpc/\(fn)", method: "POST", json: args))
    }

    /// Server messages in plain words.
    static func friendly(_ error: Error) -> String {
        let raw = error.localizedDescription
        if raw.range(of: "duplicate|unique", options: [.regularExpression, .caseInsensitive]) != nil { return "That username is taken. Try another." }
        if raw.range(of: "relation .* does not exist|schema cache", options: [.regularExpression, .caseInsensitive]) != nil {
            return "Trading isn't available yet. Check back soon."
        }
        return raw
    }

    static func notifyChanged() { NotificationCenter.default.post(name: .tradeChanged, object: nil) }

    // Profiles
    static func myProfile() async throws -> Trader? {
        guard let me = account.userID else { return nil }
        let rows: [Trader] = try await get("traders?user_id=eq.\(me)&select=*")
        return rows.first
    }

    static func saveProfile(handle: String, name: String, area: String, bio: String, share: Bool, existing: Bool) async throws {
        guard let me = account.userID else { throw Account.Failure.notSignedIn }
        func clean(_ s: String) -> Any { let t = s.trimmingCharacters(in: .whitespacesAndNewlines); return t.isEmpty ? NSNull() : t }
        let body: [String: Any] = ["handle": handle.lowercased(), "name": clean(name), "area": clean(area), "bio": clean(bio),
                                   "share_collection": share, "updated_at": Int(Date().timeIntervalSince1970 * 1000)]
        if existing {
            _ = try await account.rest("traders?user_id=eq.\(me)", method: "PATCH", json: body)
        } else {
            _ = try await account.rest("traders", method: "POST", json: body)
        }
        notifyChanged()
    }

    static func traders() async throws -> [Trader] { try await get("traders?select=*&order=created_at.desc&limit=500") }
    static func trader(handle: String) async throws -> Trader? {
        let rows: [Trader] = try await get("traders?handle=eq.\(handle.lowercased())&select=*")
        return rows.first
    }
    static func traders(ids: [String]) async throws -> [Trader] {
        guard !ids.isEmpty else { return [] }
        return try await get("traders?user_id=in.(\(ids.joined(separator: ",")))&select=*")
    }
    static func matches() async throws -> [TradeMatch] { try await rpc("trade_matches", [:]) }

    // Trade lists
    static func list(of user: String) async throws -> [TradeCard] { try await all("trade_cards?user_id=eq.\(user)&select=*&order=created_at.desc,id.asc") }
    static func listCounts() async throws -> [String: (have: Int, want: Int)] {
        struct Row: Decodable { var userId: String; var kind: String }
        let rows: [Row] = try await all("trade_cards?select=user_id,kind&order=id.asc")
        var out: [String: (have: Int, want: Int)] = [:]
        for r in rows {
            var c = out[r.userId] ?? (0, 0)
            if r.kind == "have" { c.have += 1 } else { c.want += 1 }
            out[r.userId] = c
        }
        return out
    }
    static func whoHas(_ cardId: String) async throws -> [TradeCard] { try await get("trade_cards?card_id=eq.\(cardId)&kind=eq.have&select=*&limit=200") }

    static func add(_ kind: String, _ cards: [TradeCard]) async throws {
        let rows: [[String: Any]] = cards.map { c in
            var d = c.json
            d.removeValue(forKey: "value")
            d["kind"] = kind
            d["quantity"] = min(999, max(1, c.quantity))
            if let h = c.holdingId { d["holding_id"] = h }
            return d
        }
        // Batches; one at a time only when a batch holds a copy that's already listed.
        var i = 0
        while i < rows.count {
            let batch = Array(rows[i..<min(i + 200, rows.count)])
            do {
                _ = try await account.rest("trade_cards", method: "POST", json: batch)
            } catch {
                guard error.localizedDescription.range(of: "duplicate|unique", options: [.regularExpression, .caseInsensitive]) != nil else { throw error }
                for r in batch { _ = try? await account.rest("trade_cards", method: "POST", json: r) }
            }
            i += 200
        }
        notifyChanged()
    }

    static func remove(_ ids: [String]) async throws {
        guard !ids.isEmpty else { return }
        _ = try await account.rest("trade_cards?id=in.(\(ids.joined(separator: ",")))", method: "DELETE")
        notifyChanged()
    }

    static func sharedCollection(of user: String) async throws -> [TradeCard] {
        var cards: [TradeCard] = try await all("rpc/trader_collection?order=name.asc,id.asc", method: "POST", json: ["trader": user])
        for i in cards.indices { cards[i].id = nil; cards[i].holdingId = nil }
        return cards
    }

    // Offers
    static func offers() async throws -> [TradeOffer] { try await get("trade_offers?select=*&order=updated_at.desc&limit=300") }

    static func send(to: String, give: [TradeCard], get: [TradeCard], cash: Double, message: String, counterOf: String?) async throws {
        let args: [String: Any] = ["recipient": to, "give": give.map(\.json), "get": get.map(\.json), "cash": (cash * 100).rounded() / 100,
                                   "message": message.isEmpty ? NSNull() : message, "counter_of": counterOf ?? NSNull()]
        _ = try await account.rest("rpc/make_offer", method: "POST", json: args)
        notifyChanged()
    }

    static func respond(_ offer: String, _ action: String) async throws {
        _ = try await account.rest("rpc/respond_offer", method: "POST", json: ["offer": offer, "action": action])
        notifyChanged()
    }

    static func messages(_ offer: String) async throws -> [TradeMessage] { try await get("trade_messages?offer_id=eq.\(offer)&select=*&order=created_at.asc&limit=500") }
    static func say(_ offer: String, _ body: String) async throws {
        _ = try await account.rest("trade_messages", method: "POST", json: ["offer_id": offer, "body": body.trimmingCharacters(in: .whitespacesAndNewlines)])
    }

    // Values
    /// Today's market value of each card (one copy), from the prices on this phone.
    static func withValues(_ cards: [TradeCard]) async -> [TradeCard] {
        let need = cards.indices.filter { cards[$0].value == nil }
        guard !need.isEmpty else { return cards }
        await Catalog.shared.ensureLoaded()
        let answers = await Catalog.shared.prices(need.map { i in
            let c = cards[i]
            return Catalog.PriceQuery(id: c.cardId, variant: c.variant, grader: c.grader, grade: c.grade, condition: c.condition ?? "NM")
        })
        var out = cards
        for (n, i) in need.enumerated() where out[i].language != "zh" { out[i].value = answers[n]?.value }
        return out
    }

    static func total(_ cards: [TradeCard]) -> Double { cards.reduce(0) { $0 + ($1.value ?? 0) * Double(max(1, $1.quantity)) } }
}

extension Notification.Name {
    static let tradeChanged = Notification.Name("comps.tradeChanged")
}
